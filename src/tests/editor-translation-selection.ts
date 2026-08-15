import * as assert from "node:assert/strict";
import {
  captureTranslationSelection,
  replaceTranslationSelectionIfUnchanged
} from "../editor-actions/translation-selection";

export function runEditorTranslationSelectionTests(): void {
  const editor = editorFixture("Before **你好** after", 7, 13);
  const snapshot = captureTranslationSelection(editor);
  assert.ok(snapshot);
  assert.equal(replaceTranslationSelectionIfUnchanged(editor, snapshot, "**Hello**"), true);
  assert.equal(editor.value(), "Before **Hello** after");

  const changed = editorFixture("Before 你好 after", 7, 9);
  const changedSnapshot = captureTranslationSelection(changed);
  assert.ok(changedSnapshot);
  changed.setValue("Before 用户改了 after");
  assert.equal(replaceTranslationSelectionIfUnchanged(changed, changedSnapshot, "Hello"), false);
  assert.equal(changed.value(), "Before 用户改了 after");

  const multi = editorFixture("你好", 0, 2, 2);
  assert.equal(captureTranslationSelection(multi), null);
  const empty = editorFixture("你好", 1, 1);
  assert.equal(captureTranslationSelection(empty), null);
}

function editorFixture(initial: string, from: number, to: number, selectionCount = 1) {
  let value = initial;
  const selection = {
    anchor: { line: 0, ch: from },
    head: { line: 0, ch: to }
  };
  return {
    listSelections: () => Array.from({ length: selectionCount }, () => selection),
    getSelection: () => value.slice(from, to),
    getValue: () => value,
    replaceRange: (replacement: string) => {
      value = `${value.slice(0, from)}${replacement}${value.slice(to)}`;
    },
    setValue: (next: string) => { value = next; },
    value: () => value
  };
}
