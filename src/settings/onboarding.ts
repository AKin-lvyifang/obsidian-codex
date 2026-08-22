import {
  getActiveApiProvider,
  validateApiProvider,
  type CodexForObsidianSettings,
  type SetupSettings,
  type SettingsTab
} from "./settings";

export const ECHOINK_ONBOARDING_VERSION = "onboarding-v1";

export type EchoInkOnboardingStep = "provider" | "knowledge" | "personality";

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
  setup: Readonly<SetupSettings>
): boolean {
  // dismissedVersion also acts as the last-seen tutorial version. Bumping the
  // onboarding version therefore shows the guide once after an update, while
  // the same version never reopens it in an existing Vault.
  return setup.dismissedVersion !== ECHOINK_ONBOARDING_VERSION;
}

export function dismissEchoInkOnboardingTutorial(setup: SetupSettings): void {
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
    const nextStep = expectedStep === "provider" ? "knowledge" : "personality";
    setup.tutorialStep = nextStep;
    return Object.freeze({ changed: true, completed: false, nextStep });
  }
  setup.completedAt = now;
  setup.lastCheckedAt = now;
  setup.dismissedVersion = ECHOINK_ONBOARDING_VERSION;
  setup.tutorialStep = "provider";
  return Object.freeze({ changed: true, completed: true, nextStep: null });
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
