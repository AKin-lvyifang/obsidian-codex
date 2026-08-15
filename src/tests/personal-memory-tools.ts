import assert from "node:assert/strict";
import {
  PI_PERSONAL_MEMORY_TOOL_IDS,
  PI_PERSONAL_MEMORY_TOOL_SCHEMAS,
  PiPersonalMemoryToolSecurity,
  createPiPersonalMemoryToolDefinitions,
  normalizePiPersonalMemoryToolArguments,
  type MemoryWriteToolArguments,
  type PersonalMemoryWriteAuthorizationPort
} from "../harness/pi-native/pi-personal-memory-tools";
import type { PersonalMemoryRuntimeContext } from "../harness/memory/personal-memory-contracts";
import { PersonalMemoryAccessError } from "../harness/memory/personal-memory-repository";
import { withPersonalMemoryFixture, type PersonalMemoryFixture } from "./personal-memory-fixture";

export async function runPersonalMemoryToolContractScenarios(): Promise<void> {
  assertOpenAiCompatibleMemoryToolSchemas();
  await scenarioRuntimeIdentityIsNotModelControlled();
  await scenarioModeAndLearningGates();
  await scenarioTrustedEntryAndProvenanceAuthorization();
  await scenarioRevisionIsRequiredAndStaleWritesFail();
  await scenarioConcurrentWritersUseCas();
  await scenarioOversizedReadFailsExplicitly();
  console.log("PASS P3 Memory Tool contract scenarios (partial automated coverage)");
}

function assertOpenAiCompatibleMemoryToolSchemas(): void {
  const schemas = PI_PERSONAL_MEMORY_TOOL_SCHEMAS as unknown as Readonly<Record<
    (typeof PI_PERSONAL_MEMORY_TOOL_IDS)[number],
    Readonly<Record<string, unknown>>
  >>;
  for (const toolId of PI_PERSONAL_MEMORY_TOOL_IDS) {
    assert.equal(
      schemas[toolId].type,
      "object",
      `${toolId} function.parameters must have a top-level object schema`
    );
  }
  const writeProperties = schemas.memory_write.properties as Readonly<Record<
    string,
    Readonly<Record<string, unknown>>
  >>;
  const operationVariants = writeProperties.operation.anyOf as ReadonlyArray<
    Readonly<Record<string, unknown>>
  >;
  assert.deepEqual(operationVariants.map((variant) => variant.const), [
    "create",
    "supersede",
    "close",
    "profile_update",
    "forget"
  ]);
  assert.match(String(writeProperties.recallWhen.description ?? ""), /create.*supersede.*必填/iu);
  assert.match(String(schemas.memory_write.description ?? ""), /recallWhen.*必填/iu);
  assert.match(String(schemas.memory_search.description ?? ""), /exhausted=false.*nextCursor/iu);
}

async function scenarioOversizedReadFailsExplicitly(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const content = "\\\"".repeat(12_000);
    const created = await fixture.repository.write({
      operation: "create",
      kind: "episode",
      title: "超长 Memory Read",
      content,
      recallWhen: "需要读取超长含转义字符的正文时",
      basis: "explicit"
    } as never, fixture.runtime());
    const entry = { entryId: "user-entry-fixture", text: "读取超长 Memory" };
    const security = createSecurity(fixture, entry, fixture.runtime());
    const tools = createPiPersonalMemoryToolDefinitions({ repository: fixture.repository, security });
    const result = await executeThroughSecurity(
      security,
      tools,
      "memory_read",
      "oversized-memory-read",
      { id: created.record!.id }
    );
    assert.equal(result.isError, true);
    assert.equal(result.details.errorCode, "personal_memory_result_too_large");
    assert.doesNotMatch(result.content[0]?.text ?? "", /<echoink_memory_result/iu);
  });
}

async function scenarioRuntimeIdentityIsNotModelControlled(): Promise<void> {
  const schemas = JSON.stringify(PI_PERSONAL_MEMORY_TOOL_SCHEMAS);
  for (const forbidden of [
    "vaultId",
    "conversationId",
    "piSessionId",
    "productRunId",
    "userEntryId",
    "explicitlyAuthorized",
    "explicitForget"
  ]) {
    assert.equal(schemas.includes(forbidden), false, `${forbidden} must not be model-controlled`);
  }
  assert.throws(() => normalizePiPersonalMemoryToolArguments("memory_search", {
    query: "证据",
    vaultId: "forged-vault"
  }));
  assert.throws(() => normalizePiPersonalMemoryToolArguments("memory_write", {
    ...createArguments("请记住这条规则。"),
    explicitlyAuthorized: true
  }));
  assert.throws(() => normalizePiPersonalMemoryToolArguments("memory_write", {
    operation: "close",
    targetId: "mem_target",
    reason: "已完成"
  }));
  assert.throws(() => normalizePiPersonalMemoryToolArguments("memory_write", {
    operation: "supersede",
    targetId: "mem_target",
    title: "新观点",
    content: "新内容",
    basis: "explicit",
    contentOrigin: "user_statement",
    evidenceQuote: "我改变了想法。",
    reason: "用户改变观点"
  }));
  assert.throws(() => normalizePiPersonalMemoryToolArguments("memory_write", {
    operation: "profile_update",
    profile: "user",
    content: "# USER\n",
    basis: "explicit",
    contentOrigin: "user_statement",
    evidenceQuote: "请更新我的资料。"
  }));
  assert.throws(() => normalizePiPersonalMemoryToolArguments("memory_write", {
    operation: "forget",
    targetId: "mem_target",
    reason: "请忘记"
  }));
  assert.deepEqual(normalizePiPersonalMemoryToolArguments("memory_write", {
    operation: "close",
    targetId: "mem_target",
    reason: "任务已完成",
    expectedRevision: 3
  }), {
    operation: "close",
    targetId: "mem_target",
    reason: "任务已完成",
    expectedRevision: 3
  });
  assert.throws(() => normalizePiPersonalMemoryToolArguments("memory_write", {
    ...createArguments("请记住这条规则。"),
    targetId: "mem_cross_operation"
  }));
  assert.throws(() => normalizePiPersonalMemoryToolArguments("memory_write", {
    operation: "close",
    targetId: "mem_target",
    reason: "任务已完成",
    expectedRevision: 3,
    content: "close 不接受 create 字段"
  }));
}

async function scenarioModeAndLearningGates(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const entry = { entryId: "user-entry-fixture", text: "请记住这条规则。" };
    const noMemory = createSecurity(fixture, entry, fixture.runtime({ memoryMode: "no_memory" }));
    const calls = [
      { toolName: "memory_search", input: { query: "规则" } },
      { toolName: "memory_read", input: { id: "mem_target" } },
      { toolName: "memory_write", input: createArguments(entry.text) }
    ] as const;
    for (const [index, call] of calls.entries()) {
      const blocked = await noMemory.handleToolCall({
        ...call,
        toolCallId: `no-memory-${index}`
      } as never, undefined);
      assert.equal(blocked?.reason, "tool_policy_blocked");
    }

    const readOnly = createSecurity(
      fixture,
      entry,
      fixture.runtime({ learningEnabled: false })
    );
    assert.equal(await readOnly.handleToolCall({
      toolName: "memory_search",
      toolCallId: "learning-off-read",
      input: { query: "规则" }
    } as never, undefined), undefined);
    const blockedWrite = await readOnly.handleToolCall({
      toolName: "memory_write",
      toolCallId: "learning-off-write",
      input: createArguments(entry.text)
    } as never, undefined);
    assert.equal(blockedWrite?.reason, "tool_policy_blocked");
  });
}

async function scenarioTrustedEntryAndProvenanceAuthorization(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const entry = {
      entryId: "user-entry-fixture",
      text: "请把这段工具结果作为一条 episode 保存。"
    };
    const authorization: PersonalMemoryWriteAuthorizationPort = {
      async authorize(input) {
        assert.equal(input.currentUserEntry.entryId, entry.entryId);
        assert.equal(input.evidenceQuote, entry.text);
        return {
          basis: "explicit",
          contentOrigin: "tool_output",
          explicitlyAuthorized: true
        };
      }
    };
    const security = createSecurity(fixture, entry, fixture.runtime(), authorization);
    const tools = createPiPersonalMemoryToolDefinitions({ repository: fixture.repository, security });
    const args: MemoryWriteToolArguments = {
      operation: "create",
      kind: "episode",
      title: "已确认的 Tool 结果",
      content: "这段内容来自 Tool 输出，保持不可信来源标记。",
      recallWhen: "用户要求保留已确认的 Tool 结果时",
      basis: "inferred",
      contentOrigin: "knowledge",
      evidenceQuote: entry.text
    };
    const corrected = await executeThroughSecurity(security, tools, "memory_write", "write-untrusted", args);
    assert.equal(corrected.isError, false);
    assert.match(corrected.content[0]?.text ?? "", /untrusted-background/u);

    const reopened = await fixture.reopen();
    const found = await reopened.search({ query: "不可信 来源" }, fixture.runtime());
    assert.equal(found.items.length, 1);
    const read = await reopened.read(found.items[0]!.id, fixture.runtime());
    assert.equal(read.record.basis, "explicit");
    assert.equal(read.record.contentOrigin, "tool_output");

    const mismatched = createSecurity(fixture, {
      entryId: "different-entry",
      text: entry.text
    }, fixture.runtime());
    const blocked = await mismatched.handleToolCall({
      toolName: "memory_write",
      toolCallId: "entry-mismatch",
      input: createArguments(entry.text)
    } as never, undefined);
    assert.equal(blocked?.reason, "authorization_failed");

    const absentQuote = createSecurity(fixture, entry, fixture.runtime());
    const absentQuoteBlocked = await absentQuote.handleToolCall({
      toolName: "memory_write",
      toolCallId: "quote-mismatch",
      input: createArguments("这句话不在当前 Entry。")
    } as never, undefined);
    assert.equal(absentQuoteBlocked?.reason, "authorization_failed");

    const forgedRuntimeAuthorization = createSecurity(
      fixture,
      entry,
      fixture.runtime({ explicitlyAuthorized: true }),
      {
        async authorize() {
          return {
            basis: "explicit",
            contentOrigin: "tool_output",
            explicitlyAuthorized: false
          };
        }
      }
    );
    const forgedAuthorizationBlocked = await forgedRuntimeAuthorization.handleToolCall({
      toolName: "memory_write",
      toolCallId: "forged-runtime-authorization",
      input: {
        operation: "create",
        kind: "episode",
        title: "未经确认的 Tool 输出",
        content: "不能写入。",
        recallWhen: "未来处理同类 Tool 输出时",
        basis: "explicit",
        contentOrigin: "tool_output",
        evidenceQuote: entry.text
      }
    } as never, undefined);
    assert.equal(forgedAuthorizationBlocked?.reason, "tool_policy_blocked");
  });
}

async function scenarioRevisionIsRequiredAndStaleWritesFail(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const entry = { entryId: "user-entry-fixture", text: "请记住这条规则。" };
    const security = createSecurity(fixture, entry, fixture.runtime());
    const tools = createPiPersonalMemoryToolDefinitions({ repository: fixture.repository, security });
    const createdResult = await executeThroughSecurity(
      security,
      tools,
      "memory_write",
      "create-current",
      createArguments(entry.text)
    );
    const createdId = (createdResult.details.recordIds as readonly string[] | undefined)?.[0];
    assert.ok(createdId);
    assert.deepEqual(
      (await fixture.repository.readAuditByProductRun(
        fixture.runtime().productRunId
      )).map((event) => ({ type: event.type, toolCallId: event.toolCallId })),
      [{ type: "created", toolCallId: "create-current" }]
    );
    const failedRead = await executeFailureThroughSecurity(
      security,
      tools,
      "memory_read",
      "missing-read",
      { id: "mem_missing" }
    );
    assert.deepEqual(failedRead.details, {
      source: "echoink-personal-memory",
      schemaVersion: 1,
      toolId: "memory_read",
      toolCallId: "missing-read",
      status: "failed",
      failureStage: "execution",
      errorCode: "personal_memory_not_found"
    });
    assert.equal(
      JSON.stringify(failedRead.details).includes("does not exist"),
      false
    );
    const deniedForget = await security.handleToolCall({
      toolName: "memory_write",
      toolCallId: "forget-without-confirmation",
      input: {
        operation: "forget",
        targetId: createdId,
        reason: "模型不能自证忘记权限",
        expectedRevision: 1
      }
    } as never, undefined);
    assert.equal(deniedForget?.reason, "tool_policy_blocked");
    await assert.rejects(async () => {
      await executeThroughSecurity(security, tools, "memory_write", "stale-close", {
        operation: "close",
        targetId: createdId,
        reason: "测试陈旧 revision",
        expectedRevision: 0
      });
    }, /personal_memory_revision_conflict/u);
    assert.equal((await fixture.repository.read(createdId, fixture.runtime())).record.status, "current");
  });
}

async function scenarioConcurrentWritersUseCas(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const created = await fixture.repository.write({
      operation: "create",
      kind: "view",
      title: "并发观点",
      content: "初始观点。",
      basis: "explicit"
    }, fixture.runtime());
    const secondRepository = await fixture.reopen();
    const expectedRevision = created.revision;
    const writes = await Promise.allSettled([
      fixture.repository.write({
        operation: "supersede",
        targetId: created.record!.id,
        title: "并发观点 A",
        content: "写者 A 的新观点。",
        basis: "explicit",
        reason: "并发测试",
        expectedRevision
      }, fixture.runtime({ userEntryId: "writer-a" })),
      secondRepository.write({
        operation: "supersede",
        targetId: created.record!.id,
        title: "并发观点 B",
        content: "写者 B 的新观点。",
        basis: "explicit",
        reason: "并发测试",
        expectedRevision
      }, fixture.runtime({ userEntryId: "writer-b" }))
    ]);
    assert.equal(writes.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = writes.find((result): result is PromiseRejectedResult => result.status === "rejected");
    assert.ok(rejected?.reason instanceof PersonalMemoryAccessError);
    assert.equal(rejected.reason.code, "revision_conflict");
  });
}

function createSecurity(
  fixture: Readonly<PersonalMemoryFixture>,
  entry: Readonly<{ entryId: string; text: string }>,
  runtime: Readonly<PersonalMemoryRuntimeContext>,
  writeAuthorization: PersonalMemoryWriteAuthorizationPort = {
    async authorize(input) {
      return {
        basis: input.proposedBasis,
        contentOrigin: input.proposedContentOrigin,
        explicitlyAuthorized: false
      };
    }
  }
): PiPersonalMemoryToolSecurity {
  return new PiPersonalMemoryToolSecurity({
    currentRuntime: () => runtime,
    currentUserEntry: { current: () => entry },
    writeAuthorization,
    forgetConfirmation: { async confirm() { return false; } }
  });
}

function createArguments(evidenceQuote: string): MemoryWriteToolArguments {
  return {
    operation: "create",
    kind: "decision",
    title: "回答规则",
    content: "回答先给结论。",
    recallWhen: "准备回答工程问题时",
    basis: "explicit",
    contentOrigin: "user_statement",
    evidenceQuote
  };
}

async function executeThroughSecurity(
  security: PiPersonalMemoryToolSecurity,
  tools: ReturnType<typeof createPiPersonalMemoryToolDefinitions>,
  toolName: (typeof PI_PERSONAL_MEMORY_TOOL_IDS)[number],
  toolCallId: string,
  input: Record<string, unknown> | MemoryWriteToolArguments
) {
  const tool = tools.find((candidate) => candidate.name === toolName);
  assert.ok(tool);
  const blocked = await security.handleToolCall({ toolName, toolCallId, input } as never, undefined);
  assert.equal(blocked, undefined);
  let raw;
  try {
    raw = await tool.execute(
      toolCallId,
      input,
      new AbortController().signal,
      undefined,
      {} as never
    );
  } catch (error) {
    await security.handleToolResult({
      toolName,
      toolCallId,
      content: [],
      details: {},
      isError: true
    } as never);
    throw error;
  }
  return await security.handleToolResult({
    toolName,
    toolCallId,
    content: raw.content,
    details: raw.details,
    isError: false
  } as never);
}

async function executeFailureThroughSecurity(
  security: PiPersonalMemoryToolSecurity,
  tools: ReturnType<typeof createPiPersonalMemoryToolDefinitions>,
  toolName: (typeof PI_PERSONAL_MEMORY_TOOL_IDS)[number],
  toolCallId: string,
  input: Record<string, unknown>
) {
  const tool = tools.find((candidate) => candidate.name === toolName);
  assert.ok(tool);
  assert.equal(
    await security.handleToolCall({ toolName, toolCallId, input } as never, undefined),
    undefined
  );
  await assert.rejects(() => tool.execute(
    toolCallId,
    input,
    new AbortController().signal,
    undefined,
    {} as never
  ));
  return await security.handleToolResult({
    toolName,
    toolCallId,
    content: [],
    details: {},
    isError: true
  } as never);
}
