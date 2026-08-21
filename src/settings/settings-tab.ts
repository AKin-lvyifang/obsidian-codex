import { Notice, PluginSettingTab, Setting, setIcon } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import type { PiConversationCatalogEntry } from "../harness/pi-native/contracts";
import type {
  PersonalMemoryKind,
  PersonalMemoryRecord
} from "../harness/memory/personal-memory-contracts";
import {
  currentPersonalityScores,
  templateBaselineScores,
  type PersonalityState
} from "../harness/memory/personality-state";
import { initialTemplateSelectionStatus } from "../harness/memory/cognitive-system";
import {
  PERSONALITY_TEMPLATES,
  TRAIT_DIMENSIONS,
  TRAIT_DIMENSION_META,
  getPersonalityTemplate,
  traitBehaviorBand,
  type TraitDimension
} from "../harness/memory/personality-templates";
import { AGENT_AVATAR_PRESETS, resolveAgentAvatarUrl } from "../ui/agent-avatar-presets";
import { AgentIdentityModal } from "../ui/agent-identity-modal";
import { buildActiveEchoInkResourceCatalog } from "../resources/registry";
import {
  mcpConnectionStatus,
  mcpConnectionStatusLabel,
  mcpCredentialConfigured,
  mcpToolPolicy,
  resolveMcpConnectionRecord
} from "../resources/mcp-connections";
import type {
  EchoInkMcpConnectionRecord,
  EchoInkMcpDiagnosticCode,
  EchoInkResource
} from "../resources/types";
import {
  emptyWorkspaceResourceSnapshot,
  errorsFromWorkspaceResourceCache,
  loadedTabsFromWorkspaceResourceCache,
  snapshotFromWorkspaceResourceCache
} from "../core/workspace-resources";
import { filterWorkspaceResourceRows } from "../core/workspace-resource-filter";
import {
  DEFAULT_SETTINGS,
  activateApiProvider,
  apiProviderHasUsableApiKey,
  applyApiProviderModelPreset,
  createApiProviderConfig,
  getActiveApiProvider,
  normalizeReviewOutputDir,
  normalizeSettingsLanguage,
  validateApiProvider,
  type ApiProviderConfig,
  type ReviewReportKind,
  type ResourceManagementTab,
  type SettingsTab,
  type WorkspaceResourceToggles
} from "./settings";
import {
  apiProviderApiKeyRequired,
  getApiProviderModelPreset,
  getApiProviderPreset,
  normalizeApiProviderBaseUrl,
  normalizeApiProviderId
} from "./provider-presets";
import type { WorkspaceResourceSnapshot } from "../types/app-server";
import { CODEX_MEMORY_LITE_URL } from "../knowledge-base/constants";
import {
  ECHOINK_KNOWLEDGE_MAINTENANCE_PROTOCOL_STEPS
} from "../knowledge-base/knowledge-maintenance-protocol";
import { KnowledgeInitializationSection } from "./knowledge-initialization-section";
import {
  confirmModal,
  memoryCorrectionModal,
  selectInputModal,
  textInputModal
} from "../ui/modals";
import { SETTINGS_LANGUAGE_OPTIONS, settingsCopy, type SettingsCopy } from "./i18n";
import { captureSettingsScrollSnapshot, restoreSettingsScrollSnapshot } from "./settings-scroll";
import {
  ProviderModelModal,
  type ProviderModelSaveResult
} from "./provider-model-modal";
import { renderProviderBrandIcon } from "./provider-brand-icons";
import { McpServerModal } from "./mcp-server-modal";
import {
  applySettingsRow,
  createSettingsCompactList,
  createSettingsFeatureCard,
  createSettingsGroup,
  createSettingsNavigationRow,
  createSettingsPage,
  createSettingsSection,
  createSettingsState
} from "./settings-v2";
import {
  beginSavingKnowledgeMaintenancePreference,
  createKnowledgeMaintenancePreferenceEditor,
  editKnowledgeMaintenancePreference,
  failSavingKnowledgeMaintenancePreference,
  knowledgeMaintenancePreferenceDraftState,
  knowledgeMaintenancePreferenceIsDirty,
  restoreDefaultKnowledgeMaintenancePreference,
  type KnowledgeMaintenancePreferenceEditorState
} from "./knowledge-maintenance-preference-editor";
import type { EchoInkOnboardingStep } from "./onboarding";
import { echoInkOnboardingTab } from "./onboarding";

type PersonalMemoryControlState = Awaited<
  ReturnType<CodexForObsidianPlugin["getEchoInkPersonalMemoryState"]>
>;

type KnowledgeMaintenancePreferenceControlState = Awaited<
  ReturnType<CodexForObsidianPlugin[
    "getEchoInkKnowledgeMaintenancePreferenceState"
  ]>
>;

interface AgentProfileCardRefs {
  readonly hexSide: HTMLElement;
  /** SVG 挂载点：重渲染只清空它，说明文案是兄弟节点不被波及。 */
  readonly hexChartMount: HTMLElement;
  readonly barFgs: HTMLElement[];
  readonly pctSpans: HTMLElement[];
  readonly barDescs: HTMLElement[];
  readonly dimLabels: [string, string, string][];
  readonly footerStatus: HTMLElement;
  readonly templateBtn: HTMLElement;
  readonly pickerPanel: HTMLElement;
  readonly summaryText: HTMLElement;
  readonly rawPre: HTMLElement;
}

export class CodexSettingTab extends PluginSettingTab {
  private resourceSnapshot: WorkspaceResourceSnapshot | null = null;
  private runtimeEchoInkResources: EchoInkResource[] = [];
  private resourceLoadingTab: ResourceManagementTab | null = null;
  private resourceLoaded: Record<ResourceManagementTab, boolean> = { plugins: false, mcp: false, skills: false };
  private resourceLoadErrors: Partial<Record<ResourceManagementTab, string>> = {};
  private resourceSearchQuery: Record<ResourceManagementTab, string> = { plugins: "", mcp: "", skills: "" };
  private resourceSearchDebounceTimer: number | null = null;
  private settingsVisible = false;
  private memoryActionRunning = false;
  private personalMemoryState: PersonalMemoryControlState | null = null;
  private personalMemoryLoading = false;
  private personalMemoryError: string | null = null;
  private knowledgePreferenceState:
    KnowledgeMaintenancePreferenceControlState | null = null;
  private knowledgePreferenceEditor:
    Readonly<KnowledgeMaintenancePreferenceEditorState> | null = null;
  private knowledgePreferenceLoading = false;
  private knowledgePreferenceLoadError: string | null = null;
  private knowledgeInitSection: KnowledgeInitializationSection | null = null;
  private knowledgePreferenceClosePromptRunning = false;
  private displayFrame: number | null = null;
  private settingsTitleEl: HTMLElement | null = null;
  private settingsTabsEl: HTMLElement | null = null;
  private settingsBodyEl: HTMLElement | null = null;
  private settingsStatusEl: HTMLElement | null = null;
  private settingsTabFocusId: VisibleSettingsTab | null = null;
  private resourceTabFocusId: ResourceManagementTab | null = null;
  private settingsTabPointerActivated = false;
  private resourceTabPointerActivated = false;
  private suppressSettingsTabFocusRestore = false;
  private suppressResourceTabFocusRestore = false;
  private settingsFocusIntent: string | null = null;
  private settingsActionErrors: Partial<Record<SettingsActionContext, string>> = {};
  private settingsDetail: SettingsDetail = null;
  private archivedConversations: readonly Readonly<PiConversationCatalogEntry>[] | null = null;
  private archivedConversationsLoading = false;
  private archivedConversationsError = "";
  private archivedConversationQuery = "";
  private archivedConversationBusyId = "";
  private settingsTabsResizeObserver: ResizeObserver | null = null;
  private readonly verifiedProviderConnections = new Map<string, string>();
  private onboardingCoachmarkEl: HTMLElement | null = null;
  private onboardingCoachmarkCleanup: (() => void) | null = null;
  private onboardingRestoreFocusEl: HTMLElement | null = null;
  private onboardingRefreshGeneration = 0;

  constructor(private readonly plugin: CodexForObsidianPlugin) {
    super(plugin.app, plugin);
    this.resourceSnapshot = snapshotFromWorkspaceResourceCache(this.plugin.settings.workspaceResourceCache);
    this.resourceLoaded = loadedTabsFromWorkspaceResourceCache(this.plugin.settings.workspaceResourceCache);
    this.resourceLoadErrors = errorsFromWorkspaceResourceCache(this.plugin.settings.workspaceResourceCache);
  }

  private get copy(): SettingsCopy {
    return settingsCopy(this.plugin.settings.settingsLanguage);
  }

  display(): void {
    this.settingsVisible = true;
    if (this.displayFrame !== null) {
      window.cancelAnimationFrame(this.displayFrame);
      this.displayFrame = null;
    }
    this.renderSettingsShell();
    this.renderSettingsContent();
  }

  hide(): void {
    const shouldConfirmKnowledgePreference =
      this.settingsDetail === "knowledge-preferences"
      && knowledgeMaintenancePreferenceIsDirty(
        this.knowledgePreferenceEditor
      )
      && !this.knowledgePreferenceClosePromptRunning;
    this.settingsVisible = false;
    this.clearOnboardingCoachmark(true);
    this.knowledgeInitSection?.dispose();
    this.disconnectSettingsTabsResizeObserver();
    if (this.displayFrame !== null) {
      window.cancelAnimationFrame(this.displayFrame);
      this.displayFrame = null;
    }
    super.hide();
    if (shouldConfirmKnowledgePreference) {
      this.knowledgePreferenceClosePromptRunning = true;
      void this.confirmKnowledgePreferenceDiscard().then((discard) => {
        this.knowledgePreferenceClosePromptRunning = false;
        if (discard) {
          this.resetKnowledgePreferenceDraft();
          return;
        }
        this.settingsFocusIntent =
          "explicit:knowledge:preferences:editor";
        const settings = (this.app as {
          setting?: { open?: () => void; openTabById?: (id: string) => void };
        }).setting;
        settings?.open?.();
        settings?.openTabById?.(this.plugin.manifest.id);
      });
    }
  }

  private renderSettingsShell(): void {
    this.disconnectSettingsTabsResizeObserver();
    const { containerEl } = this;
    containerEl.empty();
    this.settingsTitleEl = containerEl.createDiv({ cls: "codex-settings-title" });
    this.settingsTabsEl = containerEl.createDiv({ cls: "codex-settings-tabs-slot" });
    this.settingsBodyEl = containerEl.createDiv({ cls: "codex-settings-body" });
    this.settingsStatusEl = containerEl.createDiv({
      cls: "codex-settings-status",
      attr: {
        role: "status",
        "aria-live": "polite",
        "aria-atomic": "true"
      }
    });
  }

  private ensureSettingsShell(): void {
    if (this.settingsBodyEl && this.containerEl.contains(this.settingsBodyEl)) return;
    this.renderSettingsShell();
  }

  private renderSettingsContent(): void {
    this.ensureSettingsShell();
    this.captureTabFocusIntent();
    this.captureSettingsFocusIntent();
    const copy = this.copy;
    const settingsScrollSnapshot = captureSettingsScrollSnapshot(this.containerEl);
    try {
      this.clearResourceSearchDebounceTimer();
      const titleEl = this.settingsTitleEl;
      const tabsEl = this.settingsTabsEl;
      const bodyEl = this.settingsBodyEl;
      if (!titleEl || !tabsEl || !bodyEl) return;
      titleEl.empty();
      tabsEl.empty();
      bodyEl.empty();
      const pageTitle = new Setting(titleEl)
        .setName(copy.title)
        .setHeading();
      pageTitle.settingEl.addClass("echoink-settings-page-title-row");
      pageTitle.nameEl.addClass("codex-settings-page-title");
      pageTitle.nameEl.id = SETTINGS_TITLE_ID;

      const activeTab = visibleSettingsTab(this.plugin.settings.settingsTab);
      this.plugin.settings.settingsTab = activeTab;
      this.renderTopTabs(tabsEl, activeTab);
      bodyEl.setAttr("id", SETTINGS_PANEL_ID);
      bodyEl.setAttr("role", "tabpanel");
      bodyEl.setAttr("aria-labelledby", settingsTabDomId(activeTab));
      bodyEl.setAttr("tabindex", "0");

      bodyEl.setAttr("aria-busy", String(
        (activeTab === "resources" && this.resourceLoadingTab === this.plugin.settings.resourceManagementTab)
        || this.memoryActionRunning
      ));

      if (activeTab === "providers") {
        this.renderProviderModelManager(bodyEl);
      } else if (activeTab === "resources") {
        this.renderWorkspaceResourceManager(bodyEl);
      } else if (activeTab === "knowledgeBase") {
        this.renderKnowledgeBaseSettings(bodyEl);
      } else if (activeTab === "review") {
        this.renderReviewSettings(bodyEl);
      } else {
        this.renderGeneralSettings(bodyEl);
      }
    } finally {
      restoreSettingsScrollSnapshot(settingsScrollSnapshot);
      this.restoreSettingsFocusIntent();
      void this.refreshOnboardingCoachmark();
    }
  }

  private scheduleDisplay(): void {
    if (!this.settingsVisible) return;
    if (this.displayFrame !== null) return;
    this.displayFrame = window.requestAnimationFrame(() => {
      this.displayFrame = null;
      this.renderSettingsContent();
    });
  }

  private captureTabFocusIntent(): void {
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement) || !this.containerEl.contains(activeElement)) return;

    const settingsButton = activeElement.closest<HTMLButtonElement>(
      "button.codex-settings-tab[data-settings-tab]"
    );
    const settingsTabId = settingsButton?.dataset.settingsTab;
    if (
      !this.suppressSettingsTabFocusRestore
      && this.settingsTabFocusId === null
      && SETTINGS_TABS.some((tab) => tab.id === settingsTabId)
    ) {
      this.settingsTabFocusId = settingsTabId as VisibleSettingsTab;
    }

    const resourceButton = activeElement.closest<HTMLButtonElement>(
      "button.codex-resource-tab[data-resource-tab]"
    );
    const resourceTabId = resourceButton?.dataset.resourceTab;
    if (
      !this.suppressResourceTabFocusRestore
      && this.resourceTabFocusId === null
      && RESOURCE_TABS.some((tab) => tab.id === resourceTabId)
    ) {
      this.resourceTabFocusId = resourceTabId as ResourceManagementTab;
    }
  }

  private captureSettingsFocusIntent(): void {
    if (this.settingsFocusIntent) return;
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement) || !this.containerEl.contains(activeElement)) return;
    const focusable = activeElement.closest<HTMLElement>("button, input, select, textarea, a[href]");
    if (!focusable) return;
    if (focusable.getAttribute("role") === "tab") return;
    this.settingsFocusIntent = this.settingsFocusKey(focusable);
  }

  private restoreSettingsFocusIntent(): void {
    const key = this.settingsFocusIntent;
    if (!key) return;
    const focusable = Array.from(this.containerEl.querySelectorAll<HTMLElement>(
      "button, input, select, textarea, a[href]"
    )).find((element) => this.settingsFocusKey(element) === key);
    if (!focusable) return;
    const focusTarget = () => {
      if (focusable.isConnected) focusable.focus({ preventScroll: true });
    };
    focusTarget();
    window.requestAnimationFrame(focusTarget);
    this.settingsFocusIntent = null;
  }

  private settingsFocusKey(element: HTMLElement): string {
    const explicit = element.dataset.echoinkFocusKey;
    if (explicit) return `explicit:${explicit}`;
    const id = element.id;
    if (id) return `id:${id}`;
    const stableText = element.getAttribute("aria-label")
      ?? element.getAttribute("data-settings-tab")
      ?? element.getAttribute("data-resource-tab")
      ?? element.getAttribute("data-resource-key")
      ?? element.textContent?.trim()
      ?? "";
    const className = Array.from(element.classList).filter((name) => name.startsWith("codex-")).sort().join(".");
    return `${element.tagName}:${className}:${stableText}`;
  }

  private announceSettingsStatus(message: string): void {
    this.settingsStatusEl?.setText(message);
  }

  private renderSettingsActionError(
    container: HTMLElement,
    context: SettingsActionContext
  ): void {
    const message = this.settingsActionErrors[context];
    if (!message) return;
    createSettingsState(container, message, "error");
  }

  private reportSettingsActionError(context: SettingsActionContext): void {
    const message = this.plugin.settings.settingsLanguage === "en"
      ? `${context === "review" ? "Review" : context === "resources" ? "Resource" : "Knowledge"} action did not finish. Check the current configuration and try again.`
      : `${context === "review" ? "复盘" : context === "resources" ? "资源" : "知识库"}操作未完成。请检查当前配置后重试。`;
    this.settingsActionErrors[context] = message;
    this.announceSettingsStatus(message);
  }

  private async refreshOnboardingCoachmark(): Promise<void> {
    const generation = ++this.onboardingRefreshGeneration;
    if (!this.settingsVisible || !this.plugin.isEchoInkOnboardingRequested()) {
      this.clearOnboardingCoachmark(false);
      return;
    }
    const step = this.plugin.getEchoInkOnboardingStep();
    const requiredTab = echoInkOnboardingTab(step);
    if (this.plugin.settings.settingsTab !== requiredTab) {
      await this.activateSettingsTab(requiredTab, true);
      return;
    }
    const settingsWindow = this.containerEl.ownerDocument.defaultView ?? window;
    settingsWindow.requestAnimationFrame(() => {
      if (
        generation !== this.onboardingRefreshGeneration
        || !this.settingsVisible
        || !this.plugin.isEchoInkOnboardingRequested()
      ) return;
      this.renderOnboardingCoachmark(step);
    });
  }

  private renderOnboardingCoachmark(step: EchoInkOnboardingStep): void {
    const anchorKey = step === "provider"
      ? "providers:add"
      : step === "knowledge"
        ? "knowledge:initialize"
        : "general:personality-template";
    const anchor = this.containerEl.querySelector<HTMLElement>(
      `[data-echoink-focus-key="${anchorKey}"]`
    );
    if (!anchor) {
      this.clearOnboardingCoachmark(false);
      return;
    }
    const settingsDocument = anchor.ownerDocument;
    const settingsWindow = settingsDocument.defaultView ?? window;
    if (!this.onboardingRestoreFocusEl) {
      const active = settingsDocument.activeElement;
      this.onboardingRestoreFocusEl = active instanceof HTMLElement ? active : null;
    }
    this.clearOnboardingCoachmark(false);
    const zh = this.plugin.settings.settingsLanguage !== "en";
    const copy = onboardingCoachmarkCopy(step, zh);
    const coachmark = settingsDocument.body.createDiv({
      cls: `echoink-onboarding-coachmark is-${step}`,
      attr: {
        role: "dialog",
        "aria-modal": "false",
        "aria-label": copy.title,
        tabindex: "-1"
      }
    });
    this.onboardingCoachmarkEl = coachmark;
    anchor.addClass("is-echoink-onboarding-target");
    anchor.scrollIntoView({ block: "center", inline: "nearest" });
    coachmark.createDiv({ cls: "echoink-onboarding-step", text: copy.step });
    coachmark.createDiv({
      cls: "echoink-onboarding-title",
      text: copy.title,
      attr: { role: "heading", "aria-level": "3" }
    });
    coachmark.createDiv({ cls: "echoink-onboarding-copy", text: copy.description });
    const actions = coachmark.createDiv({ cls: "echoink-onboarding-actions" });
    const dismiss = actions.createEl("button", {
      text: zh ? "稍后再说" : "Not now",
      attr: { type: "button" }
    });
    const next = actions.createEl("button", {
      cls: "mod-cta",
      text: copy.action,
      attr: { type: "button" }
    });
    const dismissOnboarding = () => {
      void this.plugin.dismissEchoInkOnboarding().finally(() => {
        this.clearOnboardingCoachmark(true);
      });
    };
    dismiss.onclick = dismissOnboarding;
    next.onclick = () => {
      if (next.disabled) return;
      next.disabled = true;
      void this.advanceOnboardingTutorial(step).catch((error) => {
        console.error("EchoInk onboarding advance failed", error);
        new Notice(zh ? "引导进度保存失败，请重试" : "Failed to save tutorial progress. Try again.");
      }).finally(() => {
        if (next.isConnected) next.disabled = false;
      });
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      dismissOnboarding();
    };
    const position = () => positionOnboardingCoachmark(
      coachmark,
      anchor,
      settingsWindow
    );
    const ResizeObserverCtor = settingsWindow.ResizeObserver;
    const observer = typeof ResizeObserverCtor === "undefined"
      ? null
      : new ResizeObserverCtor(position);
    observer?.observe(anchor);
    observer?.observe(coachmark);
    settingsWindow.addEventListener("resize", position);
    settingsDocument.addEventListener("scroll", position, true);
    settingsDocument.addEventListener("keydown", onKeyDown, true);
    this.onboardingCoachmarkCleanup = () => {
      observer?.disconnect();
      settingsWindow.removeEventListener("resize", position);
      settingsDocument.removeEventListener("scroll", position, true);
      settingsDocument.removeEventListener("keydown", onKeyDown, true);
      anchor.removeClass("is-echoink-onboarding-target");
      coachmark.remove();
    };
    position();
    coachmark.focus({ preventScroll: true });
  }

  private async advanceOnboardingTutorial(step: EchoInkOnboardingStep): Promise<void> {
    const nextStep = await this.plugin.advanceEchoInkOnboarding(step);
    if (!nextStep) {
      this.onboardingRestoreFocusEl = this.containerEl.querySelector<HTMLElement>(
        '[data-echoink-focus-key="general:personality-template"]'
      ) ?? this.onboardingRestoreFocusEl;
      this.clearOnboardingCoachmark(true);
      return;
    }
    this.clearOnboardingCoachmark(false);
    this.onboardingRestoreFocusEl = null;
    await this.activateSettingsTab(
      echoInkOnboardingTab(nextStep),
      false
    );
    if (this.plugin.settings.settingsTab === echoInkOnboardingTab(nextStep)) {
      this.scheduleDisplay();
    }
  }

  private clearOnboardingCoachmark(restoreFocus: boolean): void {
    this.onboardingCoachmarkCleanup?.();
    this.onboardingCoachmarkCleanup = null;
    this.onboardingCoachmarkEl = null;
    if (!restoreFocus) return;
    const restore = this.onboardingRestoreFocusEl;
    this.onboardingRestoreFocusEl = null;
    if (restore?.isConnected) restore.focus({ preventScroll: true });
  }

  private async runSettingsButtonAction(
    button: HTMLButtonElement,
    context: SettingsActionContext,
    action: () => Promise<void>
  ): Promise<void> {
    button.disabled = true;
    delete this.settingsActionErrors[context];
    try {
      await action();
    } catch {
      this.reportSettingsActionError(context);
    } finally {
      if (button.isConnected) button.disabled = false;
      this.scheduleDisplay();
    }
  }

  private renderGeneralSettings(containerEl: HTMLElement): void {
    const copy = this.copy;
    const zh = this.plugin.settings.settingsLanguage !== "en";
    const page = createSettingsPage(containerEl, {
      title: zh ? "基础设置" : "General",
      description: zh
        ? "调整 EchoInk 的界面语言、启动方式和对话显示。"
        : "Choose EchoInk's language, startup behavior, and conversation display."
    });
    const interfaceSection = createSettingsSection(page, {
      title: zh ? "界面与启动" : "Interface and startup",
      surface: "group"
    });
    const interfaceGroup = createSettingsGroup(interfaceSection);
    applySettingsRow(new Setting(interfaceGroup).setName(copy.general.settingsLanguage).setDesc(copy.general.settingsLanguageDesc).addDropdown((dropdown) => {
      dropdown.selectEl.setAttr("aria-label", copy.general.settingsLanguage);
      for (const language of SETTINGS_LANGUAGE_OPTIONS) dropdown.addOption(language, copy.general.languageOptions[language]);
      dropdown.setValue(this.plugin.settings.settingsLanguage);
      dropdown.onChange(async (value) => {
        this.plugin.settings.settingsLanguage = normalizeSettingsLanguage(value);
        await this.plugin.saveSettings(true);
        this.scheduleDisplay();
      });
    }));

    applySettingsRow(new Setting(interfaceGroup)
      .setName(copy.general.autoOpen)
      .setDesc(zh ? "Obsidian 启动后自动打开 EchoInk 侧栏。" : "Open the EchoInk sidebar when Obsidian starts.")
      .addToggle((toggle) => {
        labelSettingsToggle(toggle, copy.general.autoOpen);
        toggle.setValue(this.plugin.settings.autoOpen).onChange(async (value) => {
          this.plugin.settings.autoOpen = value;
          await this.plugin.saveSettings();
        });
      }));

    applySettingsRow(new Setting(interfaceGroup)
      .setName(zh ? "首次设置" : "First-time setup")
      .setDesc(zh
        ? "重新打开 Provider、知识库和初始风格三步引导；不会重置已完成的设置。"
        : "Reopen the Provider, Knowledge, and initial-style guide without resetting completed setup.")
      .addButton((button) => button
        .setButtonText(zh ? "重新打开" : "Reopen")
        .onClick(() => void this.plugin.openEchoInkOnboarding())));

    applySettingsRow(new Setting(interfaceGroup)
      .setName(copy.general.autoOpenHome)
      .setDesc(zh ? "Obsidian 启动后显示 EchoInk 首页概览。" : "Show the EchoInk home overview when Obsidian starts.")
      .addToggle((toggle) => {
        labelSettingsToggle(toggle, copy.general.autoOpenHome);
        toggle.setValue(this.plugin.settings.autoOpenHome).onChange(async (value) => {
          this.plugin.settings.autoOpenHome = value;
          await this.plugin.saveSettings();
        });
      }));

    const memorySection = createSettingsSection(page, {
      title: zh ? "长期记忆" : "Long-term memory",
      surface: "group"
    });
    const memoryGroup = createSettingsGroup(memorySection);
    applySettingsRow(new Setting(memoryGroup)
      .setName(zh ? "使用长期记忆" : "Use long-term memory")
      .setDesc(zh
        ? "开启后，所有新旧对话都会读取长期记忆；关闭后，每次请求都强制不读写历史 Memory。身份与用户画像文件始终生效。"
        : "When enabled, every new and existing conversation can recall long-term memory. When disabled, every request is forced to skip historical Memory. Identity and user profile files always remain active.")
      .addToggle((toggle) => {
        labelSettingsToggle(toggle, zh ? "使用长期记忆" : "Use long-term memory");
        toggle.setValue(this.plugin.settings.memory.useLongTermMemory).onChange(async (enabled) => {
          this.plugin.settings.memory.useLongTermMemory = enabled;
          const mode = enabled ? "normal" : "no_memory";
          for (const session of this.plugin.settings.sessions) session.defaultMemoryMode = mode;
          await this.plugin.saveSettings(true);
          this.plugin.getCodexView()?.refreshPersonalizationUi();
        });
      }));

    // --- Dream scheduler settings ---
    applySettingsRow(new Setting(memoryGroup)
      .setName(zh ? "离线记忆整理（做梦）" : "Offline memory consolidation (dreaming)")
      .setDesc(zh
        ? "开启后，Obsidian 打开期间按定时在后台复盘一级记忆：生成二级事实，并更新用户画像、人格状态与 Agent 画像。"
        : "While Obsidian is open, periodically reviews primary memories on a timer: generates secondary facts and updates the user profile, personality state and Agent profile.")
      .addToggle((toggle) => {
        labelSettingsToggle(toggle, zh ? "离线记忆整理" : "Memory consolidation");
        toggle.setValue(this.plugin.settings.memory.dreamEnabled).onChange(async (enabled) => {
          this.plugin.settings.memory.dreamEnabled = enabled;
          await this.plugin.saveSettings();
        });
      }));

    applySettingsRow(new Setting(memoryGroup)
      .setName(zh ? "每日整理次数" : "Runs per day")
      .setDesc(zh
        ? `每天执行几次离线整理（1-6 次）。当前：${this.plugin.settings.memory.dreamRunsPerDay} 次/天，约每 ${Math.round(24 / this.plugin.settings.memory.dreamRunsPerDay)} 小时一次。`
        : `How many consolidation runs per day (1-6). Current: ${this.plugin.settings.memory.dreamRunsPerDay}/day, ~every ${Math.round(24 / this.plugin.settings.memory.dreamRunsPerDay)} hours.`)
      .addSlider((slider) => {
        slider.setLimits(1, 6, 1)
          .setValue(this.plugin.settings.memory.dreamRunsPerDay)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.memory.dreamRunsPerDay = value;
            await this.plugin.saveSettings();
            this.scheduleDisplay();
          });
      }));

    this.renderFilePersonalizationSettings(page);

    const conversationSection = createSettingsSection(page, {
      title: zh ? "对话显示" : "Conversation display",
      surface: "group"
    });
    const conversationGroup = createSettingsGroup(conversationSection);
    applySettingsRow(new Setting(conversationGroup)
      .setName(copy.general.showContext)
      .setDesc(zh ? "在对话顶部显示当前上下文容量和使用情况。" : "Show current context capacity and usage above conversations.")
      .addToggle((toggle) => {
        labelSettingsToggle(toggle, copy.general.showContext);
        toggle.setValue(this.plugin.settings.showContext).onChange(async (value) => {
          this.plugin.settings.showContext = value;
          await this.plugin.saveSettings();
        });
      }));
  }

  private renderFilePersonalizationSettings(page: HTMLElement): void {
    const zh = this.plugin.settings.settingsLanguage !== "en";
    const section = createSettingsSection(page, {
      title: zh ? "身份与用户画像" : "Identity and user profile",
      description: zh
        ? "Agent 画像由系统自动生成，不能手动编辑；用户画像由做梦与记忆修正自动维护。Agent 身份（名称和头像）可以随时修改，不影响人格或 Memory。"
        : "The Agent profile is auto-generated and cannot be edited manually; the user profile is maintained by dreaming and memory corrections. Agent identity (name and avatar) can be changed anytime without affecting personality or Memory.",
      surface: "group"
    });
    const group = createSettingsGroup(section);
    if (!this.personalMemoryState && !this.personalMemoryLoading && !this.personalMemoryError) {
      void this.loadPersonalMemoryState();
    }
    if (this.personalMemoryLoading) {
      createSettingsState(group, zh ? "正在读取画像数据…" : "Loading profile data…", "neutral");
      return;
    }
    if (!this.personalMemoryState) {
      createSettingsState(
        group,
        zh ? "画像数据暂时无法读取" : "Profile data is temporarily unavailable",
        "error",
        {
          label: zh ? "重新加载画像数据" : "Reload profile data",
          onActivate: () => void this.loadPersonalMemoryState(true)
        }
      );
      return;
    }
    // Agent identity (name + avatar): user-editable; never touches personality or Memory.
    this.addAgentIdentitySetting(group);
    // Agent profile: read-only hexagon card + collapsible text (no editing)
    this.addAgentProfileCard(group, this.personalMemoryState.agent);
    // User profile: read-only (maintained by dreaming / memory corrections)
    this.addReadOnlyUserProfileCard(group, this.personalMemoryState.user);
    applySettingsRow(new Setting(group)
      .setName(this.copy.general.showWelcome)
      .setDesc(this.copy.general.showWelcomeDesc)
      .addToggle((toggle) => {
        labelSettingsToggle(toggle, this.copy.general.showWelcome);
        toggle.setValue(this.plugin.settings.showWelcome).onChange(async (value) => {
          this.plugin.settings.showWelcome = value;
          await this.plugin.saveSettings(true);
          this.plugin.getCodexView()?.refreshPersonalizationUi();
        });
      }));

    this.renderAboutSection(page);
  }

  private renderAboutSection(page: HTMLElement): void {
    const zh = this.plugin.settings.settingsLanguage !== "en";
    const version = this.plugin.manifest.version ?? "unknown";

    const section = createSettingsSection(page, {
      title: zh ? "关于 EchoInk" : "About EchoInk",
      surface: "group"
    });
    const group = createSettingsGroup(section);

    // --- Plugin info card ---
    const card = group.createDiv({ cls: "echoink-about-card" });

    // Logo + name + version
    const header = card.createDiv({ cls: "echoink-about-header" });
    const logoWrap = header.createDiv({ cls: "echoink-about-logo" });
    logoWrap.innerHTML = `<svg width="36" height="36" viewBox="0 0 36 36" fill="none"><rect width="36" height="36" rx="10" fill="var(--interactive-accent)" fill-opacity="0.15"/><path d="M10 18c0-4.4 3.6-8 8-8s8 3.6 8 8-3.6 8-8 8" stroke="var(--interactive-accent)" stroke-width="2" stroke-linecap="round"/><circle cx="18" cy="18" r="2.5" fill="var(--interactive-accent)"/><path d="M18 10v3M18 23v3M10 18h3M23 18h3" stroke="var(--interactive-accent)" stroke-width="1.5" stroke-linecap="round" opacity="0.5"/></svg>`;
    const nameArea = header.createDiv({ cls: "echoink-about-name-area" });
    nameArea.createDiv({ cls: "echoink-about-name", text: "Codex EchoInk" });
    nameArea.createDiv({ cls: "echoink-about-version", text: `v${version}` });

    // Description
    card.createDiv({
      cls: "echoink-about-desc",
      text: zh
        ? "EchoInk 是一个 Obsidian 本地 AI 插件，让 Agent 拥有长期记忆、可演化的人格和知识库能力。所有数据留在你的 Vault 里，不上传任何云端。"
        : "EchoInk is a local Obsidian AI plugin that gives your Agent long-term memory, evolving personality, and knowledge base capabilities. All data stays in your Vault — nothing is uploaded to the cloud."
    });

    // Philosophy
    const philosophy = card.createDiv({ cls: "echoink-about-philosophy" });
    philosophy.createDiv({
      cls: "echoink-about-philosophy-title",
      text: zh ? "设计理念" : "Philosophy"
    });
    const principles = zh
      ? [
          "真实高于迎合 — Agent 不会为了讨好你而隐藏风险或伪造确定性",
          "记忆属于用户 — 所有记忆存在本地 Vault，你可随时查看、纠正、删除",
          "人格缓慢演化 — 不是你说一次就改，而是从对话和记忆中逐渐校准",
          "克制而非全能 — 只做该做的事，轻微变化保持安静"
        ]
      : [
          "Truth over flattery — Agent won't hide risks or fake certainty to please you",
          "Memory belongs to you — all memories live in your local Vault, always inspectable",
          "Personality evolves slowly — calibrated from conversations and memories, not instant overrides",
          "Restraint over omnipotence — does what's needed, stays quiet on minor changes"
        ];
    for (const p of principles) {
      const item = philosophy.createDiv({ cls: "echoink-about-principle" });
      item.createSpan({ cls: "echoink-about-principle-dot" });
      item.createSpan({ cls: "echoink-about-principle-text", text: p });
    }

    // --- Action buttons row ---
    const actions = card.createDiv({ cls: "echoink-about-actions" });

    // Star on GitHub button (sparkle animation)
    const starBtn = actions.createEl("a", {
      cls: "echoink-about-btn echoink-about-btn-star",
      attr: {
        href: "https://github.com/AKin-lvyifang/codex-echoink",
        target: "_blank",
        rel: "noopener noreferrer"
      }
    });
    const starIconWrap = starBtn.createSpan({ cls: "echoink-sparkle-icon-wrap" });
    // Default icon: GitHub
    const githubIcon = starIconWrap.createSpan({ cls: "echoink-sparkle-icon-default" });
    githubIcon.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.009-.866-.013-1.7-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.463-1.11-1.463-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.115 2.504.337 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.163 22 16.418 22 12c0-5.523-4.477-10-10-10z"/></svg>`;
    // Hover icon: Star (hidden by default)
    const starIcon = starIconWrap.createSpan({ cls: "echoink-sparkle-icon-hover" });
    starIcon.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" class="echoink-star-yellow"><path d="M12 2l2.4 7.6H22l-6.2 4.5 2.4 7.6-6.2-4.5-6.2 4.5 2.4-7.6L2 9.6h7.6z"/></svg>`;
    // Sparkle particles (appear on hover)
    const sparkle1 = starIconWrap.createSpan({ cls: "echoink-sparkle-particle echoink-sparkle-p1" });
    sparkle1.innerHTML = `<svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.4 7.6H22l-6.2 4.5 2.4 7.6-6.2-4.5-6.2 4.5 2.4-7.6L2 9.6h7.6z"/></svg>`;
    const sparkle2 = starIconWrap.createSpan({ cls: "echoink-sparkle-particle echoink-sparkle-p2" });
    sparkle2.innerHTML = `<svg width="6" height="6" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.4 7.6H22l-6.2 4.5 2.4 7.6-6.2-4.5-6.2 4.5 2.4-7.6L2 9.6h7.6z"/></svg>`;
    starBtn.createSpan({ cls: "echoink-about-btn-label", text: "Star on GitHub" });

    // Repo link button
    const repoBtn = actions.createEl("a", {
      cls: "echoink-about-btn echoink-about-btn-ghost",
      attr: {
        href: "https://github.com/AKin-lvyifang/codex-echoink",
        target: "_blank",
        rel: "noopener noreferrer"
      },
      text: zh ? "查看源码" : "Source Code"
    });

    // Issues link
    const issuesBtn = actions.createEl("a", {
      cls: "echoink-about-btn echoink-about-btn-ghost",
      attr: {
        href: "https://github.com/AKin-lvyifang/codex-echoink/issues",
        target: "_blank",
        rel: "noopener noreferrer"
      },
      text: zh ? "反馈问题" : "Report Issue"
    });
  }

  /**
   * Agent profile card: read-only projection of personality-state.json.
   * Template selection / reset persist the state and rewrite AGENT.md in ONE
   * local transaction — no Provider involved. Nothing here is manually editable.
   */
  private addAgentProfileCard(container: HTMLElement, agentContent: string): void {
    const zh = this.plugin.settings.settingsLanguage !== "en";
    const card = container.createDiv({ cls: "echoink-agent-profile-card" });

    // --- Header ---
    const header = card.createDiv({ cls: "echoink-agent-profile-card-header" });
    const titleArea = header.createDiv({ cls: "echoink-agent-profile-card-title-area" });
    titleArea.createDiv({ cls: "echoink-agent-profile-card-label", text: zh ? "Agent 画像" : "Agent profile" });
    titleArea.createSpan({
      cls: "echoink-agent-profile-card-badge",
      text: zh ? "自动生成" : "Auto-generated"
    });
    const expandBtn = header.createEl("button", {
      cls: "echoink-agent-profile-expand-btn",
      attr: { type: "button" }
    });
    const iconWrap = expandBtn.createSpan({ cls: "echoink-morph-icon-wrap" });
    const iconDefault = iconWrap.createSpan({ cls: "echoink-morph-icon-default" });
    iconDefault.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
    const iconHover = iconWrap.createSpan({ cls: "echoink-morph-icon-hover" });
    iconHover.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/></svg>`;
    const btnLabel = expandBtn.createSpan({
      cls: "echoink-morph-btn-label",
      text: zh ? "查看完整画像" : "Full profile"
    });
    header.createDiv({
      cls: "echoink-agent-profile-card-desc",
      text: zh
        ? "人格来自初始模板，并根据长期协作缓慢演化；不能直接修改六维数值。"
        : "Personality starts from the chosen template and evolves slowly through long-term collaboration; the six dimensions cannot be edited directly."
    });

    // --- Body: left hexagon + right trait bars ---
    const body = card.createDiv({ cls: "echoink-agent-profile-card-body" });
    const hexSide = body.createDiv({ cls: "echoink-agent-profile-hex-side" });
    // Round 6 修复八：六边形 SVG 挂在独立子节点上；重渲染只清空这个节点，
    // 轮廓说明文案是它的兄弟节点，不会被 empty() 误删。
    const hexChartMount = hexSide.createDiv({ cls: "echoink-trait-hexagon-mount" });
    const textSide = body.createDiv({ cls: "echoink-agent-profile-text-side" });
    // 图表、文字、模板和 Prompt 共享同一份维度常量（TRAIT_DIMENSION_META）。
    // 单向语义：数值越高 = 该特质表现越多；文案全部来自行为档 Meta。
    const dimLabels: [string, string, string][] = TRAIT_DIMENSIONS.map((dim) => {
      const meta = TRAIT_DIMENSION_META[dim];
      return [dim, zh ? meta.labelZh : meta.labelEn, ""];
    });
    const barFgs: HTMLElement[] = [];
    const pctSpans: HTMLElement[] = [];
    const barDescs: HTMLElement[] = [];
    for (let i = 0; i < dimLabels.length; i++) {
      const [dim, label] = dimLabels[i];
      const row = textSide.createDiv({ cls: "echoink-trait-row" });
      const head = row.createDiv({ cls: "echoink-trait-head" });
      head.createSpan({ cls: "echoink-trait-dim", text: label });
      const value = head.createSpan({ cls: "echoink-trait-value", text: "" });
      pctSpans.push(value);
      const barBg = row.createDiv({ cls: "echoink-trait-bar-bg" });
      const barFg = barBg.createDiv({ cls: "echoink-trait-bar-fg" });
      barFgs.push(barFg);
      const desc = textSide.createDiv({ cls: "echoink-trait-band-desc", text: "" });
      barDescs.push(desc);
      void dim;
    }
    // 人格轮廓说明：六边形表示行为特质强弱组合，不代表能力高低。
    hexSide.createDiv({
      cls: "echoink-trait-hexagon-caption",
      text: zh
        ? "人格轮廓表示六种行为特质的强弱组合，不代表 Agent 能力高低。"
        : "The personality profile shows six behavioral traits; area does not mean capability."
    });
    void body;

    // --- Footer ---
    const footer = card.createDiv({ cls: "echoink-agent-profile-card-footer" });
    const footerStatus = footer.createSpan({});
    footerStatus.setText(zh ? "正在读取人格状态…" : "Loading personality state…");
    const templateBtn = footer.createEl("button", {
      cls: "echoink-agent-profile-reselect",
      text: zh ? "初始风格选择" : "Choose initial style",
      attr: { type: "button" }
    });
    templateBtn.dataset.echoinkFocusKey = "general:personality-template";
    templateBtn.dataset.hasTemplate = "false";

    // --- Template picker panel (hidden by default) ---
    const pickerPanel = card.createDiv({ cls: "echoink-template-picker" });

    // --- Drawer (toggled by expand button) ---
    const drawer = card.createDiv({ cls: "echoink-agent-profile-drawer" });
    const drawerInner = drawer.createDiv({ cls: "echoink-agent-profile-drawer-inner" });
    const summaryCard = drawerInner.createDiv({ cls: "echoink-agent-profile-summary-card" });
    summaryCard.createDiv({ cls: "echoink-agent-profile-summary-title", text: zh ? "人格总结" : "Personality Summary" });
    const summaryText = summaryCard.createDiv({ cls: "echoink-agent-profile-summary-text" });
    summaryText.setText(zh ? "正在读取…" : "Loading…");
    drawerInner.createDiv({ cls: "echoink-agent-profile-raw-title", text: zh ? "画像文本" : "Profile text" });
    const rawPre = drawerInner.createEl("pre", {
      cls: "echoink-agent-profile-raw-text",
      text: agentContent
    });
    rawPre.setAttr("tabindex", "0");

    let isOpen = false;
    expandBtn.onclick = () => {
      isOpen = !isOpen;
      drawer.classList.toggle("is-open", isOpen);
      btnLabel.setText(isOpen
        ? (zh ? "收起画像" : "Collapse profile")
        : (zh ? "查看完整画像" : "Full profile"));
      expandBtn.classList.toggle("is-open", isOpen);
      if (isOpen) {
        // 做梦可能在后台更新了人格状态和 AGENT.md；展开时重新读取。
        void (async () => {
          try {
            const system = await this.plugin.getCognitiveSystem();
            const files = await system.readFixedFiles();
            rawPre.setText(files.agent);
          } catch { /* keep previous text */ }
          void this.loadPersonalityIntoCard(refs, zh);
        })();
      }
    };

    const refs: AgentProfileCardRefs = {
      hexSide, hexChartMount, barFgs, pctSpans, barDescs, dimLabels, footerStatus, templateBtn, pickerPanel, summaryText, rawPre
    };

    templateBtn.onclick = () => {
      // Round 6 修复三：fail-closed 状态下此按钮只是重试入口，
      // 禁止打开会覆盖现有数据的模板选择器。
      if (templateBtn.dataset.failClosed === "true") {
        void this.loadPersonalityIntoCard(refs, zh);
        return;
      }
      if (templateBtn.dataset.hasTemplate === "true") {
        // 重置人格（人格草案 §10.3）：每次都确认；确认后只打开模板列表，
        // 不修改任何文件；取消零写入，原人格继续生效。
        void confirmModal(
          this.app,
          zh ? "重置人格" : "Reset personality",
          zh
            ? "重置会把 Agent 当前人格恢复到你重新选择的模板，并清除当前自动演化结果。\n\n你的长期 Memory 不会被删除。只要相关记忆仍然存在，后续做梦很可能再次形成相似的处事和回复风格。若某条记忆不准确，请先到「复盘 → 记忆修正」中修正或忘记它。"
            : "Reset restores the Agent's personality to the template you pick next and clears the current auto-evolved results.\n\nYour long-term Memory will NOT be deleted. As long as the related memories remain, future dreaming will very likely re-form a similar style. If a memory is inaccurate, correct or forget it first in Review → Memory correction.",
          zh ? "继续选择模板" : "Continue to templates",
          zh ? "取消" : "Cancel"
        ).then((confirmed) => {
          if (!confirmed) return;
          // 确认后仅打开 8 套模板列表；真正写入只发生在选中新模板时。
          this.showTemplatePicker(refs, zh, { reset: true });
        });
      } else {
        this.showTemplatePicker(refs, zh);
      }
    };

    void this.loadPersonalityIntoCard(refs, zh);
  }

  private async loadPersonalityIntoCard(refs: AgentProfileCardRefs, zh: boolean): Promise<void> {
    try {
      const system = await this.plugin.getCognitiveSystem();
      const state = await system.readPersonalityState();
      // 读取成功：退出 fail-closed 态，按钮恢复模板选择/重置语义。
      refs.templateBtn.dataset.failClosed = "false";
      this.applyPersonalityToCard(refs, state, null, zh);
      refs.summaryText.setText(await system.renderPersonalitySummary(zh ? "zh" : "en"));
    } catch (error) {
      // Round 6 修复三：fail-closed（迁移失败/文件损坏/未知 schema）时显示
      // 明确错误与重试入口；不得显示「尚未选择初始风格」诱导用户覆盖现有数据。
      console.error("EchoInk personality state load failed", error);
      const reason = error instanceof Error ? error.message : String(error);
      refs.templateBtn.dataset.failClosed = "true";
      refs.templateBtn.setText(zh ? "重试读取人格" : "Retry loading personality");
      refs.footerStatus.setText(zh
        ? `人格数据暂不可用（${reason}），修复后点此重试`
        : `Personality data unavailable (${reason}). Retry after fixing.`);
    }
  }

  private applyPersonalityToCard(
    refs: AgentProfileCardRefs,
    state: PersonalityState,
    agentText: string | null,
    zh: boolean
  ): void {
    const scores = currentPersonalityScores(state);
    const template = state.templateId ? getPersonalityTemplate(state.templateId) : null;
    refs.templateBtn.dataset.hasTemplate = template ? "true" : "false";
    refs.templateBtn.setText(template
      ? (zh ? "重置人格" : "Reset personality")
      : (zh ? "初始风格选择" : "Choose initial style"));
    refs.footerStatus.setText(template
      ? (zh ? `基于「${template.labelZh}」模板` : `Template: ${template.labelEn}`)
      : (zh ? "尚未选择初始风格" : "No style selected yet"));
    const baseline = templateBaselineScores(state);
    void import("../ui/trait-hexagon").then(({ renderTraitHexagon }) => {
      // 只清空 SVG 挂载点；轮廓说明文案是兄弟节点，重渲染后仍然存在。
      refs.hexChartMount.empty();
      renderTraitHexagon(refs.hexChartMount, scores as Record<string, number> as never, {
        size: 170,
        rings: 4,
        // 同时显示模板基线与当前 observed 值。
        baselineScores: baseline ?? undefined
      });
    }).catch(() => {});
    for (let i = 0; i < refs.dimLabels.length; i++) {
      const dim = refs.dimLabels[i][0] as keyof typeof scores;
      const score = scores[dim] ?? 0.5;
      const behaviorBand = traitBehaviorBand(dim, score);
      refs.barFgs[i].style.width = `${Math.round(score * 100)}%`;
      refs.pctSpans[i].setText(
        `${Math.round(score * 100)} · ${zh ? behaviorBand.labelZh : behaviorBand.labelEn}`
      );
      refs.barDescs[i].setText(
        zh ? behaviorBand.uiDescriptionZh : behaviorBand.uiDescriptionEn
      );
    }
    if (agentText !== null) refs.rawPre.setText(agentText);
  }

  /** Inline picker: 8 templates; applying one is a single local transaction. */
  private showTemplatePicker(
    refs: AgentProfileCardRefs,
    zh: boolean,
    options?: Readonly<{ reset?: boolean }>
  ): void {
    const reset = Boolean(options?.reset);
    const panel = refs.pickerPanel;
    panel.empty();
    panel.addClass("is-visible");
    const stepLabel = panel.createDiv({ cls: "echoink-picker-step-label" });
    stepLabel.setText(zh
      ? (reset
          ? "选择新模板完成重置（取消不做任何修改）"
          : "选择一个最接近你期望的风格（本地立即生效，不调用模型）")
      : (reset
          ? "Pick a new template to finish the reset (cancel changes nothing)"
          : "Choose the closest style (applies locally and immediately, no model calls)"));
    const list = panel.createDiv({ cls: "echoink-picker-list" });

    // 描述统一来自 PERSONALITY_TEMPLATES 常量，不再在此重复维护（避免漂移）。

    for (const tpl of PERSONALITY_TEMPLATES) {
      const row = list.createEl("button", {
        cls: "echoink-picker-row",
        attr: { type: "button" }
      });
      row.createDiv({ cls: "echoink-picker-row-name" }).setText(zh ? tpl.labelZh : tpl.labelEn);
      row.createDiv({ cls: "echoink-picker-row-desc" }).setText(zh ? tpl.richDescZh : tpl.richDescEn);

      row.onclick = () => {
        row.setAttr("disabled", "true");
        void (async () => {
          try {
            const system = await this.plugin.getCognitiveSystem();
            const personality = await system.readPersonalityState();
            const identity = await system.readAgentIdentity();
            // Round 6 修复二：首次选择判定与底层共用同一语义
            // （initialTemplateSelectionStatus），不再叠加 personality.revision
            // 条件。尚无模板且尚无身份时才要求命名弹窗；取消时根本不会调用
            // selectPersonalityTemplate，因此取消 = 零写入。身份已存在但尚无
            // 模板时直接落模板，保留现有身份。
            const selection = initialTemplateSelectionStatus(personality, identity);
            const firstTime = !reset && selection.requiresFirstNaming;
            if (firstTime) {
              row.removeAttribute("disabled");
              this.openAgentIdentityModal({
                templateId: tpl.id,
                templateLabel: zh ? tpl.labelZh : tpl.labelEn,
                panel,
                refs,
                zh
              });
              return;
            }
            const result = await system.selectPersonalityTemplate(
              tpl.id,
              reset ? { reset: true } : undefined
            );
            this.applyPersonalityToCard(refs, result.state, result.agent, zh);
            refs.summaryText.setText(await system.renderPersonalitySummary(zh ? "zh" : "en"));
            await this.refreshIdentityAfterChange();
            new Notice(zh ? `已应用「${tpl.labelZh}」人格模板` : `Applied template: ${tpl.labelEn}`);
            panel.removeClass("is-visible");
            panel.empty();
          } catch (error) {
            console.error("EchoInk personality template selection failed", error);
            new Notice(zh ? "人格模板保存失败，请重试" : "Failed to save personality template");
          } finally {
            row.removeAttribute("disabled");
          }
        })();
      };
    }

    const cancelRow = panel.createDiv({ cls: "echoink-picker-cancel-row" });
    const cancelBtn = cancelRow.createEl("button", {
      cls: "echoink-picker-cancel-btn",
      text: zh ? "取消" : "Cancel",
      attr: { type: "button" }
    });
    cancelBtn.onclick = () => {
      panel.removeClass("is-visible");
      panel.empty();
    };
  }

  /**
   * 首次选择模板后的命名弹窗。确认前不写任何东西；取消只是关闭弹窗、
   * 模板选择面板保持打开，用户可继续换模板或退出。
   */
  private openAgentIdentityModal(context: Readonly<{
    templateId: string;
    templateLabel: string;
    panel: HTMLElement;
    refs: AgentProfileCardRefs;
    zh: boolean;
  }>): void {
    const { templateId, templateLabel, panel, refs, zh } = context;
    const modal = new AgentIdentityModal(this.plugin.app, {
      initialName: "",
      initialAvatar: Object.freeze({ kind: "default" }),
      language: zh ? "zh" : "en",
      mode: "first-run",
      presets: AGENT_AVATAR_PRESETS,
      onConfirm: async (draft) => {
        const system = await this.plugin.getCognitiveSystem();
        // 模板 + 名称 + 头像在同一个事务中落盘；失败时旧状态全部保留。
        const result = await system.selectPersonalityTemplate(templateId, {
          initialIdentity: { displayName: draft.displayName, avatar: draft.avatar }
        });
        this.applyPersonalityToCard(refs, result.state, result.agent, zh);
        refs.summaryText.setText(await system.renderPersonalitySummary(zh ? "zh" : "en"));
        await this.refreshIdentityAfterChange();
        new Notice(zh
          ? `已应用「${templateLabel}」人格模板，Agent 名称：${draft.displayName}`
          : `Applied template: ${templateLabel}. Agent name: ${draft.displayName}`);
        panel.removeClass("is-visible");
        panel.empty();
      }
    });
    modal.open();
  }

  /** 身份保存成功后：刷新设置页状态与对话区的消息头。 */
  private async refreshIdentityAfterChange(): Promise<void> {
    await this.loadPersonalMemoryState(true);
    this.plugin.getCodexView()?.refreshPersonalizationUi();
  }

  /**
   * 身份与用户画像页面顶部的「Agent 身份」卡片（草案 §8）：
   * 名称 + 头像只由用户在这里修改，绝不影响人格或 Memory。
   */
  private addAgentIdentitySetting(container: HTMLElement): void {
    const zh = this.plugin.settings.settingsLanguage !== "en";
    const identity = this.personalMemoryState?.agentIdentity ?? null;
    const personalityState = this.personalMemoryState?.personalityState ?? null;
    const hasTemplate = Boolean(personalityState && personalityState.templateId);
    const card = container.createDiv({ cls: "echoink-agent-identity-card" });

    const avatarEl = card.createDiv({ cls: "echoink-agent-identity-avatar" });
    const avatarUrl = identity ? resolveAgentAvatarUrl(identity.avatar) : null;
    if (avatarUrl) {
      avatarEl.createEl("img", { attr: { src: avatarUrl, alt: "" } });
    } else {
      avatarEl.addClass("is-default");
      setIcon(avatarEl, "bot");
    }

    const copy = card.createDiv({ cls: "echoink-agent-identity-copy" });
    copy.createDiv({
      cls: "echoink-agent-identity-name",
      text: identity ? identity.displayName : "EchoInk"
    });
    copy.createDiv({
      cls: "echoink-agent-identity-desc",
      text: !hasTemplate
        ? (zh ? "选择初始风格后设置名称与头像" : "Set a name and avatar after choosing a starting style")
        : (zh
            ? "名称和头像会显示在 Agent 回复旁；修改身份不会重置人格或 Memory。"
            : "Name and avatar appear next to the Agent's replies; editing identity never resets personality or Memory.")
    });

    const editButton = card.createEl("button", {
      cls: "echoink-agent-identity-edit",
      attr: { type: "button" },
      text: zh ? "编辑身份" : "Edit identity"
    });
    editButton.disabled = !hasTemplate;
    if (!identity && hasTemplate) {
      // 旧 Vault：人格模板已存在但没有身份文件 —— 显示默认值，可编辑，
      // 不强制弹窗。
      card.createSpan({ cls: "echoink-agent-identity-default-badge", text: zh ? "默认" : "Default" });
    }
    editButton.addEventListener("click", () => {
      const current = this.personalMemoryState?.agentIdentity ?? null;
      const modal = new AgentIdentityModal(this.plugin.app, {
        initialName: current?.displayName ?? "EchoInk",
        initialAvatar: current?.avatar ?? Object.freeze({ kind: "default" }),
        language: zh ? "zh" : "en",
        mode: "edit",
        presets: AGENT_AVATAR_PRESETS,
        onConfirm: async (draft) => {
          const system = await this.plugin.getCognitiveSystem();
          await system.updateAgentIdentity({
            displayName: draft.displayName,
            avatar: draft.avatar
          });
          await this.refreshIdentityAfterChange();
          new Notice(zh ? "Agent 身份已更新" : "Agent identity updated");
        }
      });
      modal.open();
    });
  }

  /** USER.md is maintained by dreaming / memory corrections — read-only here. */
  private addReadOnlyUserProfileCard(container: HTMLElement, userContent: string): void {
    const zh = this.plugin.settings.settingsLanguage !== "en";
    const card = container.createDiv({ cls: "echoink-agent-profile-card" });
    const header = card.createDiv({ cls: "echoink-agent-profile-card-header" });
    const titleArea = header.createDiv({ cls: "echoink-agent-profile-card-title-area" });
    titleArea.createDiv({ cls: "echoink-agent-profile-card-label", text: zh ? "用户画像" : "User profile" });
    titleArea.createSpan({
      cls: "echoink-agent-profile-card-badge",
      text: zh ? "只读" : "Read-only"
    });
    header.createDiv({
      cls: "echoink-agent-profile-card-desc",
      text: zh
        ? "用户画像由做梦与记忆修正自动维护，不提供手动编辑。"
        : "The user profile is maintained by dreaming and memory corrections; manual editing is not available."
    });
    const pre = card.createEl("pre", {
      cls: "echoink-agent-profile-raw-text",
      text: userContent
    });
    pre.setAttr("tabindex", "0");
  }

  /** 知识库初始化体验的唯一挂载点；渲染与状态都在 KnowledgeInitializationSection 内。 */
  private mountKnowledgeInitializationSection(page: HTMLElement, zh: boolean): void {
    if (!this.knowledgeInitSection) {
      this.knowledgeInitSection = new KnowledgeInitializationSection(
        this.plugin,
        () => this.scheduleDisplay()
      );
    }
    this.knowledgeInitSection.render(page, zh);
  }

  private renderKnowledgeBaseSettings(container: HTMLElement): void {
    const copy = this.copy;
    const zh = this.plugin.settings.settingsLanguage !== "en";
    if (this.settingsDetail === "knowledge-memory") {
      const page = createSettingsPage(container, {
        title: zh ? "长期记忆" : "Long-term memory",
        description: copy.knowledge.memoryNote1,
        detail: true,
        backLabel: zh ? "返回知识库" : "Back to Knowledge",
        onBack: () => void this.closeSettingsDetail()
      });
      this.renderSettingsActionError(page, "knowledge");
      const section = createSettingsSection(page, { surface: "group" });
      this.addKnowledgeBaseMemoryRecommendation(createSettingsGroup(section));
      return;
    }
    if (this.settingsDetail === "knowledge-preferences") {
      this.renderKnowledgeMaintenancePreferences(container);
      return;
    }

    if (
      !this.knowledgePreferenceState
      && !this.knowledgePreferenceLoading
      && !this.knowledgePreferenceLoadError
    ) void this.loadKnowledgePreferenceState();

    const page = createSettingsPage(container, {
      title: copy.knowledge.title,
      description: zh
        ? "在普通 EchoInk 会话中用 /ask 提问、用 /maintain 提炼。/ask 始终只读；显式 /maintain 会在一轮内安全写入并回读验证。"
        : "Use /ask and /maintain in a normal EchoInk conversation. /ask is always read-only; an explicit /maintain safely writes and verifies readback in one turn."
    });
    page.addClass("codex-knowledge-settings");
    this.renderSettingsActionError(page, "knowledge");

    this.mountKnowledgeInitializationSection(page, zh);

    const runSection = createSettingsSection(page, {
      title: zh ? "模型" : "Model",
      surface: "group"
    });
    const runGroup = createSettingsGroup(runSection);
    const availableProviders = this.plugin.settings.apiProviders.filter(
      apiProviderHasUsableApiKey
    );
    const modelSetting = applySettingsRow(new Setting(runGroup)
      .setName(zh ? "EchoInk 当前模型" : "Current EchoInk model")
      .setDesc(zh
        ? "普通聊天、/ask、/maintain 与选区翻译共用这个模型。"
        : "Chat, /ask, /maintain, and selection translation share this model.")
      .addDropdown((dropdown) => {
        dropdown.selectEl.setAttr("aria-label", zh ? "EchoInk 当前模型" : "Current EchoInk model");
        if (availableProviders.length === 0) {
          dropdown.addOption("", this.plugin.settings.apiProviders.length === 0
            ? (zh ? "尚无已保存模型" : "No saved models")
            : (zh ? "无可用模型" : "No available models"));
        }
        for (const provider of this.plugin.settings.apiProviders) {
          const apiKeyReady = apiProviderHasUsableApiKey(provider);
          const modelLabel = getApiProviderModelPreset(
            normalizeApiProviderId(provider.providerId, provider.baseUrl, provider.name),
            provider.model
          )?.displayName ?? provider.model;
          dropdown.addOption(
            provider.id,
            `${provider.name} · ${modelLabel}${apiKeyReady ? "" : (zh ? "（需重新保存 API Key）" : " (API key required)")}`
          );
          const option = Array.from(dropdown.selectEl.options).find(
            (item) => item.value === provider.id
          );
          if (option && !apiKeyReady) option.disabled = true;
        }
        dropdown
          .setValue(availableProviders.length === 0
            ? ""
            : this.plugin.settings.activeApiProviderId)
          .onChange(async (providerId) => {
            const target = this.plugin.settings.apiProviders.find(
              (provider) => provider.id === providerId
            );
            if (!target || !apiProviderHasUsableApiKey(target)) return;
            try {
              await this.plugin.activateApiProviderSettings((settings) => {
                const candidate = settings.apiProviders.find(
                  (provider) => provider.id === providerId
                );
                if (!candidate || !apiProviderHasUsableApiKey(candidate)) {
                  throw new Error("Provider API Key unavailable");
                }
                activateApiProvider(settings, candidate);
              });
              new Notice(zh
                ? `已切换到 ${target.name} · ${target.model}`
                : `Now using ${target.name} · ${target.model}`);
            } catch (error) {
              new Notice(error instanceof Error ? error.message : copy.providers.saveFailed);
            }
            this.scheduleDisplay();
          });
        dropdown.selectEl.disabled = availableProviders.length === 0;
      })
      .addButton((button) => button
        .setButtonText(zh ? "管理模型" : "Manage models")
        .onClick(() => void this.activateSettingsTab("providers", true))));
    modelSetting.settingEl.dataset.echoinkFocusKey = "knowledge:provider";

    const management = createSettingsSection(page, {
      title: zh ? "管理" : "Management",
      surface: "group"
    });
    const managementGroup = createSettingsGroup(management);
    createSettingsNavigationRow(managementGroup, {
      title: zh ? "知识提炼偏好" : "Knowledge refinement preferences",
      description: zh
        ? "调整关注维度、颗粒度、组织、融合和表达；固定六步、权限与安全边界不可编辑。"
        : "Adjust focus, granularity, organization, merging, and style. The fixed six steps and safety boundaries cannot be edited.",
      value: this.knowledgePreferenceLoading
        ? (zh ? "读取中" : "Loading")
        : this.knowledgePreferenceLoadError
          ? (zh ? "读取失败" : "Unavailable")
          : this.knowledgePreferenceState?.state === "custom"
            ? (zh ? "已自定义" : "Customized")
            : (zh ? "使用默认" : "Using default"),
      actionLabel: zh ? "编辑" : "Edit",
      focusKey: "knowledge:preferences",
      onActivate: () => this.openSettingsDetail("knowledge-preferences")
    });
    createSettingsNavigationRow(managementGroup, {
      title: zh ? "长期记忆" : "Long-term memory",
      description: copy.knowledge.memoryEnabledDesc,
      value: this.plugin.settings.memory.enabled ? copy.common.enabled : copy.common.disabled,
      actionLabel: zh ? "管理" : "Manage",
      focusKey: "knowledge:memory",
      onActivate: () => this.openSettingsDetail("knowledge-memory")
    });
  }

  private renderKnowledgeMaintenancePreferences(container: HTMLElement): void {
    const zh = this.plugin.settings.settingsLanguage !== "en";
    const page = createSettingsPage(container, {
      title: zh ? "知识提炼偏好" : "Knowledge refinement preferences",
      description: zh
        ? "固定提炼步骤不可编辑；偏好只影响下一次 /maintain。"
        : "The fixed refinement steps cannot be edited. Preferences affect only the next /maintain run.",
      detail: true,
      backLabel: zh ? "返回知识库" : "Back to Knowledge",
      onBack: () => void this.closeSettingsDetail()
    });

    const protocolSection = createSettingsSection(page, {
      title: zh ? "固定提炼步骤" : "Fixed refinement steps",
      description: zh
        ? "EchoInk 始终按以下六步执行，偏好文本不能改变显式命令授权、来源、写入目录、Raw 保护或 Personal Memory 禁用状态。"
        : "EchoInk always follows these six steps. Preference text cannot change explicit-command authorization, sources, write targets, Raw protection, or the Personal Memory boundary.",
      surface: "group"
    });
    const protocolGroup = createSettingsGroup(protocolSection);
    const protocolList = protocolGroup.createEl("ol", {
      cls: "echoink-knowledge-protocol-list"
    });
    for (const step of ECHOINK_KNOWLEDGE_MAINTENANCE_PROTOCOL_STEPS) {
      const item = protocolList.createEl("li", {
        cls: "echoink-knowledge-protocol-item"
      });
      item.createDiv({
        cls: "echoink-knowledge-protocol-title",
        text: step.title
      });
      item.createDiv({
        cls: "echoink-knowledge-protocol-description",
        text: step.instruction
      });
    }

    const preferenceSection = createSettingsSection(page, {
      title: zh ? "知识提炼偏好" : "Knowledge refinement preferences",
      description: zh
        ? "写你希望 EchoInk 关注什么、怎样拆分和融合，以及什么样的结果算好。"
        : "Describe what EchoInk should focus on, how it should split and merge knowledge, and what a good result looks like.",
      surface: "group"
    });
    const preferenceGroup = createSettingsGroup(preferenceSection);

    if (this.knowledgePreferenceLoading) {
      createSettingsState(
        preferenceGroup,
        zh ? "正在读取插件私有偏好…" : "Loading private plugin preferences…"
      );
      return;
    }
    if (this.knowledgePreferenceLoadError) {
      createSettingsState(
        preferenceGroup,
        zh
          ? "知识提炼偏好暂时无法读取。为避免覆盖现有内容，编辑器没有打开。"
          : "Preferences are temporarily unavailable. The editor remains closed to avoid overwriting existing content.",
        "error",
        {
          label: zh ? "重新加载" : "Reload",
          onActivate: () => void this.loadKnowledgePreferenceState(true)
        }
      );
      return;
    }
    const state = this.knowledgePreferenceState;
    const initialEditor = this.knowledgePreferenceEditor;
    let editor = initialEditor;
    if (!state || !editor) {
      if (!this.knowledgePreferenceLoading) void this.loadKnowledgePreferenceState();
      createSettingsState(
        preferenceGroup,
        zh ? "正在准备编辑器…" : "Preparing editor…"
      );
      return;
    }
    const loadedEditor: Readonly<KnowledgeMaintenancePreferenceEditorState> =
      editor;

    const row = applySettingsRow(new Setting(preferenceGroup)
      .setName(zh ? "偏好 Markdown" : "Preference Markdown")
      .setDesc(zh
        ? "保存在插件私有目录；不会写入 Vault 知识文件。"
        : "Stored in the plugin-private directory and never written into Vault knowledge files.")
      .setClass("echoink-personalization-instruction-row")
      .setClass("echoink-knowledge-preference-row"));
    row.controlEl.empty();
    const textarea = row.controlEl.createEl("textarea", {
      cls: "echoink-personalization-textarea echoink-knowledge-preference-textarea",
      attr: {
        rows: "16",
        maxlength: String(64 * 1024),
        "aria-label": zh ? "知识提炼偏好 Markdown" : "Knowledge refinement preference Markdown",
        "data-echoink-focus-key": "knowledge:preferences:editor"
      }
    });
    textarea.value = loadedEditor.draftContent;
    const status = row.controlEl.createDiv({
      cls: "echoink-knowledge-preference-status",
      attr: { role: "status", "aria-live": "polite" }
    });
    const error = row.controlEl.createDiv({
      cls: "codex-settings-inline-error echoink-knowledge-preference-error",
      attr: { role: "alert" }
    });
    const actions = row.controlEl.createDiv({
      cls: "echoink-personalization-actions"
    });
    const restore = actions.createEl("button", {
      text: zh ? "恢复 EchoInk 默认" : "Restore EchoInk default",
      attr: {
        type: "button",
        "data-echoink-focus-key": "knowledge:preferences:restore"
      }
    });
    const save = actions.createEl("button", {
      text: zh ? "保存" : "Save",
      attr: {
        type: "button",
        "data-echoink-focus-key": "knowledge:preferences:save"
      }
    });

    const syncControls = () => {
      const currentEditor: Readonly<KnowledgeMaintenancePreferenceEditorState> =
        this.knowledgePreferenceEditor ?? loadedEditor;
      editor = currentEditor;
      const dirty = knowledgeMaintenancePreferenceIsDirty(currentEditor);
      const draftState = knowledgeMaintenancePreferenceDraftState(
        currentEditor
      );
      status.setText([
        draftState === "default"
          ? (zh ? "使用 EchoInk 默认" : "Using EchoInk default")
          : (zh ? "已自定义" : "Customized"),
        dirty
          ? (zh ? "有未保存修改" : "Unsaved changes")
          : (zh ? "已保存" : "Saved"),
        currentEditor.saving
          ? (zh ? "正在保存…" : "Saving…")
          : ""
      ].filter(Boolean).join(" · "));
      error.setText(currentEditor.error ?? "");
      error.toggleClass("is-visible", Boolean(currentEditor.error));
      textarea.setAttr("aria-invalid", String(Boolean(currentEditor.error)));
      textarea.disabled = currentEditor.saving;
      restore.disabled = currentEditor.saving || draftState === "default";
      save.disabled = currentEditor.saving || !dirty;
      save.toggleClass("mod-cta", dirty && !currentEditor.saving);
      save.setText(currentEditor.saving
        ? (zh ? "保存中…" : "Saving…")
        : (zh ? "保存" : "Save"));
    };

    textarea.oninput = () => {
      const current = this.knowledgePreferenceEditor;
      if (!current || current.saving) return;
      this.knowledgePreferenceEditor = editKnowledgeMaintenancePreference(
        current,
        textarea.value
      );
      syncControls();
    };
    restore.onclick = () => {
      const current = this.knowledgePreferenceEditor;
      if (!current || current.saving) return;
      this.knowledgePreferenceEditor =
        restoreDefaultKnowledgeMaintenancePreference(current);
      textarea.value = this.knowledgePreferenceEditor.draftContent;
      syncControls();
      textarea.focus();
    };
    save.onclick = () => void this.saveKnowledgePreference(textarea.value);
    syncControls();
  }

  private renderReviewSettings(container: HTMLElement): void {
    const copy = this.copy;
    const settings = this.plugin.settings.review;
    const zh = this.plugin.settings.settingsLanguage !== "en";
    if (this.settingsDetail === "review-archives") {
      this.renderArchivedConversationSettings(container);
      return;
    }
    if (this.settingsDetail === "review-memory") {
      this.renderPersonalMemoryCorrectionCategories(container);
      return;
    }
    if (
      typeof this.settingsDetail === "object"
      && this.settingsDetail?.kind === "review-memory-category"
    ) {
      this.renderPersonalMemoryCorrectionRecords(
        container,
        this.settingsDetail.category
      );
      return;
    }
    const page = createSettingsPage(container, {
      title: copy.review.title,
      description: zh
        ? "生成本地周报，并管理从聊天列表移出的历史会话。"
        : "Generate local weekly summaries and manage conversations removed from chat."
    });
    page.addClass("codex-review-settings");
    this.renderSettingsActionError(page, "review");

    const generation = createSettingsSection(page, { surface: "flat" });
    const summary = createSettingsFeatureCard(
      generation,
      copy.review.generateHeading,
      zh
        ? "选择来源、统计周期和保存文件夹；生成结果只保留在所选目录。"
        : "Choose the source, date range, and destination folder. Generated files stay in that folder."
    );
    const actions = summary.createDiv({ cls: "echoink-settings-feature-actions" });
    this.addReviewAction(actions, copy.review.generateAgent, "agent-chat");
    this.addReviewAction(actions, copy.review.generateKnowledge, "knowledge-base");
    const controls = createSettingsGroup(summary);
    const outputSetting = applySettingsRow(new Setting(controls)
      .setName(copy.review.outputDir)
      .setDesc(zh ? "默认保存到 outputs，也可选择当前 Vault 内任意文件夹。" : "Defaults to outputs; choose any folder in this Vault.")
      .addText((text) => {
        text.inputEl.setAttr("aria-label", copy.review.outputDir);
        text.setValue(settings.outputDir === "." ? (zh ? "Vault 根目录" : "Vault root") : settings.outputDir);
        text.inputEl.readOnly = true;
      })
      .addButton((button) => button
        .setButtonText(zh ? "选择" : "Choose")
        .onClick(() => void this.chooseReviewOutputFolder())));
    outputSetting.settingEl.dataset.echoinkFocusKey = "review:output-dir";
    this.addReviewRangeMode(controls);
    this.addReviewOpenAfterRun(controls);

    const management = createSettingsSection(page, {
      title: zh ? "管理" : "Management",
      surface: "group"
    });
    const managementGroup = createSettingsGroup(management);
    createSettingsNavigationRow(managementGroup, {
      title: zh ? "已归档会话" : "Archived conversations",
      description: zh
        ? "搜索、恢复或从 EchoInk 列表软删除已归档会话；原始 Pi Session JSONL 始终保留。"
        : "Search, restore, or soft-delete archived conversations. Original Pi Session JSONL remains intact.",
      value: this.archivedConversations
        ? String(this.archivedConversations.length)
        : (zh ? "查看" : "View"),
      actionLabel: zh ? "打开" : "Open",
      focusKey: "review:archives",
      onActivate: () => this.openSettingsDetail("review-archives")
    });
    createSettingsNavigationRow(managementGroup, {
      title: zh ? "记忆修正" : "Memory correction",
      description: zh
        ? "按五类浏览当前 Memory；修正先由当前模型生成预览，确认后才创建新版本。"
        : "Browse current Memory in five categories. The current model creates a preview before any new version is written.",
      value: this.personalMemoryState
        ? String(this.personalMemoryState.records.filter((record) => record.status === "current").length)
        : (zh ? "查看" : "View"),
      actionLabel: zh ? "打开" : "Open",
      focusKey: "review:memory",
      onActivate: () => this.openSettingsDetail("review-memory")
    });
  }

  private async chooseReviewOutputFolder(): Promise<void> {
    const zh = this.plugin.settings.settingsLanguage !== "en";
    const folders = this.app.vault.getAllFolders(true)
      .map((folder) => folder.path || ".")
      .sort((left, right) => left.localeCompare(right, "zh-CN"));
    const selected = await selectInputModal(
      this.app,
      zh ? "选择周报保存文件夹" : "Choose report folder",
      zh ? "Vault 文件夹" : "Vault folder",
      folders.map((folder) => ({
        value: folder,
        label: folder === "." ? (zh ? "Vault 根目录" : "Vault root") : folder
      }))
    );
    if (!selected) return;
    this.plugin.settings.review.outputDir = normalizeReviewOutputDir(
      selected,
      DEFAULT_SETTINGS.review.outputDir
    );
    await this.plugin.saveSettings();
    this.scheduleDisplay();
  }

  private renderArchivedConversationSettings(container: HTMLElement): void {
    const zh = this.plugin.settings.settingsLanguage !== "en";
    const page = createSettingsPage(container, {
      title: zh ? "已归档会话" : "Archived conversations",
      description: zh
        ? "恢复后会话立即回到活动列表；删除只改变 Catalog 状态，不物理删除 Pi Session JSONL。"
        : "Restored conversations return to the active list immediately. Delete only changes Catalog state and never removes Pi Session JSONL.",
      detail: true,
      backLabel: zh ? "返回复盘" : "Back to Review",
      onBack: () => void this.closeSettingsDetail()
    });
    if (!this.archivedConversations && !this.archivedConversationsLoading && !this.archivedConversationsError) {
      void this.loadArchivedConversations();
    }
    const search = page.createEl("input", {
      cls: "codex-session-search-input echoink-review-archive-search",
      attr: {
        type: "search",
        placeholder: zh ? "搜索已归档会话" : "Search archived conversations",
        "aria-label": zh ? "搜索已归档会话" : "Search archived conversations",
        "data-echoink-focus-key": "review:archives:search"
      }
    });
    search.value = this.archivedConversationQuery;
    search.oninput = () => {
      this.archivedConversationQuery = search.value;
      this.settingsFocusIntent = "explicit:review:archives:search";
      this.scheduleDisplay();
    };

    const section = createSettingsSection(page, {
      title: zh
        ? `已归档 ${this.archivedConversations?.length ?? 0}`
        : `Archived ${this.archivedConversations?.length ?? 0}`,
      surface: "group"
    });
    const list = createSettingsCompactList(section);
    if (this.archivedConversationsLoading) {
      createSettingsState(list, zh ? "正在读取已归档会话…" : "Loading archived conversations…");
      return;
    }
    if (this.archivedConversationsError) {
      createSettingsState(list, zh ? "暂时无法读取已归档会话。" : "Archived conversations are unavailable.", "error", {
        label: zh ? "重试" : "Retry",
        onActivate: () => void this.loadArchivedConversations(true)
      });
      return;
    }
    const query = this.archivedConversationQuery.trim().toLocaleLowerCase("zh-CN");
    const entries = (this.archivedConversations ?? []).filter((entry) =>
      !query || entry.title.toLocaleLowerCase("zh-CN").includes(query)
    );
    if (!entries.length) {
      createSettingsState(list, query
        ? (zh ? "没有匹配的已归档会话。" : "No archived conversations match.")
        : (zh ? "暂无已归档会话。" : "No archived conversations."));
      return;
    }
    for (const entry of entries) {
      const busy = this.archivedConversationBusyId === entry.conversationId;
      const row = list.createDiv({ cls: "echoink-settings-compact-row" });
      row.setAttr("aria-busy", String(busy));
      const rowCopy = row.createDiv({ cls: "echoink-settings-compact-copy" });
      rowCopy.createDiv({ cls: "echoink-settings-compact-title", text: entry.title });
      rowCopy.createDiv({
        cls: "echoink-settings-compact-description",
        text: `${zh ? "归档时间" : "Archived"} · ${new Date(entry.updatedAt).toLocaleString()}`
      });
      const rowActions = row.createDiv({ cls: "echoink-settings-compact-actions" });
      const restore = rowActions.createEl("button", {
        text: busy ? (zh ? "处理中…" : "Working…") : (zh ? "恢复" : "Restore"),
        attr: { type: "button", "aria-label": `${zh ? "恢复" : "Restore"} ${entry.title}` }
      });
      restore.disabled = Boolean(this.archivedConversationBusyId);
      restore.onclick = () => void this.restoreArchivedConversation(entry);
      const remove = rowActions.createEl("button", {
        text: zh ? "删除" : "Delete",
        cls: "mod-warning",
        attr: { type: "button", "aria-label": `${zh ? "删除" : "Delete"} ${entry.title}` }
      });
      remove.disabled = Boolean(this.archivedConversationBusyId);
      remove.onclick = () => void this.softDeleteArchivedConversation(entry);
    }
  }

  private async loadArchivedConversations(force = false): Promise<void> {
    if (this.archivedConversationsLoading || (this.archivedConversations && !force)) return;
    this.archivedConversationsLoading = true;
    this.archivedConversationsError = "";
    this.scheduleDisplay();
    try {
      this.archivedConversations = Object.freeze(
        [...await this.plugin.listPiConversations(["archived"])]
          .filter((entry) => entry.status === "archived")
          .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt)
      );
    } catch (error) {
      this.archivedConversations = null;
      this.archivedConversationsError = error instanceof Error ? error.message : String(error);
    } finally {
      this.archivedConversationsLoading = false;
      this.scheduleDisplay();
    }
  }

  private async restoreArchivedConversation(entry: Readonly<PiConversationCatalogEntry>): Promise<void> {
    if (this.archivedConversationBusyId) return;
    this.archivedConversationBusyId = entry.conversationId;
    this.scheduleDisplay();
    try {
      await this.plugin.setPiConversationStatus(entry.conversationId, "active");
      this.removeArchivedConversation(entry.conversationId);
      await this.plugin.getCodexView()?.refreshPiConversationCatalog();
      new Notice(`${this.plugin.settings.settingsLanguage === "en" ? "Restored" : "已恢复"}“${entry.title}”`);
    } catch (error) {
      this.archivedConversationsError = error instanceof Error ? error.message : String(error);
    } finally {
      this.archivedConversationBusyId = "";
      this.scheduleDisplay();
    }
  }

  private async softDeleteArchivedConversation(entry: Readonly<PiConversationCatalogEntry>): Promise<void> {
    if (this.archivedConversationBusyId) return;
    const accepted = await confirmModal(
      this.app,
      `${this.plugin.settings.settingsLanguage === "en" ? "Delete" : "删除已归档会话"}“${entry.title}”？`,
      this.plugin.settings.settingsLanguage === "en"
        ? "The conversation leaves EchoInk, but its Pi Session JSONL remains on disk."
        : "会话会从 EchoInk 列表移除，但 Pi Session JSONL 不会物理删除。",
      this.plugin.settings.settingsLanguage === "en" ? "Delete" : "删除",
      this.plugin.settings.settingsLanguage === "en" ? "Cancel" : "取消"
    );
    if (!accepted) return;
    this.archivedConversationBusyId = entry.conversationId;
    this.scheduleDisplay();
    try {
      await this.plugin.setPiConversationStatus(entry.conversationId, "deleted");
      this.removeArchivedConversation(entry.conversationId);
      new Notice(`${this.plugin.settings.settingsLanguage === "en" ? "Deleted" : "已删除"}“${entry.title}”；Pi Session JSONL 已保留`);
    } catch (error) {
      this.archivedConversationsError = error instanceof Error ? error.message : String(error);
    } finally {
      this.archivedConversationBusyId = "";
      this.scheduleDisplay();
    }
  }

  private removeArchivedConversation(conversationId: string): void {
    this.archivedConversations = Object.freeze(
      (this.archivedConversations ?? []).filter((entry) => entry.conversationId !== conversationId)
    );
  }

  private renderPersonalMemoryCorrectionCategories(container: HTMLElement): void {
    const zh = this.plugin.settings.settingsLanguage !== "en";
    const page = createSettingsPage(container, {
      title: zh ? "记忆修正" : "Memory correction",
      description: zh
        ? "这里只显示仍然生效的 Memory 内容，不展示文件名、路径、内部 ID、revision 或来源 URI。"
        : "Only current Memory content appears here. File names, paths, internal IDs, revisions, and source URIs stay hidden.",
      detail: true,
      backLabel: zh ? "返回复盘" : "Back to Review",
      onBack: () => void this.closeSettingsDetail()
    });
    if (!this.personalMemoryState && !this.personalMemoryLoading && !this.personalMemoryError) {
      void this.loadPersonalMemoryState();
    }
    const section = createSettingsSection(page, {
      title: zh ? "Memory 分类" : "Memory categories",
      surface: "group"
    });
    const group = createSettingsGroup(section);
    if (this.personalMemoryLoading) {
      createSettingsState(group, zh ? "正在读取当前 Memory…" : "Loading current Memory…");
      return;
    }
    if (!this.personalMemoryState) {
      createSettingsState(group, zh ? "当前 Memory 暂时无法读取。" : "Current Memory is unavailable.", "error", {
        label: zh ? "重试" : "Retry",
        onActivate: () => void this.loadPersonalMemoryState(true)
      });
      return;
    }
    for (const category of PERSONAL_MEMORY_CORRECTION_CATEGORIES) {
      const count = this.currentPersonalMemoryRecords(category.id).length;
      createSettingsNavigationRow(group, {
        title: zh ? category.labelZh : category.labelEn,
        description: zh ? category.descriptionZh : category.descriptionEn,
        value: String(count),
        actionLabel: zh ? "查看" : "View",
        focusKey: `review:memory:${category.id}`,
        onActivate: () => this.openSettingsDetail({
          kind: "review-memory-category",
          category: category.id
        })
      });
    }
  }

  private renderPersonalMemoryCorrectionRecords(
    container: HTMLElement,
    categoryId: PersonalMemoryCorrectionCategory
  ): void {
    const zh = this.plugin.settings.settingsLanguage !== "en";
    const category = personalMemoryCorrectionCategory(categoryId);
    const page = createSettingsPage(container, {
      title: zh ? category.labelZh : category.labelEn,
      description: zh ? category.descriptionZh : category.descriptionEn,
      detail: true,
      backLabel: zh ? "返回记忆修正" : "Back to Memory correction",
      onBack: () => {
        this.settingsDetail = "review-memory";
        this.settingsFocusIntent = `explicit:review:memory:${category.id}`;
        this.scheduleDisplay();
      }
    });
    const section = createSettingsSection(page, { surface: "group" });
    const list = createSettingsCompactList(section);
    if (this.personalMemoryLoading) {
      createSettingsState(list, zh ? "正在读取当前 Memory…" : "Loading current Memory…");
      return;
    }
    if (!this.personalMemoryState) {
      createSettingsState(list, zh ? "当前 Memory 暂时无法读取。" : "Current Memory is unavailable.", "error", {
        label: zh ? "重试" : "Retry",
        onActivate: () => void this.loadPersonalMemoryState(true)
      });
      return;
    }
    const records = this.currentPersonalMemoryRecords(category.id);
    if (!records.length) {
      createSettingsState(list, zh ? "这一类暂无当前记录。" : "No current records in this category.");
      return;
    }
    for (const [recordIndex, record] of records.entries()) {
      const row = list.createDiv({ cls: "echoink-settings-compact-row echoink-memory-correction-row" });
      const copy = row.createDiv({ cls: "echoink-settings-compact-copy" });
      copy.createDiv({ cls: "echoink-settings-compact-title", text: record.title });
      copy.createDiv({ cls: "echoink-settings-compact-description", text: record.content });
      copy.createDiv({
        cls: "echoink-settings-feature-meta",
        text: `${zh ? "何时可能想起" : "When it may be recalled"}：${record.recallWhen}`
      });
      const actions = row.createDiv({ cls: "echoink-settings-compact-actions" });
      const correct = actions.createEl("button", {
        text: zh ? "修正" : "Correct",
        attr: {
          type: "button",
          "aria-label": `${zh ? "修正" : "Correct"} ${record.title}`,
          "data-echoink-focus-key": `review:memory:${category.id}:correct:${recordIndex}`
        }
      });
      correct.disabled = this.memoryActionRunning;
      correct.onclick = () => void this.correctPersonalMemoryRecord(record);

      // --- Secondary facts (二级事实 · LLM 推理): collapsed by default ---
      const secWrap = row.createDiv({ cls: "echoink-secondary-facts" });
      const secToggle = secWrap.createEl("button", {
        cls: "echoink-secondary-facts-toggle",
        attr: { type: "button" }
      });
      secToggle.setText(zh ? "二级事实·LLM 推理（…）" : "Secondary facts · LLM inferred (…)");
      const secPanel = secWrap.createDiv({ cls: "echoink-secondary-facts-panel" });
      secPanel.addClass("is-hidden");
      let secOpen = false;
      let secLoaded = false;
      const refreshSecondaryPanel = async (): Promise<void> => {
        try {
          const system = await this.plugin.getCognitiveSystem();
          const facts = [...(await system.listSecondaryForParent(record.id))]
            .filter((fact) => fact.status === "current");
          secToggle.setText(zh
            ? `二级事实·LLM 推理（${facts.length}）`
            : `Secondary facts · LLM inferred (${facts.length})`);
          if (!secOpen) return;
          secPanel.empty();
          if (!facts.length) {
            secPanel.createDiv({
              cls: "echoink-secondary-empty",
              text: zh ? "做梦还没有为这条记忆生成二级事实。" : "Dreaming has not generated secondary facts for this memory yet."
            });
            return;
          }
          for (const fact of facts) {
            this.renderSecondaryFactRow(secPanel, fact, zh, () => void refreshSecondaryPanel());
          }
        } catch (error) {
          console.error("EchoInk secondary facts load failed", error);
          secToggle.setText(zh ? "二级事实读取失败" : "Failed to load secondary facts");
        }
      };
      secToggle.onclick = () => {
        secOpen = !secOpen;
        secPanel.toggleClass("is-hidden", !secOpen);
        if (secOpen && !secLoaded) secLoaded = true;
        void refreshSecondaryPanel();
      };
      void refreshSecondaryPanel();
    }
  }

  private renderSecondaryFactRow(
    panel: HTMLElement,
    fact: Readonly<import("../harness/memory/personal-memory-contracts").SecondaryMemoryRecord>,
    zh: boolean,
    onMutated: () => void
  ): void {
    const factRow = panel.createDiv({ cls: "echoink-secondary-fact-row" });
    const head = factRow.createDiv({ cls: "echoink-secondary-fact-head" });
    head.createSpan({
      cls: "echoink-secondary-fact-badge",
      text: fact.basis === "user_edited_inference"
        ? (zh ? "二级事实·用户修正" : "Secondary fact · User edited")
        : (zh ? "二级事实·LLM 推理" : "Secondary fact · LLM inferred")
    });
    const relationLabels: Record<string, string> = {
      category: zh ? "分类" : "category",
      instance: zh ? "具体实例" : "instance",
      attribute: zh ? "属性" : "attribute",
      context: zh ? "情境" : "context",
      associated: zh ? "关联" : "associated"
    };
    head.createSpan({
      cls: "echoink-secondary-fact-badge",
      text: relationLabels[fact.relation] ?? fact.relation
    });
    head.createSpan({
      cls: "echoink-secondary-fact-badge",
      text: fact.confidence >= 0.75
        ? (zh ? "高置信度" : "High confidence")
        : fact.confidence >= 0.6
          ? (zh ? "中置信度" : "Medium confidence")
          : (zh ? "低置信度" : "Low confidence")
    });
    head.createSpan({ cls: "echoink-secondary-fact-title", text: fact.title });
    factRow.createDiv({ cls: "echoink-secondary-fact-content", text: fact.content });
    factRow.createDiv({
      cls: "echoink-settings-feature-meta",
      text: `${zh ? "联想词" : "Match terms"}：${fact.matchTerms.join("、") || "—"}`
    });
    if (fact.reason) {
      factRow.createDiv({
        cls: "echoink-settings-feature-meta",
        text: `${zh ? "依据" : "Reason"}：${fact.reason}`
      });
    }
    const factActions = factRow.createDiv({ cls: "echoink-secondary-fact-actions" });
    const editBtn = factActions.createEl("button", {
      text: zh ? "编辑" : "Edit",
      attr: { type: "button" }
    });
    const deleteBtn = factActions.createEl("button", {
      text: zh ? "删除" : "Delete",
      attr: { type: "button" }
    });
    editBtn.onclick = () => this.openSecondaryFactEditor(factRow, fact, zh, onMutated);
    deleteBtn.onclick = () => {
      void confirmModal(
        this.app,
        zh ? "删除二级事实" : "Delete secondary fact",
        zh
          ? `确定删除「${fact.title}」这条二级事实吗？一级记忆不受影响。`
          : `Delete the secondary fact "${fact.title}"? The primary memory is not affected.`,
        zh ? "删除" : "Delete",
        zh ? "取消" : "Cancel"
      ).then((confirmed) => {
        if (!confirmed) return;
        void (async () => {
          try {
            const system = await this.plugin.getCognitiveSystem();
            await system.deleteSecondaryFact(fact.id);
            new Notice(zh ? "二级事实已删除" : "Secondary fact deleted");
            onMutated();
          } catch (error) {
            console.error("EchoInk secondary fact delete failed", error);
            new Notice(zh ? "删除失败，请重试" : "Delete failed; please retry");
          }
        })();
      });
    };
  }

  private openSecondaryFactEditor(
    factRow: HTMLElement,
    fact: Readonly<import("../harness/memory/personal-memory-contracts").SecondaryMemoryRecord>,
    zh: boolean,
    onMutated: () => void
  ): void {
    factRow.empty();
    const titleInput = factRow.createEl("input", {
      cls: "echoink-secondary-edit-input",
      attr: { type: "text", placeholder: zh ? "标题" : "Title" }
    });
    titleInput.value = fact.title;
    const contentArea = factRow.createEl("textarea", {
      cls: "echoink-secondary-edit-textarea",
      attr: { rows: "3", placeholder: zh ? "内容" : "Content" }
    });
    contentArea.value = fact.content;
    const recallInput = factRow.createEl("input", {
      cls: "echoink-secondary-edit-input",
      attr: { type: "text", placeholder: zh ? "何时可能想起" : "When it may be recalled" }
    });
    recallInput.value = fact.recallWhen;
    const termsInput = factRow.createEl("input", {
      cls: "echoink-secondary-edit-input",
      attr: {
        type: "text",
        placeholder: zh ? "联想词（用逗号分隔，最多 5 个）" : "Match terms (comma separated, max 5)"
      }
    });
    termsInput.value = fact.matchTerms.join(", ");
    const reasonInput = factRow.createEl("input", {
      cls: "echoink-secondary-edit-input",
      attr: { type: "text", placeholder: zh ? "推理依据（可选）" : "Reason (optional)" }
    });
    reasonInput.value = fact.reason;
    const editorActions = factRow.createDiv({ cls: "echoink-secondary-fact-actions" });
    const saveBtn = editorActions.createEl("button", {
      text: zh ? "保存" : "Save",
      attr: { type: "button" }
    });
    const cancelBtn = editorActions.createEl("button", {
      text: zh ? "取消" : "Cancel",
      attr: { type: "button" }
    });
    cancelBtn.onclick = () => onMutated();
    saveBtn.onclick = () => {
      saveBtn.setAttr("disabled", "true");
      void (async () => {
        try {
          const system = await this.plugin.getCognitiveSystem();
          await system.updateSecondaryFact(fact.id, {
            title: titleInput.value,
            content: contentArea.value,
            recallWhen: recallInput.value,
            matchTerms: termsInput.value.split(/[,，]/u).map((term) => term.trim()).filter(Boolean),
            reason: reasonInput.value.trim()
          });
          new Notice(zh ? "二级事实已更新" : "Secondary fact updated");
          onMutated();
        } catch (error) {
          console.error("EchoInk secondary fact edit failed", error);
          new Notice(zh ? "保存失败，请重试" : "Save failed; please retry");
          saveBtn.removeAttribute("disabled");
        }
      })();
    };
  }

  private currentPersonalMemoryRecords(
    categoryId: PersonalMemoryCorrectionCategory
  ): readonly Readonly<PersonalMemoryRecord>[] {
    const kinds = new Set(personalMemoryCorrectionCategory(categoryId).kinds);
    return Object.freeze(
      [...(this.personalMemoryState?.records ?? [])]
        .filter((record) => record.status === "current" && kinds.has(record.kind))
        .sort((left, right) =>
          right.date.localeCompare(left.date)
          || left.title.localeCompare(right.title, "zh-CN")
        )
    );
  }

  private async correctPersonalMemoryRecord(
    record: Readonly<PersonalMemoryRecord>
  ): Promise<void> {
    if (this.memoryActionRunning) return;
    const zh = this.plugin.settings.settingsLanguage !== "en";
    const state = this.personalMemoryState;
    if (!state || record.status !== "current") return;
    this.memoryActionRunning = true;
    this.personalMemoryError = null;
    this.scheduleDisplay();
    try {
      const result = await memoryCorrectionModal(
        this.app,
        {
          memoryType: personalMemoryKindLabel(record.kind, zh),
          title: record.title,
          content: record.content,
          recallWhen: record.recallWhen
        },
        this.plugin.settings.settingsLanguage,
        {
          generate: async (correction, signal) =>
            await this.plugin.generateEchoInkPersonalMemoryCorrection(
              {
                kind: record.kind,
                title: record.title,
                content: record.content,
                recallWhen: record.recallWhen
              },
              correction,
              signal
            ),
          save: async (preview, correction) => {
            try {
              await this.plugin.applyEchoInkPersonalMemoryCorrection({
                targetId: record.id,
                title: preview.title,
                content: preview.content,
                recallWhen: preview.recallWhen,
                reason: `${zh ? "用户在记忆修正中明确纠正" : "User explicitly corrected this Memory"}：${correction}`.slice(0, 1_900),
                expectedRevision: state.revision
              });
              this.personalMemoryState = await this.plugin.getEchoInkPersonalMemoryState();
            } catch (error) {
              if (isPersonalMemoryRevisionConflict(error)) {
                try {
                  this.personalMemoryState = await this.plugin.getEchoInkPersonalMemoryState();
                  this.scheduleDisplay();
                } catch {
                  // Preserve the original conflict as the actionable result.
                }
                new Notice(zh
                  ? "Memory 已变化，列表已刷新；请从最新记录重新生成。"
                  : "Memory changed. The list was refreshed; regenerate from the latest record.");
              }
              throw error;
            }
          }
        }
      );
      if (result === "saved") {
        new Notice(zh ? "Memory 已保存为新版本" : "Memory saved as a new version");
      }
    } catch (error) {
      this.personalMemoryError = error instanceof Error ? error.message : String(error);
      new Notice(zh
        ? "Memory 修正未写入；请重新加载后重试。"
        : "Memory correction was not written. Reload and try again.");
    } finally {
      this.memoryActionRunning = false;
      this.scheduleDisplay();
    }
  }

  private addReviewAction(container: HTMLElement, label: string, kind: ReviewReportKind): void {
    const copy = this.copy;
    const button = container.createEl("button", {
      cls: "codex-resource-tab",
      text: label,
      attr: {
        type: "button",
        "aria-label": label,
        "data-echoink-focus-key": `review:${kind}:generate`
      }
    });
    button.onclick = async () => {
      const reportLabel = copy.review.reportLabels[kind];
      const accepted = await confirmModal(
        this.app,
        copy.review.confirmTitle(label),
        copy.review.confirmBody(reportLabel, this.plugin.settings.review.outputDir),
        copy.review.generate,
        copy.review.cancel
      );
      if (!accepted) return;
      this.settingsFocusIntent = `explicit:review:${kind}:generate`;
      await this.runSettingsButtonAction(button, "review", async () => {
        const manager = this.plugin.getReviewManager();
        if (!manager) {
          throw new Error(this.plugin.settings.settingsLanguage === "en"
            ? "Review is not ready yet. Reopen EchoInk and try again."
            : "复盘服务尚未就绪。请重新打开 EchoInk 后重试。"
          );
        }
        const result = await manager.runReview(kind);
        if (result.status === "failed") {
          throw new Error(this.plugin.settings.settingsLanguage === "en"
            ? "The review report could not be generated. Check the output directory and try again."
            : "复盘报告生成失败。请检查输出目录后重试。"
          );
        }
        this.announceSettingsStatus(this.plugin.settings.settingsLanguage === "en"
          ? `${reportLabel} generated.`
          : `${reportLabel}已生成。`
        );
        this.scheduleDisplay();
      });
    };
  }

  private addReviewRangeMode(container: HTMLElement): void {
    const copy = this.copy;
    const settings = this.plugin.settings.review;
    this.decorateSetting(new Setting(container).setName(copy.review.rangeMode).addDropdown((dropdown) => {
      dropdown.selectEl.setAttr("aria-label", copy.review.rangeMode);
      dropdown
        .addOption("previous-week", copy.review.rangeOptions["previous-week"])
        .addOption("current-week", copy.review.rangeOptions["current-week"])
        .setValue(settings.rangeMode)
        .onChange(async (value) => {
          settings.rangeMode = value === "current-week" ? "current-week" : "previous-week";
          await this.plugin.saveSettings();
        });
    }), "calendar-days");
  }

  private addReviewOpenAfterRun(container: HTMLElement): void {
    const copy = this.copy;
    const settings = this.plugin.settings.review;
    this.decorateSetting(new Setting(container).setName(copy.review.openHtmlAfterRun).addToggle((toggle) => {
      labelSettingsToggle(toggle, copy.review.openHtmlAfterRun);
      toggle.setValue(settings.openHtmlAfterRun).onChange(async (value) => {
        settings.openHtmlAfterRun = value;
        await this.plugin.saveSettings();
      });
    }), "panel-right-open");
  }

  private renderTopTabs(
    container: HTMLElement,
    activeTab: VisibleSettingsTab
  ): void {
    const copy = this.copy;
    const tabs = container.createDiv({
      cls: "codex-settings-tabs",
      attr: {
        role: "tablist",
        "aria-labelledby": SETTINGS_TITLE_ID,
        "aria-orientation": "horizontal"
      }
    });
    const updateOverflowHint = () => {
      const maxScrollLeft = Math.max(0, tabs.scrollWidth - tabs.clientWidth);
      container.toggleClass("can-scroll-left", tabs.scrollLeft > 1);
      container.toggleClass("can-scroll-right", tabs.scrollLeft < maxScrollLeft - 1);
    };
    tabs.onscroll = updateOverflowHint;
    this.disconnectSettingsTabsResizeObserver();
    if (typeof ResizeObserver !== "undefined") {
      this.settingsTabsResizeObserver = new ResizeObserver(updateOverflowHint);
      this.settingsTabsResizeObserver.observe(tabs);
    }
    let activeButton: HTMLButtonElement | null = null;
    SETTINGS_TABS.forEach((tab, index) => {
      const label = copy.tabs[tab.id];
      const isActive = activeTab === tab.id;
      const button = tabs.createEl("button", {
        cls: `codex-settings-tab ${isActive ? "is-active" : ""}`,
        attr: {
          id: settingsTabDomId(tab.id),
          type: "button",
          role: "tab",
          "data-settings-tab": tab.id,
          "data-echoink-focus-key": `settings-tab:${tab.id}`,
          "aria-selected": String(isActive),
          "aria-controls": SETTINGS_PANEL_ID,
          tabindex: isActive ? "0" : "-1"
        }
      });
      const icon = button.createSpan({ cls: "codex-settings-tab-icon" });
      setIcon(icon, tab.icon);
      button.createSpan({
        cls: "codex-settings-tab-label",
        text: label
      });
      if (isActive) {
        activeButton = button;
      }
      button.onpointerdown = () => {
        this.settingsTabPointerActivated = true;
      };
      button.onclick = () => {
        const restoreKeyboardFocus = !this.settingsTabPointerActivated;
        this.settingsTabPointerActivated = false;
        if (activeTab === tab.id) return;
        void this.activateSettingsTab(tab.id, restoreKeyboardFocus);
      };
      button.onkeydown = (event) => {
        const nextIndex = tabIndexFromKeyboard(event.key, index, SETTINGS_TABS.length);
        if (nextIndex === null) return;
        event.preventDefault();
        void this.activateSettingsTab(SETTINGS_TABS[nextIndex].id, true);
      };
    });
    window.requestAnimationFrame(updateOverflowHint);

    if (!activeButton) {
      this.suppressSettingsTabFocusRestore = false;
      return;
    }
    if (this.suppressSettingsTabFocusRestore) {
      this.suppressSettingsTabFocusRestore = false;
      return;
    }
    const tabButton = activeButton as HTMLButtonElement;
    window.requestAnimationFrame(() => {
      if (!tabButton.isConnected) return;
      tabButton.scrollIntoView({ block: "nearest", inline: "nearest" });
      if (this.settingsTabFocusId !== activeTab) return;
      tabButton.focus();
      window.requestAnimationFrame(() => {
        if (
          tabButton.isConnected
          && document.activeElement === tabButton
          && this.settingsTabFocusId === activeTab
        ) {
          this.settingsTabFocusId = null;
        }
      });
    });
  }

  private disconnectSettingsTabsResizeObserver(): void {
    this.settingsTabsResizeObserver?.disconnect();
    this.settingsTabsResizeObserver = null;
  }

  private async activateSettingsTab(
    tabId: VisibleSettingsTab,
    focus: boolean
  ): Promise<void> {
    if (this.plugin.settings.settingsTab === tabId) return;
    if (
      this.settingsDetail === "knowledge-preferences"
      && knowledgeMaintenancePreferenceIsDirty(
        this.knowledgePreferenceEditor
      )
    ) {
      const discard = await this.confirmKnowledgePreferenceDiscard();
      if (!discard) {
        this.settingsFocusIntent =
          "explicit:knowledge:preferences:editor";
        this.scheduleDisplay();
        return;
      }
      this.resetKnowledgePreferenceDraft();
    }
    this.settingsDetail = null;
    this.announceSettingsStatus("");
    this.settingsTabFocusId = focus ? tabId : null;
    this.suppressSettingsTabFocusRestore = !focus;
    this.plugin.settings.settingsTab = tabId;
    await this.plugin.saveSettings();
    this.scheduleDisplay();
  }

  private openSettingsDetail(detail: Exclude<SettingsDetail, null>): void {
    this.settingsDetail = detail;
    this.settingsFocusIntent = "explicit:settings-detail:back";
    if (detail === "knowledge-preferences") {
      void this.loadKnowledgePreferenceState();
    }
    if (detail === "review-archives") {
      void this.loadArchivedConversations();
    }
    if (detail === "review-memory") {
      void this.loadPersonalMemoryState();
    }
    this.scheduleDisplay();
  }

  private async closeSettingsDetail(): Promise<void> {
    const detail = this.settingsDetail;
    if (
      detail === "knowledge-preferences"
      && knowledgeMaintenancePreferenceIsDirty(
        this.knowledgePreferenceEditor
      )
    ) {
      const discard = await this.confirmKnowledgePreferenceDiscard();
      if (!discard) {
        this.settingsFocusIntent =
          "explicit:knowledge:preferences:editor";
        this.scheduleDisplay();
        return;
      }
      this.resetKnowledgePreferenceDraft();
    }
    this.settingsDetail = null;
    if (typeof detail === "object" && detail?.kind === "resource") {
      this.settingsFocusIntent = `explicit:resource:${detail.resourceId}:detail`;
    } else if (
      typeof detail === "object"
      && detail?.kind === "review-memory-category"
    ) {
      this.settingsFocusIntent = `explicit:review:memory:${detail.category}`;
    } else if (detail === "knowledge-memory") {
      this.settingsFocusIntent = "explicit:knowledge:memory";
    } else if (detail === "knowledge-preferences") {
      this.settingsFocusIntent = "explicit:knowledge:preferences";
    } else if (detail === "review-archives") {
      this.settingsFocusIntent = "explicit:review:archives";
    } else if (detail === "review-memory") {
      this.settingsFocusIntent = "explicit:review:memory";
    }
    this.scheduleDisplay();
  }

  private renderProviderModelManager(container: HTMLElement): void {
    const zh = this.plugin.settings.settingsLanguage !== "en";
    const label = (chinese: string, english: string) => zh ? chinese : english;
    const wrapper = createSettingsPage(container, {
      title: label("模型", "Models"),
      description: label(
        "添加并管理 EchoInk 使用的 Provider、API Key 和模型。",
        "Add and manage the providers, API keys, and models used by EchoInk."
      )
    });
    wrapper.addClass("codex-provider-model-manager");

    const addSection = wrapper.createDiv({
      cls: "codex-provider-add-section"
    });
    const addCopy = addSection.createDiv({ cls: "codex-provider-add-copy" });
    addCopy.createDiv({
      cls: "codex-provider-add-title",
      text: label("新增模型", "Add model")
    });
    addCopy.createDiv({
      cls: "codex-provider-add-description",
      text: label(
        "配置 Provider、API Key 和模型。API Key 直接保存在当前 Vault 的插件设置中。",
        "Configure a provider, API key, and model. The API key is stored directly in this Vault's plugin settings."
      )
    });
    const addButton = addSection.createEl("button", {
      cls: "codex-provider-add-button",
      attr: { type: "button", "data-echoink-focus-key": "providers:add" }
    });
    const addIcon = addButton.createSpan();
    setIcon(addIcon, "plus");
    addButton.createSpan({ text: label("添加模型", "Add model") });
    addButton.onclick = () => {
      this.openProviderModelModal(createApiProviderConfig(), false);
    };

    const savedSection = wrapper.createDiv({
      cls: "codex-provider-saved-section"
    });
    const savedHeading = new Setting(savedSection)
      .setName(label("已保存模型", "Saved models"))
      .setHeading();
    savedHeading.settingEl.addClass("echoink-provider-saved-heading-row");
    savedHeading.nameEl.addClass("codex-provider-saved-heading");
    const savedList = savedSection.createDiv({
      cls: "codex-provider-saved-list"
    });
    const active = getActiveApiProvider(this.plugin.settings);

    for (const saved of this.plugin.settings.apiProviders) {
      const providerId = getApiProviderPreset(normalizeApiProviderId(
        saved.providerId,
        saved.baseUrl,
        saved.name
      )).id;
      const modelDisplayName = getApiProviderModelPreset(providerId, saved.model)?.displayName
        ?? saved.model;
      const row = savedList.createDiv({
        cls: `codex-provider-saved-row is-provider-${providerId}`
      });
      const identity = row.createDiv({
        cls: "codex-provider-saved-identity",
        attr: {
          "aria-label": `${modelDisplayName} · ${saved.name}`
        }
      });
      const rowIcon = identity.createSpan({
        cls: `codex-provider-saved-icon is-${providerId}`
      });
      renderProviderBrandIcon(rowIcon, providerId);
      const savedCopy = identity.createDiv({
        cls: "codex-provider-saved-copy"
      });
      savedCopy.createDiv({
        cls: "codex-provider-saved-model",
        text: modelDisplayName
      });
      const savedProvider = savedCopy.createDiv({
        cls: "codex-provider-saved-provider",
        text: saved.name,
        attr: {
          tabindex: "0",
          "aria-label": this.plugin.settings.settingsLanguage === "en"
            ? `${saved.name}. Provider endpoint: ${saved.baseUrl}`
            : `${saved.name}。Provider 地址：${saved.baseUrl}`
        }
      });
      savedProvider.createSpan({
        cls: "codex-provider-url-tooltip",
        text: saved.baseUrl,
        attr: { "aria-hidden": "true" }
      });

      const rowMeta = row.createDiv({ cls: "codex-provider-saved-meta" });
      if (saved.modelSelection === "auto") {
        rowMeta.createSpan({
          cls: "codex-provider-mode-badge",
          text: "Auto"
        });
      }
      const apiKeyRequired = apiProviderApiKeyRequired(providerId);
      const apiKeyReady = apiProviderHasUsableApiKey(saved);
      const apiKeyState = !apiKeyRequired
        ? "not-required"
        : apiKeyReady
          ? "ready"
          : "missing";
      if (saved.id === active?.id) {
        rowMeta.createSpan({
          cls: "codex-provider-active-badge",
          text: label("当前选择", "Current selection")
        });
      }
      rowMeta.createSpan({
        cls: `codex-provider-credential-badge is-${apiKeyState}`,
        text: apiKeyState === "not-required"
          ? label("无需 API Key", "No API key required")
          : apiKeyState === "ready"
            ? label("API Key 已填写", "API key configured")
            : label("未配置 API Key", "API key missing")
      });
      if (
        this.verifiedProviderConnections.get(saved.id)
        === providerConfigurationFingerprint(saved)
      ) {
        rowMeta.createSpan({
          cls: "codex-provider-connection-badge is-connected",
          text: label("连接正常", "Connection verified")
        });
      }
      const edit = rowMeta.createEl("button", {
        cls: "codex-provider-row-action",
        attr: {
          type: "button",
          title: label(`编辑 ${saved.name} · ${modelDisplayName}`, `Edit ${saved.name} · ${modelDisplayName}`),
          "aria-label": label(`编辑 ${saved.name} · ${modelDisplayName}`, `Edit ${saved.name} · ${modelDisplayName}`),
          "data-echoink-focus-key": `provider:${saved.id}:edit`
        }
      });
      setIcon(edit, "pencil");
      edit.onclick = () => {
        this.openProviderModelModal(saved, true);
      };
      const remove = rowMeta.createEl("button", {
        cls: "codex-provider-row-action is-delete",
        attr: {
          type: "button",
          title: label(`删除 ${saved.name} · ${modelDisplayName}`, `Delete ${saved.name} · ${modelDisplayName}`),
          "aria-label": label(`删除 ${saved.name} · ${modelDisplayName}`, `Delete ${saved.name} · ${modelDisplayName}`),
          "data-echoink-focus-key": `provider:${saved.id}:delete`
        }
      });
      setIcon(remove, "trash-2");
      remove.onclick = () => void this.deleteSavedProviderModel(saved.id);
    }

    if (this.plugin.settings.apiProviders.length === 0) {
      const empty = savedList.createDiv({
        cls: "codex-provider-saved-empty"
      });
      const emptyIcon = empty.createSpan();
      setIcon(emptyIcon, "server");
      const emptyCopy = empty.createDiv();
      emptyCopy.createDiv({
        cls: "codex-provider-saved-empty-title",
        text: label("还没有已保存模型", "No saved models yet")
      });
      emptyCopy.createDiv({
        cls: "codex-provider-saved-empty-description",
        text: label(
          "添加第一个 Provider 后，就可以在 EchoInk 对话中使用。",
          "Add a provider to start using it in EchoInk conversations."
        )
      });
    }
  }

  private openProviderModelModal(
    source: ApiProviderConfig,
    editing: boolean
  ): void {
    new ProviderModelModal({
      app: this.app,
      draft: structuredClone(source),
      editing,
      language: this.plugin.settings.settingsLanguage,
      copy: this.copy,
      preflight: {
        listModels: async (draft) =>
          await this.plugin.listPiProviderModels(draft),
        testConnection: async (draft) =>
          await this.plugin.testPiProviderConnection(draft)
      },
      save: async (draft, apiKey, connectionVerified) =>
        await this.saveAndActivateProviderModel(
          draft,
          apiKey,
          connectionVerified,
          editing ? source : null
        )
    }).open();
  }

  private async saveAndActivateProviderModel(
    draftInput: ApiProviderConfig,
    apiKeyInput: string,
    connectionVerified = false,
    replacedProvider: ApiProviderConfig | null = null
  ): Promise<ProviderModelSaveResult> {
    const draft = structuredClone(draftInput);
    const providerId = normalizeApiProviderId(
      draft.providerId,
      draft.baseUrl,
      draft.name
    );
    const preset = getApiProviderPreset(providerId);
    const apiKey = apiKeyInput.trim();
    if (providerId !== "custom") {
      draft.providerId = preset.id;
      draft.runtimeProviderId = preset.runtimeProviderId;
      draft.name = preset.name;
      draft.baseUrl = preset.baseUrl;
      draft.apiProtocol = preset.apiProtocol;
      if (draft.modelSelection === "auto") {
        draft.model = preset.model;
      }
      const modelPreset = getApiProviderModelPreset(providerId, draft.model);
      if (modelPreset) applyApiProviderModelPreset(draft, modelPreset.id);
      if (draftInput.modelSelection === "auto") draft.modelSelection = "auto";
    }
    try {
      draft.baseUrl = normalizeApiProviderBaseUrl(
        draft.baseUrl,
        draft.apiProtocol
      );
    } catch {
      return { saved: false, message: this.copy.providers.saveFailed };
    }
    draft.name = draft.name.trim();
    draft.model = draft.model.trim();
    draft.runtimeProviderId = draft.runtimeProviderId.trim();
    draft.models = Array.from(new Set([
      draft.model,
      ...draft.models
    ].map((model) => model.trim()).filter(Boolean)));
    draft.apiKey = apiKey || draftInput.apiKey.trim();
    if (!draft.apiKey && apiProviderApiKeyRequired(providerId)) {
      return { saved: false, message: this.copy.providers.missingKey };
    }
    const errors = validateApiProvider(
      draft,
      this.plugin.settings.settingsLanguage
    );
    if (errors.length) {
      return { saved: false, message: this.copy.common.enableFailed(errors) };
    }

    void replacedProvider;
    try {
      await this.plugin.activateApiProviderSettings((settings) => {
        const index = settings.apiProviders.findIndex(
          (provider) => provider.id === draft.id
        );
        if (index >= 0) settings.apiProviders[index] = structuredClone(draft);
        else settings.apiProviders.push(structuredClone(draft));
        const candidate = settings.apiProviders.find(
          (provider) => provider.id === draft.id
        );
        if (!candidate) throw new Error("Provider candidate missing");
        activateApiProvider(settings, candidate);
      });
      if (connectionVerified) {
        const committed = this.plugin.settings.apiProviders.find(
          (provider) => provider.id === draft.id
        );
        if (committed) {
          this.verifiedProviderConnections.set(
            committed.id,
            providerConfigurationFingerprint(committed)
          );
        }
      } else {
        this.verifiedProviderConnections.delete(draft.id);
      }
      new Notice(this.copy.providers.saved(draft.name));
      this.scheduleDisplay();
      return { saved: true };
    } catch (error) {
      return {
        saved: false,
        message: error instanceof Error ? error.message : this.copy.providers.saveFailed
      };
    }
  }

  private async deleteSavedProviderModel(providerId: string): Promise<void> {
    const provider = this.plugin.settings.apiProviders.find(
      (item) => item.id === providerId
    );
    if (!provider) return;
    const accepted = await confirmModal(
      this.app,
      this.copy.providers.deleteConfirm(provider.name),
      this.plugin.settings.activeApiProviderId === providerId
        ? (this.plugin.settings.settingsLanguage === "en"
          ? "The active model will be removed. EchoInk will switch to the next saved model, or become unconfigured if none remains."
          : "将删除当前使用中的模型。EchoInk 会切换到下一项；若没有其他项，则进入未配置状态。")
        : (this.plugin.settings.settingsLanguage === "en"
          ? "This removes the saved model configuration."
          : "这会删除已保存的模型配置。"),
      this.copy.common.delete,
      this.copy.common.cancel
    );
    if (!accepted) return;
    const wasActive = this.plugin.settings.activeApiProviderId === providerId;
    const fallback = this.plugin.settings.apiProviders.find(
      (item) => item.id !== providerId && apiProviderHasUsableApiKey(item)
    ) ?? null;
    try {
      await this.plugin.activateApiProviderSettings((settings) => {
        settings.apiProviders = settings.apiProviders.filter(
          (item) => item.id !== providerId
        );
        if (!wasActive) return;
        const next = fallback
          ? settings.apiProviders.find((item) => item.id === fallback.id)
          : null;
        if (next) activateApiProvider(settings, next);
        else {
          settings.activeApiProviderId = "";
          settings.defaultModel = "";
        }
      }, wasActive ? (fallback ? "replace" : "suspend") : "preserve");
      new Notice(fallback && wasActive
        ? (this.plugin.settings.settingsLanguage === "en"
          ? `Removed. Now using ${fallback.name} · ${fallback.model}.`
          : `已删除，现已切换到 ${fallback.name} · ${fallback.model}。`)
        : (this.plugin.settings.settingsLanguage === "en"
          ? "Saved model removed."
          : "已删除已保存模型。"));
      this.scheduleDisplay();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : this.copy.providers.saveFailed);
    }
  }

  private addKnowledgeBaseMemoryRecommendation(container: HTMLElement): void {
    this.addPersonalMemoryControl(container);
    return;
  }

  private addPersonalMemoryControl(container: HTMLElement): void {
    const zh = this.plugin.settings.settingsLanguage !== "en";
    if (!this.personalMemoryState && !this.personalMemoryLoading && !this.personalMemoryError) {
      void this.loadPersonalMemoryState();
    }
    if (this.personalMemoryLoading) {
      createSettingsState(container, zh ? "正在读取长期 Memory…" : "Loading long-term Memory…", "neutral");
      return;
    }
    const state = this.personalMemoryState;
    if (!state) {
      createSettingsState(
        container,
        zh ? "长期 Memory 暂时无法读取。" : "Long-term Memory is temporarily unavailable.",
        "error"
      );
      const retry = container.createEl("button", { text: zh ? "重新加载" : "Reload", attr: { type: "button" } });
      retry.onclick = () => void this.loadPersonalMemoryState(true);
      return;
    }

    applySettingsRow(new Setting(container)
      .setName(zh ? "允许学习新 Memory" : "Allow new Memory learning")
      .setDesc(zh
        ? "关闭后已有历史仍可读取，但 memory_write 会被拒绝。"
        : "Existing history remains readable when off, while memory_write is rejected.")
      .addToggle((toggle) => {
        labelSettingsToggle(
          toggle,
          zh ? "允许学习新 Memory" : "Allow new Memory learning"
        );
        toggle.setValue(state.learningEnabled).onChange(async (enabled) => {
          await this.runPersonalMemoryAction(async () => {
            await this.plugin.setEchoInkPersonalMemoryLearningEnabled(enabled);
          });
        });
      }));

    const summary = new Setting(container)
      .setName(zh ? "文件状态" : "File status")
      .setDesc(zh
        ? `Revision ${state.revision} · 当前记录 ${state.records.filter((item) => item.status === "current").length} · 已忘记 ${state.forgottenIds.length}`
        : `Revision ${state.revision} · ${state.records.filter((item) => item.status === "current").length} current · ${state.forgottenIds.length} forgotten`);
    applySettingsRow(summary.addButton((button) => button
      .setButtonText(zh ? "导出" : "Export")
      .onClick(async () => {
        await this.runPersonalMemoryAction(async () => {
          const result = await this.plugin.exportEchoInkPersonalMemory();
          new Notice(zh ? `已导出：${result.path}` : `Exported: ${result.path}`);
        });
      })));

    const ordered = [...state.records].sort((left, right) =>
      left.kind.localeCompare(right.kind)
      || right.date.localeCompare(left.date)
      || left.id.localeCompare(right.id)
    );
    if (!ordered.length) {
      createSettingsState(
        container,
        zh ? "还没有历史记录。对话会在确有长期价值且学习开启时写入。" : "No history yet. Conversations write only durable value while learning is enabled.",
        "neutral"
      );
    }
    for (const record of ordered.slice(0, 50)) {
      const row = new Setting(container)
        .setName(`${record.title} · ${record.kind}`)
        .setDesc([
          record.content,
          `${record.status} · ${record.basis} · revision ${record.revision}`,
          record.scope ? `scope: ${record.scope}` : undefined,
          `source: ${record.source}`,
          record.supersedes ? `supersedes: ${record.supersedes}` : undefined
        ].filter(Boolean).join("\n"));
      if (record.status === "current") {
        row.addButton((button) => button
          .setWarning()
          .setButtonText(zh ? "忘记" : "Forget")
          .onClick(async () => {
            const confirmed = await confirmModal(
              this.app,
              zh ? "可恢复地忘记" : "Recoverable forget",
              zh ? `忘记“${record.title}”？原文件会进入本地备份，可稍后恢复。` : `Forget “${record.title}”? A local backup remains available for restore.`,
              zh ? "忘记" : "Forget",
              this.copy.common.cancel
            );
            if (!confirmed) return;
            await this.runPersonalMemoryAction(async () => {
              await this.plugin.forgetEchoInkPersonalMemory(
                record.id,
                zh ? "用户在 Memory 设置页明确要求忘记" : "User explicitly requested forget in Memory settings",
                state.revision
              );
            });
          }));
      }
      applySettingsRow(row);
    }

    for (const id of state.forgottenIds.slice(-20).reverse()) {
      applySettingsRow(new Setting(container)
        .setName(`${zh ? "已忘记" : "Forgotten"} · ${id}`)
        .setDesc(zh ? "保留可恢复备份。" : "A recoverable backup is retained.")
        .addButton((button) => button
          .setButtonText(zh ? "恢复" : "Restore")
          .onClick(async () => {
            await this.runPersonalMemoryAction(async () => {
              await this.plugin.restoreEchoInkPersonalMemory(id, state.revision);
            });
          })));
    }

  }



  private async loadPersonalMemoryState(force = false): Promise<void> {
    if (this.personalMemoryLoading || (!force && this.personalMemoryState)) return;
    this.personalMemoryLoading = true;
    if (force) this.personalMemoryError = null;
    try {
      this.personalMemoryState = await this.plugin.getEchoInkPersonalMemoryState();
      this.personalMemoryError = null;
    } catch (error) {
      this.personalMemoryError = error instanceof Error ? error.message : String(error);
    } finally {
      this.personalMemoryLoading = false;
      this.scheduleDisplay();
    }
  }

  private async runPersonalMemoryAction(
    action: () => Promise<void>,
    reload = true
  ): Promise<void> {
    if (this.memoryActionRunning) return;
    this.memoryActionRunning = true;
    try {
      await action();
      if (reload) {
        this.personalMemoryState = await this.plugin.getEchoInkPersonalMemoryState();
      }
      this.personalMemoryError = null;
    } catch (error) {
      this.personalMemoryError = error instanceof Error ? error.message : String(error);
      new Notice(this.plugin.settings.settingsLanguage === "en"
        ? "Memory action did not finish. Reload and try again."
        : "Memory 操作未完成，请重新加载后重试。");
    } finally {
      this.memoryActionRunning = false;
      this.scheduleDisplay();
    }
  }

  private async loadKnowledgePreferenceState(force = false): Promise<void> {
    if (
      this.knowledgePreferenceLoading
      || (!force && this.knowledgePreferenceState && this.knowledgePreferenceEditor)
    ) return;
    this.knowledgePreferenceLoading = true;
    this.knowledgePreferenceLoadError = null;
    this.scheduleDisplay();
    try {
      const state =
        await this.plugin.getEchoInkKnowledgeMaintenancePreferenceState();
      this.knowledgePreferenceState = state;
      this.knowledgePreferenceEditor =
        createKnowledgeMaintenancePreferenceEditor(state);
    } catch {
      this.knowledgePreferenceLoadError =
        this.plugin.settings.settingsLanguage === "en"
          ? "Knowledge refinement preferences could not be loaded."
          : "知识提炼偏好读取失败。";
    } finally {
      this.knowledgePreferenceLoading = false;
      this.scheduleDisplay();
    }
  }

  private async saveKnowledgePreference(draftContent: string): Promise<void> {
    const current = this.knowledgePreferenceEditor;
    if (!current || current.saving) return;
    const edited = editKnowledgeMaintenancePreference(current, draftContent);
    if (!knowledgeMaintenancePreferenceIsDirty(edited)) return;
    this.knowledgePreferenceEditor =
      beginSavingKnowledgeMaintenancePreference(edited);
    this.settingsFocusIntent = "explicit:knowledge:preferences:save";
    this.scheduleDisplay();
    try {
      const state = await this.plugin.saveEchoInkKnowledgeMaintenancePreferences(
        edited.draftContent,
        edited.expectedRevision
      );
      this.knowledgePreferenceState = state;
      this.knowledgePreferenceEditor =
        createKnowledgeMaintenancePreferenceEditor(state);
      const message = this.plugin.settings.settingsLanguage === "en"
        ? "Knowledge refinement preferences saved."
        : "知识提炼偏好已保存。";
      this.announceSettingsStatus(message);
      new Notice(message);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
      const message = this.plugin.settings.settingsLanguage === "en"
        ? code === "revision_conflict"
          ? "Preferences changed in another window. Copy your draft, reload, and reconcile before saving."
          : code === "invalid_content"
            ? "Preferences must contain valid text and remain within 64 KiB."
            : "Preferences could not be saved. Existing content was not overwritten."
        : code === "revision_conflict"
          ? "偏好已在另一个窗口变化。请先复制当前草稿，重新加载并合并后再保存。"
          : code === "invalid_content"
            ? "偏好必须是有效非空文本，且不超过 64 KiB。"
            : "知识提炼偏好保存失败，现有内容未被覆盖。";
      this.knowledgePreferenceEditor =
        failSavingKnowledgeMaintenancePreference(edited, message);
      this.announceSettingsStatus(message);
    } finally {
      this.scheduleDisplay();
    }
  }

  private resetKnowledgePreferenceDraft(): void {
    const state = this.knowledgePreferenceState;
    this.knowledgePreferenceEditor = state
      ? createKnowledgeMaintenancePreferenceEditor(state)
      : null;
  }

  private async confirmKnowledgePreferenceDiscard(): Promise<boolean> {
    const zh = this.plugin.settings.settingsLanguage !== "en";
    return await confirmModal(
      this.app,
      zh ? "有未保存的知识提炼偏好" : "Unsaved refinement preferences",
      zh
        ? "离开会舍弃当前未保存修改。继续编辑可以返回设置页保存。"
        : "Leaving will discard the current unsaved changes. Continue editing to return and save them.",
      zh ? "舍弃修改" : "Discard changes",
      zh ? "继续编辑" : "Continue editing"
    );
  }

  private addProviderText(
    container: HTMLElement,
    label: string,
    value: string,
    placeholder: string,
    onChange: (value: string) => Promise<void>,
    type: "text" | "password" = "text"
  ): void {
    const setting = new Setting(container).setName(label).addText((text) => {
      text.setPlaceholder(placeholder).setValue(value).onChange(onChange);
      text.inputEl.type = type;
      text.inputEl.setAttr("aria-label", label);
    });
    this.decorateSetting(setting, type === "password" ? "key-round" : "text-cursor-input");
  }

  private renderWorkspaceResourceManager(container: HTMLElement): void {
    const copy = this.copy;
    const detailId = typeof this.settingsDetail === "object"
      && this.settingsDetail?.kind === "resource"
      ? this.settingsDetail.resourceId
      : "";
    if (detailId) {
      const resource = this.currentEchoInkResourceCatalog().find((item) => item.id === detailId);
      if (resource) {
        this.renderResourceDetail(container, resource);
        return;
      }
      this.settingsDetail = null;
    }
    const page = createSettingsPage(container, {
      title: copy.resources.title,
      headingId: RESOURCE_TITLE_ID,
      description: copy.resources.note
    });
    this.renderSettingsActionError(page, "resources");
    const wrapper = page.createDiv({ cls: "codex-resource-manager" });
    const activeTab = this.plugin.settings.resourceManagementTab;
    const controls = wrapper.createDiv({ cls: "codex-resource-controls" });
    const toolbar = controls.createDiv({ cls: "codex-resource-toolbar" });
    const tabs = toolbar.createDiv({
      cls: "codex-resource-tabs",
      attr: {
        role: "tablist",
        "aria-labelledby": RESOURCE_TITLE_ID,
        "aria-orientation": "horizontal"
      }
    });
    let activeButton: HTMLButtonElement | null = null;
    RESOURCE_TABS.forEach((tab, index) => {
      const label = copy.resources.tabs[tab.id];
      const isActive = activeTab === tab.id;
      const button = tabs.createEl("button", {
        cls: `codex-resource-tab ${isActive ? "is-active" : ""}`,
        attr: {
          id: resourceTabDomId(tab.id),
          type: "button",
          role: "tab",
          "data-resource-tab": tab.id,
          "data-echoink-focus-key": `resource-tab:${tab.id}`,
          "aria-selected": String(isActive),
          "aria-controls": RESOURCE_PANEL_ID,
          tabindex: isActive ? "0" : "-1"
        }
      });
      button.createSpan({ text: label });
      if (isActive) activeButton = button;
      button.onpointerdown = () => {
        this.resourceTabPointerActivated = true;
      };
      button.onclick = () => {
        const restoreKeyboardFocus = !this.resourceTabPointerActivated;
        this.resourceTabPointerActivated = false;
        if (activeTab === tab.id) return;
        void this.activateResourceTab(tab.id, restoreKeyboardFocus);
      };
      button.onkeydown = (event) => {
        const nextIndex = tabIndexFromKeyboard(event.key, index, RESOURCE_TABS.length);
        if (nextIndex === null) return;
        event.preventDefault();
        void this.activateResourceTab(RESOURCE_TABS[nextIndex].id, true);
      };
    });
    this.renderResourceSearch(toolbar, activeTab);
    const toolbarActions = toolbar.createDiv({ cls: "codex-resource-toolbar-actions" });
    if (activeTab === "mcp") {
      const add = toolbarActions.createEl("button", {
        cls: "codex-resource-add",
        attr: {
          type: "button",
          "aria-label": this.plugin.settings.settingsLanguage === "en" ? "Add MCP server" : "新增 MCP Server",
          "data-echoink-focus-key": "resources:mcp:add"
        }
      });
      const addIcon = add.createSpan({ cls: "codex-resource-refresh-icon" });
      setIcon(addIcon, "plus");
      add.createSpan({ text: this.plugin.settings.settingsLanguage === "en" ? "Add server" : "新增 Server" });
      add.onclick = () => this.openMcpServerModal();
    }
    const refresh = toolbarActions.createEl("button", {
      cls: "codex-resource-refresh",
      attr: { type: "button", "aria-label": copy.resources.refreshTitle, "data-echoink-focus-key": "resources:refresh" }
    });
    const refreshIcon = refresh.createSpan({ cls: "codex-resource-refresh-icon" });
    setIcon(refreshIcon, "refresh-cw");
    refresh.createSpan({ text: this.resourceLoadingTab === this.plugin.settings.resourceManagementTab ? copy.common.loading : copy.common.refresh });
    refresh.disabled = this.resourceLoadingTab === this.plugin.settings.resourceManagementTab;
    refresh.onclick = () => void this.loadWorkspaceResources(true, this.plugin.settings.resourceManagementTab);

    const activeMeta = RESOURCE_TABS.find((tab) => tab.id === activeTab);
    const isLoading = this.resourceLoadingTab === activeTab;
    const loadError = this.resourceLoadErrors[activeTab] ?? "";
    const body = wrapper.createDiv({
      cls: "codex-resource-body",
      attr: {
        id: RESOURCE_PANEL_ID,
        role: "tabpanel",
        "aria-labelledby": resourceTabDomId(activeTab),
        tabindex: "0",
        "aria-busy": String(isLoading)
      }
    });
    if (isLoading) {
      createSettingsState(body, copy.resources.loadingTab(activeMeta ? copy.resources.tabs[activeMeta.id] : copy.tabs.resources));
    }
    if (loadError) {
      createSettingsState(
        body,
        this.plugin.settings.settingsLanguage === "en"
          ? "Resources could not be synchronized. Check the current Vault configuration and refresh this list."
          : "资源同步未完成。请检查当前 Vault 配置后刷新列表。",
        "error"
      );
    }
    if (!this.resourceLoaded[activeTab] && !isLoading && !loadError) {
      createSettingsState(body, copy.resources.notLoaded);
    }
    const hasSavedCatalog = this.currentEchoInkResourceCatalog(this.resourceSnapshot).some((resource) => resource.kind === resourceKindForResourceTab(activeTab));
    if ((this.resourceSnapshot || hasSavedCatalog) && (this.resourceLoaded[activeTab] || isLoading || hasSavedCatalog)) {
      this.renderActiveResourceTab(body, this.resourceSnapshot ?? emptyWorkspaceResourceSnapshot());
    }
    if (!this.resourceLoaded[activeTab] && !isLoading && !loadError) void this.loadWorkspaceResources(false, activeTab);

    if (this.suppressResourceTabFocusRestore) {
      this.suppressResourceTabFocusRestore = false;
    } else if (activeButton) {
      const tabButton = activeButton as HTMLButtonElement;
      window.requestAnimationFrame(() => {
        if (!tabButton.isConnected) return;
        tabButton.scrollIntoView({ block: "nearest", inline: "nearest" });
        if (this.resourceTabFocusId !== activeTab) return;
        tabButton.focus();
        window.requestAnimationFrame(() => {
          if (
            tabButton.isConnected
            && document.activeElement === tabButton
            && this.resourceTabFocusId === activeTab
          ) {
            this.resourceTabFocusId = null;
          }
        });
      });
    }
  }

  private renderResourceDetail(container: HTMLElement, resource: EchoInkResource): void {
    const english = this.plugin.settings.settingsLanguage === "en";
    const page = createSettingsPage(container, {
      title: resource.kind === "skill" ? `/${resource.name}` : resource.name,
      description: resource.description || (english ? "Resource details" : "资源详情"),
      detail: true,
      backLabel: english ? "Back to Skills and MCP" : "返回 Skills 与 MCP",
      onBack: () => {
        void this.closeSettingsDetail();
      }
    });
    this.renderSettingsActionError(page, "resources");
    const status = createSettingsSection(page, {
      title: english ? "Status" : "状态",
      surface: "group"
    });
    const group = createSettingsGroup(status);
    const connectionStatus = resource.kind === "mcp-server"
      ? mcpConnectionStatus(resource, this.plugin.settings.resources)
      : "not-mcp";
    const details = createSettingsFeatureCard(
      group,
      resourceDisplayMeta(resource, this.plugin.settings.resources, this.plugin.settings.settingsLanguage),
      resource.description || (english ? "No description" : "暂无说明")
    );
    const path = resource.contentPath ?? resource.configPath ?? "";
    if (path) {
      const pathButton = details.createEl("button", {
        cls: "codex-copyable-value",
        text: path,
        attr: {
          type: "button",
          "aria-label": english ? `Copy full path: ${path}` : `复制完整路径：${path}`,
          "data-echoink-focus-key": `resource:${resource.id}:path`
        }
      });
      pathButton.onclick = () => void this.copySettingsValue(path, pathButton);
    }
    if (resource.kind === "mcp-server") {
      const connection = resolveMcpConnectionRecord(resource, this.plugin.settings.resources);
      const diagnostic = connection?.diagnostic;
      if (diagnostic) {
        createSettingsState(
          group,
          english
            ? `${mcpDiagnosticLabel(diagnostic.code, true)}: ${diagnostic.message}`
            : `${mcpDiagnosticLabel(diagnostic.code, false)}：${diagnostic.message}`,
          "error"
        );
      }
      const actions = createSettingsSection(page, {
        title: english ? "Connection" : "连接",
        description: english
          ? "Configure the transport first, then verify the tools EchoInk can call."
          : "先补全传输配置，再验证 EchoInk 可以调用的工具。",
        surface: "group"
      });
      const actionGroup = createSettingsGroup(actions);
      if (connection) {
        createSettingsFeatureCard(
          actionGroup,
          mcpConnectionSummary(connection, english),
          mcpCredentialConfigured(connection)
            ? (english ? "Credential saved securely; the secret is not displayed." : "Credential 已安全保存，Secret 不会回显。")
            : (english ? "No credential is configured." : "尚未配置 Credential。")
        );
        this.renderMcpSettingsToggle(actionGroup, {
          title: english ? "Enable server" : "启用 Server",
          description: english
            ? "Controls whether this server is available to EchoInk."
            : "控制此 Server 是否可供 EchoInk 使用。",
          checked: resource.enabled,
          focusKey: `resource:${resource.id}:enabled`,
          action: async (enabled) => await this.plugin.setEchoInkMcpServerEnabled(resource.id, enabled)
        });
        this.renderMcpSettingsToggle(actionGroup, {
          title: english ? "Trust server" : "信任 Server",
          description: english
            ? "Admits individually trusted tools. Side-effect tools still require approval."
            : "允许逐个信任的 Tool 进入 Pi；有副作用 Tool 仍必须审批。",
          checked: connection.trusted,
          focusKey: `resource:${resource.id}:trusted`,
          action: async (trusted) => await this.plugin.setEchoInkMcpServerTrusted(resource.id, trusted)
        });
      }
      const row = actionGroup.createDiv({ cls: "echoink-settings-action-row" });
      this.renderMcpConnectionActions(row, resource, connectionStatus);

      const toolsSection = createSettingsSection(page, {
        title: english ? "Tools" : "Tools",
        description: english
          ? "Enable and trust each discovered tool. Read-only tools run directly; side effects always use approval and Receipt."
          : "逐个启用并信任发现到的 Tool。只读 Tool 直调；有副作用 Tool 始终经过审批与 Receipt。",
        surface: "group"
      });
      const toolsGroup = createSettingsGroup(toolsSection);
      if (!connection?.tools.length) {
        createSettingsState(
          toolsGroup,
          english
            ? "No verified tool list yet. Test the connection to discover tools."
            : "尚无已验证的 Tool 清单。请测试连接以完成发现。",
          "neutral"
        );
      } else {
        for (const tool of connection.tools) {
          const policy = mcpToolPolicy(connection, tool);
          const toolRow = toolsGroup.createDiv({ cls: "codex-mcp-tool-policy-row" });
          const toolCopy = toolRow.createDiv({ cls: "codex-mcp-tool-policy-copy" });
          const heading = toolCopy.createDiv({ cls: "codex-mcp-tool-policy-heading" });
          heading.createSpan({ cls: "codex-mcp-tool-policy-name", text: tool.name });
          heading.createSpan({
            cls: `codex-mcp-tool-effect is-${tool.readOnly ? "read" : tool.destructive ? "destructive" : "write"}`,
            text: tool.readOnly
              ? (english ? "Read only" : "只读")
              : tool.destructive
                ? (english ? "Destructive" : "破坏性")
                : (english ? "Approval required" : "需审批")
          });
          if (tool.description) {
            toolCopy.createDiv({ cls: "codex-mcp-tool-policy-description", text: tool.description });
          }
          if (tool.readback) {
            toolCopy.createDiv({
              cls: "codex-mcp-tool-policy-readback",
              text: english
                ? `Readback: ${tool.readback.toolName}`
                : `Readback：${tool.readback.toolName}`
            });
          }
          const controls = toolRow.createDiv({ cls: "codex-mcp-tool-policy-controls" });
          this.renderMcpCompactToggle(controls, {
            label: english ? "Enabled" : "启用",
            checked: policy.enabled,
            focusKey: `resource:${resource.id}:tool:${tool.name}:enabled`,
            action: async (enabled) => await this.plugin.setEchoInkMcpToolPolicy(resource.id, tool.name, { enabled })
          });
          this.renderMcpCompactToggle(controls, {
            label: english ? "Trusted" : "信任",
            checked: policy.trusted,
            focusKey: `resource:${resource.id}:tool:${tool.name}:trusted`,
            action: async (trusted) => await this.plugin.setEchoInkMcpToolPolicy(resource.id, tool.name, { trusted })
          });
        }
      }
    }
  }

  private renderMcpSettingsToggle(container: HTMLElement, options: {
    title: string;
    description: string;
    checked: boolean;
    focusKey: string;
    action: (checked: boolean) => Promise<void>;
  }): void {
    const row = container.createDiv({ cls: "codex-mcp-server-toggle-row" });
    const copy = row.createDiv({ cls: "codex-mcp-server-toggle-copy" });
    copy.createDiv({ cls: "codex-mcp-server-toggle-title", text: options.title });
    copy.createDiv({ cls: "codex-mcp-server-toggle-description", text: options.description });
    const toggle = row.createEl("input", {
      attr: {
        type: "checkbox",
        "aria-label": options.title,
        "data-echoink-focus-key": options.focusKey
      }
    });
    toggle.checked = options.checked;
    toggle.onchange = () => void this.runMcpToggleAction(toggle, options.action);
  }

  private renderMcpCompactToggle(container: HTMLElement, options: {
    label: string;
    checked: boolean;
    focusKey: string;
    action: (checked: boolean) => Promise<void>;
  }): void {
    const label = container.createEl("label", { cls: "codex-mcp-tool-policy-toggle" });
    const toggle = label.createEl("input", {
      attr: { type: "checkbox", "data-echoink-focus-key": options.focusKey }
    });
    toggle.checked = options.checked;
    toggle.onchange = () => void this.runMcpToggleAction(toggle, options.action);
    label.createSpan({ text: options.label });
  }

  private async runMcpToggleAction(
    toggle: HTMLInputElement,
    action: (checked: boolean) => Promise<void>
  ): Promise<void> {
    const next = toggle.checked;
    toggle.disabled = true;
    try {
      await action(next);
      this.scheduleDisplay();
    } catch {
      toggle.checked = !next;
      toggle.disabled = false;
      const message = this.plugin.settings.settingsLanguage === "en"
        ? "The MCP setting was not saved."
        : "MCP 设置未保存，请重试。";
      new Notice(message);
      this.announceSettingsStatus(message);
    }
  }

  private async activateResourceTab(
    tabId: ResourceManagementTab,
    focus: boolean
  ): Promise<void> {
    if (this.plugin.settings.resourceManagementTab === tabId) return;
    this.resourceTabFocusId = focus ? tabId : null;
    this.suppressResourceTabFocusRestore = !focus;
    this.plugin.settings.resourceManagementTab = tabId;
    await this.plugin.saveSettings();
    this.scheduleDisplay();
  }

  private renderResourceSearch(container: HTMLElement, tab: ResourceManagementTab): void {
    const copy = this.copy;
    const searchWrap = container.createDiv({ cls: "codex-resource-search" });
    const icon = searchWrap.createSpan({ cls: "codex-resource-search-icon" });
    setIcon(icon, "search");
    const input = searchWrap.createEl("input", {
      cls: "codex-resource-search-input",
      attr: {
        type: "search",
        placeholder: copy.resources.searchPlaceholder(copy.resources.tabs[tab]),
        "aria-label": copy.resources.searchAria,
        "data-echoink-focus-key": `resources:search:${tab}`
      }
    });
    input.value = this.resourceSearchQuery[tab];
    const clear = searchWrap.createEl("button", {
      cls: "codex-resource-search-clear",
      attr: { type: "button", "aria-label": copy.resources.clearSearch, "data-echoink-focus-key": `resources:clear:${tab}` }
    });
    setIcon(clear, "x");
    clear.hidden = !input.value;
    input.oninput = () => {
      this.resourceSearchQuery[tab] = input.value;
      clear.hidden = !input.value;
      this.scheduleResourceSearchFilter(tab);
    };
    clear.onclick = () => {
      input.value = "";
      this.resourceSearchQuery[tab] = "";
      clear.hidden = true;
      this.clearResourceSearchDebounceTimer();
      this.applyResourceSearchFilter(tab);
      input.focus();
    };
  }

  private scheduleResourceSearchFilter(tab: ResourceManagementTab): void {
    this.clearResourceSearchDebounceTimer();
    this.resourceSearchDebounceTimer = window.setTimeout(() => {
      this.resourceSearchDebounceTimer = null;
      this.applyResourceSearchFilter(tab);
    }, 120);
  }

  private clearResourceSearchDebounceTimer(): void {
    if (this.resourceSearchDebounceTimer === null) return;
    window.clearTimeout(this.resourceSearchDebounceTimer);
    this.resourceSearchDebounceTimer = null;
  }

  private applyResourceSearchFilter(tab: ResourceManagementTab): void {
    if (this.plugin.settings.resourceManagementTab !== tab) return;
    const body = this.containerEl.querySelector<HTMLElement>(".codex-resource-body");
    if (!body) return;
    const rows = Array.from(body.querySelectorAll<HTMLElement>(".codex-resource-row[data-resource-key]")).map((row) => ({
      key: row.dataset.resourceKey ?? "",
      name: row.dataset.resourceName ?? "",
      meta: row.dataset.resourceMeta ?? "",
      desc: row.dataset.resourceDesc ?? "",
      row
    }));
    const query = this.resourceSearchQuery[tab];
    const visibleKeys = new Set(filterWorkspaceResourceRows(rows, query).map((row) => row.key));
    let visible = 0;
    for (const row of rows) {
      const shouldShow = visibleKeys.has(row.key);
      row.row.toggleClass("is-search-hidden", !shouldShow);
      if (shouldShow) visible += 1;
    }
    const summary = body.querySelector<HTMLElement>("[data-resource-summary]");
    const total = Number(summary?.dataset.resourceTotal ?? rows.length);
    const enabled = Number(summary?.dataset.resourceEnabled ?? 0);
    if (summary) {
      const label = this.copy.resources.tabs[tab];
      summary.setText(resourceSummaryText(
        this.plugin.settings.settingsLanguage,
        label,
        enabled,
        total,
        visible,
        Boolean(query.trim())
      ));
    }
    if (summary) this.announceSettingsStatus(summary.textContent ?? "");
    const empty = body.querySelector<HTMLElement>("[data-resource-search-empty]");
    empty?.toggleClass("is-hidden", !query.trim() || visible > 0);
  }

  private currentEchoInkResourceCatalog(snapshot: WorkspaceResourceSnapshot | null = this.resourceSnapshot): EchoInkResource[] {
    void snapshot;
    return buildActiveEchoInkResourceCatalog({
      settings: this.plugin.settings.resources,
      manual: this.runtimeEchoInkResources
    });
  }

  private renderActiveResourceTab(container: HTMLElement, snapshot: WorkspaceResourceSnapshot): void {
    const catalog = this.currentEchoInkResourceCatalog(snapshot);
    if (this.plugin.settings.resourceManagementTab === "plugins") {
      this.renderEchoInkResources(container, catalog.filter((resource) => resource.kind === "tool-bundle"), snapshot.errors.plugins);
      return;
    }
    if (this.plugin.settings.resourceManagementTab === "mcp") {
      this.renderEchoInkResources(container, catalog.filter((resource) => resource.kind === "mcp-server"), snapshot.errors.mcp);
      return;
    }
    this.renderEchoInkResources(container, catalog.filter((resource) => resource.kind === "skill"), snapshot.errors.skills);
  }

  private renderEchoInkResources(container: HTMLElement, resources: EchoInkResource[], error?: string): void {
    const copy = this.copy;
    const activeTab = this.plugin.settings.resourceManagementTab;
    const rows = resources.map((resource) => ({
      key: resource.id,
      name: resource.kind === "skill" ? `/${resource.name}` : resource.name,
      meta: resourceDisplayMeta(resource, this.plugin.settings.resources, this.plugin.settings.settingsLanguage),
      desc: resource.description || resource.contentPath || resource.configPath || copy.resources.noDesc,
      resource
    }));
    const query = this.resourceSearchQuery[activeTab];
    const enabled = resources.filter((resource) => resource.enabled).length;
    const filtered = filterWorkspaceResourceRows(rows, query);
    this.renderResourceSummary(
      container,
      resources.length,
      enabled,
      error,
      filtered.length,
      query,
      copy.resources.tabs[activeTab]
    );
    if (!resources.length) {
      const emptyText = activeTab === "plugins" ? copy.resources.noPlugins : activeTab === "mcp" ? copy.resources.noMcp : copy.resources.noSkills;
      createSettingsState(
        container,
        `${emptyText} ${resourceEmptyNextStep(activeTab, this.plugin.settings.settingsLanguage)}`,
        "neutral"
      );
      return;
    }
    if (!filtered.length) {
      const emptyText = activeTab === "plugins" ? copy.resources.noPluginMatches : activeTab === "mcp" ? copy.resources.noMcpMatches : copy.resources.noSkillMatches;
      createSettingsState(container, emptyText, "neutral")
        .setAttr("data-resource-search-empty", "true");
    }
    const visibleKeys = new Set(filtered.map((row) => row.key));
    for (const row of rows) this.renderResourceRow(container, row.resource, visibleKeys.has(row.key), row);
  }

  private renderResourceSummary(
    container: HTMLElement,
    total: number,
    enabled: number,
    error?: string,
    visible = total,
    query = "",
    label = this.copy.tabs.resources
  ): void {
    const copy = this.copy;
    const searching = Boolean(query.trim());
    container.createDiv({
      cls: "codex-resource-summary",
      text: resourceSummaryText(
        this.plugin.settings.settingsLanguage,
        label,
        enabled,
        total,
        visible,
        searching
      ),
      attr: {
        "data-resource-summary": "true",
        "data-resource-total": String(total),
        "data-resource-enabled": String(enabled)
      }
    });
    if (error) {
      createSettingsState(
        container,
        this.plugin.settings.settingsLanguage === "en"
          ? "Some resource entries could not be read. Refresh after checking the current Vault configuration."
          : "部分资源未能读取。请检查当前 Vault 配置后刷新。",
        "error"
      );
    }
  }

  private renderResourceRow(container: HTMLElement, resource: EchoInkResource, visible = true, searchRow?: { key: string; name: string; meta?: string; desc?: string }): void {
    const copy = this.copy;
    const resourceEnabled = resource.enabled;
    const row = container.createDiv({
      cls: `codex-resource-row ${resourceEnabled ? "is-enabled" : "is-disabled"} ${visible ? "" : "is-search-hidden"}`,
      attr: {
        "data-resource-key": searchRow?.key ?? resource.id,
        "data-resource-name": searchRow?.name ?? (resource.kind === "skill" ? `/${resource.name}` : resource.name),
        "data-resource-meta": searchRow?.meta ?? "",
        "data-resource-desc": searchRow?.desc ?? ""
      }
    });
    const icon = row.createSpan({ cls: "codex-resource-row-icon" });
    setIcon(icon, resource.kind === "skill" ? "sparkles" : resource.kind === "mcp-server" ? "blocks" : "package");
    const content = row.createDiv({ cls: "codex-resource-row-content" });
    const name = resource.kind === "skill" ? `/${resource.name}` : resource.name;
    const connectionStatus = resource.kind === "mcp-server" ? mcpConnectionStatus(resource, this.plugin.settings.resources) : "not-mcp";
    const meta = resourceDisplayMeta(resource, this.plugin.settings.resources, this.plugin.settings.settingsLanguage);
    const nameButton = content.createEl("button", {
      cls: "codex-resource-row-name",
      text: name,
      attr: {
        type: "button",
        "data-echoink-focus-key": `resource:${resource.id}:detail`,
        "aria-label": this.plugin.settings.settingsLanguage === "en"
          ? `Open ${name} details`
          : `打开 ${name} 详情`
      }
    });
    nameButton.onclick = () => this.openSettingsDetail({ kind: "resource", resourceId: resource.id });
    const desc = resource.description || resource.contentPath || resource.configPath || copy.resources.noDesc;
    const description = [desc, meta].filter(Boolean).join(" · ");
    if (description) content.createDiv({ cls: "codex-resource-row-desc", text: description });
    const toggle = row.createEl("input", {
      cls: "codex-resource-toggle",
      attr: {
        type: "checkbox",
        "aria-label": copy.resources.toggleAria(name),
        "data-echoink-focus-key": `resource:${resource.id}:enabled`
      }
    });
    toggle.checked = resourceEnabled;
    toggle.onchange = async () => {
      const enabled = toggle.checked;
      try {
        if (resource.kind === "mcp-server") {
          await this.plugin.setEchoInkMcpServerEnabled(resource.id, enabled);
        } else {
          await this.plugin.setEchoInkSkillResourceEnabled(resource.id, enabled);
        }
        const authoritativeEnabled = this.plugin.settings.resources.catalog
          .find((candidate) => candidate.id === resource.id)?.enabled ?? false;
        toggle.checked = authoritativeEnabled;
        row.toggleClass("is-enabled", authoritativeEnabled);
        row.toggleClass("is-disabled", !authoritativeEnabled);
        this.updateResourceSummaryCounts();
      } catch {
        const authoritativeEnabled = this.plugin.settings.resources.catalog
          .find((candidate) => candidate.id === resource.id)?.enabled ?? false;
        toggle.checked = authoritativeEnabled;
        row.toggleClass("is-enabled", authoritativeEnabled);
        row.toggleClass("is-disabled", !authoritativeEnabled);
        const message = this.plugin.settings.settingsLanguage === "en"
          ? "The resource setting was not saved."
          : "资源开关未保存，请重试。";
        new Notice(message);
        this.announceSettingsStatus(message);
      }
    };
    void connectionStatus;
  }

  private updateResourceSummaryCounts(): void {
    const body = this.containerEl.querySelector<HTMLElement>(".codex-resource-body");
    const summary = body?.querySelector<HTMLElement>("[data-resource-summary]");
    if (!body || !summary) return;
    const rows = Array.from(body.querySelectorAll<HTMLElement>(".codex-resource-row[data-resource-key]"));
    const enabled = rows.filter((row) => row.hasClass("is-enabled")).length;
    const visible = rows.filter((row) => !row.hasClass("is-search-hidden")).length;
    summary.dataset.resourceEnabled = String(enabled);
    const activeTab = this.plugin.settings.resourceManagementTab;
    summary.setText(resourceSummaryText(
      this.plugin.settings.settingsLanguage,
      this.copy.resources.tabs[activeTab],
      enabled,
      rows.length,
      visible,
      Boolean(this.resourceSearchQuery[activeTab].trim())
    ));
    this.announceSettingsStatus(summary.textContent ?? "");
  }

  private async copySettingsValue(value: string, button: HTMLButtonElement): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      const message = this.plugin.settings.settingsLanguage === "en" ? "Copied full value." : "已复制完整内容。";
      this.announceSettingsStatus(message);
      new Notice(message);
    } catch {
      this.settingsActionErrors.resources = this.plugin.settings.settingsLanguage === "en"
        ? "Could not copy the value. Select it from the visible field instead."
        : "无法复制该内容，请从可见字段中选择并复制。";
      button.focus();
      this.announceSettingsStatus(this.settingsActionErrors.resources);
      this.scheduleDisplay();
    }
  }

  private renderMcpConnectionActions(row: HTMLElement, resource: EchoInkResource, status: ReturnType<typeof mcpConnectionStatus>): void {
    const actions = row.createDiv({ cls: "echoink-settings-inline-actions" });
    const configure = actions.createEl("button", {
      text: this.plugin.settings.settingsLanguage === "en"
        ? (status === "imported-only" || status === "missing-config" ? "Configure connection" : "Edit connection")
        : (status === "imported-only" || status === "missing-config" ? "补全连接配置" : "编辑连接配置"),
      attr: { type: "button", "data-echoink-focus-key": `resource:${resource.id}:configure` }
    });
    configure.onclick = () => this.openMcpServerModal(resource);
    if (status === "connectable" || status === "verified" || status === "failed") {
      const test = actions.createEl("button", {
        text: this.plugin.settings.settingsLanguage === "en" ? "Test connection" : "测试连接",
        attr: { type: "button", "data-echoink-focus-key": `resource:${resource.id}:test` }
      });
      test.onclick = () => void this.testMcpConnection(resource, test);
    }
    if (resource.source === "manual") {
      const remove = actions.createEl("button", {
        cls: "mod-warning",
        text: this.plugin.settings.settingsLanguage === "en" ? "Delete server" : "删除 Server",
        attr: { type: "button", "data-echoink-focus-key": `resource:${resource.id}:delete` }
      });
      remove.onclick = () => void this.deleteMcpServer(resource, remove);
    }
  }

  private openMcpServerModal(resource?: EchoInkResource): void {
    const connection = resource
      ? resolveMcpConnectionRecord(resource, this.plugin.settings.resources) ?? undefined
      : undefined;
    new McpServerModal({
      app: this.app,
      language: this.plugin.settings.settingsLanguage,
      ...(resource ? { resource } : {}),
      ...(connection ? { connection } : {}),
      save: async (draft) => {
        const saved = await this.plugin.saveEchoInkMcpServer(draft);
        this.settingsDetail = { kind: "resource", resourceId: saved.id };
        await this.loadWorkspaceResources(true, "mcp");
        const message = this.plugin.settings.settingsLanguage === "en"
          ? `Saved MCP server ${saved.name}.`
          : `已保存 MCP Server：${saved.name}。`;
        new Notice(message);
        this.announceSettingsStatus(message);
      }
    }).open();
  }

  private async deleteMcpServer(resource: EchoInkResource, button: HTMLButtonElement): Promise<void> {
    const english = this.plugin.settings.settingsLanguage === "en";
    const accepted = await confirmModal(
      this.app,
      english ? "Delete MCP server" : "删除 MCP Server",
      english
        ? `Delete ${resource.name} and its local connection settings? This does not execute any MCP tool.`
        : `删除 ${resource.name} 及其本地连接设置？此操作不会执行任何 MCP Tool。`,
      english ? "Delete" : "删除",
      english ? "Cancel" : "取消"
    );
    if (!accepted) return;
    button.disabled = true;
    try {
      await this.plugin.deleteEchoInkMcpServer(resource.id);
      this.settingsDetail = null;
      await this.loadWorkspaceResources(true, "mcp");
      const message = english ? "MCP server deleted." : "MCP Server 已删除。";
      new Notice(message);
      this.announceSettingsStatus(message);
    } catch {
      button.disabled = false;
      const message = english ? "The MCP server was not deleted." : "MCP Server 未删除，请重试。";
      new Notice(message);
      this.announceSettingsStatus(message);
    }
  }

  private async testMcpConnection(resource: EchoInkResource, button?: HTMLButtonElement): Promise<void> {
    if (button) button.disabled = true;
    try {
      const result = await this.plugin.refreshEchoInkMcpServer(resource.id, 30000);
      const message = this.plugin.settings.settingsLanguage === "en"
        ? `Connection verified: ${result.tools} tools.`
        : `连接已验证：${result.tools} 个工具。`;
      new Notice(message);
      this.announceSettingsStatus(message);
      await this.loadWorkspaceResources(true, "mcp");
    } catch (error) {
      const message = this.plugin.settings.settingsLanguage === "en"
        ? "Connection test did not finish. Review the visible error, then retry."
        : "连接测试未完成。请查看页面中的错误后重试。";
      new Notice(message);
      this.announceSettingsStatus(message);
    } finally {
      if (button?.isConnected) button.disabled = false;
      this.scheduleDisplay();
    }
  }

  private async loadWorkspaceResources(force = false, tab: ResourceManagementTab = this.plugin.settings.resourceManagementTab): Promise<void> {
    if (this.resourceLoadingTab === tab) return;
    if (this.resourceLoaded[tab] && !force) return;
    this.resourceLoadingTab = tab;
    delete this.resourceLoadErrors[tab];
    this.scheduleDisplay();
    try {
      this.runtimeEchoInkResources = await this.plugin.buildRuntimeEchoInkResourceCatalog();
      const scanError = this.plugin.settings.resources.lastError.trim();
      if (scanError) this.resourceLoadErrors[tab] = scanError;
      else this.resourceLoadErrors = {};
      this.resourceSnapshot = emptyWorkspaceResourceSnapshot();
      this.resourceLoaded[tab] = true;
    } catch (error) {
      this.resourceLoadErrors[tab] = error instanceof Error ? error.message : String(error);
      this.resourceSnapshot = emptyWorkspaceResourceSnapshot();
      this.resourceLoaded[tab] = true;
    } finally {
      this.resourceLoadingTab = null;
      this.scheduleDisplay();
    }
  }

  private decorateSetting(setting: Setting, iconName: string): Setting {
    void iconName;
    return applySettingsRow(setting);
  }
}

function providerConfigurationFingerprint(provider: ApiProviderConfig): string {
  return JSON.stringify({
    providerId: normalizeApiProviderId(
      provider.providerId,
      provider.baseUrl,
      provider.name
    ),
    runtimeProviderId: provider.runtimeProviderId,
    apiProtocol: provider.apiProtocol,
    baseUrl: provider.baseUrl,
    model: provider.model,
    toolCalling: provider.toolCalling,
    imageInput: provider.imageInput,
    reasoning: provider.reasoning,
    contextWindow: provider.contextWindow,
    maxOutputTokens: provider.maxOutputTokens,
    apiKeyConfigured: Boolean(provider.apiKey.trim())
  });
}

function labelSettingsToggle(
  toggle: { toggleEl: HTMLElement },
  label: string
): void {
  toggle.toggleEl.setAttr("aria-label", label);
  const inputEl = toggle.toggleEl.matches("input")
    ? toggle.toggleEl
    : toggle.toggleEl.querySelector<HTMLInputElement>('input[type="checkbox"]');
  inputEl?.setAttr("aria-label", label);
}

function onboardingCoachmarkCopy(
  step: EchoInkOnboardingStep,
  zh: boolean
): Readonly<{
  step: string;
  title: string;
  description: string;
  action: string;
}> {
  const index = step === "provider" ? 1 : step === "knowledge" ? 2 : 3;
  if (!zh) {
    return Object.freeze({
      step: `Step ${index} of 3`,
      title: step === "provider"
        ? "Add your model"
        : step === "knowledge"
          ? "Initialize Knowledge"
          : "Choose an initial style",
      description: step === "provider"
        ? "This is where you can save and activate a Provider. It is optional for this tutorial and does not prove network connectivity."
        : step === "knowledge"
          ? "Initialize now or later with a recoverable preview before EchoInk moves or refines any note."
          : "Choose a style now or later. Memory learning and recall are recommendations; dreaming remains optional and off by default.",
      action: step === "personality" ? "Finish" : "Next"
    });
  }
  return Object.freeze({
    step: `第 ${index} 步，共 3 步`,
    title: step === "provider"
      ? "添加可用模型"
      : step === "knowledge"
        ? "初始化知识库"
        : "选择初始风格",
    description: step === "provider"
      ? "这里可以保存并启用 Provider；本教程不要求现在完成，配置完整也不代表已验证网络连接。"
      : step === "knowledge"
        ? "可以现在或稍后初始化；EchoInk 移动或提炼笔记前仍会先给出可恢复的预览。"
        : "可以现在或稍后选择风格。Memory 学习与读取只是建议；做梦保持默认关闭且可选。",
    action: step === "personality" ? "完成" : "下一步"
  });
}

function positionOnboardingCoachmark(
  coachmark: HTMLElement,
  anchor: HTMLElement,
  settingsWindow: Window
): void {
  const anchorRect = anchor.getBoundingClientRect();
  const margin = 12;
  const viewportWidth = settingsWindow.innerWidth;
  const viewportHeight = settingsWindow.innerHeight;
  if (viewportWidth <= 640) {
    coachmark.setCssStyles({
      left: `${margin}px`,
      right: `${margin}px`,
      top: "auto",
      bottom: `${margin}px`,
      width: "auto"
    });
    coachmark.dataset.placement = "bottom-sheet";
    return;
  }
  const width = Math.min(360, viewportWidth - margin * 2);
  const coachmarkHeight = Math.max(coachmark.offsetHeight, 180);
  const below = anchorRect.bottom + margin;
  const above = anchorRect.top - coachmarkHeight - margin;
  const top = below + coachmarkHeight <= viewportHeight - margin
    ? below
    : Math.max(margin, above);
  const left = Math.min(
    viewportWidth - width - margin,
    Math.max(margin, anchorRect.left)
  );
  coachmark.setCssStyles({
    left: `${left}px`,
    right: "auto",
    top: `${top}px`,
    bottom: "auto",
    width: `${width}px`
  });
  coachmark.dataset.placement = top === below ? "below" : "above";
}

const RESOURCE_TABS: Array<{ id: ResourceManagementTab; icon: string }> = [
  { id: "plugins", icon: "package" },
  { id: "mcp", icon: "blocks" },
  { id: "skills", icon: "sparkles" }
];

type VisibleSettingsTab = SettingsTab;

type SettingsActionContext = "knowledge" | "review" | "resources";

type SettingsDetail =
  | "knowledge-memory"
  | "knowledge-preferences"
  | "review-archives"
  | "review-memory"
  | { readonly kind: "resource"; readonly resourceId: string }
  | {
      readonly kind: "review-memory-category";
      readonly category: PersonalMemoryCorrectionCategory;
    }
  | null;

type PersonalMemoryCorrectionCategory =
  | "facts"
  | "views"
  | "decisions"
  | "active"
  | "episodes";

interface PersonalMemoryCorrectionCategoryDefinition {
  readonly id: PersonalMemoryCorrectionCategory;
  readonly labelZh: string;
  readonly labelEn: string;
  readonly descriptionZh: string;
  readonly descriptionEn: string;
  readonly kinds: readonly PersonalMemoryKind[];
}

const PERSONAL_MEMORY_CORRECTION_CATEGORIES: readonly PersonalMemoryCorrectionCategoryDefinition[] = Object.freeze([
  { id: "facts", labelZh: "事实", labelEn: "Facts", descriptionZh: "你确认过、目前仍然有效的客观信息。", descriptionEn: "Information you confirmed that is still current.", kinds: ["fact"] },
  { id: "views", labelZh: "观点", labelEn: "Views", descriptionZh: "你当前持有的看法、判断与偏好。", descriptionEn: "Views, judgments, and preferences you currently hold.", kinds: ["view"] },
  { id: "decisions", labelZh: "决定", labelEn: "Decisions", descriptionZh: "你已经决定、后续应该遵守的做法。", descriptionEn: "Decisions you made that should be followed going forward.", kinds: ["decision"] },
  { id: "active", labelZh: "进行中", labelEn: "Active", descriptionZh: "你正在推进的目标、任务与待处理事项。", descriptionEn: "Goals, tasks, and open items you are currently working on.", kinds: ["goal", "task", "open_loop"] },
  { id: "episodes", labelZh: "经历", labelEn: "Episodes", descriptionZh: "过去发生过、在类似情况下值得参考的经验。", descriptionEn: "Past experiences worth referring to in similar situations.", kinds: ["episode"] }
]);

function personalMemoryCorrectionCategory(
  category: PersonalMemoryCorrectionCategory
): PersonalMemoryCorrectionCategoryDefinition {
  return PERSONAL_MEMORY_CORRECTION_CATEGORIES.find((item) => item.id === category)!;
}

function personalMemoryKindLabel(kind: PersonalMemoryKind, zh: boolean): string {
  const labels: Record<PersonalMemoryKind, readonly [string, string]> = {
    fact: ["事实", "fact"],
    view: ["观点", "view"],
    decision: ["决定", "decision"],
    goal: ["目标", "goal"],
    task: ["任务", "task"],
    open_loop: ["待闭环", "open loop"],
    episode: ["经历", "episode"]
  };
  return labels[kind][zh ? 0 : 1];
}

function isPersonalMemoryRevisionConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { code?: unknown; message?: unknown };
  return record.code === "revision_conflict"
    || (typeof record.message === "string"
      && record.message.includes("revision_conflict"));
}

const SETTINGS_PANEL_ID = "echoink-settings-panel";
const SETTINGS_TITLE_ID = "echoink-settings-title";
const RESOURCE_PANEL_ID = "echoink-resource-panel";
const RESOURCE_TITLE_ID = "echoink-resource-title";

const SETTINGS_TABS: Array<{ id: VisibleSettingsTab; icon: string }> = [
  { id: "general", icon: "settings" },
  { id: "providers", icon: "key-round" },
  { id: "resources", icon: "blocks" },
  { id: "knowledgeBase", icon: "book-open" },
  { id: "review", icon: "clipboard-check" }
];

function visibleSettingsTab(tab: SettingsTab): VisibleSettingsTab {
  return tab;
}

function settingsTabDomId(tab: VisibleSettingsTab): string {
  return `echoink-settings-tab-${tab}`;
}

function resourceTabDomId(tab: ResourceManagementTab): string {
  return `echoink-resource-tab-${tab}`;
}

function tabIndexFromKeyboard(
  key: string,
  currentIndex: number,
  tabCount: number
): number | null {
  if (tabCount <= 0) return null;
  if (key === "Home") return 0;
  if (key === "End") return tabCount - 1;
  if (key === "ArrowRight" || key === "ArrowDown") {
    return (currentIndex + 1) % tabCount;
  }
  if (key === "ArrowLeft" || key === "ArrowUp") {
    return (currentIndex - 1 + tabCount) % tabCount;
  }
  return null;
}

function resourceKindForResourceTab(tab: ResourceManagementTab): EchoInkResource["kind"] {
  return tab === "mcp" ? "mcp-server" : tab === "skills" ? "skill" : "tool-bundle";
}

function resourceDisplayMeta(
  resource: EchoInkResource,
  resourceSettings: Pick<typeof DEFAULT_SETTINGS.resources, "mcpConnections">,
  language: "zh-CN" | "en"
): string {
  const connectionStatus = resource.kind === "mcp-server"
    ? mcpConnectionStatus(resource, resourceSettings)
    : "not-mcp";
  return [
    resourceSourceLabel(resource.source, language),
    resource.kind === "mcp-server" ? mcpConnectionStatusLabel(connectionStatus, language) : ""
  ].filter(Boolean).join(" · ");
}

function mcpConnectionSummary(connection: EchoInkMcpConnectionRecord, english: boolean): string {
  if (connection.transport === "http") {
    let endpoint = connection.url;
    try {
      const url = new URL(connection.url);
      endpoint = `${url.origin}${url.pathname}`;
    } catch {
      endpoint = english ? "Invalid HTTP endpoint" : "HTTP 地址无效";
    }
    return `HTTP · ${endpoint}`;
  }
  const argumentCount = connection.args?.length ?? 0;
  return english
    ? `stdio · ${connection.command} · ${argumentCount} arguments`
    : `stdio · ${connection.command} · ${argumentCount} 个参数`;
}

function mcpDiagnosticLabel(code: EchoInkMcpDiagnosticCode, english: boolean): string {
  const labels: Record<EchoInkMcpDiagnosticCode, [string, string]> = {
    connection_failed: ["连接失败", "Connection failed"],
    authentication_failed: ["认证失败", "Authentication failed"],
    schema_invalid: ["Schema 异常", "Schema invalid"],
    disconnected: ["连接中断", "Disconnected"],
    timeout: ["连接超时", "Timed out"],
    call_failed: ["Tool 调用失败", "Tool call failed"]
  };
  return labels[code][english ? 1 : 0];
}

function resourceSourceLabel(source: EchoInkResource["source"], language: "zh-CN" | "en"): string {
  if (language === "en") {
    if (source === "echoink-local") return "This vault";
    if (source === "manual") return "Added locally";
    return "Imported";
  }
  if (source === "echoink-local") return "当前 Vault";
  if (source === "manual") return "本地添加";
  return "已导入";
}

function resourceEmptyNextStep(tab: ResourceManagementTab, language: "zh-CN" | "en"): string {
  if (language === "en") {
    if (tab === "mcp") return "Add an MCP connection to this vault, then select Refresh.";
    if (tab === "skills") return "Add a Skill to this vault, then select Refresh.";
    return "Add a plugin tool bundle to this vault, then select Refresh.";
  }
  if (tab === "mcp") return "将 MCP 连接添加到当前 Vault 后，点击“刷新”。";
  if (tab === "skills") return "将 Skill 添加到当前 Vault 后，点击“刷新”。";
  return "将插件工具包添加到当前 Vault 后，点击“刷新”。";
}

function resourceSummaryText(
  language: "zh-CN" | "en",
  category: string,
  enabled: number,
  total: number,
  visible: number,
  searching: boolean
): string {
  if (language === "en") {
    return searching
      ? `${category} · ${enabled} of ${total} enabled · ${visible} shown`
      : `${category} · ${enabled} of ${total} enabled`;
  }
  return searching
    ? `${category} · 已启用 ${enabled} / ${total} · 显示 ${visible}`
    : `${category} · 已启用 ${enabled} / ${total}`;
}

function pluginInstallDir(plugin: CodexForObsidianPlugin): string {
  const dir = "dir" in plugin.manifest && typeof plugin.manifest.dir === "string"
    ? plugin.manifest.dir
    : "";
  return dir ? `${dir}/` : ".obsidian/plugins/codex-echoink/";
}

function formatQueryParams(params?: Record<string, string>): string {
  return Object.entries(params ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

function parseQueryParams(value: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const paramValue = trimmed.slice(separator + 1).trim();
    if (/^[A-Za-z0-9_-]+$/.test(key) && paramValue) params[key] = paramValue;
  }
  return params;
}
