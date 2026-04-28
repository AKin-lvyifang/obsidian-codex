# Codex for Obsidian

Turn your Obsidian vault into a local Codex workspace.

把你的 Obsidian 仓库变成 Codex 可读写、可执行、可验证的本地工作台。

![Codex for Obsidian parchment hero](docs/images/obsidian-codex-parchment-hero.png)

**Languages / 支持语言**: English + 中文

Codex for Obsidian is not just another chat panel. It embeds Codex CLI into the Obsidian sidebar, uses the current vault as the working directory, and turns note management into an agentic workflow: read files, edit documents, run commands, inspect results, and keep evidence visible inside the conversation.

Codex for Obsidian 不是普通聊天窗口。它把 Codex CLI 嵌进 Obsidian 侧栏，以当前 vault 为工作区，让知识库管理进入真正的 Agent 工作流：读取文件、修改文档、执行命令、检查结果，并把过程证据保留在对话里。

## Why It Feels Different

| Capability | English | 中文 |
| --- | --- | --- |
| Vault-native workspace | Codex runs with your current Obsidian vault as its workspace. | Codex 直接以当前 Obsidian vault 为工作区。 |
| Process visibility | Reasoning, commands, file edits, MCP calls, and context usage are rendered as readable process cards. | 思考、命令、文件编辑、MCP 调用和上下文用量都以过程卡片展示。 |
| Local-first authentication | Reuses your local Codex CLI login state. No OpenAI API key is required by default. | 复用本机 Codex CLI 登录状态，默认不要求填写 OpenAI API key。 |
| Workspace-level control | Plugins, MCP servers, and skills can be managed for the current vault without changing global Codex config. | 插件、MCP、Skills 可按当前 vault 管理，不改 Codex 全局配置。 |
| Power-user workflow | Supports Agent / Plan mode, models, reasoning effort, speed, permissions, files, images, slash skills, and MCP. | 支持 Agent / Plan、模型、思考强度、速度、权限、文件、图片、slash skills 和 MCP。 |

## Screenshots

![Codex for Obsidian sidebar demo](docs/images/obsidian-codex-vault-answer.png)

## Install

1. Install and log in to Codex CLI.
2. Download `obsidian-codex-0.1.0.zip` from GitHub Releases.
3. Unzip it and get the `obsidian-codex` folder.
4. Move it into your vault plugin directory:

```text
<vault>/.obsidian/plugins/obsidian-codex/
```

5. Restart Obsidian and enable `Codex for Obsidian` in Community plugins.

The plugin folder should contain:

```text
obsidian-codex/
  main.js
  manifest.json
  styles.css
```

## 安装

1. 先安装并登录 Codex CLI。
2. 在 GitHub Releases 下载 `obsidian-codex-0.1.0.zip`。
3. 解压后得到 `obsidian-codex` 文件夹。
4. 放到你的 vault 插件目录：

```text
<vault>/.obsidian/plugins/obsidian-codex/
```

5. 重启 Obsidian，在第三方插件里启用 `Codex for Obsidian`。

插件文件夹里应包含：

```text
obsidian-codex/
  main.js
  manifest.json
  styles.css
```

## Safety Model / 安全边界

- Desktop only. / 仅支持 Obsidian 桌面端。
- No OpenAI API key is stored by default. / 默认不保存 OpenAI API key。
- Codex CLI path can be auto-detected from PATH and common install locations. / Codex CLI 路径可从 PATH 和常见安装目录自动查找。
- Local proxy can be enabled manually in settings. / 如需本地代理，可在插件设置里手动开启。
- Workspace resource switches are vault-level and do not rewrite global Codex configuration. / 插件、MCP、Skills 开关只作用当前 vault，不改全局 Codex 配置。

## Local Development / 本地开发

```bash
npm install
npm run test
npm run typecheck
npm run build
```

Generate a shareable install package:

生成可分享安装包：

```bash
npm run package
```

Deploy to your own Obsidian vault:

部署到自己的 Obsidian vault：

```bash
OBSIDIAN_VAULT=/path/to/your/vault npm run deploy
```
