export interface McpPanelResourceState {
  total: number;
  enabled: number;
}

export async function loadMcpPanelView(input: {
  readonly container: HTMLElement;
  readonly loadResources: () => Readonly<McpPanelResourceState>;
}): Promise<void> {
  const render = (error: string | null, resources: Readonly<McpPanelResourceState>) => {
    renderMcpPanelView(input.container, error, resources, {
      onRetry: () => { void loadMcpPanelView(input); }
    });
  };
  try {
    render(null, input.loadResources());
  } catch (error) {
    render(
      error instanceof Error ? error.message : String(error),
      { total: 0, enabled: 0 }
    );
  }
}

export function renderMcpPanelView(
  container: HTMLElement,
  error: string | null,
  resources: Readonly<McpPanelResourceState>,
  callbacks: { onRetry: () => void }
): void {
  container.empty();
  const titleId = "echoink-mcp-panel-title";
  container.setAttribute("role", "region");
  container.setAttribute("aria-labelledby", titleId);
  container.createDiv({
    cls: "codex-mcp-title",
    text: "MCP 状态",
    attr: { id: titleId }
  });
  if (error) {
    container.createDiv({
      cls: "codex-mcp-error",
      text: `读取失败：${error}`,
      attr: { role: "alert" }
    });
    const retry = container.createEl("button", {
      cls: "codex-mcp-retry",
      text: "重新读取 MCP",
      attr: { type: "button", "aria-label": "重新读取 MCP" }
    });
    retry.onclick = callbacks.onRetry;
    return;
  }
  if (resources.total > 0) {
    container.createDiv({
      cls: "codex-mcp-empty",
      text: resources.enabled > 0
        ? `当前已启用 ${resources.enabled} / ${resources.total} 个 MCP 资源；下一轮对话仍按 Server 与 Tool 信任策略加载。`
        : `当前 ${resources.total} 个 MCP 资源均已关闭；下一轮对话不加载 MCP。`,
      attr: { role: "status", "aria-live": "polite" }
    });
  }
  if (resources.total === 0) {
    container.createDiv({
      cls: "codex-mcp-empty",
      text: "当前没有 MCP 资源。",
      attr: { role: "status", "aria-live": "polite" }
    });
  }
}
