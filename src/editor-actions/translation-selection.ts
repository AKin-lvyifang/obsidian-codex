import type { Editor, EditorPosition } from "obsidian";

export interface TranslationSelectionSnapshot {
  readonly from: EditorPosition;
  readonly to: EditorPosition;
  readonly text: string;
  readonly document: string;
}

export function captureTranslationSelection(
  editor: Pick<Editor, "listSelections" | "getSelection" | "getValue">
): TranslationSelectionSnapshot | null {
  const selections = editor.listSelections();
  if (selections.length !== 1) return null;
  const text = editor.getSelection();
  if (!text.trim()) return null;
  const selection = selections[0];
  const [from, to] = comparePosition(selection.anchor, selection.head) <= 0
    ? [selection.anchor, selection.head]
    : [selection.head, selection.anchor];
  if (comparePosition(from, to) === 0) return null;
  return Object.freeze({
    from: { ...from },
    to: { ...to },
    text,
    document: editor.getValue()
  });
}

export function replaceTranslationSelectionIfUnchanged(
  editor: Pick<Editor, "listSelections" | "getSelection" | "getValue" | "replaceRange">,
  snapshot: TranslationSelectionSnapshot,
  translation: string
): boolean {
  const current = captureTranslationSelection(editor);
  if (
    !current
    || current.document !== snapshot.document
    || current.text !== snapshot.text
    || comparePosition(current.from, snapshot.from) !== 0
    || comparePosition(current.to, snapshot.to) !== 0
    || !translation.trim()
  ) return false;
  editor.replaceRange(translation, snapshot.from, snapshot.to, "echoink-translate");
  return true;
}

function comparePosition(left: EditorPosition, right: EditorPosition): number {
  return left.line - right.line || left.ch - right.ch;
}
