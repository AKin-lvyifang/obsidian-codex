import {
  getActiveApiProvider,
  validateApiProvider,
  type CodexForObsidianSettings,
  type SetupSettings,
  type SettingsTab
} from "./settings";

export const ECHOINK_ONBOARDING_VERSION = "onboarding-v2";

export type EchoInkOnboardingStep =
  | "sidebar"
  | "settings"
  | "provider"
  | "knowledge"
  | "personality";

export interface EchoInkOnboardingTruth {
  readonly providerComplete: boolean;
  readonly knowledgeComplete: boolean;
  readonly personalityComplete: boolean;
}

/**
 * Product truth remains visible to the settings UI, but never drives the
 * tutorial cursor. The tutorial is an independent, explicit click-through.
 */
export function deriveEchoInkOnboardingTruth(
  settings: Pick<
    CodexForObsidianSettings,
    "activeApiProviderId" | "apiProviders" | "knowledgeBase"
  >,
  personalityTemplateId: string | null
): Readonly<EchoInkOnboardingTruth> {
  const provider = getActiveApiProvider(settings);
  const providerComplete = Boolean(
    provider
    && provider.id === settings.activeApiProviderId
    && validateApiProvider(provider).length === 0
  );
  const knowledgeComplete =
    settings.knowledgeBase.initialization.status === "initialized";
  const personalityComplete = personalityTemplateId !== null;
  return Object.freeze({
    providerComplete,
    knowledgeComplete,
    personalityComplete
  });
}

export function echoInkOnboardingTab(step: EchoInkOnboardingStep): SettingsTab {
  return step === "provider"
    ? "providers"
    : step === "knowledge" ? "knowledgeBase" : "general";
}

export interface EchoInkOnboardingAdvanceResult {
  readonly changed: boolean;
  readonly completed: boolean;
  readonly nextStep: EchoInkOnboardingStep | null;
}

export function shouldAutoStartEchoInkOnboarding(
  _emptyData: boolean,
  setup: Readonly<SetupSettings>,
  enabledAfterLayoutReady = false
): boolean {
  if (enabledAfterLayoutReady) return true;
  // dismissedVersion also acts as the last-seen tutorial version. Bumping the
  // onboarding version therefore shows the guide once after an update, while
  // the same version never reopens it in an existing Vault.
  return setup.dismissedVersion !== ECHOINK_ONBOARDING_VERSION;
}

export function prepareEchoInkOnboardingTutorial(
  setup: SetupSettings,
  options: Readonly<{ forceRestart: boolean }>
): boolean {
  const newVersion = setup.tutorialVersion !== ECHOINK_ONBOARDING_VERSION;
  if (!options.forceRestart && !newVersion) return false;
  setup.completedAt = 0;
  setup.dismissedVersion = "";
  setup.tutorialVersion = ECHOINK_ONBOARDING_VERSION;
  setup.tutorialStep = "sidebar";
  return true;
}

export function dismissEchoInkOnboardingTutorial(setup: SetupSettings): void {
  setup.tutorialVersion = ECHOINK_ONBOARDING_VERSION;
  setup.dismissedVersion = ECHOINK_ONBOARDING_VERSION;
}

/** Advance only from an explicit control bound to the currently shown step. */
export function advanceEchoInkOnboardingTutorial(
  setup: SetupSettings,
  expectedStep: EchoInkOnboardingStep,
  now: number
): Readonly<EchoInkOnboardingAdvanceResult> {
  if (setup.tutorialStep !== expectedStep) {
    return Object.freeze({
      changed: false,
      completed: false,
      nextStep: setup.tutorialStep
    });
  }
  if (expectedStep !== "personality") {
    const nextStep: EchoInkOnboardingStep = expectedStep === "sidebar"
      ? "settings"
      : expectedStep === "settings"
        ? "provider"
        : expectedStep === "provider"
          ? "knowledge"
          : "personality";
    setup.tutorialStep = nextStep;
    return Object.freeze({ changed: true, completed: false, nextStep });
  }
  setup.completedAt = now;
  setup.lastCheckedAt = now;
  setup.tutorialVersion = ECHOINK_ONBOARDING_VERSION;
  setup.dismissedVersion = ECHOINK_ONBOARDING_VERSION;
  setup.tutorialStep = "sidebar";
  return Object.freeze({ changed: true, completed: true, nextStep: null });
}

export function onboardingCoachmarkCopy(
  step: EchoInkOnboardingStep,
  zh: boolean
): Readonly<{
  step: string;
  title: string;
  description: string;
  action: string | null;
}> {
  const index = ["sidebar", "settings", "provider", "knowledge", "personality"]
    .indexOf(step) + 1;
  if (!zh) {
    const copy = {
      sidebar: {
        title: "Open the Agent sidebar",
        description: "Click the robot icon in Obsidian's left ribbon to open the EchoInk Agent sidebar.",
        action: "Open EchoInk"
      },
      settings: {
        title: "Open EchoInk settings",
        description: "For your first use, open Settings from the gear in the upper-right corner of the EchoInk sidebar.",
        action: "Open settings"
      },
      provider: {
        title: "Connect a model",
        description: "Add and enable a model service so EchoInk can start chatting.",
        action: "Next"
      },
      knowledge: {
        title: "Set up Knowledge",
        description: "Choose the recommended or custom plan. EchoInk shows a preview before organizing notes.",
        action: "Next"
      },
      personality: {
        title: "Choose an Agent style",
        description: "Choose a starting style, then set a name and avatar. You can change them later.",
        action: "Finish"
      }
    } as const;
    return Object.freeze({ step: `Step ${index} of 5`, ...copy[step] });
  }
  const copy = {
    sidebar: {
      title: "打开 Agent 侧栏",
      description: "点击 Obsidian 左侧栏里的机器人图标，打开 EchoInk Agent 侧栏。",
      action: "打开 EchoInk"
    },
    settings: {
      title: "进入 EchoInk 设置",
      description: "第一次使用，请点击 EchoInk 侧栏右上角的齿轮，先进入设置。",
      action: "打开设置"
    },
    provider: {
      title: "连接一个模型",
      description: "添加并启用一个模型服务，EchoInk 才能开始对话。",
      action: "下一步"
    },
    knowledge: {
      title: "建立知识库",
      description: "选择默认或自定义方案。EchoInk 会先显示预览，再整理笔记。",
      action: "下一步"
    },
    personality: {
      title: "选择 Agent 风格",
      description: "选择一种起始风格，再设置名称和头像。以后可以随时调整。",
      action: "完成"
    }
  } as const;
  return Object.freeze({ step: `第 ${index} 步，共 5 步`, ...copy[step] });
}

export function isEmptyEchoInkPluginData(value: unknown): boolean {
  return value === null
    || value === undefined
    || (
      typeof value === "object"
      && !Array.isArray(value)
      && Object.keys(value).length === 0
    );
}
