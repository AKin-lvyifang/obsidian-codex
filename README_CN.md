<p align="center">
  <a href="https://github.com/AKin-lvyifang/codex-echoink/releases/latest">
    <img width="1024" alt="EchoInk Agent 2.0.2 发布图" src="assets/releases/echoink-agent-2.0.1-release.png">
  </a>
</p>

<h1 align="center">EchoInk Agent</h1>

<p align="center">管理你的 Obsidian 知识，也在每次使用中更懂你。</p>

<p align="center">
  <a href="#主要功能">主要功能</a> ·
  <a href="#安装">安装</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#知识维护">知识维护</a> ·
  <a href="#复盘与记忆修正">复盘与记忆修正</a> ·
  <a href="#隐私与数据">隐私与数据</a> ·
  <a href="README.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/AKin-lvyifang/codex-echoink/releases/latest">
    <img src="https://img.shields.io/badge/platform-Obsidian_Desktop-7C3AED?style=flat-square&logo=obsidian&logoColor=white" alt="平台：Obsidian 桌面端">
    <img src="https://img.shields.io/badge/version-2.0.2-0EA5E9?style=flat-square" alt="版本 2.0.2">
    <img src="https://img.shields.io/badge/license-MIT-10B981?style=flat-square" alt="MIT 开源许可证">
  </a>
</p>

<p align="center">
  <a href="https://github.com/AKin-lvyifang/codex-echoink/releases/tag/2.0.2"><strong>下载 2.0.2</strong></a>
</p>

EchoInk Agent 是一个运行在 Obsidian 中的个人知识 Agent。它能帮你持续对话，整理、提炼和维护当前 Vault，并把长期有用的信息沉淀为可查看、可修正的记忆。随着使用，这些记忆会帮助它逐渐理解你的关注点、判断方式和正在推进的事情，让它在管理知识的同时，成长为越来越懂你的个人 Agent。无需安装 Codex CLI；添加 OpenAI 或兼容 Provider 的 API URL、API Key 和模型后即可开始使用。

## 2.0 有什么变化

- 对话主链统一为 Pi-native AgentSession，历史恢复、工具过程和后续对话使用同一份会话状态。
- 长期记忆按事实、观点、决定、进行中和经历分类展示；修正时先由当前模型生成预览，确认保存后才写入新版本。
- `/maintain` 支持全局维护、单篇 Raw 笔记和名称模糊定位；已经没有更新内容时会明确结束，不重复写入。
- 复盘页合并周报生成与输出目录设置，并加入已归档会话和记忆修正入口。
- Provider 配置改为直接保存 API Key，不再要求额外的 Credential 配置步骤。
- 对话栏、消息操作、输入工具条和发送按钮重新整理；低价值的 Agent 状态与知识库健康模块已移除。

## 主要功能

### 持久会话

- 每个 Conversation 对应独立的 Pi AgentSession。
- 本地历史读取不依赖 Provider；会话打开后会在后台准备继续聊天所需的 AgentSession。
- 支持新建、重命名、归档、恢复和软删除会话。
- 已归档会话统一在 **设置 → EchoInk Agent → 复盘 → 已归档会话** 管理。
- 模型的思考、工具调用、文件变更与最终回答投影在同一条对话时间线中。

### Provider 与模型

- 内置智谱开放平台、Kimi 中国版、MiniMax 中国版、DeepSeek、Ollama 本地和 Custom 预设。
- 支持 OpenAI Responses、OpenAI Chat Completions 和 Anthropic Messages 协议。
- 支持模型列表获取、连接测试、自定义 Model ID、推理强度和上下文配置。
- API Key 直接保存在当前 Vault 的 EchoInk 插件设置中；Ollama 本地预设默认不需要 API Key。

### Vault 知识维护

- `/ask` 对当前知识库进行只读提问。
- `/maintain` 提炼 Raw 笔记，把可复用知识写入 Wiki 或 Projects，并在写入后回读确认。
- 维护候选与目标内容版本绑定；目标在生成期间发生变化时，本轮不会覆盖新内容。
- 显式 `/maintain` 才能写入。普通聊天里出现“整理一下”等自然语言不会自动触发维护。

### 可查看、可修正的长期记忆

- 当前记忆按事实、观点、决定、进行中和经历五类展示，不暴露内部文件名、路径和 revision。
- 每条记录展示标题、内容和“何时可能想起”。
- 修正弹窗保留原记忆，输入纠正说明后生成浅青色预览。
- 生成预览不会修改原记忆；只有点击保存才创建新版本。
- 停止、关闭、生成失败或迟到的模型结果都不会写入；并发版本冲突会要求基于最新记录重新生成。

### 复盘

- 手动生成 Agent 周报或知识库周报。
- 可选择上一完整周或本周至今。
- 默认保存到当前 Vault 的 `outputs`，也可选择 Vault 内任意文件夹。
- 可选择生成后直接打开 HTML；插件不维护“最近报告”列表。

### 资源与编辑能力

- 在设置中管理当前 Vault 可用的插件资源、Skills 与 MCP 连接。
- 只读 MCP Tool 通过当前 Pi 会话执行，并遵循各连接的启用与信任设置。
- 在编辑器中选中文本后，可通过右键菜单使用当前默认 Provider 翻译成英文。

## 安装

### Obsidian 社区插件

如果 EchoInk Agent 已出现在 Obsidian 社区插件中：

1. 打开 **设置 → 第三方插件 → 浏览**。
2. 搜索 `EchoInk Agent`。
3. 安装并启用插件。

### 手动安装

1. 从 [2.0.2 Release](https://github.com/AKin-lvyifang/codex-echoink/releases/tag/2.0.2) 下载 `main.js`、`manifest.json` 和 `styles.css`。
2. 在 Vault 中创建目录：

```text
<vault>/.obsidian/plugins/codex-echoink/
```

3. 将三个文件放入该目录。
4. 重启 Obsidian，在第三方插件中启用 `EchoInk Agent`。

## 快速开始

1. 打开 **设置 → EchoInk Agent → API Provider**。
2. 添加一个 Provider，输入 API URL、API Key 和模型后保存。Ollama 本地可不填 API Key。
3. 从 Ribbon 或命令面板打开 EchoInk 侧栏。
4. 新建会话并开始对话；需要知识库问答时输入 `/ask`，需要提炼时输入 `/maintain`。
5. 在 **设置 → EchoInk Agent → 复盘** 中生成周报、管理已归档会话或修正长期记忆。

## 知识维护

`/maintain` 有三种定位方式：

| 输入方式 | 作用范围 |
| --- | --- |
| `/maintain` | 全局检查当前可维护的 Raw 笔记 |
| 在输入区用 `+` 选择一篇 `raw/**.md`，再执行 `/maintain` | 只维护这篇 Raw 笔记 |
| `/maintain 笔记名称` | 模糊搜索相关 Raw 笔记，并在候选范围内维护 |

单篇模式一次只接受一篇当前 Vault 内的 Raw Markdown。带名称的搜索没有可靠匹配时不会自动回退到全局维护。已经提炼且没有新变化的内容会以无写入结果结束。

## 复盘与记忆修正

进入 **设置 → EchoInk Agent → 复盘**：

- 在“生成周报”中选择统计周期、输出文件夹和生成后是否打开 HTML。
- 在“已归档会话”中搜索、恢复或从列表软删除会话；原始 Pi Session JSONL 保留。
- 在“记忆修正”中按类别查看记录，生成修正后预览，再决定是否保存。

## 从 1.x 升级

- 2.0 改为直接保存 Provider API Key。升级后如果原配置只有旧 Credential 引用，需要在 Provider 设置中重新输入一次 API Key。
- 2.0 不读取或迁移已经退役的 Codex、OpenCode、Hermes 会话，以及旧版 Cognitive、Reflection 或 Memory 数据；插件也不会主动删除这些旧文件。
- 建议升级前按自己的 Vault 备份习惯保留一份快照。

## 隐私与数据

- EchoInk 仅支持桌面端，并通过 Obsidian API 访问当前 Vault。
- 会话目录、知识文件、记忆和周报保存在本地 Vault 中。
- API Key 直接保存在当前 Vault 的插件设置中。请只在可信设备和可信 Vault 中配置。
- 远程 Provider 只接收完成当前请求所需的 Prompt、会话、知识、记忆和工具上下文；EchoInk 不会默认上传整个 Vault。
- 使用 Custom Provider 或 MCP 时，数据处理还受对应服务、服务器和命令的条款约束。
- EchoInk 没有自己的遥测服务。

## 使用要求

- Obsidian Desktop 1.11.4 或更高版本。
- Node.js 仅用于本地开发；普通安装不需要单独安装 Node.js。
- 云端 Provider 需要自己的 API Key，并可能产生 Provider 费用。
- 当前不支持 Obsidian Mobile。

## 本地开发

```bash
npm install
npm run test
npm run typecheck
npm run build
```

生成本地手动安装包：

```bash
npm run package
```

## 许可证

EchoInk 使用 [MIT License](LICENSE) 开源。
