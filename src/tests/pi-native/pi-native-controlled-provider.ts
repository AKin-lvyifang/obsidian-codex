import * as assert from "node:assert/strict";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import {
  createPiNativeControlledProvider,
  createPiNativeModelFromConfiguration,
  createPiNativeModelFromCatalog,
  PiNativeModelMetadataError
} from "../../harness/pi-native/pi-native-controlled-provider";
import {
  createPiProviderModelDefinition,
  type PiProviderRuntimeConfig
} from "../../harness/pi/production-pi-model-resolver";

export async function runPiNativeControlledProviderTests(): Promise<void> {
  assertCatalogModelMetadataFailsClosed();
  assertConfiguredModelCapabilitiesAndCatalogImageTruthMerge();
  await assertExecutableAgentToolsProjectToProviderMetadata();
  await assertThrownOverflowRemainsVisibleToAgentSession();
  await assertUnknownProviderFailuresRemainSanitized();
}

function assertConfiguredModelCapabilitiesAndCatalogImageTruthMerge(): void {
  const provider = providerConfig();
  const catalog = {
    ...providerModel(),
    name: "Catalog model",
    reasoning: true,
    input: ["text", "image"] as Array<"text" | "image">,
    contextWindow: 128_000,
    maxTokens: 32_000
  };
  const configured = createPiNativeModelFromConfiguration({
    catalogModel: catalog,
    provider,
    configured: {
      apiProtocol: "openai-completions",
      contextWindow: 96_000,
      maxOutputTokens: 12_000,
      reasoning: false,
      imageInput: false
    }
  });
  assert.equal(configured.reasoning, false);
  assert.equal(configured.contextWindow, 96_000);
  assert.equal(configured.maxTokens, 12_000);
  assert.deepEqual(configured.input, ["text", "image"]);

  const configuredImage = createPiNativeModelFromConfiguration({
    catalogModel: { ...catalog, input: ["text"] },
    provider,
    configured: {
      apiProtocol: "openai-completions",
      contextWindow: 96_000,
      maxOutputTokens: 12_000,
      reasoning: false,
      imageInput: true
    }
  });
  assert.deepEqual(configuredImage.input, ["text", "image"]);
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
