# Codex for Obsidian

在 Obsidian 侧栏中使用 Codex CLI，让 Codex 以当前 vault 为工作区阅读、整理和修改笔记。

## 功能

- 右侧栏多会话聊天
- 复用本机 Codex CLI 登录状态
- 支持模型、思考强度、速度、权限和 Agent / Plan 模式
- 支持当前笔记、文件、图片、slash skills、MCP 和插件能力开关
- 展示思考、命令、文件编辑、MCP 调用和上下文用量

## 安装

1. 先安装并登录 Codex CLI。
2. 在 GitHub Releases 下载 `obsidian-codex-0.1.0.zip`。
3. 解压后得到 `obsidian-codex` 文件夹。
4. 放到你的 vault 插件目录：`<vault>/.obsidian/plugins/obsidian-codex/`。
5. 重启 Obsidian，在第三方插件里启用 `Codex for Obsidian`。

插件文件夹里应包含：

```text
obsidian-codex/
  main.js
  manifest.json
  styles.css
```

## 本地开发

```bash
npm install
npm run test
npm run typecheck
npm run build
```

生成可分享安装包：

```bash
npm run package
```

部署到自己的 Obsidian vault：

```bash
OBSIDIAN_VAULT=/path/to/your/vault npm run deploy
```

## 注意

- 仅支持 Obsidian 桌面端。
- 插件不会保存 OpenAI API key。
- Codex CLI 路径留空时会从 PATH 和常见安装目录自动查找。
- 如需本地代理，可在插件设置里手动开启并填写地址。
