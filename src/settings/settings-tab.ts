import { Notice, PluginSettingTab, Setting, setIcon } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import type { PiConversationCatalogEntry } from "../harness/pi-native/contracts";
import type {
  PersonalMemoryKind,
  PersonalMemoryRecord
} from "../harness/memory/personal-memory-contracts";
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

type PersonalMemoryControlState = Awaited<
  ReturnType<CodexForObsidianPlugin["getEchoInkPersonalMemoryState"]>
>;

type KnowledgeMaintenancePreferenceControlState = Awaited<
  ReturnType<CodexForObsidianPlugin[
    "getEchoInkKnowledgeMaintenancePreferenceState"
  ]>
>;

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
        ? "直接编辑当前 Vault 的 AGENT.md 与 USER.md；下一次请求重新读取，不再复制到设置 JSON。"
        : "Edit this Vault's AGENT.md and USER.md directly. The next request reloads both files; settings JSON is not a second source.",
      surface: "group"
    });
    const group = createSettingsGroup(section);
    if (!this.personalMemoryState && !this.personalMemoryLoading && !this.personalMemoryError) {
      void this.loadPersonalMemoryState();
    }
    if (this.personalMemoryLoading) {
      createSettingsState(group, zh ? "正在读取文件…" : "Loading files…", "neutral");
      return;
    }
    if (!this.personalMemoryState) {
      createSettingsState(
        group,
        zh ? "暂时无法读取当前 Vault 的身份文件。" : "Identity files are temporarily unavailable.",
        "error",
        {
          label: zh ? "重新加载身份文件" : "Reload identity files",
          onActivate: () => void this.loadPersonalMemoryState(true)
        }
      );
      return;
    }
    this.addPersonalMemoryProfileEditor(group, "agent", this.personalMemoryState.agent);
    this.addPersonalMemoryProfileEditor(group, "user", this.personalMemoryState.user);
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
  }

  private addPersonalMemoryProfileEditor(
    container: HTMLElement,
    profile: "agent" | "user",
    initialValue: string
  ): void {
    const zh = this.plugin.settings.settingsLanguage !== "en";
    const row = applySettingsRow(new Setting(container)
      .setName(profile === "agent" ? "AGENT.md" : "USER.md")
      .setDesc(profile === "agent"
        ? (zh ? "定义 EchoInk 的身份、表达与协作方式；Memory Tool 永远不能修改它。" : "Defines EchoInk identity and voice; Memory Tools can never modify it.")
        : (zh ? "只保存用户明确确认的稳定资料与合作要求。" : "Stores only explicitly confirmed stable user profile and collaboration preferences."))
      .setClass("echoink-personal-memory-profile-row"));
    row.controlEl.empty();
    const textarea = row.controlEl.createEl("textarea", {
      cls: "echoink-personalization-textarea",
      attr: {
        rows: "7",
        maxlength: "16000",
        "aria-label": zh
          ? `编辑 ${profile === "agent" ? "AGENT.md 身份" : "USER.md 用户画像"}`
          : `Edit ${profile === "agent" ? "AGENT.md identity" : "USER.md profile"}`,
        "data-echoink-focus-key": `personal-memory:${profile}`
      }
    });
    textarea.value = initialValue;
    const actions = row.controlEl.createDiv({ cls: "echoink-personalization-actions" });
    const save = actions.createEl("button", {
      text: zh ? "保存文件" : "Save file",
      attr: {
        type: "button",
        "aria-label": zh
          ? `保存文件：${profile === "agent" ? "AGENT.md 身份" : "USER.md 用户画像"}`
          : `Save file: ${profile === "agent" ? "AGENT.md identity" : "USER.md profile"}`
      }
    });
    save.onclick = () => void this.runPersonalMemoryAction(async () => {
      const state = this.personalMemoryState;
      if (!state) return;
      await this.plugin.updateEchoInkPersonalMemoryProfile(
        profile,
        textarea.value,
        state.revision
      );
      new Notice(zh ? `${profile === "agent" ? "AGENT" : "USER"}.md 已保存` : `${profile.toUpperCase()}.md saved`);
    });
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

    const statusSection = createSettingsSection(page, { surface: "flat" });
    const summary = createSettingsFeatureCard(
      statusSection,
      zh ? "Knowledge Agent" : "Knowledge Agent",
      zh
        ? "空知识库或没有命中时仍由 Pi Agent 正常回答；有依据时可渐进检索 Wiki、Projects 与 Raw，并按需对照只读 Personal Memory。"
        : "Pi Agent still answers when Knowledge is empty or has no match. With evidence, it progressively reads Wiki, Projects, and Raw and may align with read-only Personal Memory."
    );
    summary.createDiv({
      cls: "echoink-settings-feature-meta",
      text: this.knowledgePreferenceLoading
        ? (zh ? "正在读取维护状态…" : "Loading maintenance state…")
        : this.knowledgePreferenceLoadError
          ? (zh
              ? "维护状态暂时无法读取；不会覆盖现有偏好。"
              : "Maintenance state is temporarily unavailable; existing preferences will not be overwritten.")
          : (zh
              ? "显式 /maintain 会直接完成提炼、安全写入和回读验证。"
              : "Explicit /maintain completes refinement, safe writes, and readback verification directly.")
    });

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
    }
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
