import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import {
  findDynamicScriptCreations,
  patchReactDomScriptResources,
  REACT_DOM_VERSION,
  SCRIPT_RESOURCE_DISABLED
} from "./react-dom-script-resources.mjs";

function findFunction(source, name, development) {
  const file = ts.createSourceFile("react-dom.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let found;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    const property = name === "preinitScript" ? "X" : name === "preinitModuleScript" ? "M" : null;
    if (development && property && ts.isPropertyAssignment(node)
      && node.name.getText(file) === property && ts.isFunctionExpression(node.initializer)) found = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(found, name);
  return found.getText(file);
}

const version = JSON.parse(readFileSync("node_modules/react-dom/package.json", "utf8")).version;
assert.equal(version, REACT_DOM_VERSION);
for (const mode of ["production", "development"]) {
  const fileName = `node_modules/react-dom/cjs/react-dom-client.${mode}.js`;
  const source = readFileSync(fileName, "utf8");
  const patched = patchReactDomScriptResources(source, fileName, version);
  assert.equal(findDynamicScriptCreations(source).length, 3);
  assert.equal(findDynamicScriptCreations(patched).length, 0);
  const development = mode === "development";
  for (const name of ["preinitScript", "preinitModuleScript"]) {
    let delegated = 0;
    const fn = vm.runInNewContext(`(${findFunction(patched, name, development)})`, {
      previousDispatcher: { X() { delegated++; }, M() { delegated++; } }
    });
    assert.throws(() => fn("https://example.invalid/unused.js", {}), { message: SCRIPT_RESOURCE_DISABLED });
    assert.equal(delegated, 0, `${mode} ${name} must not delegate execution`);
  }
  const acquire = vm.runInNewContext(`(${findFunction(patched, "acquireResource", development)})`, { Inserted: 4, NotLoaded: 0 });
  for (const instance of [null, { existingScript: true }]) {
    const resource = { type: "script", count: 0, instance };
    assert.throws(() => acquire(null, resource, {}), { message: SCRIPT_RESOURCE_DISABLED });
    assert.equal(resource.count, 0, "refuse before counting or reusing an existing script");
    assert.equal(resource.instance, instance);
  }
  // Existing non-script resources still follow upstream reference counting.
  for (const type of ["style", "stylesheet"]) {
    const instance = { existingStyle: true };
    const resource = { type, count: 2, instance, state: { loading: 4 } };
    assert.equal(acquire({}, resource, {}), instance);
    assert.equal(resource.count, 3);
  }
  assert.equal(acquire({}, { type: "void", count: 0, instance: null }, {}), null);
  // Stylesheet creation and placement helpers are left byte-for-byte intact.
  for (const name of ["insertStylesheet", "preloadStylesheet", "getResource", "adoptPreloadPropsForStylesheet"]) {
    assert.equal(findFunction(patched, name, development), findFunction(source, name, development), `${name} changed`);
  }
  assert.throws(() => patchReactDomScriptResources(source, fileName, "19.2.0"), /Re-audit/);
  assert.throws(() => patchReactDomScriptResources(patched, fileName, version), /Expected 3/);
  console.log(`PASS ${mode}: script loaders refuse execution; cached instances cannot bypass; style handling unchanged`);
}

assert.equal(findDynamicScriptCreations(`doc.createElement('script'); doc['createElementNS']('svg', 'script'); doc.createElement('div');`).length, 2);
assert.equal(findDynamicScriptCreations(`${"x(),".repeat(10000)}doc.createElement('script');`).length, 1);
console.log("PASS bundle scanner catches ordinary and namespaced script creation");
