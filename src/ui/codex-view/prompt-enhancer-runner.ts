import type { CodexViewPromptEnhanceContext } from "./runner-context";

/** Retained only as a short-lived internal seam until the hidden UI is removed. */
export async function enhanceChatInput(
  _view: CodexViewPromptEnhanceContext
): Promise<void> {
  throw new Error("Prompt Enhancer 尚未接入 Pi Agent。");
}
