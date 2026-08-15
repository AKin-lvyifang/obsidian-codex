export type ProviderErrorDiagnostic = Readonly<{
  kind: "timeout" | "provider" | "generic";
  title: string;
  cause: string;
  action: string;
  original: string;
  context: string;
  text: string;
}>;

export function diagnoseProviderError(
  error: unknown,
  context: { model?: string | null; providerLabel?: string | null } = {}
): ProviderErrorDiagnostic {
  const original = error instanceof Error ? error.message : String(error);
  const timeout = /timeout|timed out|请求超时/iu.test(original);
  const provider = /provider|model|api|http|network|网络|模型|凭据/iu.test(original);
  const kind = timeout ? "timeout" : provider ? "provider" : "generic";
  const title = timeout ? "Provider 响应超时" : provider ? "Provider 请求失败" : "EchoInk 请求失败";
  const cause = timeout
    ? "Provider 没有在限定时间内返回结果。"
    : provider
      ? "当前 Provider、模型、凭据或网络连接未完成请求。"
      : "Pi Agent 返回了未分类错误。";
  const action = "检查 Provider 与模型设置后重试；保留下方原始错误以便继续定位。";
  const contextText = [
    `模型 ${context.model?.trim() || "自动"}`,
    context.providerLabel ? `连接 ${context.providerLabel}` : ""
  ].filter(Boolean).join("；");
  const text = [
    title,
    "",
    `可能原因：${cause}`,
    `建议处理：${action}`,
    contextText ? `当前上下文：${contextText}` : "",
    `原始错误：${original || "未知错误"}`
  ].filter(Boolean).join("\n");
  return { kind, title, cause, action, original, context: contextText, text };
}
