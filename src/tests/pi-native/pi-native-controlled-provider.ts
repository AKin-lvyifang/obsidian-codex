import * as assert from "node:assert/strict";
import type {
  Api,
  Context,
  ImageContent,
  Model
} from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
  createPiNativeControlledProvider,
  createPiNativeModelFromCatalog,
  createPiNativeModelFromConfiguration,
  piModelSupportsImageInput,
  PiNativeModelMetadataError
} from "../../harness/pi-native/pi-native-controlled-provider";
import {
  createPiProviderModelDefinition,
  type ControlledPiStreamInput,
  type PiProviderRuntimeConfig
} from "../../harness/pi/production-pi-model-resolver";

export async function runPiNativeControlledProviderTests(): Promise<void> {
  assertCatalogModelMetadataFailsClosed();
  assertCurrentModelImageCapabilityIsCanonical();
  assertConfiguredModelCapabilitiesAndCatalogImageTruthMerge();
  await assertProtocolRequestLimitProjection();
  await assertExecutableAgentToolsProjectToProviderMetadata();
  await assertImageContentSurvivesControlledProviderProjection();
  await assertThrownOverflowRemainsVisibleToAgentSession();
  await assertUnknownProviderFailuresRemainSanitized();
}

async function assertProtocolRequestLimitProjection(): Promise<void> {
  const capture = async (
    apiProtocol: PiProviderRuntimeConfig["apiProtocol"],
    configuredMaxTokens?: number,
    requestedMaxTokens?: number
  ): Promise<ControlledPiStreamInput["options"]> => {
    const config: PiProviderRuntimeConfig = {
      ...providerConfig(),
      apiProtocol
    };
    const model = createPiProviderModelDefinition({
      providerId: config.providerId,
      apiProtocol,
      baseUrl: config.baseUrl,
      modelRef: config.modelRef,
      maxOutputTokens: 8_192
    });
    let captured: ControlledPiStreamInput["options"] | undefined;
    const provider = createPiNativeControlledProvider({
      config: { read: async () => structuredClone(config) },
      controlledStream: {
        authorityId: "request-limit-authority",
        storeSetId: "request-limit-store",
        stream: (input) => {
          captured = input.options;
          throw new Error("fixture_transport_stop");
        }
      },
      model,
      ...(configuredMaxTokens === undefined
        ? {}
        : { maxTokens: configuredMaxTokens }),
      currentExecutionContext: () => ({
        runId: "request-limit-run",
        conversationId: "request-limit-conversation",
        turnId: "request-limit-turn",
        correlationId: "request-limit-correlation"
      })
    });
    await provider.stream(
      model,
      emptyContext(),
      requestedMaxTokens === undefined ? {} : { maxTokens: requestedMaxTokens }
    ).result();
    assert.ok(captured);
    return captured;
  };

  for (const protocol of [
    "openai-completions",
    "openai-responses"
  ] as const) {
    const inherited = await capture(protocol);
    assert.equal(Object.hasOwn(inherited, "maxTokens"), false);
    const internallyRequested = await capture(protocol, undefined, 1_024);
    assert.equal(internallyRequested.maxTokens, 1_024);
  }
  const overridden = await capture("openai-completions", 2_048, 1_024);
  assert.equal(overridden.maxTokens, 1_024);
  const anthropic = await capture("anthropic-messages");
  assert.equal(anthropic.maxTokens, 8_192);
}

function assertCurrentModelImageCapabilityIsCanonical(): void {
  const apiKeyProvider = providerConfig();
  const oauthProvider = oauthProviderConfig();
  const catalogImageModel = {
    ...providerModel(oauthProvider),
    input: ["text", "image"] as Model<Api>["input"]
  };
  const catalogResolved = createPiNativeModelFromConfiguration({
    catalogModel: catalogImageModel,
    provider: oauthProvider,
    configured: configuredModelMetadata(oauthProvider, false)
  });
  assert.equal(piModelSupportsImageInput(catalogResolved), true);
  assert.deepEqual(catalogResolved.input, ["text", "image"]);

  const configuredResolved = createPiNativeModelFromConfiguration({
    catalogModel: undefined,
    provider: apiKeyProvider,
    configured: configuredModelMetadata(apiKeyProvider, true)
  });
  assert.equal(configuredResolved.reasoning, true);
  assert.equal(piModelSupportsImageInput(configuredResolved), true);
  assert.deepEqual(configuredResolved.input, ["text", "image"]);
  assert.deepEqual(getSupportedThinkingLevels(configuredResolved), [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max"
  ]);

  const textOnly = createPiNativeModelFromConfiguration({
    catalogModel: providerModel(),
    provider: apiKeyProvider,
    configured: configuredModelMetadata(apiKeyProvider, false)
  });
  assert.equal(piModelSupportsImageInput(textOnly), false);
  assert.deepEqual(textOnly.input, ["text"]);
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
  assert.equal(
    configured.reasoning,
    true,
    "catalog reasoning truth must ignore a manual false override"
  );
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

async function assertImageContentSurvivesControlledProviderProjection():
Promise<void> {
  const config = providerConfig();
  const model = createPiNativeModelFromConfiguration({
    catalogModel: {
      ...providerModel(),
      input: ["text", "image"]
    },
    provider: config,
    configured: configuredModelMetadata(config, false)
  });
  assert.equal(piModelSupportsImageInput(model), true);
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

function providerModel(
  config: PiProviderRuntimeConfig = providerConfig()
): Model<Api> {
  return createPiProviderModelDefinition({
    providerId: config.providerId,
    apiProtocol: config.apiProtocol,
    baseUrl: config.baseUrl,
    modelRef: config.modelRef
  });
}

function providerConfig(): PiProviderRuntimeConfig {
  return {
    providerId: "custom",
    apiProtocol: "openai-completions",
    authMode: "api-key",
    baseUrl: "https://fixture.example/v1",
    modelRef: "fixture/model"
  };
}

function oauthProviderConfig(): PiProviderRuntimeConfig {
  return {
    providerId: "openai-codex",
    apiProtocol: "openai-codex-responses",
    authMode: "oauth",
    baseUrl: "https://chatgpt.com/backend-api",
    modelRef: "gpt-5.6-sol"
  };
}

function configuredModelMetadata(
  provider: PiProviderRuntimeConfig,
  imageInput: boolean
) {
  return {
    apiProtocol: provider.apiProtocol,
    contextWindow: 64_000,
    maxOutputTokens: 8_192,
    reasoning: true,
    imageInput
  };
}

function emptyContext(): Context {
  return {
    systemPrompt: "Phase 1 controlled Provider fixture",
    messages: [],
    tools: []
  };
}
