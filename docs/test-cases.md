# Codex for Obsidian 测试用例

## 1. 测试范围

本文件覆盖 `docs/PRD.md` 中第一版功能。每个 Phase 必须先满足本文件对应用例，再进入下一 Phase。

## 2. Phase 1：PRD 测试

- TC-PRD-01：PRD 明确插件目标。
  - 步骤：阅读 `docs/PRD.md`。
  - 期望：能说清插件是把 Codex CLI 嵌入 Obsidian 当前 vault。
- TC-PRD-02：PRD 覆盖用户 8 条需求。
  - 步骤：检查“用户 8 条需求覆盖”章节。
  - 期望：8 条都有对应章节。
- TC-PRD-03：PRD 明确非目标。
  - 步骤：检查“非目标”章节。
  - 期望：移动端、远程服务、全局配置编辑器、保存 key 均不在范围内。

## 3. Phase 2：测试文档自检

- TC-TEST-01：每个 PRD 核心能力有测试。
  - 步骤：逐项对照 PRD 5.1 至 5.10。
  - 期望：本文件均有对应功能或集成测试。
- TC-TEST-02：每个 Phase 有通过条件。
  - 步骤：检查每个 Phase 的测试章节。
  - 期望：没有空白 Phase。

## 4. Phase 3：插件工程骨架

- TC-SCAFFOLD-01：TypeScript 类型检查通过。
  - 命令：`npm run typecheck`
  - 期望：退出码为 0。
- TC-SCAFFOLD-02：插件构建通过。
  - 命令：`npm run build`
  - 期望：生成 `dist/main.js`。
- TC-SCAFFOLD-03：插件部署到 Obsidian。
  - 命令：`npm run deploy`
  - 期望：部署目录存在 `manifest.json`、`main.js`、`styles.css`。
- TC-SCAFFOLD-04：Obsidian 能打开右侧栏。
  - 人工步骤：启用插件，点击 Ribbon 图标或命令“打开 Codex 侧栏”。
  - 期望：右侧栏出现 Codex for Obsidian 空状态。

## 5. Phase 4：Codex app-server 后端

- TC-BACKEND-01：能启动 Codex app-server。
  - 步骤：打开插件侧栏。
  - 期望：状态显示“Codex 已连接”。
- TC-BACKEND-02：能读取账号状态。
  - 步骤：查看侧栏顶部状态。
  - 期望：已登录时显示账号状态；未登录时显示中文登录提示。
- TC-BACKEND-03：能读取模型列表。
  - 步骤：打开模型选择。
  - 期望：显示 Codex 返回的模型。
- TC-BACKEND-04：能读取 skills。
  - 步骤：输入 `/`。
  - 期望：出现 skills 列表；超时时显示中文提示但聊天仍可用。
- TC-BACKEND-05：能读取 MCP 状态。
  - 步骤：打开 MCP 面板。
  - 期望：显示 MCP 服务器名、工具数量、授权状态。
- TC-BACKEND-06：app-server 崩溃可恢复。
  - 步骤：手动停止 Codex 子进程或触发重启按钮。
  - 期望：UI 提示断开，可重新连接。
- TC-BACKEND-07：用量读取不阻塞主聊天。
  - 步骤：模拟或等待 `account/rateLimits/read` 慢响应/超时，再发送普通消息。
  - 期望：右上角主状态不显示用量接口超时；聊天连接、建线程和发送不等待用量读取；用量面板内可单独展示读取失败。

## 6. Phase 5：基础聊天闭环

- TC-CHAT-01：新建 thread 并发送消息。
  - 步骤：输入“用一句话回复我现在在哪个 vault”并发送。
  - 期望：收到 Codex 流式回复。
- TC-CHAT-02：会话可恢复。
  - 步骤：重启 Obsidian。
  - 期望：会话标签仍在，能继续发送。
- TC-CHAT-03：中断当前 turn。
  - 步骤：发送较长任务后点击停止。
  - 期望：Codex 停止输出，UI 状态恢复可输入。
- TC-CHAT-04：多会话标签。
  - 步骤：新建两个会话并切换。
  - 期望：不同会话内容互不覆盖。
- TC-CHAT-05：右键删除会话。
  - 步骤：右键任意会话标签，点击“删除会话”。
  - 期望：该会话从标签中消失；若删除当前会话，自动切换到相邻会话；至少保留一个可用会话。

## 7. Phase 6：消息渲染

- TC-RENDER-01：Markdown 渲染。
  - 步骤：让 Codex 输出标题、列表、表格。
  - 期望：格式正确。
- TC-RENDER-02：代码块可复制。
  - 步骤：让 Codex 输出代码块，点击复制。
  - 期望：剪贴板内容正确。
- TC-RENDER-03：命令输出和文件变更可读。
  - 步骤：让 Codex 列目录或修改测试文件。
  - 期望：命令、输出、diff、文件路径分块显示。
- TC-RENDER-04：工具调用可折叠。
  - 步骤：触发 shell 或 MCP 工具调用。
  - 期望：工具块可展开/折叠。
- TC-RENDER-05：图片渲染。
  - 步骤：发送图片，或让 Codex 引用 vault 内图片。
  - 期望：图片缩略图显示，可点击放大。
- TC-RENDER-06：长内容不撑破侧栏。
  - 步骤：输出长日志。
  - 期望：侧栏保持可滚动，输入框仍可见。
- TC-RENDER-07：思考中动态呈现。
  - 步骤：发送一条需要较长处理的任务。
  - 期望：回复前显示“Codex 正在思考”呼吸态；处理过程里出现带大脑图标的思考卡片，大脑图标在运行中呼吸闪烁；reasoning summary/text delta 会持续追加到卡片内容里；完成后卡片标题变为“已思考”且保留内容。
- TC-RENDER-08：过程时间线。
  - 步骤：触发命令、文件编辑或 MCP 工具。
  - 期望：思考、命令、文件编辑、MCP/动态工具以过程卡片展示；卡片头部优先显示用户可读摘要和状态，原始命令/长输出放在折叠详情里。
- TC-RENDER-09：过程文件可点击直达。
  - 步骤：触发查看文件、搜索文件、编辑文件和 MCP 工具参数里的文件路径。
  - 期望：过程块显示文件名 chip；vault 内文件点击后在 Obsidian 新标签页打开；vault 外文件点击后由 Finder 定位。
- TC-RENDER-10：回复结构化阅读。
  - 步骤：让 Codex 输出结论、列表、表格、代码块和引用提示。
  - 期望：回答优先短段落和结构化 Markdown，长中文段落自动拆分，表格和提示块有清晰层级。

## 8. Phase 7：底部工具栏和上下文

- TC-TOOLBAR-01：模型选择生效。
  - 步骤：切换模型后发送消息。
  - 期望：`turn/start` 使用所选模型。
- TC-TOOLBAR-02：速度选择生效。
  - 步骤：切换标准/快速后发送消息。
  - 期望：`serviceTier` 参数正确。
- TC-TOOLBAR-03：思考强度生效。
  - 步骤：切换 low/medium/high/xhigh 后发送消息。
  - 期望：`effort` 参数正确。
- TC-TOOLBAR-04：权限默认工作区可写。
  - 步骤：打开插件首次使用。
  - 期望：权限显示“工作区可写”。
- TC-TOOLBAR-05：Plan 模式生效。
  - 步骤：切换 Plan 后发送“给我计划”。
  - 期望：Codex 返回计划模式内容。
- TC-TOOLBAR-06：文件添加生效。
  - 步骤：添加 vault 内文件并发送。
  - 期望：用户消息中显示已附带文件 chip；文件作为 mention 输入传给 Codex；同时输入中明确告诉 Codex“当前笔记/这个文档”指向该文件路径。
- TC-TOOLBAR-07：上下文容量显示更新。
  - 步骤：发送多轮消息。
  - 期望：上下文圆环和百分比随当前会话 token 通知变化。
- TC-TOOLBAR-07B：上下文容量不串会话。
  - 步骤：会话 A 发送多轮消息后切换到新会话 B。
  - 期望：会话 B 上下文显示弱态 `--` 或自己的用量，不沿用会话 A 的百分比。
- TC-TOOLBAR-08：底部 icon 不被遮盖。
  - 步骤：把右侧栏缩窄到约 760px 和 480px 宽，查看底部工具栏。
  - 期望：当前笔记、添加文件、图片、MCP、上下文、发送/停止 icon 全部可见，不被 select 或状态栏遮挡。

## 9. Phase 8：skills 和 MCP

- TC-SKILL-01：slash skills 唤起。
  - 步骤：输入 `/`。
  - 期望：显示 skills 列表。
- TC-SKILL-02：skills 搜索。
  - 步骤：输入 `/fix` 或 `/answer`。
  - 期望：列表被过滤。
- TC-SKILL-03：skill 发送。
  - 步骤：选择一个 skill 后发送任务。
  - 期望：Codex 收到 `skill` 类型输入。
- TC-MCP-01：MCP 状态面板。
  - 步骤：打开 MCP 面板。
  - 期望：显示服务器、工具数、授权状态。
- TC-MCP-02：MCP OAuth。
  - 步骤：点击需要登录的 MCP 登录。
  - 期望：打开授权 URL 或显示中文提示。
- TC-MCP-03：MCP 表单请求。
  - 步骤：触发 MCP elicitation。
  - 期望：Obsidian 显示中文表单，提交后继续 turn。

## 10. Phase 9：中文设置页和体验

- TC-SETTINGS-01：设置页中文。
  - 步骤：打开插件设置页。
  - 期望：主文案均为中文。
- TC-SETTINGS-02：CLI 路径检测。
  - 步骤：查看 Codex CLI 路径。
  - 期望：显示找到/找不到和版本。
- TC-SETTINGS-03：默认偏好保存。
  - 步骤：修改默认模型、速度、思考强度、权限、模式后重启。
  - 期望：设置仍在。
- TC-SETTINGS-04：主题适配。
  - 步骤：切换 Obsidian 明暗主题。
  - 期望：文字和边框可读。

## 11. Phase 10：最终验收

- TC-FINAL-01：Codex 能读当前 vault。
  - 步骤：要求 Codex 总结当前打开笔记。
  - 期望：能读到真实内容。
- TC-FINAL-02：Codex 能写当前 vault。
  - 步骤：要求 Codex 新建一篇测试笔记。
  - 期望：文件出现在 vault 内。
- TC-FINAL-03：图片、文件、skills、MCP 真实任务。
  - 步骤：各运行一个小任务。
  - 期望：均可完成或给出中文可理解错误。
- TC-FINAL-04：工程验证。
  - 命令：`npm run typecheck && npm run build`
  - 期望：全部通过。
- TC-FINAL-05：部署验证。
  - 命令：`npm run deploy`
  - 期望：Obsidian 插件目录产物更新。

## 12. 错误场景

- ERR-01：Codex CLI 找不到。
  - 期望：中文提示“找不到 Codex CLI”，设置页可填写路径。
- ERR-02：Codex 未登录。
  - 期望：中文提示“Codex 未登录”，不要求填写 key。
- ERR-03：app-server 超时。
  - 期望：提示“Codex 连接超时”，可重试。
- ERR-04：MCP 不可用。
  - 期望：MCP 面板显示失败，但聊天仍可用。
- ERR-04B：Codex 用量读取超时。
  - 期望：只影响用量面板，不污染“活跃/思考中”主状态，不阻塞发送。
- ERR-05：权限被拒绝。
  - 期望：turn 显示权限被拒绝，不崩溃。
