import { App, TFile, TFolder, getAllTags, normalizePath } from "obsidian";
import {
  BUILT_IN_JOURNAL_TEMPLATES,
  HOME_ENTRY_IDS,
  JOURNAL_TEMPLATE_DIRECTORY,
  applyJournalTemplate,
  buildHomeActivityDays,
  buildHomeGraph,
  buildHomeJournalDays,
  countRecordsInFolder,
  importedTemplatePath,
  isKnowledgeBaseReviewPath,
  journalPathForDate,
  mostRecentRecordInFolder,
  nextAvailableImportedTemplatePath,
  parseImportedJournalTemplate,
  sortRecentHomeRecords,
  type HomeActivityDay,
  type HomeEntryId,
  type HomeGraphData,
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

export interface HomeCustomTemplateSummary {
  id: string;
  name: string;
  path: string;
}

export interface HomeWorkbenchData {
  records: HomeVaultFileRecord[];
  graph: HomeGraphData;
  activity: HomeActivityDay[];
  journalDays: HomeJournalDay[];
  recentThoughts: HomeVaultFileRecord[];
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
    const graph = buildHomeGraph(records, this.app.metadataCache.resolvedLinks);
    const activity = buildHomeActivityDays(records, { now: new Date(), days: 371 });
    const journalDays = buildHomeJournalDays(records, activity, visibleMonth);
    const recentThoughts = sortRecentHomeRecords(records, 10);
    const customTemplates = this.listCustomTemplates();
    return {
      records,
      graph,
      activity,
      journalDays,
      recentThoughts,
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
    const cache = this.app.metadataCache.getFileCache(file);
    const properties: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(cache?.frontmatter ?? {})) {
      if (key === "position") continue;
      const values = flattenPropertyValues(value);
      if (values.length) properties[key] = values;
    }
    const imageFile = (cache?.embeds ?? [])
      .filter((embed) => IMAGE_EXTENSION.test(embed.link.split(/[?#]/u)[0] ?? ""))
      .map((embed) => this.app.metadataCache.getFirstLinkpathDest(embed.link, file.path))
      .find((candidate): candidate is TFile => candidate instanceof TFile);
    return {
      path: file.path,
      title: file.basename,
      folder: file.parent?.path || "根目录",
      ctime: file.stat.ctime,
      mtime: file.stat.mtime,
      tags: cache ? (getAllTags(cache) ?? []) : [],
      properties,
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
      if (existing instanceof TFolder) continue;
      if (existing) throw new Error(`无法创建目录，路径已被文件占用：${current}`);
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

function flattenPropertyValues(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap(flattenPropertyValues);
  if (typeof value === "object") {
    try {
      const serialized = JSON.stringify(value);
      return serialized === undefined ? [] : [serialized];
    } catch {
      return [];
    }
  }
  if (typeof value === "string") return [value];
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return [String(value)];
  return [];
}
