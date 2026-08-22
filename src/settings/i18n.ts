
import type {
  KnowledgeBaseInitStatus,
  KnowledgeBaseRunStatus,
  ResourceManagementTab,
  ReviewRangeMode,
  ReviewReportKind,
  SettingsLanguage,
  SettingsTab,
} from "./settings";
import type { PermissionMode, ServiceTierChoice, UiMode } from "../types/app-server";
import type { KnowledgeBaseRunCompletion } from "../knowledge-base/types";

const ZH_CN = {
  languageName: "中文",
  title: "EchoInk Agent 设置",
  common: {
    enabled: "启用",
    disabled: "关闭",
    connected: "已连接",
    disconnected: "未连接",
    unknown: "未知",
    current: (value: string) => `当前：${value}`,
    readFailed: (error: string) => `读取失败：${error}`,
    partialReadFailed: (error: string) => `部分读取失败：${error}`,
    detected: (value: string) => `已检测：${value}`,
    notDetectedManual: "未检测到，可手动填写",
    missing: (items: string[]) => `缺少：${items.join("，")}`,
    enableFailed: (items: string[]) => `无法启用：${items.join("，")}`,
    refresh: "刷新",
    loading: "读取中",
    cancel: "取消",
    delete: "删除",
    clear: "清空"
  },
  tabs: {
    general: "基础设置",
    providers: "API Provider",
    resources: "Skills & MCP",
    knowledgeBase: "知识库管理",
    review: "复盘"
  } satisfies Record<SettingsTab, string>,
  general: {
    settingsLanguage: "设置语言",
    settingsLanguageDesc: "只影响设置页显示；不会改写 Prompt、会话内容或用户自定义名称。",
    auto: "自动",
    defaultReasoning: "默认思考强度",
    defaultSpeed: "默认速度",
    defaultPermission: "默认文件权限",
    defaultMode: "默认模式",
    autoOpen: "启动时自动打开侧栏",
    autoOpenHome: "启动时自动打开首页",
    showContext: "显示上下文容量",
    customWelcome: "自定义加载欢迎语",
    customWelcomeDesc: "开启后可修改空会话里的标题和问候语；关闭时使用默认文案。不会写入对话，也不占用模型 Token。",
    welcomeTitle: "欢迎标题",
    welcomeTitleDesc: "空会话中显示的大标题；留空时使用默认标题。",
    welcomeGreeting: "问候语",
    welcomeGreetingDesc: "标题下方的小字；留空时使用默认问候语。",
    languageOptions: {
      "zh-CN": "中文",
      en: "English"
    } satisfies Record<SettingsLanguage, string>,
    serviceTierOptions: {
      standard: "标准",
      fast: "快速",
      flex: "弹性"
    } satisfies Record<ServiceTierChoice, string>,
    permissionOptions: {
      "read-only": "只读",
      "workspace-write": "工作区可写",
      "danger-full-access": "完全放开"
    } satisfies Record<PermissionMode, string>,
    modeOptions: {
      agent: "Agent",
      plan: "Plan"
    } satisfies Record<UiMode, string>
  },
  knowledge: {
    title: "知识库管理",
    safety: "EchoInk 只响应显式 /maintain，在同一轮核对来源、安全写入并回读验证；原始资料保持不变。",
    lastRunIncomplete: "上一次知识库运行未完成。请检查当前模型设置和操作指南后，从知识库面板重试。",
    statusHeading: "运行状态",
    recentStatus: (status: string, time: string) => `最近状态：${status}${time ? ` · ${time}` : ""}`,
    recentCompletion: (completion: string, attempts: number, pending: number) => [
      `结果：${completion}`,
      attempts > 1 ? `${attempts} 次 Agent 尝试` : "",
      pending ? `${pending} 项留待下轮` : ""
    ].filter(Boolean).join(" · "),
    completionLabels: {
      full: "完整完成",
      partial: "部分完成",
      recovered: "恢复后完成",
      noop: "已检查（无新来源）"
    } satisfies Record<KnowledgeBaseRunCompletion, string>,
    initialization: (status: string, path: string) => `初始化：${status}${path ? ` · ${path}` : ""}`,
    guide: (path: string, _custom: boolean) => `操作指南：${path}（每轮强制注入）`,
    recentReport: (path: string) => `最近报告：${path}`,
    openChannel: "打开当前 Conversation",
    initChannel: "初始化知识库",
    commandHeading: "快捷命令",
    commandGuide: [
      { command: "/ask ...", description: "对知识库发问" },
      { command: "/maintain ...", description: "一次完成知识提炼、安全写入和回读验证" }
    ],
    enabled: "启用知识库管理",
    backend: "知识库使用模型",
    backendDesc: "统一继承当前启用的 Provider 与 Model；请在 API Provider 中修改。",
    followGlobal: (backend: string) => `跟随全局（${backend}）`,
    customRules: "使用自定义指南文件",
    customRulesDesc: (defaultFile: string, _agentsFile: string) => `默认使用 ${defaultFile}；也可以从当前 Vault 选择其他 Markdown 文件。`,
    detection: (value: string) => `检测结果：${value}`,
    modelCapabilities: (text: boolean, image: boolean, pdf: boolean) => `模型能力：文本 ${text ? "✓" : "×"} · 图片 ${image ? "✓" : "×"} · PDF ${pdf ? "✓" : "×"}`,
    testConnection: "测试连接",
    channelNote: "在当前 Pi Conversation 使用 /ask 或 /maintain；设置页负责配置、状态和规则文件。",
    rulesFile: "知识库操作指南文件",
    chooseRulesTitle: "从当前 Vault 选择 Markdown 文件",
    chooseFile: "选择文件",
    useRulesFile: (file: string) => `使用 ${file}`,
    repairRules: "检查并修复",
    repairRulesTitle: "检查指南文件是否缺失必要知识库规则；缺失时自动创建或补齐",
    rulesFileNoteCustom: (file: string, agentsFile: string) => `EchoInk 每轮强制读取 ${file} 并注入系统上下文；${agentsFile} 可不存在，也不会被合并为知识库规则。`,
    rulesFileNoteLegacy: (_agentsFile: string, defaultFile: string) => `知识库任务默认强制加载 ${defaultFile}。`,
    memoryHeading: "EchoInk 文件化 Memory",
    memoryNote1: "Markdown 是当前 Vault 长期 Memory 的内容真源；身份、用户画像和历史记录按固定路径隔离保存。",
    memoryNote2: "AGENT.md、USER.md 与 MEMORY.md 在每次请求重新读取；历史记录只通过受控 Memory Tool 渐进访问。",
    memoryEnabled: "启用长期记忆",
    memoryEnabledDesc: "普通 Chat 和 /ask 会读取提炼记忆，并获得仍在保留期内的本地记录查询入口；维护类 workflow 只在本地提交成功后记录结果。",
    memoryStatusLine: (initialized: boolean, revision: number, pending: number, confirmations: number, issues: number) => `状态：${initialized ? "已初始化" : "未初始化"} · revision ${revision} · pending ${pending} · 待确认 ${confirmations} · 异常 ${issues}`,
    memoryLastSync: (outcome: string, time: string) => `最近同步：${outcome}${time ? ` · ${time}` : ""}`,
    memoryStatusFailed: (_error: string) => "Memory 状态暂时无法读取。请重新加载；若仍未恢复，请使用“恢复事务”。",
    memoryReload: "重新加载状态",
    memoryInitialize: "初始化",
    memorySync: "立即同步",
    memoryRecover: "恢复事务",
    memoryConfirmations: "待确认 / 冲突",
    memoryConflicts: (ids: string) => `冲突项：${ids}`,
    memoryAccept: "接受",
    memoryDismiss: "忽略",
    memoryIssues: "未解决事务",
    memoryRetry: "重试同步",
    memoryDrop: "放弃 pending",
    memoryItems: "已记录项",
    memoryDeleteConfirm: (statement: string) => `删除这条 EchoInk 长期记忆？\n\n${statement}`,
    memoryActionFailed: (_error: string) => "Memory 操作未完成。请重新加载状态后重试。",
    repairSummary: (status: "created" | "patched" | "ok", path: string) => {
      if (status === "created") return `已创建知识库指南：${path}`;
      if (status === "patched") return `已补齐知识库指南：${path}`;
      return `知识库指南可用：${path}`;
    },
    repairPatchedDetail: (count: number) => `，补齐 ${count} 项`,
    repairFailed: (_error: string) => "修复未完成。请检查知识库指南文件后重试。",
    noMarkdownFiles: "当前 Vault 没有可选的 Markdown 文件。",
    selectedRulesFile: (path: string) => `已选择知识库指南：${path}`,
    filePickerPlaceholder: "选择知识库操作指南 Markdown 文件",
    filePickerEmpty: "当前 Vault 没有匹配的 Markdown 文件",
    statusLabels: {
      idle: "未运行",
      running: "运行中",
      success: "成功",
      failed: "失败",
      canceled: "已取消"
    } satisfies Record<KnowledgeBaseRunStatus, string>,
    initStatusLabels: {
      "not-started": "未初始化",
      "preview-ready": "已生成预览",
      initialized: "已初始化",
      failed: "失败"
    } satisfies Record<KnowledgeBaseInitStatus, string>
  },
  review: {
    title: "复盘",
    generateHeading: "生成周报",
    generateAgent: "生成 Agent 周报",
    generateKnowledge: "生成知识库周报",
    pathsHeading: "存放路径",
    outputDir: "输出目录",
    knowledgeMarkdown: "知识库 Markdown",
    knowledgeHtml: "知识库 HTML",
    agentMarkdown: "Agent Markdown",
    agentHtml: "Agent HTML",
    settingsHeading: "周报设置",
    confirmTitle: (label: string) => label,
    confirmBody: (report: string, outputDir: string) => `确定生成${report}？\n\n输出目录：${outputDir}`,
    generate: "生成",
    cancel: "取消",
    reportLabels: {
      "knowledge-base": "知识库周报",
      "agent-chat": "Agent 周报"
    } satisfies Record<ReviewReportKind, string>,
    rangeMode: "统计周期",
    rangeOptions: {
      "previous-week": "上一完整周",
      "current-week": "本周至今"
    } satisfies Record<ReviewRangeMode, string>,
    openHtmlAfterRun: "生成后打开 HTML"
  },
  providers: {
    title: "API Provider",
    simpleSetup: "选择服务商，确认 API URL，输入 API Key 后保存即可聊天。API Key 直接保存在当前 Vault 的插件设置中。",
    provider: "Provider",
    protocol: "API 协议",
    protocolOptions: {
      "openai-responses": "OpenAI Responses",
      "openai-completions": "OpenAI 兼容（Chat Completions）",
      "anthropic-messages": "Anthropic Messages"
    },
    modelPreset: (model: string) => `默认模型：${model}`,
    modelId: "Model ID",
    modelPlaceholder: "请获取或添加模型",
    addCustomModel: "添加自定义 Model ID",
    customModelPrompt: "输入 Model ID，例如 provider/model",
    invalidModel: "Model ID 无效，请输入不含空格的有效 ID",
    fetchModels: "获取模型",
    refreshModels: "刷新模型",
    modelListIdle: "未获取模型列表",
    modelListLoading: "正在获取模型列表…",
    modelListAvailable: (count: number) => `已获取 ${count} 个模型，请从下拉列表选择`,
    modelListUnsupported: "该服务未提供可读取的模型列表，请使用右侧 + 添加 Model ID",
    modelListApiKeyError: "API Key 无效或没有模型列表权限，请检查后重试",
    modelListFailed: "本次获取失败。已保存模型仍会保留，也可在下拉中手动输入模型 ID。",
    keyPlaceholder: "输入 API Key",
    savedKeyPlaceholder: "API Key 已保存；留空表示继续使用",
    showKey: "显示当前输入",
    hideKey: "隐藏当前输入",
    testConnection: "测试连接",
    testingConnection: "测试中…",
    connectionIdle: "尚未测试连接；测试会产生一次极少量 API 费用",
    connectionAvailable: "连接可用",
    connectionFailures: {
      auth: "API Key 无效或没有权限",
      protocol: "Base URL 与所选协议可能不匹配",
      model: "当前 Model ID 不可用",
      rate_limit: "已连接，但当前额度不足或正在限流",
      network: "无法连接服务",
      provider: "Provider 暂时异常"
    },
    saveAndUse: "保存并使用",
    saving: "保存中…",
    missingKey: "请输入 API Key。",
    saved: (provider: string) => `${provider} 已保存，可以直接聊天。`,
    saveFailed: "Provider 未能保存或启用。请检查 Endpoint、API Key、协议与网络后重试。",
    warningKey: "API Key 输入会被遮挡，并直接保存在当前 Vault 的 EchoInk 插件设置中。",
    warningApi: "API URL 需要兼容所选的 API 协议。",
    add: "新增",
    addTitle: "新增 API Provider",
    defaultName: "自定义 API",
    empty: "还没有自定义 API Provider。",
    unnamed: "未命名 Provider",
    active: "已启用",
    enableReconnect: "启用并重连",
    deleteConfirm: (name: string) => `删除 ${name || "这个 Provider"}？`,
    name: "名称",
    namePlaceholder: "例如 OpenAI API",
    baseUrl: "Base URL",
    apiKey: "API key",
    queryParams: "Query Params",
    responseApiRequirement: "要求：服务端需支持 OpenAI Chat Completions。",
    models: "模型"
  },
  resources: {
    title: "Skills & MCP",
    note: "用列表开关控制 EchoInk 可用的插件、MCP 与 Skills。",
    tabs: {
      plugins: "插件",
      mcp: "MCP",
      skills: "Skills"
    } satisfies Record<ResourceManagementTab, string>,
    refreshTitle: "刷新当前列表",
    loadingTab: (label: string) => `正在同步 ${label}…`,
    notLoaded: "资源尚未同步。请刷新后重试。",
    searchPlaceholder: (label: string) => `搜索 ${label}`,
    searchAria: "搜索当前能力列表",
    clearSearch: "清空搜索",
    installed: "已安装",
    notInstalled: "未安装",
    noPlugins: "没有读取到插件。",
    noPluginMatches: "没有匹配的插件。",
    toolsCount: (count: number) => `${count} 个工具`,
    mcpDesc: "已导入到 EchoInk 资源目录",
    noMcp: "没有读取到 MCP 服务器。",
    noMcpMatches: "没有匹配的 MCP 服务器。",
    noDesc: "无描述",
    noSkills: "没有读取到 Skills。",
    noSkillMatches: "没有匹配的 Skill。",
    summary: (label: string, enabled: number, total: number, visible: number, searching: boolean) => searching ? `${label}：已启用 ${enabled} / ${total} · 显示 ${visible}` : `${label}：已启用 ${enabled} / ${total}`,
    toggleAria: (name: string) => `${name} 开关`,
    codexDisconnected: "资源尚未连接"
  },
};

export type SettingsCopy = typeof ZH_CN;

const EN: SettingsCopy = {
  languageName: "English",
  title: "EchoInk Agent Settings",
  common: {
    enabled: "Enabled",
    disabled: "Off",
    connected: "Connected",
    disconnected: "Disconnected",
    unknown: "Unknown",
    current: (value) => `Current: ${value}`,
    readFailed: (error) => `Failed to load: ${error}`,
    partialReadFailed: (error) => `Some items failed: ${error}`,
    detected: (value) => `Detected: ${value}`,
    notDetectedManual: "Not found. Enter manually.",
    missing: (items) => `Missing: ${items.join(", ")}`,
    enableFailed: (items) => `Cannot enable: ${items.join(", ")}`,
    refresh: "Refresh",
    loading: "Loading",
    cancel: "Cancel",
    delete: "Delete",
    clear: "Clear"
  },
  tabs: {
    general: "General",
    providers: "API Provider",
    resources: "Skills & MCP",
    knowledgeBase: "Knowledge",
    review: "Review"
  },
  general: {
    settingsLanguage: "Settings language",
    settingsLanguageDesc: "Only changes this settings page. Prompts, chats, and custom names are unchanged.",
    auto: "Auto",
    defaultReasoning: "Default reasoning",
    defaultSpeed: "Default speed",
    defaultPermission: "Default file access",
    defaultMode: "Default mode",
    autoOpen: "Open sidebar on startup",
    autoOpenHome: "Open homepage on startup",
    showContext: "Show context usage",
    customWelcome: "Customize welcome message",
    customWelcomeDesc: "Turn this on to edit the empty-chat title and greeting. When off, EchoInk uses the default copy. It is never added to the conversation or model tokens.",
    welcomeTitle: "Welcome title",
    welcomeTitleDesc: "The large heading shown in an empty conversation. Leave blank to use the default.",
    welcomeGreeting: "Greeting",
    welcomeGreetingDesc: "The smaller line below the title. Leave blank to use the default.",
    languageOptions: {
      "zh-CN": "中文",
      en: "English"
    },
    serviceTierOptions: {
      standard: "Standard",
      fast: "Fast",
      flex: "Flex"
    },
    permissionOptions: {
      "read-only": "Read only",
      "workspace-write": "Workspace write",
      "danger-full-access": "Full access"
    },
    modeOptions: {
      agent: "Agent",
      plan: "Plan"
    }
  },
  knowledge: {
    title: "Knowledge",
    safety: "EchoInk responds only to explicit /maintain, checks sources, writes safely, and verifies readback in one turn while leaving source material unchanged.",
    lastRunIncomplete: "The last Knowledge run did not finish. Check the current Provider and guide, then retry from the Knowledge panel.",
    statusHeading: "Run status",
    recentStatus: (status, time) => `Latest: ${status}${time ? ` · ${time}` : ""}`,
    recentCompletion: (completion, attempts, pending) => [
      `Result: ${completion}`,
      attempts > 1 ? `${attempts} Agent attempts` : "",
      pending ? `${pending} deferred` : ""
    ].filter(Boolean).join(" · "),
    completionLabels: {
      full: "Complete",
      partial: "Partially complete",
      recovered: "Recovered",
      noop: "Checked (no new sources)"
    },
    initialization: (status, path) => `Initialization: ${status}${path ? ` · ${path}` : ""}`,
    guide: (path, _custom) => `Guide: ${path} (injected every run)`,
    recentReport: (path) => `Latest report: ${path}`,
    openChannel: "Open current Conversation",
    initChannel: "Initialize Knowledge",
    commandHeading: "Shortcuts",
    commandGuide: [
      { command: "/ask ...", description: "Ask the knowledge base" },
      { command: "/maintain ...", description: "Refine, write safely, and verify readback in one turn" }
    ],
    enabled: "Enable Knowledge",
    backend: "Knowledge model",
    backendDesc: "Inherits the active Provider and model. Change it from API Provider.",
    followGlobal: (backend) => `Follow global (${backend})`,
    customRules: "Use custom guide file",
    customRulesDesc: (defaultFile, _agentsFile) => `Defaults to ${defaultFile}. You can choose another Markdown file from this vault.`,
    detection: (value) => `Detection: ${value}`,
    modelCapabilities: (text, image, pdf) => `Model capabilities: Text ${text ? "✓" : "×"} · Images ${image ? "✓" : "×"} · PDF ${pdf ? "✓" : "×"}`,
    testConnection: "Test connection",
    channelNote: "Use /ask or /maintain in the current Pi Conversation. Settings manages configuration, status, and the rules file.",
    rulesFile: "Knowledge guide file",
    chooseRulesTitle: "Choose a Markdown file from this vault",
    chooseFile: "Choose file",
    useRulesFile: (file) => `Use ${file}`,
    repairRules: "Check and repair",
    repairRulesTitle: "Check whether required Knowledge rules are missing; create or patch the guide file if needed",
    rulesFileNoteCustom: (file, agentsFile) => `EchoInk force-loads ${file} into system context for every run. ${agentsFile} may be absent and is never merged as Knowledge rules.`,
    rulesFileNoteLegacy: (_agentsFile, defaultFile) => `Knowledge tasks force-load ${defaultFile} by default.`,
    memoryHeading: "EchoInk file-based Memory",
    memoryNote1: "Markdown is the content source of truth for this Vault's long-term Memory, with fixed paths for identity, user profile, and history.",
    memoryNote2: "AGENT.md, USER.md, and MEMORY.md are reloaded for each request; history is accessed progressively through controlled Memory Tools.",
    memoryEnabled: "Enable long-term memory",
    memoryEnabledDesc: "Chat and /ask retrieve curated memory and receive a lookup entry for local records that remain within retention. Maintenance workflows record results only after the local commit succeeds.",
    memoryStatusLine: (initialized, revision, pending, confirmations, issues) => `Status: ${initialized ? "initialized" : "not initialized"} · revision ${revision} · pending ${pending} · confirmations ${confirmations} · issues ${issues}`,
    memoryLastSync: (outcome, time) => `Latest sync: ${outcome}${time ? ` · ${time}` : ""}`,
    memoryStatusFailed: (_error) => "Memory status is temporarily unavailable. Reload it, or use Recover transactions if it does not return.",
    memoryReload: "Reload status",
    memoryInitialize: "Initialize",
    memorySync: "Sync now",
    memoryRecover: "Recover transactions",
    memoryConfirmations: "Confirmations and conflicts",
    memoryConflicts: (ids) => `Conflicts: ${ids}`,
    memoryAccept: "Accept",
    memoryDismiss: "Dismiss",
    memoryIssues: "Unresolved transactions",
    memoryRetry: "Retry sync",
    memoryDrop: "Drop pending",
    memoryItems: "Recorded memories",
    memoryDeleteConfirm: (statement) => `Delete this EchoInk long-term memory?\n\n${statement}`,
    memoryActionFailed: (_error) => "The Memory action did not finish. Reload the status, then try again.",
    repairSummary: (status, path) => {
      if (status === "created") return `Knowledge guide created: ${path}`;
      if (status === "patched") return `Knowledge guide updated: ${path}`;
      return `Knowledge guide ready: ${path}`;
    },
    repairPatchedDetail: (count) => `, patched ${count} items`,
    repairFailed: (_error) => "Repair did not finish. Check the Knowledge guide file, then try again.",
    noMarkdownFiles: "No Markdown files are available in this vault.",
    selectedRulesFile: (path) => `Knowledge guide selected: ${path}`,
    filePickerPlaceholder: "Choose Knowledge guide Markdown file",
    filePickerEmpty: "No matching Markdown files in this vault",
    statusLabels: {
      idle: "Not run",
      running: "Running",
      success: "Success",
      failed: "Failed",
      canceled: "Canceled"
    },
    initStatusLabels: {
      "not-started": "Not initialized",
      "preview-ready": "Preview ready",
      initialized: "Initialized",
      failed: "Failed"
    }
  },
  review: {
    title: "Review",
    generateHeading: "Generate weekly review",
    generateAgent: "Generate Agent review",
    generateKnowledge: "Generate Knowledge review",
    pathsHeading: "Output paths",
    outputDir: "Output directory",
    knowledgeMarkdown: "Knowledge Markdown",
    knowledgeHtml: "Knowledge HTML",
    agentMarkdown: "Agent Markdown",
    agentHtml: "Agent HTML",
    settingsHeading: "Review settings",
    confirmTitle: (label) => label,
    confirmBody: (report, outputDir) => `Generate ${report}?\n\nOutput directory: ${outputDir}`,
    generate: "Generate",
    cancel: "Cancel",
    reportLabels: {
      "knowledge-base": "Knowledge review",
      "agent-chat": "Agent review"
    },
    rangeMode: "Date range",
    rangeOptions: {
      "previous-week": "Previous full week",

      "current-week": "Current week to date"
    },
    openHtmlAfterRun: "Open HTML after run"
  },
  providers: {
    title: "API Provider",
    simpleSetup: "Choose a provider, confirm the API URL, enter an API key, and save. The key is stored directly in this Vault's EchoInk plugin settings.",
    provider: "Provider",
    protocol: "API protocol",
    protocolOptions: {
      "openai-responses": "OpenAI Responses",
      "openai-completions": "OpenAI compatible (Chat Completions)",
      "anthropic-messages": "Anthropic Messages"
    },
    modelPreset: (model) => `Default model: ${model}`,
    modelId: "Model ID",
    modelPlaceholder: "Get or add a model",
    addCustomModel: "Add custom Model ID",
    customModelPrompt: "Enter a Model ID, for example provider/model",
    invalidModel: "Enter a valid Model ID without spaces",
    fetchModels: "Get models",
    refreshModels: "Refresh models",
    modelListIdle: "Model list not loaded",
    modelListLoading: "Loading models…",
    modelListAvailable: (count) => `${count} models loaded; choose one from the list`,
    modelListUnsupported: "This service does not expose a readable model list. Use + to add a Model ID.",
    modelListApiKeyError: "The API key is invalid or cannot list models. Check it and retry.",
    modelListFailed: "Could not load models this time. The saved model is preserved, and you can enter a Model ID in the dropdown.",
    keyPlaceholder: "Enter API key",
    savedKeyPlaceholder: "API key saved; leave blank to keep using it",
    showKey: "Show current input",
    hideKey: "Hide current input",
    testConnection: "Test connection",
    testingConnection: "Testing…",
    connectionIdle: "Connection not tested. A test may incur a very small API charge.",
    connectionAvailable: "Connection available",
    connectionFailures: {
      auth: "The API key is invalid or lacks permission",
      protocol: "The Base URL may not match the selected protocol",
      model: "The current Model ID is unavailable",
      rate_limit: "Connected, but the account is rate-limited or out of quota",
      network: "Could not connect to the service",
      provider: "The provider is temporarily unavailable"
    },
    saveAndUse: "Save and use",
    saving: "Saving…",
    missingKey: "Enter an API key.",
    saved: (provider) => `${provider} is ready for chat.`,
    saveFailed: "The provider was not saved or activated. Check the endpoint, API key, protocol, and network, then retry.",
    warningKey: "API key input is masked and stored directly in this Vault's EchoInk plugin settings.",
    warningApi: "The API URL must support the selected API protocol.",
    add: "Add",
    addTitle: "Add API Provider",
    defaultName: "Custom API",
    empty: "No custom API providers yet.",
    unnamed: "Unnamed provider",
    active: "Enabled",
    enableReconnect: "Enable and reconnect",
    deleteConfirm: (name) => `Delete ${name || "this provider"}?`,
    name: "Name",
    namePlaceholder: "Example: OpenAI API",
    baseUrl: "Base URL",
    apiKey: "API key",
    queryParams: "Query Params",
    responseApiRequirement: "Required: the server must support OpenAI Chat Completions.",
    models: "Models"
  },
  resources: {
    title: "Skills & MCP",
    note: "Use the list switches to control which plugins, MCP servers, and Skills are available to EchoInk.",
    tabs: {
      plugins: "Plugins",
      mcp: "MCP",
      skills: "Skills"
    },
    refreshTitle: "Refresh current list",
    loadingTab: (label) => `Syncing ${label}…`,
    notLoaded: "Resources have not been synced. Refresh to try again.",
    searchPlaceholder: (label) => `Search ${label}`,
    searchAria: "Search current capability list",
    clearSearch: "Clear search",
    installed: "Installed",
    notInstalled: "Not installed",
    noPlugins: "No plugins loaded.",
    noPluginMatches: "No matching plugins.",
    toolsCount: (count) => `${count} tools`,
    mcpDesc: "Imported into the EchoInk resource catalog",
    noMcp: "No MCP servers loaded.",
    noMcpMatches: "No matching MCP servers.",
    noDesc: "No description",
    noSkills: "No Skills loaded.",
    noSkillMatches: "No matching Skills.",
    summary: (label, enabled, total, visible, searching) => searching ? `${label}: ${enabled} / ${total} enabled · Showing ${visible}` : `${label}: ${enabled} / ${total} enabled`,
    toggleAria: (name) => `${name} toggle`,
    codexDisconnected: "Resources disconnected"
  },
};

export const SETTINGS_COPY = {
  "zh-CN": ZH_CN,
  en: EN
} satisfies Record<SettingsLanguage, SettingsCopy>;

export const SETTINGS_LANGUAGE_OPTIONS: SettingsLanguage[] = ["zh-CN", "en"];

export function settingsCopy(language: SettingsLanguage): SettingsCopy {
  return SETTINGS_COPY[language] ?? SETTINGS_COPY["zh-CN"];
}
