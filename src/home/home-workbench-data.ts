import { App, TFile, normalizePath } from "obsidian";
import {
  BUILT_IN_JOURNAL_TEMPLATES,
  HOME_ENTRY_IDS,
  JOURNAL_TEMPLATE_DIRECTORY,
  applyJournalTemplate,
  buildHomeActivityDays,
  buildHomeJournalDays,
  countRecordsInFolder,
  importedTemplatePath,
  isKnowledgeBaseReviewPath,
  journalDateFromPath,
  journalPathForDate,
  mostRecentRecordInFolder,
  nextAvailableImportedTemplatePath,
  parseImportedJournalTemplate,
  type HomeActivityDay,
  type HomeEntryId,
  type HomeJournalDay,
  type HomeVaultFileRecord,
  type ImportedJournalTemplate,
  type JournalTemplateDefinition
} from "./home-workbench-model";

const IMAGE_EXTENSION = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/iu;

export interface HomeEntrySummary {
  id: HomeEntryId;
  label: string;
  description: string;
  count: number;
  targetPath?: string;
}

export type HomeKnowledgeEntryId = Extract<HomeEntryId, "wiki" | "outputs" | "projects" | "inbox">;

export const HOME_ENTRY_INDEX_PATHS: Readonly<Record<HomeKnowledgeEntryId, string>> = Object.freeze({
  wiki: "wiki/index.md",
  outputs: "outputs/index.md",
  projects: "projects/index.md",
  inbox: "inbox/index.md"
});

export function homeEntryIndexPath(id: HomeEntryId): string | null {
  return HOME_ENTRY_INDEX_PATHS[id as HomeKnowledgeEntryId] ?? null;
}

export interface HomeCustomTemplateSummary {
  id: string;
  name: string;
  path: string;
}

export interface HomeWorkbenchData {
  records: HomeVaultFileRecord[];
  activity: HomeActivityDay[];
  journalDays: HomeJournalDay[];
  entries: HomeEntrySummary[];
  customTemplates: HomeCustomTemplateSummary[];
}

export type HomeJournalTemplateChoice =
  | { kind: "built-in"; template: JournalTemplateDefinition }
  | { kind: "custom"; path: string; name: string };

export interface HomeJournalCreateResult {
  file: TFile;
  created: boolean;
}

export interface HomeTemplateSaveResult {
  status: "saved" | "conflict";
  path: string;
  file?: TFile;
  safeCopyPath?: string;
}

export class HomeWorkbenchDataService {
  constructor(private readonly app: App) {}

  async build(visibleMonth = new Date()): Promise<HomeWorkbenchData> {
    const records = this.app.vault.getMarkdownFiles().map((file) => this.recordForFile(file));
    const activity = buildHomeActivityDays(records, { now: new Date(), days: 371 });
    const journalDays = buildHomeJournalDays(records, activity, visibleMonth);
    const customTemplates = this.listCustomTemplates();
    return {
      records,
      activity,
      journalDays,
      entries: buildEntrySummaries(records),
      customTemplates
    };
  }

  async readTemplate(choice: HomeJournalTemplateChoice): Promise<string> {
    if (choice.kind === "built-in") return choice.template.content;
    const file = this.app.vault.getAbstractFileByPath(normalizePath(choice.path));
    if (!(file instanceof TFile)) throw new Error(`没有找到模板：${choice.path}`);
    return await this.app.vault.read(file);
  }

  async createOrOpenJournal(choice: HomeJournalTemplateChoice, date = new Date()): Promise<HomeJournalCreateResult> {
    const path = normalizePath(journalPathForDate(date));
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) return { file: existing, created: false };
    if (existing) throw new Error(`日记路径已被文件夹占用：${path}`);
    const source = await this.readTemplate(choice);
    const content = applyJournalTemplate(source, date);
    await this.ensureFolder(path.slice(0, path.lastIndexOf("/")));
    const file = await this.app.vault.create(path, content);
    return { file, created: true };
  }

  previewImportedTemplate(fileName: string, content: string): ImportedJournalTemplate {
    return parseImportedJournalTemplate(fileName, content);
  }

  listCustomTemplates(): HomeCustomTemplateSummary[] {
    const prefix = `${JOURNAL_TEMPLATE_DIRECTORY}/`;
    return this.app.vault.getMarkdownFiles()
      .filter((file) => file.path.toLocaleLowerCase().startsWith(prefix))
      .sort((left, right) => left.basename.localeCompare(right.basename, "zh-Hans"))
      .map((file) => ({ id: `custom:${file.path}`, name: file.basename, path: file.path }));
  }

  async saveImportedTemplate(
    template: ImportedJournalTemplate,
    conflictResolution: "cancel" | "safe-copy" = "cancel"
  ): Promise<HomeTemplateSaveResult> {
    const path = normalizePath(importedTemplatePath(template.name));
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing && conflictResolution === "cancel") {
      const paths = new Set(this.app.vault.getMarkdownFiles().map((file) => file.path));
      return {
        status: "conflict",
        path,
        safeCopyPath: nextAvailableImportedTemplatePath(template.name, paths)
      };
    }
    const targetPath = existing
      ? normalizePath(nextAvailableImportedTemplatePath(
        template.name,
        new Set(this.app.vault.getMarkdownFiles().map((file) => file.path))
      ))
      : path;
    await this.ensureFolder(JOURNAL_TEMPLATE_DIRECTORY);
    const file = await this.app.vault.create(targetPath, template.content);
    return { status: "saved", path: targetPath, file };
  }

  private recordForFile(file: TFile): HomeVaultFileRecord {
    const cache = journalDateFromPath(file.path)
      ? this.app.metadataCache.getFileCache(file)
      : null;
    const imageFile = (cache?.embeds ?? [])
      .filter((embed) => IMAGE_EXTENSION.test(embed.link.split(/[?#]/u)[0] ?? ""))
      .map((embed) => this.app.metadataCache.getFirstLinkpathDest(embed.link, file.path))
      .find((candidate): candidate is TFile => candidate instanceof TFile);
    return {
      path: file.path,
      title: file.basename,
      folder: file.parent?.path || "根目录",
      mtime: file.stat.mtime,
      ...(imageFile instanceof TFile
        ? {
          firstImagePath: imageFile.path,
          firstImageUrl: this.app.vault.getResourcePath(imageFile)
        }
        : {})
    };
  }

  private async ensureFolder(path: string): Promise<void> {
    const parts = normalizePath(path).split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing instanceof TFile) throw new Error(`无法创建目录，路径已被文件占用：${current}`);
      if (existing) continue;
      await this.app.vault.createFolder(current);
    }
  }
}

export function defaultJournalTemplateChoice(): HomeJournalTemplateChoice {
  return { kind: "built-in", template: BUILT_IN_JOURNAL_TEMPLATES[0] };
}

function buildEntrySummaries(records: readonly HomeVaultFileRecord[]): HomeEntrySummary[] {
  const definitions: Record<HomeEntryId, Pick<HomeEntrySummary, "label" | "description"> & { folder?: string }> = {
    wiki: { label: "Wiki", description: "结构化长期知识", folder: "wiki" },
    outputs: { label: "Outputs", description: "维护记录与生成成果", folder: "outputs" },
    projects: { label: "Projects", description: "正在推进的项目知识", folder: "projects" },
    inbox: { label: "Inbox", description: "等待归类的输入", folder: "inbox" },
    journal: { label: "Journal", description: "日记、复盘与时间记录", folder: "journal" },
    review: { label: "Review", description: "知识库复盘与报告" }
  };
  return HOME_ENTRY_IDS.map((id) => {
    const definition = definitions[id];
    const folder = definition.folder;
    const recent = folder ? mostRecentRecordInFolder(records, folder) : null;
    const wikiIndex = id === "wiki" ? records.find((record) => record.path.toLocaleLowerCase() === "wiki/index.md") : null;
    const reviews = id === "review"
      ? records.filter((record) => isKnowledgeBaseReviewPath(record.path)).sort((left, right) => right.mtime - left.mtime)
      : [];
    const review = reviews[0] ?? null;
    return {
      id,
      label: definition.label,
      description: definition.description,
      count: folder ? countRecordsInFolder(records, folder) : reviews.length,
      targetPath: wikiIndex?.path ?? recent?.path ?? review?.path
    };
  });
}
