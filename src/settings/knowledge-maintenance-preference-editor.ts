import {
  ECHOINK_DEFAULT_KNOWLEDGE_MAINTENANCE_PREFERENCES,
  type KnowledgeMaintenancePreferenceState
} from "../knowledge-base/knowledge-maintenance-preferences";

export interface KnowledgeMaintenancePreferenceEditorSnapshot {
  readonly state: KnowledgeMaintenancePreferenceState;
  readonly revision: string;
  readonly content: string;
}

export interface KnowledgeMaintenancePreferenceEditorState {
  readonly savedState: KnowledgeMaintenancePreferenceState;
  readonly expectedRevision: string;
  readonly savedContent: string;
  readonly draftContent: string;
  readonly saving: boolean;
  readonly error: string | null;
}

export function createKnowledgeMaintenancePreferenceEditor(
  snapshot: Readonly<KnowledgeMaintenancePreferenceEditorSnapshot>
): Readonly<KnowledgeMaintenancePreferenceEditorState> {
  return freezeEditor({
    savedState: snapshot.state,
    expectedRevision: snapshot.revision,
    savedContent: snapshot.content,
    draftContent: snapshot.content,
    saving: false,
    error: null
  });
}

export function editKnowledgeMaintenancePreference(
  editor: Readonly<KnowledgeMaintenancePreferenceEditorState>,
  draftContent: string
): Readonly<KnowledgeMaintenancePreferenceEditorState> {
  return freezeEditor({
    ...editor,
    draftContent,
    error: null
  });
}

export function restoreDefaultKnowledgeMaintenancePreference(
  editor: Readonly<KnowledgeMaintenancePreferenceEditorState>
): Readonly<KnowledgeMaintenancePreferenceEditorState> {
  return editKnowledgeMaintenancePreference(
    editor,
    ECHOINK_DEFAULT_KNOWLEDGE_MAINTENANCE_PREFERENCES
  );
}

export function beginSavingKnowledgeMaintenancePreference(
  editor: Readonly<KnowledgeMaintenancePreferenceEditorState>
): Readonly<KnowledgeMaintenancePreferenceEditorState> {
  return freezeEditor({ ...editor, saving: true, error: null });
}

export function failSavingKnowledgeMaintenancePreference(
  editor: Readonly<KnowledgeMaintenancePreferenceEditorState>,
  error: string
): Readonly<KnowledgeMaintenancePreferenceEditorState> {
  return freezeEditor({ ...editor, saving: false, error });
}

export function knowledgeMaintenancePreferenceIsDirty(
  editor: Readonly<KnowledgeMaintenancePreferenceEditorState> | null
): boolean {
  return Boolean(editor && editor.draftContent !== editor.savedContent);
}

export function knowledgeMaintenancePreferenceDraftState(
  editor: Readonly<KnowledgeMaintenancePreferenceEditorState>
): KnowledgeMaintenancePreferenceState {
  return editor.draftContent === ECHOINK_DEFAULT_KNOWLEDGE_MAINTENANCE_PREFERENCES
    ? "default"
    : "custom";
}

function freezeEditor(
  editor: KnowledgeMaintenancePreferenceEditorState
): Readonly<KnowledgeMaintenancePreferenceEditorState> {
  return Object.freeze({ ...editor });
}
