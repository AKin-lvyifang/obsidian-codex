import type CodexForObsidianPlugin from "../../main";
import type {
  PiConversationDraftRecord,
  PiConversationProjection,
  PiConversationSupportState
} from "../../harness/pi-native/contracts";

interface PiConversationUiState {
  readonly supportByConversation: Map<string, PiConversationSupportState>;
  readonly selectedDraftByConversation: Map<string, string>;
  readonly recoveringConversations: Set<string>;
}

const stateByPlugin = new WeakMap<
  CodexForObsidianPlugin,
  PiConversationUiState
>();

export function rememberPiConversationProjection(
  plugin: CodexForObsidianPlugin,
  projection: Readonly<PiConversationProjection>
): PiConversationSupportState {
  return rememberPiConversationSupport(plugin, {
    catalog: projection.catalog,
    diagnostics: projection.diagnostics,
    drafts: projection.drafts
  });
}

export function rememberPiConversationSupport(
  plugin: CodexForObsidianPlugin,
  support: Readonly<PiConversationSupportState>
): PiConversationSupportState {
  const state = requireState(plugin);
  const snapshot = cloneSupportState(support);
  state.supportByConversation.set(
    snapshot.catalog.conversationId,
    snapshot
  );
  const selectedDraftId = state.selectedDraftByConversation.get(
    snapshot.catalog.conversationId
  );
  if (
    selectedDraftId
    && !snapshot.drafts.some((draft) => draft.draftId === selectedDraftId)
  ) {
    state.selectedDraftByConversation.delete(snapshot.catalog.conversationId);
  }
  return cloneSupportState(snapshot);
}

export async function refreshPiConversationSupport(
  plugin: CodexForObsidianPlugin,
  conversationId: string
): Promise<PiConversationSupportState> {
  return rememberPiConversationSupport(
    plugin,
    await plugin.readPiConversationSupportState(conversationId)
  );
}

export function piConversationSupport(
  plugin: CodexForObsidianPlugin,
  conversationId: string
): PiConversationSupportState | null {
  const support = requireState(plugin).supportByConversation.get(conversationId);
  return support ? cloneSupportState(support) : null;
}

export function selectPiConversationDraft(
  plugin: CodexForObsidianPlugin,
  conversationId: string,
  draftId: string
): PiConversationDraftRecord | null {
  const state = requireState(plugin);
  const draft = state.supportByConversation
    .get(conversationId)
    ?.drafts.find((candidate) => candidate.draftId === draftId);
  if (!draft) return null;
  state.selectedDraftByConversation.set(conversationId, draftId);
  return { ...draft };
}

export function selectedPiConversationDraftId(
  plugin: CodexForObsidianPlugin,
  conversationId: string
): string | undefined {
  const state = requireState(plugin);
  const draftId = state.selectedDraftByConversation.get(conversationId);
  if (!draftId) return undefined;
  const exists = state.supportByConversation
    .get(conversationId)
    ?.drafts.some((draft) => draft.draftId === draftId);
  if (exists) return draftId;
  state.selectedDraftByConversation.delete(conversationId);
  return undefined;
}

export function clearSelectedPiConversationDraft(
  plugin: CodexForObsidianPlugin,
  conversationId: string
): void {
  requireState(plugin).selectedDraftByConversation.delete(conversationId);
}

export function setPiConversationRecovering(
  plugin: CodexForObsidianPlugin,
  conversationId: string,
  recovering: boolean
): void {
  const state = requireState(plugin);
  if (recovering) state.recoveringConversations.add(conversationId);
  else state.recoveringConversations.delete(conversationId);
}

export function isPiConversationRecovering(
  plugin: CodexForObsidianPlugin,
  conversationId: string
): boolean {
  return requireState(plugin).recoveringConversations.has(conversationId);
}

function requireState(plugin: CodexForObsidianPlugin): PiConversationUiState {
  let state = stateByPlugin.get(plugin);
  if (!state) {
    state = {
      supportByConversation: new Map(),
      selectedDraftByConversation: new Map(),
      recoveringConversations: new Set()
    };
    stateByPlugin.set(plugin, state);
  }
  return state;
}

function cloneSupportState(
  support: Readonly<PiConversationSupportState>
): PiConversationSupportState {
  return {
    catalog: { ...support.catalog },
    diagnostics: support.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    drafts: support.drafts.map((draft) => ({ ...draft }))
  };
}
