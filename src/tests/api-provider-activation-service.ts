import * as assert from "node:assert/strict";
import {
  ApiProviderActivationError,
  ApiProviderActivationService,
  ProductActivityGate,
  type ApiProviderActivationPort
} from "../plugin/api-provider-activation-service";

interface FixtureState { selected: string; language?: string; }

export async function runApiProviderActivationServiceTests(): Promise<void> {
  await assertCandidateCutoverOrder();
  await assertFailureRestoresMemoryDiskAndRuntime();
  await assertBusyAndConcurrentChangesAreRejectedOrSerialized();
  await assertRecoveryFailureRequiresReload();
  await assertRollbackPreservesConcurrentUnownedSettings();
  await assertUnsafeRevocationFailureKeepsCandidate();
  await assertProductActivityGateClosesBothRaceDirections();
}

async function assertRollbackPreservesConcurrentUnownedSettings(): Promise<void> {
  const state: FixtureState = { selected: "old", language: "zh-CN" };
  const persisted: FixtureState = structuredClone(state);
  let runtime = "old-runtime";
  await assert.rejects(new ApiProviderActivationService().run({
    isBusy: () => false,
    beginSwitch: () => undefined,
    endSwitch: () => undefined,
    snapshotMemory: () => ({ selected: state.selected }),
    readPersisted: async () => ({ selected: persisted.selected }),
    applyCandidate: () => { state.selected = "candidate"; },
    persistCandidate: async () => { persisted.selected = "candidate"; },
    createCandidateRuntime: async () => {
      state.language = "en";
      persisted.language = "en";
      throw new Error("candidate failed");
    },
    finalizeCandidate: async () => undefined,
    abortCandidate: async () => undefined,
    currentRuntime: () => runtime,
    activateRuntime: (next) => { runtime = next ?? ""; },
    shutdownRuntime: async () => undefined,
    restoreMemory: (snapshot) => { state.selected = snapshot.selected; },
    restorePersisted: async (snapshot) => { persisted.selected = snapshot.selected; }
  }));
  assert.deepEqual(state, { selected: "old", language: "en" });
  assert.deepEqual(persisted, { selected: "old", language: "en" });
}

async function assertUnsafeRevocationFailureKeepsCandidate(): Promise<void> {
  const fixture = activationFixture([], { finalizeUnsafeFailure: true });
  await assert.rejects(new ApiProviderActivationService().run(fixture.port),
    (error: unknown) => error instanceof ApiProviderActivationError
      && error.code === "provider_switch_recovery_failed");
  assert.equal(fixture.state.selected, "candidate");
  assert.equal(fixture.persisted.selected, "candidate");
  assert.equal(fixture.activeRuntime(), "candidate-runtime");
}

async function assertProductActivityGateClosesBothRaceDirections(): Promise<void> {
  const gate = new ProductActivityGate();
  let release!: () => void;
  const pending = gate.run(async () => await new Promise<void>((resolve) => {
    release = resolve;
  }));
  assert.equal(gate.hasActivity, true);
  assert.throws(() => gate.beginSwitch(), (error: unknown) =>
    error instanceof ApiProviderActivationError
      && error.code === "provider_switch_busy");
  release();
  await pending;
  gate.beginSwitch();
  await assert.rejects(gate.run(async () => undefined), /切换模型/u);
  gate.endSwitch();
  assert.equal(await gate.run(async () => "ready"), "ready");
}

async function assertCandidateCutoverOrder(): Promise<void> {
  const events: string[] = [];
  const fixture = activationFixture(events);
  await new ApiProviderActivationService().run(fixture.port);
  assert.deepEqual(events, ["begin-switch", "read-persisted", "apply-candidate", "persist-candidate", "create-candidate", "activate-candidate", "finalize-candidate", "shutdown-old", "end-switch"]);
  assert.equal(fixture.state.selected, "candidate");
  assert.equal(fixture.persisted.selected, "candidate");
  assert.equal(fixture.activeRuntime(), "candidate-runtime");
}

async function assertFailureRestoresMemoryDiskAndRuntime(): Promise<void> {
  const events: string[] = [];
  const fixture = activationFixture(events, { candidateFailure: true });
  await assert.rejects(new ApiProviderActivationService().run(fixture.port),
    (error: unknown) => error instanceof ApiProviderActivationError && error.code === "provider_switch_failed");
  assert.equal(fixture.state.selected, "old");
  assert.equal(fixture.persisted.selected, "old");
  assert.equal(fixture.activeRuntime(), "old-runtime");
  assert.equal(events.includes("shutdown-old"), false);
}

async function assertBusyAndConcurrentChangesAreRejectedOrSerialized(): Promise<void> {
  const busy = activationFixture([], { busy: true });
  await assert.rejects(new ApiProviderActivationService().run(busy.port),
    (error: unknown) => error instanceof ApiProviderActivationError && error.code === "provider_switch_busy");
  const events: string[] = [];
  const service = new ApiProviderActivationService();
  const first = activationFixture(events, { label: "first" });
  const second = activationFixture(events, { label: "second" });
  await Promise.all([service.run(first.port), service.run(second.port)]);
  assert.ok(events.indexOf("first:shutdown-old") < events.indexOf("second:read-persisted"));
}

async function assertRecoveryFailureRequiresReload(): Promise<void> {
  const fixture = activationFixture([], { candidateFailure: true, recoveryFailure: true });
  await assert.rejects(new ApiProviderActivationService().run(fixture.port),
    (error: unknown) => error instanceof ApiProviderActivationError
      && error.code === "provider_switch_recovery_failed" && /重载/u.test(error.message));
}

function activationFixture(events: string[], options: {
  busy?: boolean; candidateFailure?: boolean; recoveryFailure?: boolean;
  finalizeUnsafeFailure?: boolean; label?: string;
} = {}): {
  port: ApiProviderActivationPort<FixtureState, FixtureState, string>;
  state: FixtureState;
  persisted: FixtureState;
  activeRuntime(): string;
} {
  const prefix = options.label ? `${options.label}:` : "";
  const record = (event: string): void => events.push(`${prefix}${event}`);
  const state = { selected: "old" };
  const persisted = { selected: "old" };
  let activeRuntime = "old-runtime";
  return {
    state, persisted, activeRuntime: () => activeRuntime,
    port: {
      isBusy: () => options.busy === true,
      beginSwitch: () => { record("begin-switch"); },
      endSwitch: () => { record("end-switch"); },
      snapshotMemory: () => structuredClone(state),
      readPersisted: async () => { record("read-persisted"); return structuredClone(persisted); },
      applyCandidate: () => { record("apply-candidate"); state.selected = "candidate"; },
      persistCandidate: async () => { record("persist-candidate"); persisted.selected = state.selected; },
      createCandidateRuntime: async () => { record("create-candidate"); if (options.candidateFailure) throw new Error("candidate failed"); return "candidate-runtime"; },
      finalizeCandidate: async () => {
        record("finalize-candidate");
        if (options.finalizeUnsafeFailure) throw new Error("revocation uncertain");
      },
      abortCandidate: async () => { record("abort-candidate"); },
      currentRuntime: () => activeRuntime,
      activateRuntime: (runtime) => { record("activate-candidate"); activeRuntime = runtime ?? ""; },
      shutdownRuntime: async (runtime) => { record(runtime === "old-runtime" ? "shutdown-old" : "shutdown-candidate"); },
      restoreMemory: (snapshot) => { record("restore-memory"); state.selected = snapshot.selected; },
      restorePersisted: async (snapshot) => { record("restore-persisted"); if (options.recoveryFailure) throw new Error("recovery failed"); persisted.selected = snapshot.selected; },
      isRollbackSafe: () => options.finalizeUnsafeFailure !== true
    }
  };
}
