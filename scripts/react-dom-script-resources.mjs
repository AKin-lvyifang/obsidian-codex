import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

export const REACT_DOM_VERSION = "19.1.1";
export const SCRIPT_RESOURCE_DISABLED =
  "EchoInk's embedded React DOM does not support executable script resources.";

function parse(source, fileName) {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (file.parseDiagnostics.length) throw new Error(`Cannot parse React DOM: ${fileName}`);
  return file;
}

function visit(node, callback) {
  const pending = [node];
  while (pending.length) {
    const current = pending.pop();
    callback(current);
    ts.forEachChild(current, (child) => { pending.push(child); });
  }
}

export function findDynamicScriptCreations(source, fileName = "main.js") {
  const matches = [];
  visit(parse(source, fileName), (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    const method = ts.isPropertyAccessExpression(callee) ? callee.name.text
      : ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)
        ? callee.argumentExpression.text : null;
    const tag = node.arguments[method === "createElementNS" ? 1 : 0];
    if ((method === "createElement" || method === "createElementNS")
      && tag && ts.isStringLiteralLike(tag) && tag.text.toLowerCase() === "script") {
      matches.push(node);
    }
  });
  return matches;
}

/**
 * Keep React 19's renderer intact while removing three unused executable-script
 * resource loaders. This is a disclosed build adaptation, not a source spelling
 * change: the original allocation, dispatcher delegation and append operations
 * are removed, and attempts to use the unsupported capability fail explicitly.
 * No installed dependency files are modified.
 */
export function patchReactDomScriptResources(source, fileName, version) {
  if (version !== REACT_DOM_VERSION) {
    throw new Error(`React DOM script-resource adaptation requires ${REACT_DOM_VERSION}; found ${version}. Re-audit before upgrading.`);
  }
  const file = parse(source, fileName);
  const isDevelopment = fileName.endsWith("react-dom-client.development.js");
  const functions = new Map();
  visit(file, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name
      && ["preinitScript", "preinitModuleScript", "acquireResource"].includes(node.name.text)) {
      functions.set(node.name.text, [...(functions.get(node.name.text) ?? []), node]);
    }
    if (isDevelopment && ts.isPropertyAssignment(node) && ts.isFunctionExpression(node.initializer)
      && ["X", "M"].includes(node.name.getText(file))) {
      const name = node.name.getText(file) === "X" ? "preinitScript" : "preinitModuleScript";
      functions.set(name, [...(functions.get(name) ?? []), node.initializer]);
    }
  });
  for (const name of ["preinitScript", "preinitModuleScript", "acquireResource"]) {
    if (functions.get(name)?.length !== 1) throw new Error(`React DOM ${name} anchor changed: ${fileName}`);
  }
  const creations = findDynamicScriptCreations(source, fileName);
  if (creations.length !== 3) throw new Error(`Expected 3 React DOM script loaders; found ${creations.length}: ${fileName}`);
  const rejection = `throw Error(${JSON.stringify(SCRIPT_RESOURCE_DISABLED)});`;
  const edits = [];
  for (const name of ["preinitScript", "preinitModuleScript"]) {
    const fn = functions.get(name)[0];
    const owned = creations.filter((node) => node.pos >= fn.body.pos && node.end <= fn.body.end);
    if (owned.length !== 1) throw new Error(`React DOM ${name} script creation changed: ${fileName}`);
    edits.push({ start: fn.body.getStart(file), end: fn.body.end, text: `{ ${rejection} }` });
  }
  const acquire = functions.get("acquireResource")[0];
  if (acquire.parameters[1]?.name.getText(file) !== "resource") {
    throw new Error(`React DOM acquireResource signature changed: ${fileName}`);
  }
  const clauses = [];
  visit(acquire.body, (node) => {
    if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression) && node.expression.text === "script") clauses.push(node);
  });
  if (clauses.length !== 1 || creations.filter((node) => node.pos >= clauses[0].pos && node.end <= clauses[0].end).length !== 1) {
    throw new Error(`React DOM acquireResource script branch changed: ${fileName}`);
  }
  // Reject before counting or reusing a cached instance. Style resources retain
  // exactly the upstream implementation, including preload adoption and order.
  const bodyStart = acquire.body.getStart(file) + 1;
  edits.push({ start: bodyStart, end: bodyStart, text: `\n  if (resource.type === "script") { ${rejection} }\n` });
  edits.push({ start: clauses[0].getStart(file), end: clauses[0].end, text: `case "script": ${rejection}\n` });
  let patched = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    patched = patched.slice(0, edit.start) + edit.text + patched.slice(edit.end);
  }
  if (findDynamicScriptCreations(patched, fileName).length) throw new Error(`React DOM script resource removal incomplete: ${fileName}`);
  return patched;
}

export const reactDomScriptResourcesPlugin = {
  name: "echoink-react-dom-script-resources",
  setup(build) {
    build.onLoad({ filter: /[/\\]react-dom[/\\]cjs[/\\]react-dom-client\.(?:production|development)\.js$/ }, async ({ path: fileName }) => {
      const [source, metadata] = await Promise.all([
        fs.readFile(fileName, "utf8"),
        fs.readFile(path.resolve(path.dirname(fileName), "..", "package.json"), "utf8")
      ]);
      return { contents: patchReactDomScriptResources(source, fileName, JSON.parse(metadata).version), loader: "js" };
    });
  }
};
