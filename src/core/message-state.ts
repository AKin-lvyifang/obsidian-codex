import type { ChatMessage } from "../settings/settings";

export function settleStaleRunningMessages(messages: ChatMessage[]): number {
  let settled = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.status !== "running") continue;

    if (message.itemType === "thinking" || isEmptyProcessMessage(message)) {
      messages.splice(index, 1);
      settled += 1;
      continue;
    }

    message.status = "interrupted";
    settled += 1;
  }
  return settled;
}

function isEmptyProcessMessage(message: ChatMessage): boolean {
  if (!isProcessItemType(message.itemType)) return false;
  return !String(message.text ?? "").trim();
}

function isProcessItemType(itemType?: string): boolean {
  return itemType === "reasoning" || itemType === "commandExecution" || itemType === "fileChange" || itemType === "mcpToolCall" || itemType === "dynamicToolCall" || itemType === "collabAgentToolCall" || itemType === "plan";
}
