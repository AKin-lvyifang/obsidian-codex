import type { BuiltinSkillDefinition } from "./builtin-skills";
import license from "../../../third-party/obsidian-skills/LICENSE.md";
import markdown from "../../../third-party/obsidian-skills/skills/obsidian-markdown/SKILL.md";
import callouts from "../../../third-party/obsidian-skills/skills/obsidian-markdown/references/CALLOUTS.md";
import embeds from "../../../third-party/obsidian-skills/skills/obsidian-markdown/references/EMBEDS.md";
import properties from "../../../third-party/obsidian-skills/skills/obsidian-markdown/references/PROPERTIES.md";
import bases from "../../../third-party/obsidian-skills/skills/obsidian-bases/SKILL.md";
import functions from "../../../third-party/obsidian-skills/skills/obsidian-bases/references/FUNCTIONS_REFERENCE.md";
import canvas from "../../../third-party/obsidian-skills/skills/json-canvas/SKILL.md";
import examples from "../../../third-party/obsidian-skills/skills/json-canvas/references/EXAMPLES.md";

export const OBSIDIAN_SKILLS_SOURCE = Object.freeze({
  repository: "https://github.com/kepano/obsidian-skills",
  commit: "a1dc48e68138490d522c04cbf5822214c6eb1202",
  license: "MIT"
});

const MANAGED_TOOLS = `## EchoInk 工具

使用当前已注册的工具。查找用 vault_search，读取用 note_read；创建用 note_create，更新用 note_update 并带上刚读取的 expectedVersion。这些工具支持 Vault 内 .md、.base、.canvas 文本文件，创建与更新沿用写入确认、版本检查和写后回读。文件内容过长或读取截断时不覆盖。

## 边界

工作区选项决定读写权限。Skill 只提供流程和格式知识，不授予写入权限。没有终端、bash、任意 JavaScript、插件重载或 DOM 工具；下文公式、Mermaid 和 JSON 是文档内容。只有实际执行并回读成功才报告保存；未在 Obsidian 界面检查时不声称视觉渲染已验证。`;

function reference(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, "")
    .replace(/\[([^\]]+)\]\(references\/[^)]+\)/gu, "$1（已附在本 Skill 下文）").trim();
}

function adapted(id: BuiltinSkillDefinition["id"], title: string, description: string, body: string): BuiltinSkillDefinition {
  return Object.freeze({
    id, title, description,
    body: [
      "## 用途与触发", description,
      `来源：${OBSIDIAN_SKILLS_SOURCE.repository}；固定版本 ${OBSIDIAN_SKILLS_SOURCE.commit}；MIT。EchoInk 适配了工具调用，格式参考保留上游内容。`,
      MANAGED_TOOLS, body, "## 上游许可证", license.trim()
    ].join("\n\n")
  });
}

export const OBSIDIAN_BUILTIN_SKILLS: readonly BuiltinSkillDefinition[] = Object.freeze([
  adapted("obsidian-cli", "Obsidian CLI", "用户明确要使用 Obsidian CLI 或原生命令读取、列出、搜索当前 Vault 时启用。", `## 原生命令调用

EchoInk 的 obsidian_cli 调用当前运行应用的原生 CLI 命令处理器。插件内部引擎与操作系统终端命令是两种入口；内部引擎可用不代表终端 CLI 已安装或启用。不要在 PATH 中找同名程序。

先用 obsidian_cli，参数为 {"command":"version"} 检查引擎。可用时只使用下面已实现的命令：

- {"command":"files","folder":"wiki","ext":"md"}：列出文件，folder/ext 可省略；ext 支持 md/base/canvas。
- {"command":"search","query":"关键词","path":"wiki","limit":10}：搜索；path 可省略，limit 最大 20。
- {"command":"read","path":"wiki/主题.md"}：读取精确路径。
- {"command":"daily:path"}：查询原生当天日记路径。
- {"command":"templates"}：列出原生模板。

目标始终是当前 Vault，不接受 vault、shell、eval、dev、写入或插件控制命令。返回 available:false 时说明引擎限制，并按用户任务使用 vault_search/note_read；日记保存设置用 obsidian_context。CLI read 没有 expectedVersion，编辑前必须另用 note_read；新建、追加和更新都走上面的受管 note 工具。不要用原生命令直接写文件。

官方文档：https://help.obsidian.md/cli`),
  adapted("obsidian-markdown", "Obsidian Markdown", "创建或修改 Obsidian Markdown、双链、嵌入、callout、frontmatter 或标签时启用。",
    [markdown, callouts, embeds, properties].map(reference).join("\n\n")),
  adapted("obsidian-bases", "Obsidian Bases", "创建或修改 .base 文件、笔记表格视图、筛选条件、公式和汇总时启用。",
    [bases, functions].map(reference).join("\n\n")),
  adapted("json-canvas", "JSON Canvas", "创建或修改 .canvas 文件、节点、连线、分组、思维导图或流程图时启用。",
    [canvas, examples].map(reference).join("\n\n"))
]);
