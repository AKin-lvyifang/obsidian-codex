import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { BUILTIN_SKILLS } from "../harness/resources/builtin-skills";
import { initializeVaultResourceStore } from "../harness/resources/vault-store";
import {
  AUTO_SKILL_LIFECYCLE_THRESHOLDS_MS,
  SkillRuntimeCoordinator
} from "../harness/resources/skill-runtime";
import { loadVaultSkill } from "../harness/resources/skill-loader";

export async function runSkillRuntimeScenarios(): Promise<void> {
  await withVault(async (vaultPath) => {
    const initialized = await initializeVaultResourceStore({ vaultPath });
    assert.equal(
      initialized.created.filter((file) => file.endsWith("/SKILL.md")).length,
      BUILTIN_SKILLS.length
    );
    await initializeVaultResourceStore({ vaultPath });
    for (const definition of BUILTIN_SKILLS) {
      const loaded = await loadVaultSkill({
        vaultPath,
        skillId: definition.id,
        maxBytes: 200_000
      });
      assert.equal(loaded.frontmatter.id, definition.id);
      assert.equal(loaded.frontmatter.permissions.length, 0);
      assert.match(loaded.instruction, new RegExp(definition.title, "u"));
      assert.match(loaded.instruction, /## 用途与触发/u);
      assert.match(loaded.instruction, /## 边界/u);
    }

    let now = 10_000;
    let candidate = {
      eligible: true,
      candidate: {
        name: "Release evidence checklist",
        description: "复用已跑通的发布前证据核对流程。",
        triggerPhrases: ["发布前证据", "release evidence"],
        steps: ["列出本次交付声明。", "逐项绑定已有验证结果。"],
        output: "输出声明、证据和未验证项。",
        boundaries: ["不发布、不推送，也不新增权限。"],
        existingCapabilities: ["knowledge_read"]
      }
    };
    const reviewPrompts: string[] = [];
    const coordinator = new SkillRuntimeCoordinator(vaultPath, {
      now: () => now,
      reviewLlm: () => ({ call: async (input) => {
        reviewPrompts.push(input.userPrompt);
        return JSON.stringify(candidate);
      } })
    });
    const initial = await coordinator.initialize();
    assert.equal(Object.keys(initial.records).length, 7);
    assert.equal(Object.values(initial.records).every((record) =>
      record.origin === "builtin" && record.status === "active"
    ), true);

    assert.equal(await coordinator.selectForTask({
      text: "把 hello 翻译成中文",
      preferredSkillIds: ["evidence-freshness-audit"]
    }), null, "personality preference cannot trigger a Skill for a simple task");

    const preferred = await coordinator.selectForTask({
      text: "请用小白能懂的方式，从第一性原理和多视角拆解这个复杂矛盾",
      preferredSkillIds: ["multi-lens-problem-solving", "two-layer-explanation"]
    });
    assert.equal(preferred?.id, "multi-lens-problem-solving");
    assert.deepEqual(preferred?.applicableSkillIds.slice(0, 2), [
      "multi-lens-problem-solving",
      "two-layer-explanation"
    ]);
    assert.equal(preferred?.applicableSkillIds.includes("deep-understanding"), true,
      "all matching Skills remain visible as routing evidence");
    assert.deepEqual(preferred?.skills.map((skill) => skill.id), [
      "multi-lens-problem-solving",
      "two-layer-explanation"
    ], "analysis and explanation combine, while overlapping analysis keeps only the more specific route");

    const requiredAndMethod = await coordinator.selectForTask({
      text: "请用第一性原理核验当前 AI 产品价格是否真实",
      preferredSkillIds: ["multi-lens-problem-solving"]
    });
    assert.deepEqual(requiredAndMethod?.skills.map((skill) => skill.id), [
      "evidence-freshness-audit",
      "multi-lens-problem-solving"
    ], "freshness is mandatory while only one complementary method is loaded");

    const freshness = await coordinator.selectForTask({
      text: "请核验当前 AI 产品价格是否真实，并给出最新来源",
      preferredSkillIds: ["multi-lens-problem-solving"]
    });
    assert.equal(freshness?.id, "evidence-freshness-audit",
      "freshness verification is a shared product requirement, not a personality option");
    assert.equal(freshness?.requiresFreshnessVerification, true);

    const selfExplorationAndAnalysis = await coordinator.selectForTask({
      text: "请用第一性原理分析我过去的真实经历，探索我的职业方向和长期优势",
      preferredSkillIds: ["multi-lens-problem-solving"]
    });
    assert.equal(
      selfExplorationAndAnalysis?.skills.some(
        (skill) => skill.id === "self-discovery-life-design"
      ),
      true,
      "self exploration remains an independent responsibility from analysis"
    );
    assert.equal(
      selfExplorationAndAnalysis?.skills.some(
        (skill) => skill.id === "multi-lens-problem-solving"
      ),
      true,
      "an explicitly requested analysis method can combine with self exploration"
    );

    const created = await coordinator.reviewCompletedTask({
      productRunId: "run-skill-review",
      request: "完成发布前证据核对",
      result: "所有声明均已由现有验证结果证明",
      terminalState: "completed",
      existingCapabilityIds: ["knowledge_read"]
    });
    assert.equal(created.outcome, "created");
    if (created.outcome !== "created") return;
    assert.equal(created.record.origin, "auto");
    assert.equal(created.record.userModified, false);
    assert.equal(created.record.status, "active");
    assert.equal(created.record.usageCount, 1);
    assert.equal(await readFile(created.skillPath, "utf8").then(Boolean), true);
    assert.match(reviewPrompts[0] ?? "", /existingSkills/u);
    assert.match(reviewPrompts[0] ?? "", /evidence-freshness-audit/u,
      "post-task review receives semantic summaries of existing Skills");

    candidate = {
      eligible: true,
      candidate: {
        name: "Release evidence review",
        description: "发布交付前逐项复核声明与已有验证证据。",
        triggerPhrases: ["发布前证据核对", "release evidence check"],
        steps: ["列出本次交付结论。", "逐个绑定已经完成的验证结果。"],
        output: "输出交付声明、对应证据与未核验部分。",
        boundaries: ["不执行发布、推送或扩权。"],
        existingCapabilities: ["knowledge_read"]
      }
    };
    const duplicate = await coordinator.reviewCompletedTask({
      productRunId: "run-skill-review-2",
      request: "再次完成同一流程",
      result: "同一流程再次通过",
      terminalState: "completed",
      existingCapabilityIds: ["knowledge_read"]
    });
    assert.equal(duplicate.outcome, "duplicate");

    candidate = {
      eligible: true,
      candidate: {
        name: "Decision handoff note",
        description: "把已完成任务的判断整理成可复用的交接说明。",
        triggerPhrases: ["决策交接说明"],
        steps: ["提炼已经确认的决定。", "列出执行边界和下一步。"],
        output: "输出决定、边界和下一步。",
        boundaries: ["只整理本轮已经确认的公开信息。"],
        existingCapabilities: []
      }
    };
    const methodOnly = await coordinator.reviewCompletedTask({
      productRunId: "run-method-only-review",
      request: "整理这次讨论形成的决策交接说明",
      result: "已形成决定、边界和下一步",
      terminalState: "completed",
      existingCapabilityIds: []
    });
    assert.equal(methodOnly.outcome, "created",
      "a successful reusable method can become a Skill without Tool or preselected Skill capabilities");
    if (methodOnly.outcome === "created") {
      assert.match(await readFile(methodOnly.skillPath, "utf8"), /无需 Tool/u);
    }

    now += AUTO_SKILL_LIFECYCLE_THRESHOLDS_MS.activeToDownranked + 1;
    assert.equal((await coordinator.advanceLifecycle()).records[created.record.id]?.status, "downranked");
    now = 10_000 + AUTO_SKILL_LIFECYCLE_THRESHOLDS_MS.downrankedToDisabled + 1;
    assert.equal((await coordinator.advanceLifecycle()).records[created.record.id]?.status, "disabled");
    now = 10_000 + AUTO_SKILL_LIFECYCLE_THRESHOLDS_MS.disabledToArchived + 1;
    const archived = await coordinator.advanceLifecycle();
    assert.equal(archived.records[created.record.id]?.status, "archived");
    await assert.rejects(readFile(created.skillPath, "utf8"));
    const archivedSkillPath = path.join(
      vaultPath,
      ".echoink/resources/skills-archive",
      created.record.id,
      "SKILL.md"
    );
    assert.equal(await readFile(archivedSkillPath, "utf8").then(Boolean), true,
      "archiving moves the auto Skill into the recoverable archive area");
    const archivedAt = archived.records[created.record.id]!.statusChangedAt;
    now = archivedAt + AUTO_SKILL_LIFECYCLE_THRESHOLDS_MS.archivedToCleaned - 1;
    assert.equal((await coordinator.advanceLifecycle()).records[created.record.id]?.status, "archived",
      "physical cleanup is forbidden before a full 180 days in archived state");
    now += 2;
    assert.equal((await coordinator.advanceLifecycle()).records[created.record.id]?.status, "cleaned");
    await assert.rejects(readFile(archivedSkillPath, "utf8"));

    candidate = {
      eligible: true,
      candidate: {
        name: "Knowledge source ledger",
        description: "把本轮读取过的知识来源整理成可复用的来源核对清单。",
        triggerPhrases: ["来源核对清单"],
        steps: ["收集已成功读取的来源。", "按结论关联来源与日期。"],
        output: "输出来源、日期和对应结论。",
        boundaries: ["只使用本轮已成功读取的来源。"],
        existingCapabilities: ["knowledge_read"]
      }
    };
    const userTouched = await coordinator.reviewCompletedTask({
      productRunId: "run-user-touched-skill",
      request: "整理本轮已读取来源",
      result: "来源已读取并完成对应",
      terminalState: "completed",
      existingCapabilityIds: ["knowledge_read"]
    });
    assert.equal(userTouched.outcome, "created");
    if (userTouched.outcome !== "created") return;
    const userTouchedCreatedAt = now;
    now = userTouchedCreatedAt
      + AUTO_SKILL_LIFECYCLE_THRESHOLDS_MS.activeToDownranked + 1;
    await coordinator.advanceLifecycle();
    now = userTouchedCreatedAt
      + AUTO_SKILL_LIFECYCLE_THRESHOLDS_MS.downrankedToDisabled + 1;
    assert.equal(
      (await coordinator.advanceLifecycle()).records[userTouched.record.id]?.status,
      "disabled"
    );
    const beforeUserEdit = (await coordinator.read()).records[userTouched.record.id]!;
    await writeFile(
      userTouched.skillPath,
      `${await readFile(userTouched.skillPath, "utf8")}\n<!-- user edit after disable -->\n`,
      "utf8"
    );
    now += 1;
    const restarted = new SkillRuntimeCoordinator(vaultPath, { now: () => now });
    const restartedState = await restarted.initialize();
    const restartedRecord = restartedState.records[userTouched.record.id]!;
    assert.equal(restartedRecord.userModified, true);
    assert.equal(restartedRecord.status, "active",
      "a user edit observed during restart reactivates a disabled auto Skill");
    assert.equal(restartedRecord.statusChangedAt, now);
    assert.notEqual(restartedRecord.contentHash, beforeUserEdit.contentHash,
      "restart records the user's current content hash");
    assert.equal(restartedRecord.createdAt, beforeUserEdit.createdAt);
    assert.equal(restartedRecord.usageCount, beforeUserEdit.usageCount);
    assert.equal(restartedRecord.lastUsedAt, beforeUserEdit.lastUsedAt);
    const restartedRoute = await restarted.selectForTask({
      text: "请按来源核对清单整理这次已经读取的资料"
    });
    assert.equal(
      restartedRoute?.applicableSkillIds.includes(userTouched.record.id),
      true,
      "the reactivated user-modified Skill is routable after restart"
    );
    await coordinator.recordUse(userTouched.record.id, now + 1);
    const manuallyUsed = await coordinator.read();
    assert.equal(manuallyUsed.records[userTouched.record.id]?.status, "active");
    assert.equal(manuallyUsed.records[userTouched.record.id]?.usageCount, 2,
      "manual use reactivates and records an auto Skill");
    now += AUTO_SKILL_LIFECYCLE_THRESHOLDS_MS.disabledToArchived + 1;
    const userModifiedAuto = await coordinator.advanceLifecycle();
    assert.equal(userModifiedAuto.records[userTouched.record.id]?.userModified, true);
    assert.equal(userModifiedAuto.records[userTouched.record.id]?.status, "active",
      "a user edit observed before transition permanently exits auto cleanup");

    const builtinPath = path.join(
      vaultPath,
      ".echoink/resources/skills/evidence-freshness-audit/SKILL.md"
    );
    await writeFile(builtinPath, `${await readFile(builtinPath, "utf8")}\n<!-- user edit -->\n`, "utf8");
    const reloaded = new SkillRuntimeCoordinator(vaultPath, { now: () => now });
    const state = await reloaded.initialize();
    assert.equal(state.records["evidence-freshness-audit"]?.userModified, true);
    now += 10 * AUTO_SKILL_LIFECYCLE_THRESHOLDS_MS.archivedToCleaned;
    const preserved = await reloaded.advanceLifecycle();
    assert.equal(preserved.records["evidence-freshness-audit"]?.status, "active");
    assert.equal(await readFile(builtinPath, "utf8").then(Boolean), true,
      "preinstalled and user-modified Skills never enter automatic cleanup");

    candidate = {
      eligible: true,
      candidate: {
        name: "Incident decision ledger",
        description: "把一次处理过程中的决定整理成后续可复用的决策记录。",
        triggerPhrases: ["事故决策记录"],
        steps: ["提取已执行的关键决定。", "记录结果与适用边界。"],
        output: "输出决定、结果和适用边界。",
        boundaries: ["不补写本轮没有发生的动作。"],
        existingCapabilities: []
      }
    };
    now += 1;
    const concurrentReviews = await Promise.all([
      coordinator.reviewCompletedTask({
        productRunId: "run-concurrent-review-a",
        request: "整理事故处理决策",
        result: "决策已经执行并验证",
        terminalState: "completed",
        existingCapabilityIds: []
      }),
      coordinator.reviewCompletedTask({
        productRunId: "run-concurrent-review-b",
        request: "沉淀同一事故处理决策",
        result: "同一方法已经执行并验证",
        terminalState: "completed",
        existingCapabilityIds: []
      })
    ]);
    assert.deepEqual(
      concurrentReviews.map((result) => result.outcome).sort(),
      ["created", "duplicate"],
      "concurrent reviews recheck the latest state and create only one semantic Skill"
    );
    const concurrentCreated = concurrentReviews.find(
      (result) => result.outcome === "created"
    );
    assert.ok(concurrentCreated?.outcome === "created");
    await Promise.all(Array.from({ length: 8 }, (_, index) =>
      coordinator.recordUse(concurrentCreated.record.id, now + index + 1)
    ));
    assert.equal(
      (await coordinator.read()).records[concurrentCreated.record.id]?.usageCount,
      9,
      "concurrent usage recording preserves every increment"
    );
  });
  console.log("PASS EchoInk Skill installation, routing, learning, and lifecycle contracts");
}

async function withVault(run: (vaultPath: string) => Promise<void>): Promise<void> {
  const vaultPath = await mkdtemp(path.join(tmpdir(), "echoink-skill-runtime-"));
  try {
    await run(vaultPath);
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
}
