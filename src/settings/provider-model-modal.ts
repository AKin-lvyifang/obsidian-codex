import { App, Modal, setIcon, setTooltip } from "obsidian";
import type {
  AuthEvent,
  AuthInteraction,
  AuthPrompt
} from "@earendil-works/pi-ai";
import type {
  PiProviderConfigurationDraft
} from "../plugin/pi-provider-configuration-service";
import type {
  OpenAICodexAuthStatus
} from "../plugin/openai-codex-oauth-service";
import {
  applyApiProviderModelPreset,
  createApiProviderConfig,
  isValidApiProviderModelId,
  type ApiProviderConfig
} from "./settings";
import type { SettingsCopy } from "./i18n";
import { renderProviderBrandIcon } from "./provider-brand-icons";
import {
  API_PROVIDER_PRESETS,
  apiProviderApiKeyRequired,
  apiProviderMaxOutputReserve,
  getApiProviderPreset,
  normalizeApiProviderId,
  type ApiProviderPreset,
  type ApiProviderProtocol
} from "./provider-presets";
import { providerTooltipBaseUrl } from "./provider-tooltip";
import {
  ProviderPreflightSession,
  providerPreflightApiKeyReady,
  type ProviderPreflightService
} from "./provider-preflight";
import { applyAmicroButton } from "./amicro-buttons";

type ProviderFormField =
  | "oauth"
  | "apiKey"
  | "endpoint"
  | "model"
  | "protocol"
  | "contextWindow"
  | "maxOutputTokens";

export type ProviderModelSaveResult =
  | { readonly saved: true }
  | { readonly saved: false; readonly message?: string };

let providerModelModalInstance = 0;

export interface ProviderModelModalOptions {
  readonly app: App;
  readonly draft: ApiProviderConfig;
  readonly editing: boolean;
  readonly language: "zh-CN" | "en";
  readonly copy: SettingsCopy;
  readonly preflight: ProviderPreflightService;
  readonly codexOAuth?: {
    status(): Promise<OpenAICodexAuthStatus>;
    login(interaction: AuthInteraction): Promise<OpenAICodexAuthStatus>;
    logout(): Promise<void>;
    openExternal(url: string): Promise<boolean>;
  };
  readonly save: (
    draft: ApiProviderConfig,
    apiKey: string,
    connectionVerified: boolean
  ) => Promise<ProviderModelSaveResult>;
}

export class ProviderModelModal extends Modal {
  private draft: ApiProviderConfig;
  private apiKeyInput = "";
  private readonly preflight: ProviderPreflightSession;
  private customProtocolEnabled: boolean;
  private closed = true;
  private suppressModalClose = false;
  private saving = false;
  private invalidatingPreflightInPlace = false;
  private formErrors: Partial<Record<ProviderFormField, string>> = {};
  private focusIntent: string | null = null;
  private liveRegionEl: HTMLElement | null = null;
  private codexAuthStatus: OpenAICodexAuthStatus = {
    state: "disconnected"
  };
  private codexAuthLoading = false;
  private codexLoginController: AbortController | null = null;
  private codexManualCode = "";
  private codexManualResolve: ((value: string) => void) | null = null;
  private codexManualReject: ((error: Error) => void) | null = null;
  private codexAuthUrl = "";
  private codexAuthError = "";
  private readonly accessibilityId = `echoink-provider-model-${++providerModelModalInstance}`;
  private readonly handleEscapeCapture = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    const openPicker = this.modalEl.querySelector<HTMLElement>(
      ".codex-provider-combobox.is-open"
    );
    const activeElement = document.activeElement;
    if (
      !openPicker
      || !(activeElement instanceof HTMLElement)
      || !openPicker.contains(activeElement)
    ) return;
    const trigger = openPicker.querySelector<HTMLButtonElement>(
      ".codex-provider-combobox-trigger"
    );
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    this.closeOpenPickers();
    window.requestAnimationFrame(() => {
      if (trigger?.isConnected) trigger.focus();
    });
  };

  constructor(private readonly options: ProviderModelModalOptions) {
    super(options.app);
    this.draft = structuredClone(options.draft);
    this.customProtocolEnabled =
      this.draft.apiProtocol !== "openai-completions";
    this.preflight = new ProviderPreflightSession(
      options.preflight,
      (state) => {
        if (this.closed) return;
        if (state.operation === "model_list" && state.status === "available") {
          const models = unique(
            state.models.filter(isValidApiProviderModelId)
          );
          this.draft.models = unique([
            ...models,
            this.draft.model
          ].filter(Boolean));
        }
        this.announce(this.modelStatusText());
        if (this.invalidatingPreflightInPlace && state.status === "idle") {
          this.refreshPreflightStatus();
          return;
        }
        this.render();
      }
    );
  }

  onOpen(): void {
    this.closed = false;
    this.modalEl.addClass("codex-provider-model-modal");
    this.liveRegionEl = this.modalEl.createDiv({
      cls: "codex-provider-modal-live-region",
      attr: {
        role: "status",
        "aria-live": "polite",
        "aria-atomic": "true"
      }
    });
    window.addEventListener("keydown", this.handleEscapeCapture, true);
    this.render();
    this.startInitialModelPreflight();
    if (this.providerId === "openai-codex") {
      void this.loadCodexAuthStatus();
    }
  }

  close(): void {
    if (this.suppressModalClose) {
      this.suppressModalClose = false;
      return;
    }
    const openPicker = this.modalEl.querySelector<HTMLElement>(
      ".codex-provider-combobox.is-open"
    );
    const activeElement = document.activeElement;
    if (
      openPicker
      && activeElement instanceof HTMLElement
      && openPicker.contains(activeElement)
    ) {
      const trigger = openPicker.querySelector<HTMLButtonElement>(
        ".codex-provider-combobox-trigger"
      );
      this.closeOpenPickers();
      window.requestAnimationFrame(() => {
        if (trigger?.isConnected) trigger.focus();
      });
      return;
    }
    super.close();
  }

  onClose(): void {
    this.closed = true;
    this.cancelCodexLogin();
    this.dismissProviderUrlTooltips();
    window.removeEventListener("keydown", this.handleEscapeCapture, true);
    this.preflight.cancel();
    this.modalEl.onclick = null;
    this.liveRegionEl = null;
    this.modalEl.removeClass("codex-provider-model-modal");
    this.titleEl.empty();
    this.contentEl.empty();
  }

  private get zh(): boolean {
    return this.options.language !== "en";
  }

  private label(chinese: string, english: string): string {
    return this.zh ? chinese : english;
  }

  private get providerId(): ApiProviderPreset["id"] {
    return getApiProviderPreset(normalizeApiProviderId(
      this.draft.providerId,
      this.draft.baseUrl,
      this.draft.name
    )).id;
  }

  private render(): void {
    this.dismissProviderUrlTooltips();
    this.captureFocusIntent();
    const focusedTriggerId = this.focusedComboboxTriggerId();
    const providerId = this.providerId;
    const preset = getApiProviderPreset(providerId);
    this.modalEl.toggleClass("is-custom-provider", providerId === "custom");
    this.titleEl.empty();
    this.titleEl.addClass("codex-provider-modal-title");
    this.titleEl.createSpan({
      cls: "codex-provider-modal-title-text",
      text: this.options.editing
        ? this.label("编辑模型", "Edit model")
        : this.label("添加模型", "Add model")
    });
    if (providerId === "openai-codex") {
      this.titleEl.createSpan({
        cls: "codex-provider-beta-pill",
        text: "Beta"
      });
    } else {
      this.titleEl.createSpan({
        cls: "codex-provider-protocol-pill",
        text: protocolPill(this.draft.apiProtocol, this.zh)
      });
    }

    this.contentEl.empty();
    this.contentEl.addClass("codex-provider-modal-content");
    const form = this.contentEl.createDiv({ cls: "codex-provider-modal-form" });
    form.setAttr("aria-busy", String(
      this.saving || this.preflight.state.status === "loading"
    ));
    this.renderProviderPicker(form, providerId);

    if (providerId === "custom") {
      this.renderCustomForm(form);
    } else {
      if (providerId === "openai-codex") {
        this.renderCodexOAuth(form);
      }
      if (apiProviderApiKeyRequired(providerId)) {
        this.renderApiKeyField(form);
      }
      this.renderPresetModelField(form, preset.model);
    }

    const footer = this.contentEl.createDiv({ cls: "codex-provider-modal-footer" });
    const saveState = footer.createDiv({
      cls: "codex-provider-modal-save-state",
      attr: { "aria-live": "off" }
    });
    const actions = footer.createDiv({ cls: "codex-provider-modal-actions" });
    const cancel = actions.createEl("button", {
      text: this.label("取消", "Cancel"),
      attr: { type: "button", "data-modal-focus-key": "cancel" }
    });
    applyAmicroButton(cancel, { variant: "secondary" });
    cancel.onclick = () => this.close();
    const save = actions.createEl("button", {
      cls: "mod-cta",
      text: this.options.copy.providers.saveAndUse,
      attr: { type: "button", "data-modal-focus-key": "save" }
    });
    applyAmicroButton(save, { variant: "primary", motion: "complete" });
    save.dataset.idleLabel = this.options.copy.providers.saveAndUse;
    save.disabled = this.saving || !this.codexSaveReady();
    save.onclick = () => {
      void (async () => {
        const errors = this.validateForm();
        if (Object.keys(errors).length) {
          this.formErrors = errors;
          const [field, message] = Object.entries(errors)[0] as [ProviderFormField, string];
          this.announce(message);
          this.render();
          this.focusField(field);
          return;
        }
        const maxOutputTokens = apiProviderMaxOutputReserve(
          this.providerId,
          this.draft.model,
          this.draft.maxOutputTokens
        );
        if (maxOutputTokens !== this.draft.maxOutputTokens) {
          this.draft.maxOutputTokens = maxOutputTokens;
          this.invalidatePreflight();
        }
        this.saving = true;
        save.disabled = true;
        save.textContent = this.options.copy.providers.saving;
        saveState.removeClass("is-error");
        saveState.textContent = this.options.copy.providers.saving;
        this.announce(this.options.copy.providers.saving);
        try {
          const result = await this.options.save(
            this.draft,
            this.apiKeyInput,
            this.preflight.state.operation === "connection"
              && this.preflight.state.status === "available"
          );
          if (result.saved) {
            this.announce(this.options.copy.providers.saved(this.draft.name));
            this.close();
            return;
          }
          saveState.textContent = result.message ?? this.options.copy.providers.saveFailed;
          saveState.addClass("is-error");
          this.announce(saveState.textContent);
        } catch {
          saveState.textContent = this.options.copy.providers.saveFailed;
          saveState.addClass("is-error");
          this.announce(saveState.textContent);
        } finally {
          this.saving = false;
          if (save.isConnected) {
            save.disabled = !this.codexSaveReady();
            save.textContent = save.dataset.idleLabel ?? this.options.copy.providers.saveAndUse;
          }
        }
      })();
    };

    this.modalEl.onclick = (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.closest(".codex-provider-combobox")) return;
      this.closeOpenPickers();
    };
    if (this.focusIntent) this.restoreFocusIntent();
    else if (focusedTriggerId) this.restoreComboboxTriggerFocus(focusedTriggerId);
  }

  private renderProviderPicker(
    container: HTMLElement,
    providerId: ApiProviderPreset["id"]
  ): void {
    const row = container.createDiv({ cls: "codex-provider-modal-field" });
    const labelRow = row.createDiv({ cls: "codex-provider-modal-label-row" });
    const providerLabel = labelRow.createDiv({
      cls: "codex-provider-modal-label",
      text: this.label("提供商", "Provider"),
      attr: { id: `${this.providerTriggerId}-label` }
    });
    const selected = getApiProviderPreset(providerId);
    if (selected.docsUrl) {
      labelRow.createEl("a", {
        cls: "codex-provider-doc-link",
        text: this.label("查看文档", "View docs"),
        href: selected.docsUrl,
        attr: {
          target: "_blank",
          rel: "noopener noreferrer"
        }
      });
    }

    const picker = row.createDiv({ cls: "codex-provider-combobox" });
    const listboxId = `${this.accessibilityId}-provider-listbox`;
    const trigger = picker.createEl("button", {
      cls: "codex-provider-combobox-trigger",
      attr: {
        type: "button",
        "data-provider-url-tooltip": "true",
        "aria-haspopup": "listbox",
        "aria-expanded": "false",
        "aria-controls": listboxId
      }
    });
    trigger.id = this.providerTriggerId;
    const triggerName = renderProviderIdentity(trigger, providerId, selected.name);
    triggerName.id = `${this.providerTriggerId}-name`;
    trigger.setAttr("aria-labelledby", `${providerLabel.id} ${triggerName.id}`);
    this.applyProviderUrlTooltip(trigger, providerId);
    const chevron = trigger.createSpan({ cls: "codex-provider-combobox-chevron" });
    setIcon(chevron, "chevron-down");

    const menu = picker.createDiv({
      cls: "codex-provider-combobox-menu"
    });
    const searchWrap = menu.createDiv({ cls: "codex-provider-combobox-search" });
    const searchIcon = searchWrap.createSpan();
    setIcon(searchIcon, "search");
    const search = searchWrap.createEl("input", {
      attr: {
        type: "search",
        placeholder: this.label("搜索 Provider", "Search providers"),
        autocomplete: "off",
        "aria-label": this.label("搜索 Provider", "Search providers")
      }
    }) as HTMLInputElement;
    const options = menu.createDiv({
      cls: "codex-provider-combobox-options",
      attr: {
        role: "listbox",
        "aria-label": this.label("选择 Provider", "Choose a provider")
      }
    });
    options.id = listboxId;
    const official = API_PROVIDER_PRESETS.filter((item) => item.id !== "custom");
    const optionRows: Array<{ element: HTMLElement; text: string }> = [];
    for (const item of official) {
      optionRows.push({
        element: this.renderProviderOption(options, item.id, item.name),
        text: `${item.id} ${item.name}`.toLowerCase()
      });
    }
    const otherHeading = options.createDiv({
      cls: "codex-provider-combobox-group",
      text: this.label("其他", "Other")
    });
    const custom = getApiProviderPreset("custom");
    const customRow = this.renderProviderOption(options, "custom", custom.name);
    optionRows.push({
      element: customRow,
      text: `custom ${custom.name}`.toLowerCase()
    });

    const resetProviderFilter = () => {
      search.value = "";
      for (const row of optionRows) row.element.removeClass("is-hidden");
      otherHeading.removeClass("is-hidden");
    };
    const openPicker = (focusTarget: ComboboxFocusTarget) => {
      this.closeOpenPickers();
      picker.addClass("is-open");
      trigger.setAttr("aria-expanded", "true");
      this.positionCombobox(picker, trigger);
      resetProviderFilter();
      focusOpenCombobox(search, options, focusTarget);
    };
    const closePicker = (restoreFocus: boolean) => {
      if (restoreFocus) this.suppressModalCloseForCurrentEvent();
      picker.removeClass("is-open");
      trigger.setAttr("aria-expanded", "false");
      if (restoreFocus) trigger.focus();
    };
    trigger.onclick = (event) => {
      event.stopPropagation();
      if (picker.hasClass("is-open")) {
        closePicker(false);
        return;
      }
      openPicker("search");
    };
    search.onclick = (event) => event.stopPropagation();
    search.oninput = () => {
      const query = search.value.trim().toLowerCase();
      for (const row of optionRows) {
        row.element.toggleClass("is-hidden", Boolean(query) && !row.text.includes(query));
      }
      otherHeading.toggleClass("is-hidden", customRow.hasClass("is-hidden"));
    };
    bindComboboxKeyboard({
      picker,
      trigger,
      search,
      options,
      openPicker,
      closePicker
    });
  }

  private renderProviderOption(
    container: HTMLElement,
    providerId: ApiProviderPreset["id"],
    name: string
  ): HTMLElement {
    const option = container.createEl("button", {
      cls: `codex-provider-combobox-option ${providerId === this.providerId ? "is-selected" : ""}`,
      attr: {
        type: "button",
        role: "option",
        "data-provider-id": providerId,
        "data-provider-url-tooltip": "true",
        "aria-selected": String(providerId === this.providerId),
        tabindex: "-1"
      }
    });
    const optionName = renderProviderIdentity(option, providerId, name);
    optionName.id = `${this.accessibilityId}-provider-option-${providerId}-name`;
    option.setAttr("aria-labelledby", optionName.id);
    this.applyProviderUrlTooltip(option, providerId);
    renderComboboxCheck(option, providerId === this.providerId);
    option.onclick = (event) => {
      event.stopPropagation();
      this.selectProvider(providerId);
    };
    return option;
  }

  private selectProvider(providerId: ApiProviderPreset["id"]): void {
    if (providerId === this.providerId) {
      this.closeOpenPickers();
      this.restoreComboboxTriggerFocus(this.providerTriggerId);
      return;
    }
    if (this.providerId === "openai-codex") {
      this.cancelCodexLogin();
    }
    const replacement = createApiProviderConfig(providerId, this.draft.id);
    this.draft = { ...replacement, apiKey: "" };
    this.apiKeyInput = "";
    this.customProtocolEnabled = false;
    this.preflight.reset();
    this.startInitialModelPreflight();
    if (providerId === "openai-codex") {
      void this.loadCodexAuthStatus();
    }
    this.restoreComboboxTriggerFocus(this.providerTriggerId);
  }

  private renderApiKeyField(container: HTMLElement): void {
    const inputId = this.controlId("apiKey");
    const field = this.createField(container, "API Key", inputId);
    const controls = field.createDiv({ cls: "codex-provider-modal-input-control" });
    const input = controls.createEl("input", {
      cls: "codex-provider-modal-input",
      attr: {
        id: inputId,
        type: "password",
        autocomplete: "new-password",
        "data-modal-focus-key": "apiKey",
        placeholder: this.draft.apiKey.trim()
          ? this.options.copy.providers.savedKeyPlaceholder
          : this.options.copy.providers.keyPlaceholder
      }
    }) as HTMLInputElement;
    this.applyFieldAccessibility(input, "apiKey");
    input.value = this.apiKeyInput;
    input.oninput = () => {
      this.apiKeyInput = input.value;
      this.invalidatePreflight();
      this.clearFieldError("apiKey", input);
    };
    input.onchange = () => {
      if (!input.value.trim()) return;
      void this.discoverModels();
    };
    const reveal = controls.createEl("button", {
      cls: "codex-provider-modal-icon-button",
      attr: {
        type: "button",
        title: this.options.copy.providers.showKey,
        "aria-label": this.options.copy.providers.showKey,
        "data-modal-focus-key": "toggle-api-key"
      }
    });
    setIcon(reveal, "eye");
    reveal.onclick = () => {
      input.type = input.type === "password" ? "text" : "password";
      reveal.empty();
      setIcon(reveal, input.type === "password" ? "eye" : "eye-off");
      reveal.title = input.type === "password"
        ? this.options.copy.providers.showKey
        : this.options.copy.providers.hideKey;
      reveal.setAttr("aria-label", input.type === "password"
        ? this.options.copy.providers.showKey
        : this.options.copy.providers.hideKey);
    };
    this.renderFieldError(field, "apiKey");
  }

  private renderCodexOAuth(container: HTMLElement): void {
    const card = container.createDiv({
      cls: `codex-provider-oauth-card is-${this.codexAuthStatus.state}`
    });
    const copy = card.createDiv({ cls: "codex-provider-oauth-copy" });
    copy.createDiv({
      cls: "codex-provider-oauth-title",
      text: this.label("OpenAI 浏览器授权", "OpenAI browser authorization")
    });
    copy.createDiv({
      cls: "codex-provider-oauth-description",
      text: this.codexAuthStatus.state === "connected"
        ? this.label("已连接 OpenAI Codex。", "OpenAI Codex is connected.")
        : this.codexAuthStatus.state === "expired"
          ? this.label(
              "已连接；下次请求会安全刷新授权。",
              "Connected; authorization refreshes safely on the next request."
            )
          : this.label(
              "通过浏览器连接 ChatGPT 账户；EchoInk 不会显示访问令牌。",
              "Connect a ChatGPT account in your browser. EchoInk never displays access tokens."
            )
    });

    const actions = card.createDiv({ cls: "codex-provider-oauth-actions" });
    const connected = this.codexAuthStatus.state !== "disconnected";
    if (connected) {
      const logout = actions.createEl("button", {
        text: this.label("退出登录", "Log out"),
        attr: {
          type: "button",
          "data-modal-focus-key": "codex-oauth-logout"
        }
      });
      logout.disabled = this.codexAuthLoading;
      logout.onclick = () => void this.logoutCodex();
    } else if (!this.codexLoginController) {
      const login = actions.createEl("button", {
        cls: "mod-cta",
        text: this.codexAuthLoading
          ? this.label("正在读取…", "Loading…")
          : this.label("使用 OpenAI 登录", "Sign in with OpenAI"),
        attr: {
          type: "button",
          "data-modal-focus-key": "codex-oauth-login"
        }
      });
      login.disabled = this.codexAuthLoading || !this.options.codexOAuth;
      login.onclick = () => void this.startCodexLogin();
    }

    if (this.codexAuthUrl) {
      const reopen = actions.createEl("button", {
        text: this.label("重新打开登录页面", "Reopen login page"),
        attr: {
          type: "button",
          "data-modal-focus-key": "codex-oauth-reopen"
        }
      });
      reopen.onclick = () => {
        void this.options.codexOAuth?.openExternal(this.codexAuthUrl);
      };
    }

    if (this.codexLoginController) {
      const manual = card.createDiv({ cls: "codex-provider-oauth-manual" });
      const inputId = this.controlId("oauth");
      manual.createEl("label", {
        text: this.label(
          "浏览器没有自动完成时，粘贴回调地址或授权码",
          "If the browser does not finish automatically, paste the redirect URL or authorization code"
        ),
        attr: { for: inputId }
      });
      const input = manual.createEl("input", {
        cls: "codex-provider-modal-input",
        attr: {
          id: inputId,
          type: "text",
          value: this.codexManualCode,
          autocomplete: "off",
          "data-modal-focus-key": "codex-oauth-manual"
        }
      });
      input.oninput = () => {
        this.codexManualCode = input.value;
      };
      const manualActions = manual.createDiv({
        cls: "codex-provider-oauth-manual-actions"
      });
      const finish = manualActions.createEl("button", {
        cls: "mod-cta",
        text: this.label("完成授权", "Complete authorization"),
        attr: { type: "button" }
      });
      finish.disabled = !this.codexManualCode.trim();
      input.oninput = () => {
        this.codexManualCode = input.value;
        finish.disabled = !this.codexManualCode.trim();
      };
      finish.onclick = () => this.finishCodexManualCode();
      const cancel = manualActions.createEl("button", {
        text: this.label("停止", "Stop"),
        attr: { type: "button" }
      });
      cancel.onclick = () => {
        this.cancelCodexLogin();
        this.render();
      };
    }

    if (this.codexAuthError) {
      card.createDiv({
        cls: "codex-provider-field-error",
        text: this.codexAuthError,
        attr: { role: "alert" }
      });
    }
  }

  private async loadCodexAuthStatus(): Promise<void> {
    if (!this.options.codexOAuth || this.codexAuthLoading) return;
    this.codexAuthLoading = true;
    this.render();
    try {
      this.codexAuthStatus = await this.options.codexOAuth.status();
      this.codexAuthError = "";
    } catch {
      this.codexAuthStatus = { state: "disconnected" };
      this.codexAuthError = this.label(
        "暂时无法读取登录状态。",
        "The sign-in status is temporarily unavailable."
      );
    } finally {
      this.codexAuthLoading = false;
      if (!this.closed) this.render();
    }
  }

  private async startCodexLogin(): Promise<void> {
    const service = this.options.codexOAuth;
    if (!service || this.codexLoginController) return;
    const controller = new AbortController();
    this.codexLoginController = controller;
    this.codexManualCode = "";
    this.codexAuthUrl = "";
    this.codexAuthError = "";
    this.render();
    const interaction: AuthInteraction = {
      signal: controller.signal,
      notify: (event) => this.handleCodexAuthEvent(event),
      prompt: async (prompt) => await this.handleCodexAuthPrompt(prompt)
    };
    try {
      this.codexAuthStatus = await service.login(interaction);
      this.codexAuthUrl = "";
      this.codexAuthError = "";
      this.announce(this.label("OpenAI Codex 已连接。", "OpenAI Codex connected."));
    } catch {
      if (!controller.signal.aborted) {
        this.codexAuthError = this.label(
          "OpenAI 授权未完成，请重试。",
          "OpenAI authorization did not finish. Try again."
        );
      }
    } finally {
      this.codexLoginController = null;
      this.codexManualCode = "";
      this.codexManualResolve = null;
      this.codexManualReject = null;
      if (!this.closed) this.render();
    }
  }

  private handleCodexAuthEvent(event: AuthEvent): void {
    if (event.type !== "auth_url") return;
    this.codexAuthUrl = event.url;
    void this.options.codexOAuth?.openExternal(event.url)
      .then((opened) => {
        if (!opened) {
          this.codexAuthError = this.label(
            "浏览器未能自动打开，请使用“重新打开登录页面”。",
            "The browser could not open automatically. Use “Reopen login page”."
          );
        }
        if (!this.closed) this.render();
      })
      .catch(() => {
        this.codexAuthError = this.label(
          "浏览器未能自动打开，请使用“重新打开登录页面”。",
          "The browser could not open automatically. Use “Reopen login page”."
        );
        if (!this.closed) this.render();
      });
    if (!this.closed) this.render();
  }

  private async handleCodexAuthPrompt(prompt: AuthPrompt): Promise<string> {
    if (prompt.type === "select") return "browser";
    if (prompt.type !== "manual_code") {
      throw new Error("codex_oauth_prompt_unsupported");
    }
    return await new Promise<string>((resolve, reject) => {
      if (prompt.signal?.aborted) {
        reject(new Error("codex_oauth_prompt_cancelled"));
        return;
      }
      this.codexManualResolve = resolve;
      this.codexManualReject = reject;
      prompt.signal?.addEventListener("abort", () => {
        this.codexManualResolve = null;
        this.codexManualReject = null;
        reject(new Error("codex_oauth_prompt_cancelled"));
      }, { once: true });
      if (!this.closed) this.render();
    });
  }

  private finishCodexManualCode(): void {
    const value = this.codexManualCode.trim();
    if (!value || !this.codexManualResolve) return;
    const resolve = this.codexManualResolve;
    this.codexManualResolve = null;
    this.codexManualReject = null;
    resolve(value);
  }

  private cancelCodexLogin(): void {
    this.codexLoginController?.abort();
    this.codexLoginController = null;
    this.codexManualCode = "";
    this.codexManualReject?.(new Error("codex_oauth_login_cancelled"));
    this.codexManualResolve = null;
    this.codexManualReject = null;
  }

  private async logoutCodex(): Promise<void> {
    if (!this.options.codexOAuth || this.codexAuthLoading) return;
    this.codexAuthLoading = true;
    this.render();
    try {
      await this.options.codexOAuth.logout();
      this.codexAuthStatus = { state: "disconnected" };
      this.codexAuthUrl = "";
      this.codexAuthError = "";
      this.announce(this.label("已退出 OpenAI Codex。", "Logged out of OpenAI Codex."));
    } catch {
      this.codexAuthError = this.label(
        "退出登录失败，请重试。",
        "Log out failed. Try again."
      );
    } finally {
      this.codexAuthLoading = false;
      if (!this.closed) this.render();
    }
  }

  private codexSaveReady(): boolean {
    return this.providerId !== "openai-codex"
      || this.codexAuthStatus.state !== "disconnected";
  }

  private renderPresetModelField(
    container: HTMLElement,
    automaticModel: string
  ): void {
    const field = this.createField(
      container,
      this.label("模型名称", "Model"),
      this.modelTriggerId
    );
    this.renderModelPicker(field, automaticModel);
    const statusRow = field.createDiv({
      cls: `codex-provider-model-status is-${this.preflight.state.status}`,
      attr: { role: "status", "aria-live": "off" }
    });
    this.renderPreflightStatus(statusRow);
    this.renderFieldError(field, "model");
  }

  private renderPreflightStatus(statusRow: HTMLElement): void {
    statusRow.createSpan({ text: this.modelStatusText() });
    if (
      this.preflight.state.operation === "model_list"
      && (
        this.preflight.state.status === "api_key_error"
        || this.preflight.state.status === "temporary_failure"
      )
    ) {
      const retry = statusRow.createEl("button", {
        cls: "codex-provider-inline-retry",
        text: this.label("重试", "Retry"),
        attr: {
          type: "button",
          "data-modal-focus-key": "model-retry"
        }
      });
      retry.onclick = () => {
        this.focusIntent = "model-retry";
        void this.discoverModels();
      };
    }
    if (
      this.canTestConnection()
      && this.preflight.state.status !== "loading"
    ) {
      const test = statusRow.createEl("button", {
        cls: "codex-provider-inline-retry",
        text: this.options.copy.providers.testConnection,
        attr: {
          type: "button",
          "data-modal-focus-key": "provider-test-connection"
        }
      });
      test.onclick = () => {
        this.focusIntent = "provider-test-connection";
        void this.testConnection();
      };
    }
  }

  private refreshPreflightStatus(): void {
    this.contentEl.querySelector<HTMLElement>(".codex-provider-modal-form")
      ?.setAttr("aria-busy", String(
        this.saving || this.preflight.state.status === "loading"
      ));
    const statusRow = this.contentEl.querySelector<HTMLElement>(
      ".codex-provider-model-status"
    );
    if (!statusRow) return;
    statusRow.className = `codex-provider-model-status is-${this.preflight.state.status}`;
    statusRow.empty();
    this.renderPreflightStatus(statusRow);
  }

  private renderModelPicker(
    container: HTMLElement,
    automaticModel: string
  ): void {
    const picker = container.createDiv({ cls: "codex-provider-combobox codex-model-combobox" });
    const listboxId = `${this.accessibilityId}-model-listbox`;
    const selectedModelLabel = this.draft.modelSelection === "auto"
      ? this.label("Auto", "Auto")
      : this.draft.model;
    const trigger = picker.createEl("button", {
      cls: "codex-provider-combobox-trigger",
      attr: {
        type: "button",
        title: selectedModelLabel,
        "data-modal-focus-key": "model",
        "aria-label": this.label(
          `当前模型：${selectedModelLabel}`,
          `Current model: ${selectedModelLabel}`
        ),
        "aria-haspopup": "listbox",
        "aria-expanded": "false",
        "aria-controls": listboxId
      }
    });
    trigger.id = this.modelTriggerId;
    trigger.createSpan({
      cls: "codex-model-combobox-value",
      text: selectedModelLabel
    });
    const chevron = trigger.createSpan({ cls: "codex-provider-combobox-chevron" });
    setIcon(chevron, "chevron-down");
    const menu = picker.createDiv({
      cls: "codex-provider-combobox-menu"
    });
    const searchWrap = menu.createDiv({ cls: "codex-provider-combobox-search" });
    const searchIcon = searchWrap.createSpan();
    setIcon(searchIcon, "search");
    const search = searchWrap.createEl("input", {
      attr: {
        type: "search",
        placeholder: this.label("搜索或输入模型 ID", "Search or enter a model ID"),
        autocomplete: "off",
        "aria-label": this.label("搜索或输入模型 ID", "Search or enter a model ID")
      }
    }) as HTMLInputElement;
    const list = menu.createDiv({
      cls: "codex-provider-combobox-options",
      attr: {
        role: "listbox",
        "aria-label": this.label("选择模型", "Choose a model")
      }
    });
    list.id = listboxId;

    const renderOptions = () => {
      list.empty();
      const query = search.value.trim();
      const normalizedQuery = query.toLowerCase();
      const choices = this.modelChoices(automaticModel);
      const autoMatches = !normalizedQuery || "auto".includes(normalizedQuery);
      if (autoMatches) {
        const isSelected = this.draft.modelSelection === "auto";
        const auto = list.createEl("button", {
          cls: `codex-provider-combobox-option ${isSelected ? "is-selected" : ""}`,
          attr: {
            type: "button",
            role: "option",
            title: `Auto · ${automaticModel}`,
            "aria-selected": String(isSelected),
            tabindex: "-1"
          }
        });
        auto.createSpan({ cls: "codex-model-option-name", text: "Auto" });
        auto.createSpan({
          cls: "codex-model-option-hint",
          text: automaticModel
        });
        renderComboboxCheck(auto, isSelected);
        auto.onclick = (event) => {
          event.stopPropagation();
          const first = getApiProviderPreset(this.providerId).models[0];
          if (first) applyApiProviderModelPreset(this.draft, first.id);
          this.draft.modelSelection = "auto";
          this.invalidatePreflight();
          this.render();
          this.restoreComboboxTriggerFocus(this.modelTriggerId);
        };
      }
      for (const modelId of choices) {
        if (normalizedQuery && !modelId.toLowerCase().includes(normalizedQuery)) continue;
        const isSelected = this.draft.modelSelection === "model" && this.draft.model === modelId;
        const option = list.createEl("button", {
          cls: `codex-provider-combobox-option ${isSelected ? "is-selected" : ""}`,
          attr: {
            type: "button",
            role: "option",
            title: modelId,
            "aria-selected": String(isSelected),
            tabindex: "-1"
          }
        });
        option.createSpan({ cls: "codex-model-option-name", text: modelId });
        renderComboboxCheck(option, isSelected);
        option.onclick = (event) => {
          event.stopPropagation();
          this.selectModel(modelId);
        };
      }
      if (
        query
        && isValidApiProviderModelId(query)
        && !choices.includes(query)
      ) {
        const custom = list.createEl("button", {
          cls: "codex-provider-combobox-option codex-model-custom-option",
          attr: {
            type: "button",
            role: "option",
            title: query,
            "aria-selected": "false",
            tabindex: "-1"
          }
        });
        const icon = custom.createSpan({ cls: "codex-provider-option-icon" });
        setIcon(icon, "plus");
        custom.createSpan({
          text: this.label(`使用 ${query}`, `Use ${query}`)
        });
        custom.onclick = (event) => {
          event.stopPropagation();
          this.selectModel(query);
        };
      }
      if (!list.childElementCount) {
        list.createDiv({
          cls: "codex-provider-combobox-empty",
          text: this.label("没有匹配的模型", "No matching models")
        });
      }
    };
    renderOptions();
    const openPicker = (focusTarget: ComboboxFocusTarget) => {
      this.closeOpenPickers();
      picker.addClass("is-open");
      trigger.setAttr("aria-expanded", "true");
      this.positionCombobox(picker, trigger);
      search.value = "";
      renderOptions();
      focusOpenCombobox(search, list, focusTarget);
    };
    const closePicker = (restoreFocus: boolean) => {
      if (restoreFocus) this.suppressModalCloseForCurrentEvent();
      picker.removeClass("is-open");
      trigger.setAttr("aria-expanded", "false");
      if (restoreFocus) trigger.focus();
    };
    trigger.onclick = (event) => {
      event.stopPropagation();
      if (picker.hasClass("is-open")) {
        closePicker(false);
        return;
      }
      openPicker("search");
    };
    search.onclick = (event) => event.stopPropagation();
    search.oninput = renderOptions;
    bindComboboxKeyboard({
      picker,
      trigger,
      search,
      options: list,
      openPicker,
      closePicker
    });
  }

  private selectModel(modelId: string): void {
    this.draft.model = modelId;
    this.draft.modelSelection = "model";
    this.draft.models = unique([modelId, ...this.draft.models]);
    applyApiProviderModelPreset(this.draft, modelId);
    this.invalidatePreflight();
    this.render();
    this.restoreComboboxTriggerFocus(this.modelTriggerId);
  }

  private modelChoices(automaticModel: string): string[] {
    const presetModels = getApiProviderPreset(this.providerId).models.map(
      (model) => model.id
    );
    const discoveredModels = this.preflight.state.models.filter(
      isValidApiProviderModelId
    );
    const source = discoveredModels.length > 0
      ? discoveredModels
      : presetModels;
    return unique([
      ...source,
      ...this.draft.models,
      this.draft.model,
      automaticModel
    ].filter(Boolean));
  }

  private modelStatusText(): string {
    const state = this.preflight.state;
    if (state.operation === "connection") {
      if (state.status === "loading") {
        return this.options.copy.providers.testingConnection;
      }
      if (state.status === "available") {
        return this.options.copy.providers.connectionAvailable;
      }
      if (state.connectionFailure) {
        if (
          state.connectionFailure === "auth"
          && this.providerId === "openai-codex"
        ) {
          return this.label(
            "OpenAI Codex 授权已失效，请重新登录。",
            "OpenAI Codex authorization expired. Sign in again."
          );
        }
        return this.options.copy.providers.connectionFailures[
          state.connectionFailure
        ];
      }
    }
    if (state.status === "loading") {
      return this.providerId === "ollama"
        ? this.label("正在读取本机模型…", "Loading local models…")
        : this.options.copy.providers.modelListLoading;
    }
    if (state.status === "available") {
      if (state.models.length === 0) {
        return this.label(
          "Provider 没有返回可选模型。请确认权限或直接输入已知 Model ID。",
          "The provider returned no models. Check access or enter a known Model ID."
        );
      }
      return this.options.copy.providers.modelListAvailable(
        state.models.length
      );
    }
    if (state.status === "unsupported") {
      return this.label(
        "该 Provider 未开放模型列表，当前显示内置候选。",
        "This provider does not expose a model list; built-in choices are shown."
      );
    }
    if (state.status === "api_key_error") {
      return this.options.copy.providers.modelListApiKeyError;
    }
    if (state.status === "temporary_failure") {
      return this.options.copy.providers.modelListFailed;
    }
    if (
      apiProviderApiKeyRequired(this.providerId)
      && !this.apiKeyInput.trim()
      && !this.draft.apiKey.trim()
    ) {
      return this.label(
        "输入 API Key 后自动获取；当前显示内置候选。",
        "Enter an API key to load models automatically; built-in choices are shown."
      );
    }
    return this.label(
      "将自动获取可用模型；当前显示内置候选。",
      "Available models will load automatically; built-in choices are shown."
    );
  }

  private renderCustomForm(container: HTMLElement): void {
    const endpointId = this.controlId("endpoint");
    const endpoint = this.createField(
      container,
      this.label("接口地址", "Endpoint URL"),
      endpointId
    );
    const endpointInput = endpoint.createEl("input", {
      cls: "codex-provider-modal-input",
      attr: {
        id: endpointId,
        type: "url",
        value: this.draft.baseUrl,
        placeholder: "https://api.example.com/v1/chat/completions",
        autocomplete: "off",
        "data-modal-focus-key": "endpoint"
      }
    }) as HTMLInputElement;
    this.applyFieldAccessibility(endpointInput, "endpoint");
    endpointInput.oninput = () => {
      this.draft.baseUrl = endpointInput.value;
      this.clearFieldError("endpoint", endpointInput);
      this.invalidatePreflight();
      this.syncCurrentProviderUrlTooltips();
    };
    this.renderFieldError(endpoint, "endpoint");

    this.renderApiKeyField(container);

    const modelId = this.controlId("model");
    const model = this.createField(
      container,
      this.label("模型名称", "Model ID"),
      modelId
    );
    const modelInput = model.createEl("input", {
      cls: "codex-provider-modal-input",
      attr: {
        id: modelId,
        type: "text",
        value: this.draft.model,
        placeholder: this.label(
          "输入模型参数值，例如 gpt-4o 或 openai/gpt-4o",
          "Enter a model ID, for example gpt-4o or openai/gpt-4o"
        ),
        autocomplete: "off",
        "data-modal-focus-key": "model"
      }
    }) as HTMLInputElement;
    this.applyFieldAccessibility(modelInput, "model");
    modelInput.oninput = () => {
      this.draft.model = modelInput.value.trim();
      this.draft.modelSelection = "model";
      this.draft.models = this.draft.model ? [this.draft.model] : [];
      this.invalidatePreflight();
      this.clearFieldError("model", modelInput);
    };
    this.renderFieldError(model, "model");

    const advanced = container.createDiv({ cls: "codex-provider-custom-advanced" });
    advanced.createDiv({
      cls: "codex-provider-custom-heading",
      text: this.label("高级配置", "Advanced settings")
    });
    const toggles = advanced.createDiv({ cls: "codex-provider-custom-toggles" });
    let protocolField: HTMLElement | null = null;
    this.renderToggle(toggles, this.label("工具调用", "Tool calling"), "tool-calling", this.draft.toolCalling, (value) => {
      this.draft.toolCalling = value;
    });
    this.renderToggle(toggles, this.label("图片输入", "Image input"), "image-input", this.draft.imageInput, (value) => {
      this.draft.imageInput = value;
    });
    this.renderToggle(toggles, this.label("思考模式", "Reasoning mode"), "reasoning-mode", this.draft.reasoning, (value) => {
      this.draft.reasoning = value;
    });
    this.renderToggle(toggles, this.label("自定义协议", "Custom protocol"), "custom-protocol", this.customProtocolEnabled, (value) => {
      this.focusIntent = "toggle:custom-protocol";
      this.customProtocolEnabled = value;
      if (!value) {
        const protocolChanged = this.draft.apiProtocol !== "openai-completions";
        this.draft.apiProtocol = "openai-completions";
        if (protocolChanged) {
          this.render();
        }
      }
      protocolField?.toggleAttribute("hidden", !value);
      this.updateProtocolPill();
    });

    const protocolId = this.controlId("protocol");
    protocolField = this.createField(
      advanced,
      this.label("API 协议", "API protocol"),
      protocolId
    );
    protocolField.addClass("codex-provider-protocol-field");
    protocolField.toggleAttribute("hidden", !this.customProtocolEnabled);
    const select = protocolField.createEl("select", {
      cls: "codex-provider-modal-input",
      attr: {
        id: protocolId,
        "data-modal-focus-key": "protocol"
      }
    }) as HTMLSelectElement;
    this.applyFieldAccessibility(select, "protocol");
    for (const item of [
      "openai-completions",
      "openai-responses",
      "anthropic-messages"
    ] as const) {
      select.createEl("option", {
        value: item,
        text: this.options.copy.providers.protocolOptions[item]
      });
    }
    select.value = this.draft.apiProtocol;
    select.onchange = () => {
      this.focusIntent = "protocol";
      this.draft.apiProtocol = select.value as ApiProviderProtocol;
      delete this.formErrors.protocol;
      this.invalidatePreflight();
      this.updateProtocolPill();
      this.restoreFocusIntent();
    };
    this.renderFieldError(protocolField, "protocol");

    const contexts = advanced.createDiv({ cls: "codex-provider-context-grid" });
    this.renderContextField(
      contexts,
      this.label("输入", "Input"),
      this.draft.contextWindow,
      [32_000, 64_000, 128_000, 256_000],
      1_024,
      2_000_000,
      (value) => { this.draft.contextWindow = value; }
    );
    this.renderContextField(
      contexts,
      this.label("输出", "Output"),
      this.draft.maxOutputTokens,
      [8_000, 16_000, 32_000, 64_000],
      1,
      1_000_000,
      (value) => { this.draft.maxOutputTokens = value; }
    );
  }

  private renderToggle(
    container: HTMLElement,
    label: string,
    focusKey: string,
    checked: boolean,
    onChange: (value: boolean) => void
  ): void {
    const control = container.createEl("label", {
      cls: "codex-provider-custom-toggle"
    });
    const input = control.createEl("input", {
      attr: { type: "checkbox", "data-modal-focus-key": `toggle:${focusKey}` }
    }) as HTMLInputElement;
    input.checked = checked;
    input.onchange = () => {
      this.focusIntent = `toggle:${focusKey}`;
      onChange(input.checked);
      this.invalidatePreflight();
      this.restoreFocusIntent();
    };
    control.createSpan({ text: label });
  }

  private updateProtocolPill(): void {
    this.titleEl.querySelector<HTMLElement>(".codex-provider-protocol-pill")
      ?.setText(protocolPill(this.draft.apiProtocol, this.zh));
  }

  private renderContextField(
    container: HTMLElement,
    label: string,
    value: number,
    suggestions: readonly number[],
    min: number,
    max: number,
    onChange: (value: number) => void
  ): void {
    const fieldKey: ProviderFormField = label === this.label("输入", "Input")
      ? "contextWindow"
      : "maxOutputTokens";
    const inputId = this.controlId(fieldKey);
    const field = container.createDiv({ cls: "codex-provider-context-field" });
    field.createEl("label", {
      cls: "codex-provider-modal-label",
      text: label,
      attr: { for: inputId, "data-provider-field-label": "true" }
    });
    const input = field.createEl("input", {
      cls: "codex-provider-modal-input",
      attr: {
        id: inputId,
        type: "number",
        min: String(min),
        max: String(max),
        step: "1",
        value: String(value),
        placeholder: this.label("使用提供商默认值", "Use provider default"),
        "data-modal-focus-key": fieldKey
      }
    }) as HTMLInputElement;
    this.applyFieldAccessibility(input, fieldKey);
    input.oninput = () => {
      const next = Number(input.value);
      if (Number.isSafeInteger(next)) {
        onChange(next);
        this.invalidatePreflight();
        this.clearFieldError(fieldKey, input);
      }
    };
    const shortcuts = field.createDiv({ cls: "codex-provider-context-shortcuts" });
    for (const suggestion of suggestions) {
      const button = shortcuts.createEl("button", {
        text: `${Math.round(suggestion / 1_000)}K`,
        attr: {
          type: "button",
          "data-modal-focus-key": `${fieldKey}-${suggestion}`,
          "aria-label": this.label(
            `将${label}设为 ${suggestion.toLocaleString()} tokens`,
            `Set ${label} to ${suggestion.toLocaleString()} tokens`
          )
        }
      });
      button.onclick = () => {
        input.value = String(suggestion);
        onChange(suggestion);
        this.invalidatePreflight();
        this.clearFieldError(fieldKey, input);
      };
    }
    this.renderFieldError(field, fieldKey);
  }

  private createField(container: HTMLElement, label: string, controlId: string): HTMLElement {
    const field = container.createDiv({ cls: "codex-provider-modal-field" });
    field.createEl("label", {
      cls: "codex-provider-modal-label",
      text: label,
      attr: {
        for: controlId,
        id: `${controlId}-label`,
        "data-provider-field-label": "true"
      }
    });
    return field;
  }

  private controlId(field: ProviderFormField): string {
    return `${this.accessibilityId}-${field}`;
  }

  private errorId(field: ProviderFormField): string {
    return `${this.controlId(field)}-error`;
  }

  private applyFieldAccessibility(control: HTMLElement, field: ProviderFormField): void {
    const error = this.formErrors[field];
    control.setAttr("aria-invalid", String(Boolean(error)));
    const descriptions = [error ? this.errorId(field) : ""].filter(Boolean);
    if (descriptions.length) {
      control.setAttr("aria-describedby", descriptions.join(" "));
    } else control.removeAttribute("aria-describedby");
  }

  private renderFieldError(container: HTMLElement, field: ProviderFormField): void {
    const error = this.formErrors[field];
    if (!error) return;
    container.createDiv({
      cls: "codex-provider-field-error",
      text: error,
      attr: {
        id: this.errorId(field),
        role: "alert"
      }
    });
  }

  private clearFieldError(field: ProviderFormField, control: HTMLElement): void {
    if (!this.formErrors[field]) return;
    delete this.formErrors[field];
    this.applyFieldAccessibility(control, field);
    this.modalEl.querySelector<HTMLElement>(`#${this.errorId(field)}`)?.remove();
  }

  private validateForm(): Partial<Record<ProviderFormField, string>> {
    const errors: Partial<Record<ProviderFormField, string>> = {};
    const requiredKey = apiProviderApiKeyRequired(this.providerId);
    if (requiredKey && !this.apiKeyInput.trim() && !this.draft.apiKey.trim()) {
      errors.apiKey = this.options.copy.providers.missingKey;
    }
    if (this.providerId === "custom") {
      const endpoint = this.draft.baseUrl.trim();
      if (!endpoint) {
        errors.endpoint = this.label("请输入 Endpoint URL。", "Enter an endpoint URL.");
      } else {
        try {
          const url = new URL(endpoint);
          if (url.protocol !== "https:" && url.protocol !== "http:") {
            errors.endpoint = this.label("Endpoint 必须使用 http 或 https。", "The endpoint must use http or https.");
          }
        } catch {
          errors.endpoint = this.label("请输入有效的 Endpoint URL。", "Enter a valid endpoint URL.");
        }
      }
      if (!isValidApiProviderModelId(this.draft.model.trim())) {
        errors.model = this.options.copy.providers.invalidModel;
      }
      if (!["openai-completions", "openai-responses", "anthropic-messages"].includes(this.draft.apiProtocol)) {
        errors.protocol = this.label("请选择支持的 API 协议。", "Choose a supported API protocol.");
      }
      if (!Number.isSafeInteger(this.draft.contextWindow) || this.draft.contextWindow < 1_024 || this.draft.contextWindow > 2_000_000) {
        errors.contextWindow = this.label("输入上下文需在 1,024 到 2,000,000 之间。", "Input context must be between 1,024 and 2,000,000.");
      }
      if (!Number.isSafeInteger(this.draft.maxOutputTokens) || this.draft.maxOutputTokens < 1 || this.draft.maxOutputTokens > 1_000_000) {
        errors.maxOutputTokens = this.label("输出 token 需在 1 到 1,000,000 之间。", "Output tokens must be between 1 and 1,000,000.");
      }
    }
    return errors;
  }

  private captureFocusIntent(): void {
    const activeElement = this.modalEl.ownerDocument.activeElement;
    if (!(activeElement instanceof HTMLElement) || !this.modalEl.contains(activeElement)) return;
    const focusable = activeElement.closest<HTMLElement>("[data-modal-focus-key]");
    if (focusable?.dataset.modalFocusKey) this.focusIntent = focusable.dataset.modalFocusKey;
  }

  private restoreFocusIntent(): void {
    const key = this.focusIntent;
    if (!key) return;
    this.focusIntent = null;
    this.restoreModalFocusKey(key);
  }

  private restoreModalFocusKey(key: string): void {
    const focusTarget = () => {
      const target = Array.from(
        this.modalEl.querySelectorAll<HTMLElement>("[data-modal-focus-key]")
      ).find((element) => element.dataset.modalFocusKey === key);
      if (target?.isConnected) target.focus({ preventScroll: true });
    };
    focusTarget();
    window.queueMicrotask(focusTarget);
    window.requestAnimationFrame(focusTarget);
    // Obsidian can restore the modal container's focus in the first paint
    // after a synchronous control change. Correct it in the next paint so a
    // render does not strand keyboard users on the page root.
    window.requestAnimationFrame(() => window.requestAnimationFrame(focusTarget));
  }

  private focusField(field: ProviderFormField): void {
    const target = this.modalEl.querySelector<HTMLElement>(`#${this.controlId(field)}`);
    const focusTarget = () => target?.focus({ preventScroll: true });
    focusTarget();
    window.requestAnimationFrame(focusTarget);
    window.requestAnimationFrame(() => window.requestAnimationFrame(focusTarget));
  }

  private announce(message: string): void {
    if (this.liveRegionEl) {
      this.liveRegionEl.setText(message);
    }
  }

  private applyProviderUrlTooltip(
    element: HTMLElement,
    providerId: ApiProviderPreset["id"]
  ): void {
    const customBaseUrl = providerId === "custom" && this.providerId === "custom"
      ? this.draft.baseUrl
      : "";
    const url = providerTooltipBaseUrl(providerId, customBaseUrl);
    element.removeAttribute("title");
    if (!url) {
      element.removeAttribute("aria-label");
      element.removeAttribute("data-tooltip-position");
      return;
    }
    setTooltip(element, url, { placement: "top" });
  }

  private dismissProviderUrlTooltips(): void {
    const MouseEventConstructor = this.modalEl.ownerDocument.defaultView?.MouseEvent
      ?? MouseEvent;
    for (const element of Array.from(
      this.modalEl.querySelectorAll<HTMLElement>("[data-provider-url-tooltip]")
    )) {
      element.dispatchEvent(new MouseEventConstructor("mouseleave", {
        relatedTarget: this.modalEl
      }));
      element.dispatchEvent(new MouseEventConstructor("mouseout", {
        bubbles: true,
        relatedTarget: this.modalEl
      }));
    }
  }

  private syncCurrentProviderUrlTooltips(): void {
    const trigger = this.modalEl.querySelector<HTMLElement>(
      `#${this.providerTriggerId}`
    );
    if (trigger) this.applyProviderUrlTooltip(trigger, this.providerId);
    const customOption = this.modalEl.querySelector<HTMLElement>(
      '[data-provider-id="custom"]'
    );
    if (customOption) this.applyProviderUrlTooltip(customOption, "custom");
  }

  private closeOpenPickers(): void {
    for (const picker of Array.from(
      this.modalEl.querySelectorAll<HTMLElement>(".codex-provider-combobox.is-open")
    )) {
      picker.removeClass("is-open");
      picker.removeClass("opens-upward");
      picker.style.removeProperty("--codex-combobox-max-height");
      picker.querySelector<HTMLElement>(".codex-provider-combobox-trigger")
        ?.setAttr("aria-expanded", "false");
    }
  }

  private positionCombobox(picker: HTMLElement, trigger: HTMLElement): void {
    const rect = trigger.getBoundingClientRect();
    const viewportPadding = 12;
    const below = Math.max(0, window.innerHeight - rect.bottom - viewportPadding);
    const above = Math.max(0, rect.top - viewportPadding);
    const opensUpward = below < 220 && above > below;
    const available = opensUpward ? above : below;
    picker.toggleClass("opens-upward", opensUpward);
    picker.style.setProperty(
      "--codex-combobox-max-height",
      `${Math.max(96, Math.min(360, available))}px`
    );
  }

  private get providerTriggerId(): string {
    return `${this.accessibilityId}-provider-trigger`;
  }

  private get modelTriggerId(): string {
    return `${this.accessibilityId}-model-trigger`;
  }

  private restoreComboboxTriggerFocus(triggerId: string): void {
    const focusTrigger = () => {
      this.modalEl.querySelector<HTMLButtonElement>(`#${triggerId}`)
        ?.focus({ preventScroll: true });
    };
    focusTrigger();
    window.requestAnimationFrame(() => {
      focusTrigger();
      window.requestAnimationFrame(focusTrigger);
    });
  }

  private suppressModalCloseForCurrentEvent(): void {
    this.suppressModalClose = true;
    window.requestAnimationFrame(() => {
      this.suppressModalClose = false;
    });
  }

  private focusedComboboxTriggerId(): string | null {
    const activeElement = this.modalEl.ownerDocument.activeElement;
    if (!(activeElement instanceof HTMLElement) || !this.modalEl.contains(activeElement)) return null;
    const picker = activeElement.closest<HTMLElement>(".codex-provider-combobox");
    if (!picker || !this.modalEl.contains(picker)) return null;
    const trigger = picker.querySelector<HTMLButtonElement>(
      ".codex-provider-combobox-trigger"
    );
    if (
      trigger?.id === this.providerTriggerId
      || trigger?.id === this.modelTriggerId
    ) {
      return trigger.id;
    }
    return null;
  }

  private startInitialModelPreflight(): void {
    if (!this.canDiscoverModels()) return;
    void this.discoverModels();
  }

  private invalidatePreflight(): void {
    this.invalidatingPreflightInPlace = true;
    try {
      this.preflight.invalidate();
    } finally {
      this.invalidatingPreflightInPlace = false;
    }
  }

  private apiKeyReady(): boolean {
    return providerPreflightApiKeyReady({
      providerId: this.providerId,
      apiKey: this.apiKeyInput,
      storedApiKey: this.draft.apiKey
    });
  }

  private canDiscoverModels(): boolean {
    return this.providerId !== "custom" && this.apiKeyReady();
  }

  private canTestConnection(): boolean {
    return this.apiKeyReady()
      && Boolean(this.draft.baseUrl.trim())
      && isValidApiProviderModelId(this.draft.model.trim());
  }

  private providerPreflightDraft(): PiProviderConfigurationDraft {
    return {
      providerSettingsId: this.draft.id,
      providerId: this.providerId,
      runtimeProviderId: this.draft.runtimeProviderId,
      apiProtocol: this.draft.apiProtocol,
      authMode: this.draft.authMode,
      baseUrl: this.draft.baseUrl,
      modelId: this.draft.model,
      apiKey: this.apiKeyInput,
      toolCalling: this.draft.toolCalling,
      imageInput: this.draft.imageInput,
      reasoning: this.draft.reasoning,
      contextWindow: this.draft.contextWindow,
      maxOutputTokens: this.draft.maxOutputTokens
    };
  }

  private async discoverModels(): Promise<void> {
    if (!this.canDiscoverModels()) return;
    await this.preflight.discoverModels(this.providerPreflightDraft());
  }

  private async testConnection(): Promise<void> {
    if (!this.canTestConnection()) return;
    await this.preflight.testConnection(this.providerPreflightDraft());
  }
}

type ComboboxFocusTarget = "search" | "selected" | "last";

interface ComboboxKeyboardBinding {
  readonly picker: HTMLElement;
  readonly trigger: HTMLButtonElement;
  readonly search: HTMLInputElement;
  readonly options: HTMLElement;
  readonly openPicker: (focusTarget: ComboboxFocusTarget) => void;
  readonly closePicker: (restoreFocus: boolean) => void;
}

function visibleComboboxOptions(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>(
      "button.codex-provider-combobox-option:not(.is-hidden):not(:disabled)"
    )
  );
}

function focusOpenCombobox(
  search: HTMLInputElement,
  options: HTMLElement,
  focusTarget: ComboboxFocusTarget
): void {
  window.requestAnimationFrame(() => {
    if (focusTarget === "search") {
      search.focus();
      return;
    }
    const visible = visibleComboboxOptions(options);
    if (!visible.length) {
      search.focus();
      return;
    }
    const selected = visible.find((option) => option.getAttribute("aria-selected") === "true");
    (selected ?? (focusTarget === "last" ? visible[visible.length - 1] : visible[0])).focus();
  });
}

function bindComboboxKeyboard(binding: ComboboxKeyboardBinding): void {
  const { picker, trigger, search, options, openPicker, closePicker } = binding;

  trigger.onkeydown = (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      openPicker(event.key === "ArrowUp" ? "last" : "selected");
      return;
    }
    if (event.key === "Escape" && picker.hasClass("is-open")) {
      event.preventDefault();
      event.stopPropagation();
      closePicker(true);
    }
  };

  search.onkeydown = (event) => {
    const visible = visibleComboboxOptions(options);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closePicker(true);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      if (!visible.length) return;
      const selected = visible.find((option) => option.getAttribute("aria-selected") === "true");
      (selected ?? (event.key === "ArrowUp" ? visible[visible.length - 1] : visible[0])).focus();
      return;
    }
    if (event.key === "Enter") {
      const selected = visible.find((option) => option.getAttribute("aria-selected") === "true");
      const option = selected ?? visible[0];
      if (!option) return;
      event.preventDefault();
      event.stopPropagation();
      option.click();
    }
  };

  options.onkeydown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closePicker(true);
      return;
    }
    if (
      event.key !== "ArrowDown"
      && event.key !== "ArrowUp"
      && event.key !== "Home"
      && event.key !== "End"
    ) return;

    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const current = target.closest<HTMLButtonElement>(
      "button.codex-provider-combobox-option"
    );
    if (!current) return;
    const visible = visibleComboboxOptions(options);
    const currentIndex = visible.indexOf(current);
    if (currentIndex < 0 || !visible.length) return;
    event.preventDefault();
    event.stopPropagation();
    let nextIndex = currentIndex;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = visible.length - 1;
    if (event.key === "ArrowDown") nextIndex = (currentIndex + 1) % visible.length;
    if (event.key === "ArrowUp") nextIndex = (currentIndex - 1 + visible.length) % visible.length;
    visible[nextIndex].focus();
  };
}

function renderComboboxCheck(option: HTMLElement, selected: boolean): void {
  if (!selected) return;
  const check = option.createSpan({
    cls: "codex-provider-option-check",
    attr: { "aria-hidden": "true" }
  });
  setIcon(check, "check");
}

export function renderProviderIdentity(
  container: HTMLElement,
  providerId: ApiProviderPreset["id"],
  name: string
): HTMLElement {
  const icon = container.createSpan({
    cls: `codex-provider-option-icon is-${providerId}`
  });
  renderProviderBrandIcon(icon, providerId);
  return container.createSpan({ cls: "codex-provider-option-name", text: name });
}

function protocolPill(protocol: ApiProviderProtocol, zh: boolean): string {
  if (protocol === "openai-codex-responses") return "Codex Responses";
  if (protocol === "anthropic-messages") return "Anthropic Messages API";
  if (protocol === "openai-responses") return "OpenAI Responses API";
  return zh ? "OpenAI 兼容 API" : "OpenAI-compatible API";
}

function unique(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}
