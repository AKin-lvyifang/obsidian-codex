import * as assert from "node:assert/strict";
import type {
  Api,
  Context,
  ImageContent,
  Model
} from "@earendil-works/pi-ai";
import {
  createPiNativeControlledProvider,
  createPiNativeModelFromCatalog,
  PiNativeModelMetadataError
} from "../../harness/pi-native/pi-native-controlled-provider";
import {
  createPiProviderModelDefinition,
  type PiProviderRuntimeConfig
} from "../../harness/pi/production-pi-model-resolver";

export async function runPiNativeControlledProviderTests(): Promise<void> {
  assertCatalogModelMetadataFailsClosed();
  await assertExecutableAgentToolsProjectToProviderMetadata();
  await assertImageContentSurvivesControlledProviderProjection();
  await assertThrownOverflowRemainsVisibleToAgentSession();
  await assertUnknownProviderFailuresRemainSanitized();
}

function assertCatalogModelMetadataFailsClosed(): void {
  const config = providerConfig();
  const valid = providerModel();
  const cases: ReadonlyArray<{
    label: string;
    catalogModel: Model<Api> | undefined;
    expectedCode: PiNativeModelMetadataError["code"];
  }> = [{
    label: "missing catalog model",
    catalogModel: undefined,
    expectedCode: "model_metadata_missing"
  }, {
    label: "zero context window",
    catalogModel: { ...valid, contextWindow: 0 },
    expectedCode: "model_metadata_incompatible"
  }, {
    label: "fractional context window",
    catalogModel: { ...valid, contextWindow: 64_000.5 },
    expectedCode: "model_metadata_incompatible"
  }];

  for (const testCase of cases) {
    assert.throws(
      () => createPiNativeModelFromCatalog({
        catalogModel: testCase.catalogModel,
        provider: config
      }),
      (error: unknown) => {
        assert.ok(
          error instanceof PiNativeModelMetadataError,
          `${testCase.label} must fail closed instead of inventing a context window`
        );
        assert.equal(error.code, testCase.expectedCode);
        return true;
      }
    );
  }
}

async function assertThrownOverflowRemainsVisibleToAgentSession():
Promise<void> {
  const result = await runThrowingProvider("context_length_exceeded");
  assert.equal(result.errorMessage, "context_length_exceeded");
}

async function assertUnknownProviderFailuresRemainSanitized(): Promise<void> {
  const result = await runThrowingProvider("rate limit with secret detail");
  assert.equal(result.errorMessage, "controlled_transport_failed");
}

async function assertExecutableAgentToolsProjectToProviderMetadata():
Promise<void> {
  const model = providerModel();
  const config = providerConfig();
  let captured: Context | undefined;
  const execute = async () => ({
    content: [{ type: "text" as const, text: "fixture" }],
    details: { fixture: true }
  });
  const runtimeTool = {
    name: "echoink_readonly_fixture",
    label: "EchoInk read-only fixture",
    description: "Return deterministic Phase 1 fixture data",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string" }
      },
      required: ["key"],
      additionalProperties: false
    },
    prepareArguments: (value: unknown) => value,
    execute,
    executionMode: "sequential"
  };
  const provider = createPiNativeControlledProvider({
    config: {
      read: async () => structuredClone(config)
    },
    controlledStream: {
      authorityId: "phase1-provider-authority",
      storeSetId: "phase1-provider-store",
      stream: (input) => {
        captured = input.context;
        throw new Error("fixture_transport_stop");
      }
    },
    model,
    currentExecutionContext: () => ({
      runId: "phase1-provider-run",
      conversationId: "phase1-provider-conversation",
      turnId: "phase1-provider-turn",
      correlationId: "phase1-provider-correlation"
    })
  });
  const context: Context = {
    ...emptyContext(),
    tools: [runtimeTool]
  };

  const result = await provider.stream(model, context, {}).result();

  assert.equal(result.errorMessage, "controlled_transport_failed");
  assert.ok(captured, "Provider transport must receive the Context");
  assert.notEqual(captured, context);
  assert.deepEqual(captured.tools, [{
    name: runtimeTool.name,
    description: runtimeTool.description,
    parameters: runtimeTool.parameters
  }]);
  assert.equal("execute" in captured.tools![0]!, false);
  assert.equal(runtimeTool.execute, execute);
}

async function assertImageContentSurvivesControlledProviderProjection():
Promise<void> {
  const model = providerModel();
  const config = providerConfig();
  const image: ImageContent = {
    type: "image",
    data: "AQIDBA==",
    mimeType: "image/png"
  };
  const context: Context = {
    systemPrompt: "Inspect the ordered image content.",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "请看图片" },
        image
      ],
      timestamp: 1
    }],
    tools: []
  };
  let captured: Context | undefined;
  const provider = createPiNativeControlledProvider({
    config: {
      read: async () => structuredClone(config)
    },
    controlledStream: {
      authorityId: "phase1-provider-authority",
      storeSetId: "phase1-provider-store",
      stream: (input) => {
        captured = input.context;
        throw new Error("fixture_transport_stop");
      }
    },
    model,
    currentExecutionContext: () => ({
      runId: "phase1-provider-image-run",
      conversationId: "phase1-provider-image-conversation",
      turnId: "phase1-provider-image-turn",
      correlationId: "phase1-provider-image-correlation"
    })
  });

  const result = await provider.stream(model, context, {}).result();

  assert.equal(result.errorMessage, "controlled_transport_failed");
  assert.ok(captured, "the controlled Provider dispatcher must receive Context");
  assert.notEqual(captured, context);
  assert.notEqual(captured.messages[0], context.messages[0]);
  assert.deepEqual(captured.messages[0], context.messages[0]);
  const capturedContent = captured.messages[0]?.content;
  assert.ok(Array.isArray(capturedContent));
  assert.deepEqual(capturedContent, [
    { type: "text", text: "请看图片" },
    { type: "image", data: "AQIDBA==", mimeType: "image/png" }
  ]);
}

async function runThrowingProvider(message: string) {
  const model = providerModel();
  const config = providerConfig();
  const provider = createPiNativeControlledProvider({
    config: {
      read: async () => structuredClone(config)
    },
    controlledStream: {
      authorityId: "phase1-provider-authority",
      storeSetId: "phase1-provider-store",
      stream: () => {
        throw new Error(message);
      }
    },
    model,
    currentExecutionContext: () => ({
      runId: "phase1-provider-run",
      conversationId: "phase1-provider-conversation",
      turnId: "phase1-provider-turn",
      correlationId: "phase1-provider-correlation"
    })
  });
  return await provider.stream(model, emptyContext(), {}).result();
}

function providerModel(): Model<Api> {
  return createPiProviderModelDefinition({
    providerId: "custom",
    apiProtocol: "openai-completions",
    authMode: "api-key",
    baseUrl: "https://fixture.example/v1",
    modelRef: "fixture/model"
  });
}

function providerConfig(): PiProviderRuntimeConfig {
  return {
    providerId: "custom",
    apiProtocol: "openai-completions",
    baseUrl: "https://fixture.example/v1",
    modelRef: "fixture/model"
  };
}

function emptyContext(): Context {
  return {
    systemPrompt: "Phase 1 controlled Provider fixture",
    messages: [],
    tools: []
  };
}
