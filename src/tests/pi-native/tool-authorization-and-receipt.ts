import assert from "node:assert/strict";
import {
  lstat as nodeLstat,
  mkdtemp,
  realpath as nodeRealpath,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  FileDomainReceiptStore,
  TEST_UNCERTAIN,
  TestUncertainInjectionError,
  type DomainReadbackSummary,
  type PersistDomainReceiptInput
} from "../../harness/pi-native/domain-receipt-store";
import { PiNativeFileStoreError } from "../../harness/pi-native/file-store-utils";
import {
  PI_VAULT_TOOL_POLICIES,
  PI_VAULT_TOOL_POLICY_VERSION,
  PI_VAULT_TOOL_VERSION
} from "../../harness/pi-native/pi-vault-tool-contracts";
import {
  PiVaultToolAuthorizationError
} from "../../harness/pi-native/pi-vault-tool-security-extension";
import {
  FileApprovalTicketStore,
  createReadToolAuthorizationContext,
  isReadToolAuthorizationContext,
  isWriteToolAuthorizationContext,
  type ApprovalOperationContract,
  type EchoInkApprovalTicket,
  type WriteToolAuthorizationContext
} from "../../harness/pi-native/tool-authorization";
import type { VaultDomainAdapter } from "../../harness/pi-native/vault-domain-service";
import { PiAgentApprovalBroker } from "../../plugin/pi-agent-approval-broker";
import { createPiVaultProductionAuthorizationPort } from "../../plugin/pi-vault-tool-production";

export async function runToolAuthorizationAndReceiptTests(): Promise<void> {
  await assertAgentApprovalBrokerOneShotIdentity();
  await withFixture(async (fixture) => {
    await assertExactTicketConsumptionAndInvalidation(fixture);
    await assertDurableApprovalTerminalViews(fixture);
    await assertReadAuthorizationCannotCreateReceipt(fixture);
    await assertReceiptLifecycleAndReadbackInvariant(fixture);
    await assertTestUncertainRecoveryNeverRetriesEffect(fixture);
    await assertStartedJournalCanOnlyRecoverByReadback(fixture);
    await assertVaultApprovalBrokerKeepsTicketAuthority(fixture);
    await assertVaultIsolation(fixture);
  });
}

async function assertAgentApprovalBrokerOneShotIdentity(): Promise<void> {
  const broker = new PiAgentApprovalBroker();
  const identity = Object.freeze({
    conversationId: "conversation-approval",
    piSessionId: "pi-session-approval",
    productRunId: "product-run-approval",
    toolCallId: "tool-call-approval"
  });
  let matchingNotifications = 0;
  let foreignNotifications = 0;
  const matchingSubscription = broker.subscribeRun(identity, () => {
    matchingNotifications += 1;
  });
  const foreignSubscription = broker.subscribeRun({
    conversationId: identity.conversationId,
    piSessionId: identity.piSessionId,
    productRunId: "product-run-other"
  }, () => {
    foreignNotifications += 1;
  });

  const approved = broker.waitForDecision({
    ...identity,
    requestId: "request-approve",
    target: "Target.md",
    preview: "approve preview"
  });
  const approvedBinding = broker.bindingFor(identity);
  assert.ok(approvedBinding);
  assert.equal(approvedBinding.target, "Target.md");
  assert.equal(approvedBinding.preview, "approve preview");
  assert.equal(broker.bindingFor({
    ...identity,
    conversationId: "conversation-other"
  }), null, "a different Conversation cannot obtain the waiter");
  assert.equal(broker.bindingFor({
    ...identity,
    piSessionId: "pi-session-other"
  }), null, "a different Pi session cannot obtain the waiter");
  assert.equal(broker.bindingFor({
    ...identity,
    productRunId: "product-run-other"
  }), null, "a different ProductRun cannot obtain the waiter");
  assert.equal(broker.bindingFor({
    ...identity,
    toolCallId: "tool-call-other"
  }), null, "a different Tool Call cannot obtain the waiter");
  assert.equal(approvedBinding.decide("approve"), true);
  assert.equal(approvedBinding.decide("reject"), false,
    "one live request can be decided only once");
  assert.equal(await approved, true);

  const rejected = broker.waitForDecision({
    ...identity,
    requestId: "request-approve",
    target: "Target.md",
    preview: "reject preview"
  });
  assert.equal(approvedBinding.decide("approve"), false,
    "a stale binding cannot decide a later waiter even when every external identity repeats");
  const rejectedBinding = broker.bindingFor(identity);
  assert.ok(rejectedBinding);
  assert.equal(rejectedBinding.decide("reject"), true);
  assert.equal(await rejected, false);

  const conflict = broker.waitForDecision({
    ...identity,
    requestId: "request-conflict",
    target: "Target.md",
    preview: "conflict preview"
  });
  await assert.rejects(
    broker.waitForDecision({
      ...identity,
      requestId: "request-conflict-other-identity",
      target: "Other.md",
      preview: "must not replace"
    }),
    /waiter_conflict/u,
    "a second request cannot replace an identity that is already waiting"
  );
  await assert.rejects(
    broker.waitForDecision({
      ...identity,
      toolCallId: "tool-call-conflicting-request-id",
      requestId: "request-conflict",
      target: "Other.md",
      preview: "must not alias"
    }),
    /waiter_conflict/u,
    "one opaque request identity cannot alias another Tool Call"
  );
  assert.equal(broker.bindingFor(identity)?.decide("reject"), true);
  assert.equal(await conflict, false);

  const abortController = new AbortController();
  const cancelledIdentity = {
    ...identity,
    toolCallId: "tool-call-cancelled"
  };
  const cancelled = broker.waitForDecision({
    ...cancelledIdentity,
    requestId: "request-cancelled",
    target: "Cancelled.md",
    preview: "cancel preview",
    signal: abortController.signal
  });
  const cancelledBinding = broker.bindingFor(cancelledIdentity);
  assert.ok(cancelledBinding);
  abortController.abort();
  await assert.rejects(cancelled, /approval_cancelled/u);
  assert.equal(cancelledBinding.decide("approve"), false,
    "an aborted waiter cannot later approve anything");

  const disposedIdentity = {
    ...identity,
    toolCallId: "tool-call-disposed"
  };
  const disposed = broker.waitForDecision({
    ...disposedIdentity,
    requestId: "request-disposed",
    target: "Disposed.md",
    preview: "dispose preview"
  });
  const disposedBinding = broker.bindingFor(disposedIdentity);
  assert.ok(disposedBinding);
  broker.dispose();
  await assert.rejects(disposed, /broker_disposed/u);
  assert.equal(disposedBinding.decide("approve"), false,
    "runtime disposal invalidates every captured decision closure");
  await assert.rejects(
    broker.waitForDecision({
      ...identity,
      requestId: "request-after-dispose",
      target: "After.md",
      preview: "after dispose"
    }),
    /broker_disposed/u
  );
  assert.ok(matchingNotifications >= 10,
    "the matching run is notified when live waiters enter and leave");
  assert.equal(foreignNotifications, 0,
    "run subscriptions never receive another ProductRun's waiter changes");
  matchingSubscription.unsubscribe();
  foreignSubscription.unsubscribe();
}

async function assertVaultApprovalBrokerKeepsTicketAuthority(
  fixture: Fixture
): Promise<void> {
  const broker = new PiAgentApprovalBroker();
  const runIdentity = Object.freeze({
    conversationId: "conversation-vault-agent-approval",
    piSessionId: "pi-session-vault-agent-approval",
    productRunId: "product-run-vault-agent-approval",
    vaultId: fixture.vaultId
  });
  const confirmationRequests: Array<Readonly<{
    requestId: string;
    conversationId: string;
    piSessionId: string;
    productRunId: string;
    toolCallId: string;
  }>> = [];
  const authorization = createPiVaultProductionAuthorizationPort({
    approvals: fixture.approvals,
    adapter: localAuthorizationAdapter(fixture),
    currentRunIdentity: () => runIdentity,
    userId: "user-vault-agent-approval",
    deviceId: "device-vault-agent-approval",
    now: () => fixture.clock.value,
    confirmation: {
      async confirm(request) {
        confirmationRequests.push(request);
        return await broker.waitForDecision({
          requestId: request.requestId,
          conversationId: request.conversationId,
          piSessionId: request.piSessionId,
          productRunId: request.productRunId,
          toolCallId: request.toolCallId,
          target: JSON.stringify(request.target),
          preview: JSON.stringify(request.preview),
          signal: request.signal
        });
      }
    }
  });
  const authorize = (
    toolCallId: string,
    relativePath: string,
    signal?: AbortSignal
  ) => authorization.authorize({
    toolCallId,
    toolId: "note_create",
    arguments: { relativePath, content: `content for ${relativePath}` },
    policy: PI_VAULT_TOOL_POLICIES.note_create,
    toolVersion: PI_VAULT_TOOL_VERSION,
    policyVersion: PI_VAULT_TOOL_POLICY_VERSION,
    signal
  });
  const identityFor = (toolCallId: string) => ({
    conversationId: runIdentity.conversationId,
    piSessionId: runIdentity.piSessionId,
    productRunId: runIdentity.productRunId,
    toolCallId
  });

  const approvedPromise = authorize("vault-call-approved", "Approved.md");
  const approvedBinding = await waitForApprovalBinding(
    broker,
    identityFor("vault-call-approved")
  );
  assert.equal(approvedBinding.decide("approve"), true);
  const approvedAuthorization = await approvedPromise;
  assert.ok(isWriteToolAuthorizationContext(approvedAuthorization));
  assert.equal((await fixture.approvals.get(
    runIdentity.productRunId,
    "vault-call-approved"
  ))?.status, "approved",
  "the existing Ticket store, not the broker, records approved after consume");

  const deniedPromise = authorize("vault-call-denied", "Denied.md");
  const deniedBinding = await waitForApprovalBinding(
    broker,
    identityFor("vault-call-denied")
  );
  assert.equal(deniedBinding.decide("reject"), true);
  await assert.rejects(
    deniedPromise,
    (error) => error instanceof PiVaultToolAuthorizationError
      && error.code === "approval_denied"
  );
  assert.equal((await fixture.approvals.get(
    runIdentity.productRunId,
    "vault-call-denied"
  ))?.status, "denied",
  "reject continues through the existing denied Ticket resolution");

  const abortController = new AbortController();
  const cancelledPromise = authorize(
    "vault-call-cancelled",
    "Cancelled.md",
    abortController.signal
  );
  await waitForApprovalBinding(
    broker,
    identityFor("vault-call-cancelled")
  );
  abortController.abort();
  await assert.rejects(
    cancelledPromise,
    (error) => error instanceof PiVaultToolAuthorizationError
      && error.code === "approval_cancelled"
  );
  assert.equal((await fixture.approvals.get(
    runIdentity.productRunId,
    "vault-call-cancelled"
  ))?.status, "cancelled");

  assert.deepEqual(
    confirmationRequests.map((request) => ({
      conversationId: request.conversationId,
      piSessionId: request.piSessionId,
      productRunId: request.productRunId,
      toolCallId: request.toolCallId
    })),
    ["vault-call-approved", "vault-call-denied", "vault-call-cancelled"].map(
      (toolCallId) => identityFor(toolCallId)
    ),
    "Vault confirmation receives the exact four-part runtime identity"
  );
  assert.ok(confirmationRequests.every((request) => request.requestId.trim()),
    "Vault confirmation receives the existing opaque Ticket identity");
  broker.dispose();
}

function localAuthorizationAdapter(fixture: Fixture): VaultDomainAdapter {
  return {
    vaultId: fixture.vaultId,
    vaultRootPath: fixture.rootPath,
    async lstat(absolutePath) {
      try {
        const stat = await nodeLstat(absolutePath);
        return {
          kind: stat.isSymbolicLink()
            ? "symbolic_link"
            : stat.isFile()
              ? "file"
              : stat.isDirectory()
                ? "directory"
                : "other"
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async realpath(absolutePath) {
      return await nodeRealpath(absolutePath);
    },
    async search() {
      return [];
    },
    async readFile() {
      return null;
    },
    async createFile() {
      throw new Error("not used by authorization test");
    },
    async updateFile() {
      throw new Error("not used by authorization test");
    },
    async moveFile() {
      throw new Error("not used by authorization test");
    },
    async trashFileRecoverably() {
      throw new Error("not used by authorization test");
    }
  };
}

async function waitForApprovalBinding(
  broker: PiAgentApprovalBroker,
  identity: Readonly<{
    conversationId: string;
    piSessionId: string;
    productRunId: string;
    toolCallId: string;
  }>
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const binding = broker.bindingFor(identity);
    if (binding) return binding;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for Agent Approval binding");
}

interface Fixture {
  rootPath: string;
  vaultId: string;
  clock: { value: number };
  approvals: FileApprovalTicketStore;
  receipts: FileDomainReceiptStore;
}

async function assertExactTicketConsumptionAndInvalidation(
  fixture: Fixture
): Promise<void> {
  const contract = contractFor(fixture, "exact");
  const ticket = await issue(fixture, contract);
  assert.equal((await fixture.approvals.listPending()).length, 1);

  const mismatchCases: Array<[
    string,
    ApprovalOperationContract
  ]> = [
    ["arguments", { ...contract, normalizedArguments: { content: "changed" } }],
    ["target", { ...contract, resolvedTarget: { path: "changed.md" } }],
    ["targetVersion", { ...contract, targetVersion: "version-2" }],
    ["toolVersion", { ...contract, toolVersion: "tool-v2" }],
    ["policyVersion", { ...contract, policyVersion: "policy-v2" }],
    ["preview", { ...contract, preview: { diff: "+ changed" } }],
    ["ProductRun", { ...contract, productRunId: "run-other" }],
    ["Conversation", { ...contract, conversationId: "conversation-other" }],
    ["Pi Session", { ...contract, piSessionId: "pi-session-other" }],
    ["user", { ...contract, userId: "user-other" }],
    ["device", { ...contract, deviceId: "device-other" }]
  ];
  for (const [label, changed] of mismatchCases) {
    await assert.rejects(
      fixture.approvals.consume({
        ticketId: ticket.ticketId,
        operationIdentity: ticket.operationIdentity,
        contract: changed
      }),
      (error) => error instanceof PiNativeFileStoreError,
      `${label} change must invalidate the exact Ticket`
    );
  }

  const authorization = await consume(fixture, ticket, contract);
  assert.ok(isWriteToolAuthorizationContext(authorization));
  assert.equal(Object.isFrozen(authorization), true);
  assert.equal((await fixture.approvals.listPending()).length, 0);
  assert.equal(
    (await fixture.approvals.listViews({ statuses: ["approved"] }))[0]
      ?.ticket.ticketId,
    ticket.ticketId
  );
  await assert.rejects(
    consume(fixture, ticket, contract),
    /已进入 approved/u,
    "a Ticket must be consumed only once"
  );

  const replacementContract = contractFor(fixture, "replacement");
  const oldTicket = await issue(fixture, replacementContract);
  const changedPreview = {
    ...replacementContract,
    preview: { diff: "+ replacement preview" }
  } satisfies ApprovalOperationContract;
  const replacement = await fixture.approvals.issue({
    ...changedPreview,
    issuedAt: fixture.clock.value,
    expiresAt: fixture.clock.value + 100
  });
  assert.notEqual(replacement.ticketId, oldTicket.ticketId);
  await assert.rejects(
    consume(fixture, oldTicket, replacementContract),
    /ticketId 已失效/u
  );
  await consume(fixture, replacement, changedPreview);
  await assert.rejects(
    fixture.approvals.issue({
      ...replacementContract,
      preview: { diff: "+ cannot replace consumed" },
      issuedAt: fixture.clock.value,
      expiresAt: fixture.clock.value + 100
    }),
    /不能替换/u,
    "a consumed Ticket cannot be replaced"
  );
}

async function assertDurableApprovalTerminalViews(
  fixture: Fixture
): Promise<void> {
  const deniedContract = contractFor(fixture, "denied");
  const deniedTicket = await issue(fixture, deniedContract);
  const denied = await fixture.approvals.resolve({
    productRunId: deniedContract.productRunId,
    toolCallId: deniedContract.toolCallId,
    ticketId: deniedTicket.ticketId,
    resolution: "denied"
  });
  assert.equal(denied.status, "denied");
  assert.equal(denied.consumedAt, null);
  await assert.rejects(
    consume(fixture, deniedTicket, deniedContract),
    /denied/u
  );

  const cancelledContract = contractFor(fixture, "cancelled");
  const cancelledTicket = await issue(fixture, cancelledContract);
  assert.equal((await fixture.approvals.resolve({
    productRunId: cancelledContract.productRunId,
    toolCallId: cancelledContract.toolCallId,
    ticketId: cancelledTicket.ticketId,
    resolution: "cancelled"
  })).status, "cancelled");

  const expiredContract = contractFor(fixture, "expired");
  const expiredTicket = await issue(fixture, expiredContract, 5);
  fixture.clock.value += 5;
  assert.equal(
    (await fixture.approvals.get(
      expiredContract.productRunId,
      expiredContract.toolCallId
    ))?.status,
    "expired"
  );
  await assert.rejects(
    consume(fixture, expiredTicket, expiredContract),
    /expired/u
  );

  const reopened = new FileApprovalTicketStore({
    storageRootPath: fixture.rootPath,
    vaultId: fixture.vaultId,
    now: () => fixture.clock.value
  });
  await reopened.initialize();
  assert.deepEqual(
    new Set((await reopened.listViews()).map((view) => view.status)),
    new Set(["approved", "denied", "cancelled", "expired"]),
    "all Approval terminal states must survive a fresh Store instance"
  );
}

async function assertReadAuthorizationCannotCreateReceipt(
  fixture: Fixture
): Promise<void> {
  const read = createReadToolAuthorizationContext({
    productRunId: "run-read",
    toolCallId: "tool-call-read",
    conversationId: "conversation-read",
    piSessionId: "pi-session-read",
    userId: "user-1",
    vaultId: fixture.vaultId,
    deviceId: "device-1",
    toolId: "note_read",
    toolVersion: "tool-v1",
    policyVersion: "policy-v1",
    normalizedArguments: { path: "read.md" },
    resolvedTarget: { path: "read.md" },
    targetVersion: "read-version-1",
    authorizedAt: fixture.clock.value
  });
  assert.ok(isReadToolAuthorizationContext(read));
  assert.equal(Object.isFrozen(read), true);
  await assert.rejects(
    fixture.receipts.beginAuthorizedOperation(
      read as unknown as WriteToolAuthorizationContext
    ),
    (error) => error instanceof PiNativeFileStoreError
      && error.code === "invalid-input",
    "read Tools must never create a side-effect Receipt journal"
  );
}

async function assertReceiptLifecycleAndReadbackInvariant(
  fixture: Fixture
): Promise<void> {
  const authorization = await authorize(fixture, "receipt-completed");
  const operation = await fixture.receipts.beginAuthorizedOperation(
    authorization
  );
  assert.equal((await fixture.receipts.inspectRecovery(
    operation.operationIdentity
  )).state, "not_started");
  await fixture.receipts.markEffectStarted(operation.operationIdentity);
  await assert.rejects(
    fixture.receipts.markEffectStarted(operation.operationIdentity),
    /禁止再次启动/u,
    "the journal must structurally block a second side-effect start"
  );
  assert.equal((await fixture.receipts.inspectRecovery(
    operation.operationIdentity
  )).state, "readback_required");
  await fixture.receipts.markEffectCompleted(operation.operationIdentity);

  await assert.rejects(
    fixture.receipts.persistReceipt(receiptInput(
      fixture,
      operation.operationIdentity,
      false
    )),
    /readbackVerified=true/u,
    "completed can never be persisted without verified Readback"
  );
  const input = receiptInput(fixture, operation.operationIdentity, true);
  const receipt = await fixture.receipts.persistReceipt(input);
  assert.equal(receipt.status, "completed");
  assert.equal(receipt.readback.readbackVerified, true);
  assert.equal(receipt.recoveryState, "not_required");
  assert.deepEqual(
    await fixture.receipts.persistReceipt(input),
    receipt,
    "persisting the exact Receipt is idempotent"
  );
  assert.equal((await fixture.receipts.listReceipts({
    conversationId: authorization.conversationId,
    statuses: ["completed"]
  })).length, 1);
  assert.equal((await fixture.receipts.listUiViews({
    productRunId: authorization.productRunId
  }))[0]?.recoveryState, "receipt_present");
}

async function assertTestUncertainRecoveryNeverRetriesEffect(
  fixture: Fixture
): Promise<void> {
  const authorization = await authorize(fixture, "test-uncertain");
  const operation = await fixture.receipts.beginAuthorizedOperation(
    authorization
  );
  const injected = {
    ...receiptInput(fixture, operation.operationIdentity, true),
    failureInjection: TEST_UNCERTAIN
  } satisfies PersistDomainReceiptInput;

  await assert.rejects(
    fixture.receipts.persistReceipt(injected),
    (error) =>
      error instanceof PiNativeFileStoreError
      && !(error instanceof TestUncertainInjectionError),
    "TEST_UNCERTAIN must not exist before the effect starts"
  );
  await fixture.receipts.markEffectStarted(operation.operationIdentity);
  await assert.rejects(
    fixture.receipts.persistReceipt(injected),
    (error) =>
      error instanceof PiNativeFileStoreError
      && !(error instanceof TestUncertainInjectionError),
    "TEST_UNCERTAIN must not exist while the effect is merely started"
  );

  let sideEffectExecutions = 1;
  await fixture.receipts.markEffectCompleted(operation.operationIdentity);
  await assert.rejects(
    fixture.receipts.persistReceipt(injected),
    (error) =>
      error instanceof TestUncertainInjectionError
      && error.code === TEST_UNCERTAIN
  );
  assert.equal(
    await fixture.receipts.readReceipt(operation.operationIdentity),
    null,
    "the injected window must leave the Receipt absent"
  );

  const reopened = new FileDomainReceiptStore({
    storageRootPath: fixture.rootPath,
    vaultId: fixture.vaultId,
    now: () => fixture.clock.value
  });
  await reopened.initialize();
  assert.equal((await reopened.inspectRecovery(
    operation.operationIdentity
  )).state, "readback_required");

  let readbackCalls = 0;
  const recovered = await reopened.recoverMissingReceipt(
    operation.operationIdentity,
    (context) => {
      readbackCalls += 1;
      assert.equal(Object.isFrozen(context), true);
      assert.equal(context.operationIdentity, operation.operationIdentity);
      return {
        status: "completed",
        safeSummary: { effect: "already present" },
        readback: readback(fixture, true, "recovered-version")
      };
    }
  );
  assert.equal(recovered.recoveryState, "readback_recovered");
  assert.equal(readbackCalls, 1);
  assert.equal(sideEffectExecutions, 1);

  await reopened.recoverMissingReceipt(
    operation.operationIdentity,
    () => {
      sideEffectExecutions += 1;
      throw new Error("must not run after Receipt exists");
    }
  );
  assert.equal(readbackCalls, 1);
  assert.equal(sideEffectExecutions, 1);
}

async function assertStartedJournalCanOnlyRecoverByReadback(
  fixture: Fixture
): Promise<void> {
  const authorization = await authorize(fixture, "started-recovery");
  const operation = await fixture.receipts.beginAuthorizedOperation(
    authorization
  );
  await fixture.receipts.markEffectStarted(operation.operationIdentity);
  const recovered = await fixture.receipts.recoverMissingReceipt(
    operation.operationIdentity,
    () => ({
      status: "completed",
      safeSummary: { recovered: true },
      readback: readback(fixture, true, "started-recovered-version")
    })
  );
  assert.equal(recovered.status, "completed");
  assert.equal(recovered.recoveryState, "readback_recovered");
}

async function assertVaultIsolation(fixture: Fixture): Promise<void> {
  const operationIdentity = (await fixture.receipts.listReceipts())[0]
    ?.operationIdentity;
  assert.ok(operationIdentity);
  const otherApprovals = new FileApprovalTicketStore({
    storageRootPath: fixture.rootPath,
    vaultId: "vault-other",
    now: () => fixture.clock.value
  });
  const otherReceipts = new FileDomainReceiptStore({
    storageRootPath: fixture.rootPath,
    vaultId: "vault-other",
    now: () => fixture.clock.value
  });
  await Promise.all([otherApprovals.initialize(), otherReceipts.initialize()]);
  assert.deepEqual(await otherApprovals.listViews(), []);
  assert.deepEqual(await otherReceipts.listUiViews(), []);
  assert.equal(await otherReceipts.readReceipt(operationIdentity), null);
}

function contractFor(
  fixture: Fixture,
  suffix: string,
  overrides: Partial<ApprovalOperationContract> = {}
): ApprovalOperationContract {
  return {
    productRunId: `run-${suffix}`,
    toolCallId: `tool-call-${suffix}`,
    conversationId: `conversation-${suffix}`,
    piSessionId: `pi-session-${suffix}`,
    userId: "user-1",
    vaultId: fixture.vaultId,
    deviceId: "device-1",
    toolId: "note_update",
    toolVersion: "tool-v1",
    policyVersion: "policy-v1",
    normalizedArguments: {
      path: `${suffix}.md`,
      content: "safe fixture content"
    },
    resolvedTarget: { path: `${suffix}.md` },
    targetVersion: "version-1",
    preview: { diff: "+ safe fixture content" },
    ...overrides
  };
}

async function issue(
  fixture: Fixture,
  contract: ApprovalOperationContract,
  ttl = 100
): Promise<Readonly<EchoInkApprovalTicket>> {
  return await fixture.approvals.issue({
    ...contract,
    issuedAt: fixture.clock.value,
    expiresAt: fixture.clock.value + ttl
  });
}

async function consume(
  fixture: Fixture,
  ticket: Readonly<EchoInkApprovalTicket>,
  contract: ApprovalOperationContract
): Promise<Readonly<WriteToolAuthorizationContext>> {
  return await fixture.approvals.consume({
    ticketId: ticket.ticketId,
    operationIdentity: ticket.operationIdentity,
    contract
  });
}

async function authorize(
  fixture: Fixture,
  suffix: string
): Promise<Readonly<WriteToolAuthorizationContext>> {
  const contract = contractFor(fixture, suffix);
  return await consume(fixture, await issue(fixture, contract), contract);
}

function receiptInput(
  fixture: Fixture,
  operationIdentity: string,
  readbackVerified: boolean
): PersistDomainReceiptInput {
  return {
    operationIdentity,
    status: "completed",
    safeSummary: { effect: "fixture write" },
    readback: readback(fixture, readbackVerified, "version-after-write")
  };
}

function readback(
  fixture: Fixture,
  readbackVerified: boolean,
  observedTargetVersion: string
): DomainReadbackSummary {
  return {
    checkedAt: fixture.clock.value,
    readbackVerified,
    observedTargetVersion,
    safeSummary: { exists: true, bytes: 20 }
  };
}

async function withFixture(
  run: (fixture: Fixture) => Promise<void>
): Promise<void> {
  const rootPath = await mkdtemp(path.join(
    tmpdir(),
    "echoink-tool-authorization-receipt-"
  ));
  const clock = { value: 1_000 };
  const vaultId = "vault-primary";
  const approvals = new FileApprovalTicketStore({
    storageRootPath: rootPath,
    vaultId,
    now: () => clock.value
  });
  const receipts = new FileDomainReceiptStore({
    storageRootPath: rootPath,
    vaultId,
    now: () => clock.value
  });
  try {
    await Promise.all([approvals.initialize(), receipts.initialize()]);
    await run({ rootPath, vaultId, clock, approvals, receipts });
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}
