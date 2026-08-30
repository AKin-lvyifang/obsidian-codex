import { Notice, type App } from "obsidian";

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
