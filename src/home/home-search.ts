import { type App, TFile } from "obsidian";

export interface HomeSearchMatch { path: string; title: string; mtime: number }
/** Metadata first, then on-demand content; new input cancels old work between reads. */
export class HomeSearchService {
  private readonly cache = new Map<string, { mtime: number; text: string }>();
  private readonly contentCache = new Map<string, { mtime: number; text: string }>();
  constructor(private readonly app: App) {}
  async search(query: string, signal: AbortSignal): Promise<{ matches: HomeSearchMatch[]; count: number; failed: number }> {
    const terms = query.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
    const matches: HomeSearchMatch[] = [];
    let failed = 0;
    const files = this.app.vault.getMarkdownFiles();
    const paths = new Set(files.map((f) => f.path));
    for (const p of this.cache.keys()) if (!paths.has(p)) { this.cache.delete(p); this.contentCache.delete(p); }
    for (let i = 0; i < files.length; i++) {
      if (signal.aborted) return { matches: [], count: 0, failed: 0 };
      const file = files[i];
      try {
        let cached = this.cache.get(file.path);
        if (!cached || cached.mtime !== file.stat.mtime) {
          const metadata = this.app.metadataCache.getFileCache(file);
          const frontmatter = metadata?.frontmatter;
          const text = [file.path, file.basename, frontmatter?.aliases, frontmatter?.alias, frontmatter?.tags, ...(metadata?.tags ?? []).map((tag) => tag.tag)]
            .flat().filter((v) => typeof v === "string").join(" ").toLocaleLowerCase();
          cached = { mtime: file.stat.mtime, text };
          this.cache.set(file.path, cached);
        }
        let searchable = cached.text;
        if (terms.length && !terms.every((t) => searchable.includes(t))) {
          let content = this.contentCache.get(file.path);
          if (!content || content.mtime !== file.stat.mtime) {
            if (signal.aborted) return { matches: [], count: 0, failed: 0 };
            content = { mtime: file.stat.mtime, text: (await this.app.vault.cachedRead(file)).toLocaleLowerCase() };
            if (signal.aborted) return { matches: [], count: 0, failed: 0 };
            this.contentCache.set(file.path, content);
          }
          searchable += " " + content.text;
        }
        if (terms.every((t) => searchable.includes(t))) matches.push({ path: file.path, title: file.basename, mtime: file.stat.mtime });
      } catch { failed++; }
      if (i % 100 === 99) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    matches.sort((a, b) => b.mtime - a.mtime);
    return { matches: matches.slice(0, 6), count: matches.length, failed };
  }
  async excerpt(path: string): Promise<string> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || file.stat.size > 262_144) return "";
    const text = await this.app.vault.cachedRead(file);
    return text.replace(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/u, "").replace(/[#>*_`[\]]/gu, "").replace(/\s+/gu, " ").trim().slice(0, 150);
  }
}
