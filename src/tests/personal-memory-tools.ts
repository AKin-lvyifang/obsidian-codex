import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  PI_PERSONAL_MEMORY_TOOL_IDS,
  PI_PERSONAL_MEMORY_TOOL_SCHEMAS,
  PiPersonalMemoryToolSecurity,
  createPiPersonalMemoryToolDefinitions,
  normalizePiPersonalMemoryToolArguments,
  type MemoryWriteToolArguments,
  type PersonalMemoryWriteAuthorizationPort
} from "../harness/pi-native/pi-personal-memory-tools";
import { PersonalMemoryRecallHarness } from "../harness/memory/personal-memory-recall-harness";
import type { PersonalMemoryRuntimeContext } from "../harness/memory/personal-memory-contracts";
import { PersonalMemoryAccessError } from "../harness/memory/personal-memory-repository";
import { USER_PROFILE_SLOTS } from "../harness/memory/user-profile-state";
import { withPersonalMemoryFixture, type PersonalMemoryFixture } from "./personal-memory-fixture";

export async function runPersonalMemoryToolContractScenarios(): Promise<void> {
  assertOpenAiCompatibleMemoryToolSchemas();
  await scenarioRuntimeIdentityIsNotModelControlled();
  await scenarioInvalidArgumentsAndMemoryModeErrors();
  await scenarioSearchBeforeAutonomousWriteAndEvidenceBinding();
  await scenarioHostRevisionUpdateForgetAndErrors();
  await scenarioProfileUpdateIsIdempotentAndReplacesSource();
  await scenarioConcurrentWritersUseCas();
  await scenarioExternalPrimaryTruthWinsWithoutWatchers();
  await scenarioRepositoryDisposeStopsExternalWatchers();
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
  assert.deepEqual(schemas.memory_write.required, ["request"]);
  const writeProperties = schemas.memory_write.properties as Readonly<Record<
    string,
    Readonly<Record<string, unknown>>
  >>;
  assert.deepEqual(Object.keys(writeProperties), ["request"]);
  const operationVariants = writeProperties.request.anyOf as ReadonlyArray<
    Readonly<Record<string, unknown>>
  >;
  const operationNames = operationVariants.map((variant) => {
    const properties = variant.properties as Readonly<Record<
      string,
      Readonly<Record<string, unknown>>
    >>;
    return properties.operation.const;
  });
  assert.deepEqual(operationNames, [
    "create",
    "update",
    "profile_update",
    "forget"
  ]);
  assert.deepEqual(operationVariants.map((variant) => variant.additionalProperties), [
    false, false, false, false
  ]);
  assert.deepEqual(operationVariants.map((variant) => variant.required), [
    ["operation", "title", "content", "recallWhen", "evidenceQuote"],
    ["operation", "targetId", "title", "content", "recallWhen", "reason", "evidenceQuote"],
    ["operation", "profileKey", "text", "evidenceQuote"],
    ["operation", "targetId", "reason", "evidenceQuote"]
  ]);
  const profileVariant = operationVariants[2]!;
  const profileProperties = profileVariant.properties as Readonly<Record<
    string,
    Readonly<Record<string, unknown>>
  >>;
  const profileKeyVariants = profileProperties.profileKey.anyOf as ReadonlyArray<
    Readonly<Record<string, unknown>>
  >;
  assert.deepEqual(
    profileKeyVariants.map((variant) => variant.const),
    USER_PROFILE_SLOTS.map((slot) => slot.profileKey),
    "profile_update.profileKey must expose the complete closed profile taxonomy"
  );
  for (const hiddenHostField of [
    "kind",
    "basis",
    "contentOrigin",
    "expectedRevision"
  ]) {
    assert.equal(
      JSON.stringify(writeProperties).includes(`\"${hiddenHostField}\"`),
      false,
      `${hiddenHostField} must be host-controlled rather than model-visible`
    );
  }
  const createProperties = operationVariants[0]!.properties as Readonly<Record<
    string,
    Readonly<Record<string, unknown>>
  >>;
  assert.match(String(createProperties.recallWhen.description ?? ""), /未来.*召回/iu);
  assert.match(String(schemas.memory_write.description ?? ""), /先.*memory_search.*同义.*跳过.*变化.*更新/iu);
  assert.match(String(schemas.memory_search.description ?? ""), /exhausted=false.*nextCursor/iu);
  assert.equal(profileProperties.text.maxLength, 120);

  assert.deepEqual(normalizePiPersonalMemoryToolArguments("memory_write", {
    request: {
      operation: "create",
      title: "沟通偏好",
      content: "用户希望先给结论。",
      recallWhen: "需要组织回答时",
      evidenceQuote: "请记住：以后先给结论。"
    }
  }), {
    request: {
      operation: "create",
      title: "沟通偏好",
      content: "用户希望先给结论。",
      recallWhen: "需要组织回答时",
      evidenceQuote: "请记住：以后先给结论。"
    }
  });
  const stringRequest = {
    operation: "create",
    title: "字符串兼容",
    content: "只兼容 request 中的普通对象 JSON 字符串。",
    recallWhen: "Provider 把 request 编码成字符串时",
    evidenceQuote: "请记住这个字符串兼容测试。"
  };
  assert.deepEqual(normalizePiPersonalMemoryToolArguments("memory_write", {
    request: JSON.stringify(stringRequest)
  }), { request: stringRequest });
  for (const invalidRequest of [
    "not-json",
    "null",
    "[]",
    JSON.stringify("nested-string"),
    JSON.stringify({ ...stringRequest, extra: true })
  ]) {
    assert.throws(() => normalizePiPersonalMemoryToolArguments(
      "memory_write",
      { request: invalidRequest }
    ));
  }
  assert.throws(() => normalizePiPersonalMemoryToolArguments(
    "memory_search",
    JSON.stringify({ query: "不得扩展到其他 Tool" })
  ));
  assert.deepEqual(normalizePiPersonalMemoryToolArguments("memory_write", {
    request: {
      operation: "forget",
      targetId: "mem_target",
      reason: "用户明确要求忘掉",
      evidenceQuote: "忘掉我以前偏好表格这件事。"
    }
  }), {
    request: {
      operation: "forget",
      targetId: "mem_target",
      reason: "用户明确要求忘掉",
      evidenceQuote: "忘掉我以前偏好表格这件事。"
    }
  });
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
    request: createArguments("请记住这条规则。").request,
    explicitlyAuthorized: true
  }));
  assert.throws(() => normalizePiPersonalMemoryToolArguments("memory_write", {
    request: {
      operation: "close",
      targetId: "mem_target",
      reason: "已完成"
    }
  }));
  assert.throws(() => normalizePiPersonalMemoryToolArguments("memory_write", {
    request: {
      operation: "update",
      targetId: "mem_target",
      title: "新观点",
      content: "新内容",
      evidenceQuote: "我改变了想法。",
      reason: "用户改变观点"
    }
  }));
  assert.throws(() => normalizePiPersonalMemoryToolArguments("memory_write", {
    request: {
      operation: "profile_update",
      profileKey: "preference.unknown",
      text: "用户偏好中文",
      evidenceQuote: "请更新我的资料。"
    }
  }));
  const boundedProfileText = "甲".repeat(120);
  assert.deepEqual(normalizePiPersonalMemoryToolArguments("memory_write", {
    request: {
      operation: "profile_update",
      targetId: "mem_existing_profile_fact",
      profileKey: "preference.language",
      text: boundedProfileText,
      evidenceQuote: "请更新我的资料。"
    }
  }), {
    request: {
      operation: "profile_update",
      targetId: "mem_existing_profile_fact",
      profileKey: "preference.language",
      text: boundedProfileText,
      evidenceQuote: "请更新我的资料。"
    }
  });
  assert.throws(() => normalizePiPersonalMemoryToolArguments("memory_write", {
    request: {
      operation: "profile_update",
      profileKey: "preference.language",
      text: "甲".repeat(121),
      evidenceQuote: "请更新我的资料。"
    }
  }));
  assert.throws(() => normalizePiPersonalMemoryToolArguments("memory_write", {
    request: {
      operation: "profile_update",
      profileKey: "preference.language",
      text: "用户偏好中文",
      content: "旧的 16000/24000 字段路径不得继续存在",
      evidenceQuote: "请更新我的资料。"
    }
  }));
  assert.throws(() => normalizePiPersonalMemoryToolArguments("memory_write", {
    request: {
      operation: "forget",
      targetId: "mem_target",
      reason: "请忘记"
    }
  }));
  assert.throws(() => normalizePiPersonalMemoryToolArguments("memory_write", {
    request: {
      ...createArguments("请记住这条规则。").request,
      targetId: "mem_cross_operation"
    }
  }));
  assert.throws(() => normalizePiPersonalMemoryToolArguments("memory_write", {
    request: {
      operation: "close",
      targetId: "mem_target",
      reason: "任务已完成",
      expectedRevision: 3,
      content: "close 不接受 create 字段"
    }
  }));
}

async function scenarioInvalidArgumentsAndMemoryModeErrors(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const entry = { entryId: "user-entry-fixture", text: "请记住这条规则。" };
    const noMemory = createSecurity(fixture, entry, fixture.runtime({ memoryMode: "no_memory" }));
    const tools = createPiPersonalMemoryToolDefinitions({ repository: fixture.repository, security: noMemory });
    const calls = [
      { toolName: "memory_search", input: { query: "规则" } },
      { toolName: "memory_read", input: { id: "mem_target" } },
      { toolName: "memory_write", input: createArguments(entry.text) }
    ] as const;
    for (const [index, call] of calls.entries()) {
      const failed = await executeFailureThroughSecurity(
        noMemory,
        tools,
        call.toolName,
        `no-memory-${index}`,
        call.input
      );
      assert.equal(failed.details.errorCode, "personal_memory_no_memory");
      assert.match(failed.content[0]?.text ?? "", /长期记忆总开关已关闭/u);
    }

    const normal = createSecurity(fixture, entry, fixture.runtime());
    const normalTools = createPiPersonalMemoryToolDefinitions({
      repository: fixture.repository,
      security: normal
    });
    const invalid = await executeFailureThroughSecurity(
      normal,
      normalTools,
      "memory_write",
      "invalid-write-arguments",
      { request: { operation: "create", title: "缺参数" } }
    );
    assert.equal(invalid.details.errorCode, "personal_memory_invalid_request");
    assert.match(invalid.content[0]?.text ?? "", /参数无效/u);
  });
}

async function scenarioSearchBeforeAutonomousWriteAndEvidenceBinding(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const entry = {
      entryId: "user-entry-fixture",
      text: "请记住：以后回答工程问题先给结论。"
    };
    const authorization: PersonalMemoryWriteAuthorizationPort = {
      async authorize(input) {
        assert.equal(input.currentUserEntry.entryId, entry.entryId);
        assert.equal(input.evidenceQuote, entry.text);
        assert.equal(input.operation, "create");
        return {
          basis: "explicit",
          contentOrigin: "user_statement",
          explicitlyAuthorized: false
        };
      }
    };
    const security = createSecurity(fixture, entry, fixture.runtime(), authorization);
    const tools = createPiPersonalMemoryToolDefinitions({ repository: fixture.repository, security });
    const args: MemoryWriteToolArguments = {
      request: {
        operation: "create",
        title: "回答规则",
        content: "回答工程问题先给结论。",
        recallWhen: "准备回答工程问题时",
        evidenceQuote: entry.text
      }
    };
    const beforeSearch = await executeFailureThroughSecurity(
      security,
      tools,
      "memory_write",
      "write-before-search",
      args
    );
    assert.equal(beforeSearch.details.errorCode, "personal_memory_invalid_request");
    assert.match(beforeSearch.content[0]?.text ?? "", /memory_search/u);

    for (const [index, title] of ["无关历史甲", "无关历史乙"].entries()) {
      await fixture.repository.write({
        operation: "create",
        kind: "fact",
        title,
        content: `第 ${index + 1} 条无关历史。`,
        recallWhen: "只用于验证搜索分页时",
        basis: "explicit"
      }, fixture.runtime({ userEntryId: `partial-search-fixture-${index}` }));
    }
    const partialSearch = await executeThroughSecurity(
      security,
      tools,
      "memory_search",
      "partial-search-before-create",
      { query: "", limit: 1 }
    );
    assert.match(partialSearch.content[0]?.text ?? "", /"exhausted":false/u);
    const afterPartialSearch = await executeFailureThroughSecurity(
      security,
      tools,
      "memory_write",
      "write-after-partial-search",
      args
    );
    assert.equal(afterPartialSearch.details.errorCode, "personal_memory_invalid_request");

    await executeThroughSecurity(
      security,
      tools,
      "memory_search",
      "search-before-create",
      { query: "回答规则" }
    );
    const corrected = await executeThroughSecurity(
      security,
      tools,
      "memory_write",
      "create-after-search",
      args
    );
    assert.equal(corrected.isError, false);
    assert.match(corrected.content[0]?.text ?? "", /untrusted-background/u);

    const reopened = await fixture.reopen();
    const found = await reopened.search({ query: "回答 工程 结论" }, fixture.runtime());
    assert.equal(found.items.length, 1);
    const read = await reopened.read(found.items[0]!.id, fixture.runtime());
    assert.equal(read.record.kind, "fact");
    assert.equal(read.record.basis, "explicit");
    assert.equal(read.record.contentOrigin, "user_statement");
    assert.match(
      read.record.file,
      /(?:^|\/)facts\//u,
      "host-managed fact classification uses the existing facts catalog"
    );
    const runtime = fixture.runtime();
    const recalled = await new PersonalMemoryRecallHarness(reopened).prepareTurnContext({
      memoryMode: "normal",
      query: "准备回答工程问题",
      tokenBudget: 320,
      vaultId: runtime.vaultId,
      conversationId: runtime.conversationId,
      piSessionId: runtime.piSessionId,
      productRunId: runtime.productRunId
    });
    assert.equal(
      recalled.recall?.candidates.some((candidate) => candidate.id === read.record.id),
      true,
      "host-managed fact creates remain reachable through the existing recall harness"
    );

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

    const deniedByPolicy = createSecurity(fixture, entry, fixture.runtime(), {
      async authorize() { return null; }
    });
    const deniedTools = createPiPersonalMemoryToolDefinitions({
      repository: fixture.repository,
      security: deniedByPolicy
    });
    await executeThroughSecurity(
      deniedByPolicy,
      deniedTools,
      "memory_search",
      "search-before-policy-denial",
      { query: "回答规则" }
    );
    const policyBlocked = await deniedByPolicy.handleToolCall({
      toolName: "memory_write",
      toolCallId: "real-policy-denial",
      input: args
    } as never, undefined);
    assert.equal(policyBlocked?.reason, "tool_policy_blocked");
  });
}

async function scenarioHostRevisionUpdateForgetAndErrors(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const entry = {
      entryId: "user-entry-fixture",
      text: "请记住这条规则。我现在改成先给结论再给依据。忘掉这条回答规则。"
    };
    const security = createSecurity(fixture, entry, fixture.runtime());
    const tools = createPiPersonalMemoryToolDefinitions({ repository: fixture.repository, security });
    await executeThroughSecurity(
      security,
      tools,
      "memory_search",
      "search-before-current-create",
      { query: "回答规则" }
    );
    const createdResult = await executeThroughSecurity(
      security,
      tools,
      "memory_write",
      "create-current",
      createArguments("请记住这条规则。")
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
    await executeThroughSecurity(
      security,
      tools,
      "memory_search",
      "search-before-update",
      { query: "回答规则" }
    );
    const updatedResult = await executeThroughSecurity(
      security,
      tools,
      "memory_write",
      "update-current",
      memoryWriteArguments({
        operation: "update",
        targetId: createdId,
        title: "回答规则",
        content: "回答时先给结论，再给依据。",
        recallWhen: "准备回答工程问题时",
        reason: "用户改变了回答偏好",
        evidenceQuote: "我现在改成先给结论再给依据。"
      })
    );
    const updatedId = (updatedResult.details.recordIds as readonly string[] | undefined)?.[0];
    assert.ok(updatedId);
    const updated = await fixture.repository.read(updatedId, fixture.runtime());
    assert.equal(updated.record.kind, "fact", "update preserves the host-managed kind");
    assert.equal(updated.record.supersedes, createdId);

    await executeThroughSecurity(
      security,
      tools,
      "memory_search",
      "search-before-stale-update",
      { query: "回答规则" }
    );
    await fixture.repository.write({
      operation: "create",
      kind: "fact",
      title: "并发变化",
      content: "这条写入只用于推进 manifest revision。",
      recallWhen: "测试并发 revision 时",
      basis: "explicit"
    }, fixture.runtime({ userEntryId: "concurrent-writer" }));
    const stale = await executeFailureThroughSecurity(
      security,
      tools,
      "memory_write",
      "stale-host-revision",
      memoryWriteArguments({
        operation: "update",
        targetId: updatedId,
        title: "回答规则",
        content: "不应落盘的陈旧更新。",
        recallWhen: "不应生效",
        reason: "测试陈旧 revision",
        evidenceQuote: "我现在改成先给结论再给依据。"
      })
    );
    assert.equal(stale.details.errorCode, "personal_memory_revision_conflict");
    assert.match(stale.content[0]?.text ?? "", /重新 memory_search/u);

    await executeThroughSecurity(
      security,
      tools,
      "memory_search",
      "search-before-forget",
      { query: "回答规则" }
    );
    const forgotten = await executeThroughSecurity(
      security,
      tools,
      "memory_write",
      "forget-directly-from-conversation",
      memoryWriteArguments({
        operation: "forget",
        targetId: updatedId,
        reason: "用户明确要求忘掉",
        evidenceQuote: "忘掉这条回答规则。"
      })
    );
    assert.equal(forgotten.isError, false);
    assert.deepEqual(forgotten.details.recordIds, [updatedId]);

    await executeThroughSecurity(
      security,
      tools,
      "memory_search",
      "search-before-missing-forget",
      { query: "回答规则" }
    );
    const missingForget = await executeFailureThroughSecurity(
      security,
      tools,
      "memory_write",
      "forget-missing-target",
      memoryWriteArguments({
        operation: "forget",
        targetId: updatedId,
        reason: "再次忘掉不存在的目标",
        evidenceQuote: "忘掉这条回答规则。"
      })
    );
    assert.equal(missingForget.details.errorCode, "personal_memory_not_found");
    assert.match(missingForget.content[0]?.text ?? "", /不存在/u);
  });
}

async function scenarioProfileUpdateIsIdempotentAndReplacesSource(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const entry = {
      entryId: "user-entry-fixture",
      text: "请记住我偏好中文。现在更新为我偏好英文。"
    };
    const security = createSecurity(fixture, entry, fixture.runtime());
    const tools = createPiPersonalMemoryToolDefinitions({ repository: fixture.repository, security });
    const writeProfile = async (
      toolCallId: string,
      text: string,
      evidenceQuote: string
    ) => {
      await executeThroughSecurity(
        security,
        tools,
        "memory_search",
        `search-${toolCallId}`,
        { query: "用户画像 语言偏好" }
      );
      return await executeThroughSecurity(
        security,
        tools,
        "memory_write",
        toolCallId,
        memoryWriteArguments({
          operation: "profile_update",
          profileKey: "preference.language",
          text,
          evidenceQuote
        })
      );
    };

    const created = await writeProfile(
      "profile-create",
      "用户偏好中文",
      "请记住我偏好中文。"
    );
    const createdId = (created.details.recordIds as readonly string[])[0]!;
    const duplicate = await writeProfile(
      "profile-idempotent",
      "用户偏好中文",
      "请记住我偏好中文。"
    );
    assert.match(duplicate.content[0]?.text ?? "", /"status":"idempotent"/u);
    assert.deepEqual(duplicate.details.recordIds, [createdId]);

    const replaced = await writeProfile(
      "profile-replace",
      "用户偏好英文",
      "现在更新为我偏好英文。"
    );
    const replacementId = (replaced.details.recordIds as readonly string[])[0]!;
    assert.notEqual(replacementId, createdId);
    const state = await fixture.repository.readUserControlState();
    const profileRecords = state.records.filter((record) =>
      record.title === "用户画像：语言"
    );
    assert.equal(profileRecords.filter((record) => record.status === "current").length, 1);
    assert.equal(profileRecords.find((record) => record.id === createdId)?.status, "superseded");
    assert.equal(profileRecords.find((record) => record.id === replacementId)?.status, "current");
    const user = await readFile(fixture.repository.layout.user, "utf8");
    assert.match(user, /用户偏好英文/u);
    assert.doesNotMatch(user, /用户偏好中文/u);
  });

  await withPersonalMemoryFixture(async (fixture) => {
    const generic = await fixture.repository.write({
      operation: "create",
      kind: "fact",
      title: "用户称呼",
      content: "用户希望称为方哥",
      recallWhen: "称呼用户时",
      basis: "explicit",
      contentOrigin: "user_statement"
    }, fixture.runtime());
    const promoted = await fixture.repository.write({
      operation: "profile_update",
      profileKey: "identity.name",
      text: "用户希望称为方哥",
      basis: "explicit",
      contentOrigin: "user_statement",
      expectedRevision: generic.revision
    }, fixture.runtime());
    assert.equal(promoted.record?.id, generic.record?.id,
      "an exact generic fact is promoted as the profile source instead of duplicated");
    const afterPromotion = await fixture.repository.inspect();
    assert.equal(afterPromotion.records.filter((record) => record.status === "current").length, 1);
    assert.match(await readFile(fixture.repository.layout.user, "utf8"), /用户希望称为方哥/u);
  });

  await withPersonalMemoryFixture(async (fixture) => {
    const wrong = await fixture.repository.write({
      operation: "create",
      kind: "fact",
      title: "用户称呼",
      content: "用户希望称为老王",
      recallWhen: "称呼用户时",
      basis: "explicit",
      contentOrigin: "user_statement"
    }, fixture.runtime());
    const corrected = await fixture.repository.write({
      operation: "profile_update",
      targetId: wrong.record!.id,
      profileKey: "identity.name",
      text: "用户希望称为方哥",
      basis: "explicit",
      contentOrigin: "confirmed_change",
      expectedRevision: wrong.revision
    }, fixture.runtime());
    assert.notEqual(corrected.record?.id, wrong.record?.id);
    const afterCorrection = await fixture.repository.readUserControlState();
    assert.equal(
      afterCorrection.records.find((record) => record.id === wrong.record!.id)?.status,
      "superseded",
      "the searched generic wrong fact must leave current when profile_update corrects it"
    );
    assert.equal(
      afterCorrection.records.filter((record) => record.status === "current").length,
      1,
      "profile correction leaves one current primary Memory for the user fact"
    );
    const user = await readFile(fixture.repository.layout.user, "utf8");
    assert.match(user, /用户希望称为方哥/u);
    assert.doesNotMatch(user, /用户希望称为老王/u);
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

async function scenarioExternalPrimaryTruthWinsWithoutWatchers(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const created = await fixture.repository.write({
      operation: "create",
      kind: "view",
      title: "外部编辑后再替换",
      content: "缓存中的旧正文。",
      recallWhen: "验证外部编辑优先级时",
      basis: "explicit"
    }, fixture.runtime());
    const file = path.join(fixture.repository.layout.root, created.record!.file);
    await writeRecordBody(file, "磁盘上的新正文，不能被旧缓存覆盖。");

    await assert.rejects(fixture.repository.write({
      operation: "supersede",
      targetId: created.record!.id,
      title: "不应成功的替换",
      content: "不应覆盖磁盘正文。",
      recallWhen: "不应生效",
      basis: "explicit",
      reason: "陈旧 revision",
      expectedRevision: created.revision
    }, fixture.runtime()), isRevisionConflict);

    const reconciled = await fixture.repository.read(created.record!.id, fixture.runtime());
    assert.equal(reconciled.revision, created.revision + 1);
    assert.equal(reconciled.record.content, "磁盘上的新正文，不能被旧缓存覆盖。");
    assert.match(reconciled.record.source, /^user-edit:\/\/personal-memory\//u);
  }, { watchExternalChanges: false });

  await withPersonalMemoryFixture(async (fixture) => {
    const created = await fixture.repository.write({
      operation: "create",
      kind: "task",
      title: "外部删除后再关闭",
      content: "这条记录会从磁盘删除。",
      recallWhen: "验证外部删除优先级时",
      basis: "explicit"
    }, fixture.runtime());
    const file = path.join(fixture.repository.layout.root, created.record!.file);
    await rm(file);

    await assert.rejects(fixture.repository.write({
      operation: "close",
      targetId: created.record!.id,
      reason: "陈旧缓存不得复活删除记录",
      expectedRevision: created.revision
    }, fixture.runtime()), isRevisionConflict);

    const reconciled = await fixture.repository.inspect();
    assert.equal(reconciled.revision, created.revision + 1);
    assert.equal(reconciled.records.some((record) => record.id === created.record!.id), false);
  }, { watchExternalChanges: false });

  await withPersonalMemoryFixture(async (fixture) => {
    const created = await fixture.repository.write({
      operation: "create",
      kind: "fact",
      title: "外部编辑后忘记",
      content: "缓存中的旧事实。",
      recallWhen: "验证忘记备份时",
      basis: "explicit"
    }, fixture.runtime());
    const file = path.join(fixture.repository.layout.root, created.record!.file);
    await writeRecordBody(file, "外部修正后的事实必须进入忘记备份。");

    await assert.rejects(
      fixture.repository.forgetFromUserControl(
        created.record!.id,
        "先用陈旧 revision 尝试",
        created.revision
      ),
      isRevisionConflict
    );
    const reconciled = await fixture.repository.inspect();
    const forgotten = await fixture.repository.forgetFromUserControl(
      created.record!.id,
      "确认忘记外部修正后的事实",
      reconciled.revision
    );
    const afterForget = await fixture.repository.inspect();
    const tombstone = afterForget.tombstones.find((item) => item.recordId === forgotten.forgottenId);
    assert.ok(tombstone);
    assert.match(
      await readFile(path.join(fixture.repository.layout.root, tombstone.backupFile), "utf8"),
      /外部修正后的事实必须进入忘记备份/u
    );
  }, { watchExternalChanges: false });

  await withPersonalMemoryFixture(async (fixture) => {
    const created = await fixture.repository.write({
      operation: "create",
      kind: "decision",
      title: "外部编辑后界面修正",
      content: "缓存中的旧决定。",
      recallWhen: "验证界面修正冲突时",
      basis: "explicit"
    }, fixture.runtime());
    const file = path.join(fixture.repository.layout.root, created.record!.file);
    await writeRecordBody(file, "外部修正后的决定必须保留。");

    await assert.rejects(fixture.repository.supersedeFromUserCorrection({
      targetId: created.record!.id,
      title: "界面生成的新决定",
      content: "不应覆盖外部正文。",
      recallWhen: "不应生效",
      reason: "陈旧界面预览",
      expectedRevision: created.revision
    }), isRevisionConflict);

    const reconciled = await fixture.repository.read(created.record!.id, fixture.runtime());
    assert.equal(reconciled.record.content, "外部修正后的决定必须保留。");
  }, { watchExternalChanges: false });

  await withPersonalMemoryFixture(async (fixture) => {
    const edited = await fixture.repository.write({
      operation: "create",
      kind: "episode",
      title: "导出中的外部编辑",
      content: "导出前的旧正文。",
      recallWhen: "验证导出磁盘真源时",
      basis: "explicit"
    }, fixture.runtime());
    const deleted = await fixture.repository.write({
      operation: "create",
      kind: "fact",
      title: "导出前已从磁盘删除",
      content: "这条记录不应进入导出。",
      recallWhen: "验证导出排除删除时",
      basis: "explicit"
    }, fixture.runtime());
    await writeRecordBody(
      path.join(fixture.repository.layout.root, edited.record!.file),
      "导出必须包含这段磁盘新正文。"
    );
    await rm(path.join(fixture.repository.layout.root, deleted.record!.file));

    const exported = await fixture.repository.exportMemory();
    const exportText = await readFile(exported.path, "utf8");
    assert.match(exportText, /导出必须包含这段磁盘新正文/u);
    assert.doesNotMatch(exportText, /导出前已从磁盘删除/u);
    const reconciled = await fixture.repository.inspect();
    assert.equal(reconciled.records.some((record) => record.id === deleted.record!.id), false);
  }, { watchExternalChanges: false });

  console.log("PASS P1 primary mutations and export reconcile disk truth without watchers");
}

async function scenarioRepositoryDisposeStopsExternalWatchers(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const created = await fixture.repository.write({
      operation: "create",
      kind: "fact",
      title: "dispose watcher 验证",
      content: "关闭前正文。",
      recallWhen: "验证插件卸载后监听生命周期时",
      basis: "explicit"
    }, fixture.runtime());
    let repository = fixture.repository;
    for (let index = 0; index < 3; index += 1) {
      await repository.dispose();
      const before = await Promise.all([
        readFile(repository.layout.manifest, "utf8"),
        readFile(repository.layout.audit, "utf8"),
        readFile(repository.layout.searchIndex, "utf8")
      ]);
      await writeFile(repository.layout.agent, `# 卸载后的 AGENT 外部编辑 ${index}\n`, "utf8");
      await writeFile(repository.layout.user, `# 卸载后的 USER 外部编辑 ${index}\n`, "utf8");
      await writeRecordBody(
        path.join(repository.layout.root, created.record!.file),
        `卸载后的一级 Memory 外部编辑 ${index}。`
      );
      await Promise.all([
        repository.handleExternalChange({
          event: "change",
          relativePath: "agents/echoink/AGENT.md"
        }),
        repository.handleExternalChange({
          event: "change",
          relativePath: "shared-user/USER.md"
        }),
        repository.handleExternalChange({
          event: "change",
          relativePath: created.record!.file
        })
      ]);
      await new Promise((resolve) => setTimeout(resolve, 80));
      const after = await Promise.all([
        readFile(repository.layout.manifest, "utf8"),
        readFile(repository.layout.audit, "utf8"),
        readFile(repository.layout.searchIndex, "utf8")
      ]);
      assert.deepEqual(after, before,
        "disposed and previously reloaded repositories cannot mutate derived state");
      if (index < 2) repository = await fixture.reopen();
    }

    await assert.rejects(
      fixture.repository.exportMemory(),
      /Repository is disposed/u
    );
  });
  console.log("PASS P1 repository dispose stops watcher mutations across repeated reloads");
}

async function writeRecordBody(file: string, content: string): Promise<void> {
  const current = await readFile(file, "utf8");
  const closingFrontmatter = current.indexOf("\n---\n", 4);
  assert.ok(closingFrontmatter > 0, "fixture record must contain closing frontmatter");
  await writeFile(file, `${current.slice(0, closingFrontmatter + 5)}\n${content.trim()}\n`, "utf8");
}

function isRevisionConflict(error: unknown): boolean {
  return error instanceof PersonalMemoryAccessError && error.code === "revision_conflict";
}

function createSecurity(
  fixture: Readonly<PersonalMemoryFixture>,
  entry: Readonly<{ entryId: string; text: string }>,
  runtime: Readonly<PersonalMemoryRuntimeContext>,
  writeAuthorization: PersonalMemoryWriteAuthorizationPort = {
    async authorize(input) {
      return {
        basis: "explicit",
        contentOrigin: input.operation === "create"
          ? "user_statement"
          : "confirmed_change",
        explicitlyAuthorized: input.operation === "forget"
      };
    }
  }
): PiPersonalMemoryToolSecurity {
  return new PiPersonalMemoryToolSecurity({
    currentRuntime: () => runtime,
    currentUserEntry: { current: () => entry },
    writeAuthorization
  });
}

function createArguments(evidenceQuote: string): MemoryWriteToolArguments {
  return memoryWriteArguments({
    operation: "create",
    title: "回答规则",
    content: "回答先给结论。",
    recallWhen: "准备回答工程问题时",
    evidenceQuote
  });
}

function memoryWriteArguments(
  request: MemoryWriteToolArguments["request"]
): MemoryWriteToolArguments {
  return Object.freeze({ request: Object.freeze({ ...request }) });
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
