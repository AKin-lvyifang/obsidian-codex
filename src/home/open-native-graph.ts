import { Notice, TFile, normalizePath, type App } from "obsidian";

/**
 * Opens Obsidian's core Graph View through the public Workspace leaf API.
 * The graph implementation and its settings remain entirely owned by Obsidian.
 */
export async function openObsidianGraphLeaf(app: App): Promise<boolean> {
  try {
    let leaf = app.workspace.getLeavesOfType("graph")[0];
    if (!leaf) {
      leaf = app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: "graph", active: true, state: {} });
    }
    await app.workspace.revealLeaf(leaf);
    if (leaf.getViewState().type !== "graph") {
      throw new Error("Obsidian did not activate the Graph View");
    }
    return true;
  } catch (error) {
    console.warn("EchoInk 无法打开 Obsidian 原生图谱", error);
    new Notice("暂时无法打开 Obsidian 原生图谱，请稍后重试。");
    return false;
  }
}

/**
 * Opens a new native Local Graph leaf centered on one existing Vault file.
 * EchoInk supplies only the center file; Obsidian owns the graph neighborhood,
 * rendering, filters, and interaction.
 */
export async function openObsidianLocalGraphLeaf(app: App, indexPath: string): Promise<boolean> {
  const normalizedPath = normalizePath(indexPath);
  const indexFile = app.vault.getAbstractFileByPath(normalizedPath);
  if (!(indexFile instanceof TFile)) {
    new Notice(`没有在当前 Vault 找到：${normalizedPath}`);
    return false;
  }

  try {
    const leaf = app.workspace.getLeaf("tab");
    await leaf.setViewState({
      type: "localgraph",
      active: true,
      state: { file: normalizedPath }
    });
    const viewState = leaf.getViewState();
    if (viewState.type !== "localgraph" || viewState.state?.file !== normalizedPath) {
      throw new Error("Obsidian did not activate the requested Local Graph");
    }
    await app.workspace.revealLeaf(leaf);
    return true;
  } catch (error) {
    console.warn("EchoInk 无法打开 Obsidian 原生局部图谱", error);
    new Notice("暂时无法打开 Obsidian 原生局部图谱，请稍后重试。");
    return false;
  }
}
