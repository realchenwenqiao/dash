# DASH — DeepSeek Awesome Harness

[![dsh-plugin](https://img.shields.io/badge/dsh--plugin-DeepSeek%20Harness%20plugin-4D6BFE)](https://github.com/topics/dsh-plugin)
[![stars](https://img.shields.io/github/stars/realchenwenqiao/dash)](https://github.com/realchenwenqiao/dash/stargazers)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

![DASH cover](assets/cover.png)

**DASH** 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的终端原生前端：同一套「一切皆插件」的 agent 内核与多模型切换能力，跑在你的 shell 里。

`dash` 是一个挂载在官方 `dsh-base` 之上的 Cordis 插件（bundle），通过 `dsh plugin add` 一键安装。**DASH** = **D**eepSeek **A**we**S**ome **H**arness。

> 英文版请见 [README_EN.md](README_EN.md)。

## 为什么是终端？

- 从命令行到编码 agent，只差一次回车。
- **多模型**同一会话 —— `/model` 无需离开 TUI 即可切换 provider。
- 可脚本化、可管道、SSH 下照常可用。

## 特性

- **全屏 TUI**：ANSI Shadow 的 DASH logo、滚动回看（banner、提示、正文、输入框作为同一条内容流滚动）、底部信息栏（`cwd (branch)` + 累计 token + session id）。
- **多行编辑器**：历史、撤销、kill-ring —— `Enter` 发送，`Shift+Enter` 换行。
- **Markdown 渲染**：代码块、列表、行内代码、表格。
- **思考折叠**：推理默认隐藏，`Ctrl+O` 展开为暗色块。
- **工具输出折叠**：每个工具结果折叠为一行 `↳ N lines` 摘要，`Ctrl+T` 展开为代码块；错误保持内联。
- **斜杠命令**：带搜索框菜单 + accent 高亮。
- **多模型**：`/model` 选择器（共享 llm 目录）。
- **API key**：`/login` 通过凭证 seam 存储并激活 provider 路由。
- **工具卡片**：参数摘要；输出折叠，展开才显示。
- **会话恢复**：`/resume` 在输入区打开选择器；`dsh tui --resume <id>` 直接恢复。
- **回滚（时间旅行分叉）**：双击 `Esc` 在输入区打开**行为账本**——每条用户消息、工具调用、助手回复各一行，带 `[user]`/`[tool]`/`[assistant]` 标识 + turn 号 + 实测时长。选中一行即分叉回该 turn 边界——非破坏性分支，不是 undo 栈。
- **实时工作状态 footer**：累计 token · 流式 TPS（`64t/s`）· 上下文占用预警（≥80% 黄、≥95% 红）· 运行中工具（`⚙ 工具名`）。
- **`@` 文件补全**：输入 `@` + 路径前缀，用 `fd`/`fdfind` 模糊补全文件路径。
- **鼠标选择即复制**：拖拽选择文本，松开自动复制到剪贴板（OSC 52），双击选词、三击选行、滚轮滚动。

## 从 dsh 继承了什么

`dash` 完整复用 `dsh-base` 插件树——agent 相关的任何东西都没有重写：

- **一切皆插件的内核** —— Cordis 运行时、agent loop、工具注册表、会话日志，全部来自上游。
- **多 provider 的 llm** —— `/model` 在共享 `ctx.llm` 目录上切换。
- **技能系统** —— `skill-filesystem` 扫描 `~/.agents/skills` 与 `<project>/.agents/skills`，与 Claude Code / Codex / Grok 共享的技能，dash 的模型经 `skill` 工具直接可用。
- **工具** —— bash、fs、web、subagent、todo 等原样经 `ctx.tools` 注册。
- **会话持久化与恢复** —— `--resume <id>` 与 `/resume` 恢复持久化会话。
- **plan 模式、命令、凭证、设置** —— 宿主 seam 及其 handler。

## 我们的理解

dash 增加的不是新能力，而是一个新 surface——以及几个我们觉得终端比浏览器表达得更好的想法：

- **终端是 agent 的汇编语言。** dsh 的「一切皆插件」是把 Unix 哲学用在 agent 上；dash 想让组装一个 agent 的感觉，像组装一个 shell 环境。
- **回滚是分叉，不是撤销栈。** 双击 `Esc` 打开行为账本——每条用户消息、工具调用、助手回复各一行。选中一行分叉回该 turn 边界，旧分支（fork 谱系）被保留而非销毁。只有 append-only 的行为日志能表达这一点；纯聊天的 harness 只能回滚消息。
- **行为账本，而不是消息列表。** 对齐 web 版 Trajectory 视图：`[user]` / `[tool]` / `[assistant]` 行带 turn 号与实测时长，让插件/工具活动可见。
- **输入框跟随内容流。** 没有 dock 固定的输入框——编辑器随历史一起滚走，Claude Code 式。
- **同一色系。** 所有品牌相关元素都落在 DeepSeek 靛蓝→天蓝渐变（`#4D6BFE → #3982FF → #2498FF`）上。

## 安装

dash 以 dsh bundle 插件的形式安装到官方 dsh CLI 上：

```sh
# 1. 安装官方 dsh CLI（已装可跳过）
npm install -g @deepseek-ai/dsh

# 2. 把 dash 插件装入 tui profile（`dsh plugin add` 会自动识别
#    package.json 里的 `dsh.bundle.patch` 并挂进 bundle 层）
dsh plugin --profile tui add @realchenwenqiao/dash

# 3. 启动
dsh --profile tui
```

> npm 发布前，也可从源码运行：
>
> ```sh
> git clone https://github.com/realchenwenqiao/dash.git
> cd dash
> pnpm install
> pnpm run build
> pnpm dash tui
> ```

需要 Node.js 与 pnpm。退出时用 `dash tui --resume <session-id>` 恢复（id 会在退出时打印），或在 TUI 内用 `/resume`。

## 用法

输入提示词，回车。会话流式输出回复与工具活动，底部信息栏显示累计 `↑ in ↓ out R reasoning`、缓存命中率、上下文占用与当前 session id（供 `--resume` 使用）。

### 斜杠命令

| 命令 | 作用 |
|------|------|
| `/model` | 切换模型——遍历 llm 注册表里每个 provider 的选择器。 |
| `/login` | 为某 provider 添加 API key，激活其路由。 |
| `/logout` | 清除当前 provider 存储的凭证。 |
| `/resume` | 选择已保存会话，在其 workspace 中恢复。 |
| `/new` | 开始全新会话。 |
| `/clear` | 清空正文。 |
| `/export` | 把会话日志导出为 markdown 文件。 |
| `/status` | 显示会话状态（session / cwd / model / plan / token / 账本行数）。 |
| `/cost` · `/tokens` | 显示 token 用量与缓存命中。 |
| `/thinking` | 切换思考展开/折叠。 |
| `/help` | 显示快捷键与命令清单。 |
| `/audit` `/bug` `/review` `/practice` `/pr_comments` `/release-notes` `/vuln-check` | 技能命令——向模型发送激活提示（随包内置对应 SKILL.md）。 |
| `/exit` · `/quit` | 退出。 |
| `/compact` `/plan` `/goal` `/feedback` `/permission` | 宿主命令，与 web UI 共享同一注册表。 |

### 快捷键

| 键 | 动作 |
|----|------|
| `Enter` | 发送 |
| `Shift+Enter` / `Ctrl+J` | 换行 |
| `↑` / `↓` | 输入历史 |
| `Ctrl+O` | 展开 / 折叠思考 |
| `Ctrl+T` | 展开 / 折叠工具输出 |
| `Shift+Tab` | 切换 plan 模式 |
| `Esc` `Esc` | 打开回滚账本（分叉回之前的 turn） |
| `Ctrl+C` | 取消打开的浮层；无浮层时退出 |

**鼠标**：拖拽选择即复制 · 双击选词 · 三击选行 · 滚轮滚动。

## 色卡

一套靛蓝→天蓝品牌族、一组中性色、三种常规状态色：

| 角色 | 出现位置 |
|------|----------|
| logo · brand · accent · code | DASH logo、标题、斜杠命令、选中项、行内代码 |
| dim | 工具正文、footer、推理 |
| `bgQuote` | 用户消息块（深靛蓝底） |
| success · warning · error | diff 新增 · 待处理 · diff 删除 |

## 生态

`dash` 是 [DeepSeek Harness 插件生态](https://github.com/topics/dsh-plugin)的一员——在 `dsh-plugin` topic 下浏览所有社区插件，或查看精选清单 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)。

## 架构

`dash` 是一个 Cordis bundle——`@realchenwenqiao/dash`——通过 `tui` profile 挂载在 `dsh-base` 之上，与 `web`、`headless` bundle 同构。TUI 驱动稳定表面（`agents.create` / `agent.followup` / `agent.whenIdle` / `session/event`），用 [pi-tui](https://github.com/earendil-works/pi-tui) 组件渲染。上游保持原样，TUI 只是多了一个 surface。

## 开发

从 [docs/development.md](docs/development.md) 与 [AGENTS.md](AGENTS.md) 开始。

## License

[MIT](LICENSE)。第三方声明：[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
