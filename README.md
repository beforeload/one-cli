# one-cli

一个从 0→1 实现的小型、可审计 Coding Agent CLI。重点不是工具数量，而是稳定的运行时边界：tool-call 配对、安全审批、workspace 约束、append-only session、可恢复取消和纯 JSONL 输出。

## 能力

- OpenAI-compatible streaming provider
- `read` / `list` / `grep` / `write` / `edit` / `shell`
- `deny` / `ask` / `auto-edit` / `all` 审批模式
- 路径穿越与 symlink escape 防护
- 原子写入、唯一 literal edit、stale-target 检查
- workspace-bound JSONL session 与 `--resume`
- 人类 text 输出和机器 JSONL 协议
- 首次 SIGINT 协作取消，退出码 130
- 本地 fake SSE provider 的 unit/integration tests

## 安装与运行

要求 Node.js 22+。

```bash
npm install
npm run build

export OPENAI_API_KEY="..."
export OPENAI_MODEL="your-model"
# 可选，默认 https://api.openai.com/v1
export OPENAI_BASE_URL="https://your-compatible-endpoint/v1"

node dist/index.js run -p "阅读 README，告诉我项目如何工作"
```

开发模式：

```bash
npm run dev -- run -p "列出当前项目的 TypeScript 文件"
```

## CLI

```text
one-cli run -p <prompt> [options]
one-cli run --stdin [options]
one-cli sessions [--workspace <dir>]
```

常用选项：

```text
--resume <uuid>
--workspace <dir>             默认当前目录
--output <text|jsonl>         默认 text
--approval <deny|ask|auto-edit|all>
--model <name>
--base-url <url>
--max-rounds <n>
--max-tool-calls <n>
--shell-timeout-ms <n>
```

审批语义：

| mode | read/list/grep | write/edit | shell |
|---|---|---|---|
| `deny` | allow | deny | deny |
| `ask` | allow | prompt | prompt |
| `auto-edit` | allow | allow | prompt |
| `all` | allow | allow | allow |

非 TTY 环境无法交互审批，`ask` 会 fail-closed。自动化必须显式选择 `--approval auto-edit` 或 `--approval all`。

## 重要安全边界

File tools 被限制在 canonical workspace 内：

- 拒绝绝对路径、`..` 越界与 NUL；
- 不跟随路径中的 symlink；
- 只读写 regular files；
- write/edit 在同目录写临时文件后原子 rename；
- 审批后、写入前重新校验目标 hash；
- hard policy 拒绝 `.env`、`.git/**` 等敏感 mutation。

`shell` **不是 OS sandbox**。把 `cwd` 设为 workspace 不能阻止命令使用绝对路径、访问网络或启动子进程。本项目只做：

- 默认人工审批并显示 “host-capable command”；
- 清理 API key/secret 环境变量，使用临时 HOME；
- 关闭 stdin，限制 timeout 与输出；
- 拒绝明显危险命令形状；
- 取消时终止整个进程组。

需要强隔离时，应增加 macOS sandbox、Linux namespace/container 等独立 backend，并在不可用时关闭 shell。

## Session 与恢复

默认存储：

```text
~/.one-cli/sessions/<uuid>.jsonl
```

可用 `ONE_CLI_HOME` 改写根目录。每条 record 带 schema/version/sessionId/seq/ts；session 只 append，不做 checkpoint rewrite。

```bash
node dist/index.js sessions --workspace "$PWD"
node dist/index.js run --resume <uuid> -p "继续上一轮"
```

恢复规则：

- 只能在创建 session 的 canonical workspace 中恢复；
- 可修复一条 torn trailing record；
- 中间坏行或 seq gap 拒绝恢复；
- `tool.started` 没有对应 `tool.finished` 时视为 `in_doubt`，禁止自动恢复。

## JSONL 协议

```bash
node dist/index.js run -p "检查项目" --output jsonl
```

stdout 每行都是：

```json
{"protocol":"one-cli.events","version":1,"seq":1,"ts":"...","runId":"...","sessionId":"...","type":"run.started","model":"..."}
```

事件包括：

```text
run.started
assistant.delta
assistant.completed
tool.requested
approval.requested
approval.resolved
tool.started
tool.completed
provider.retry
usage
error
run.finished
```

人类诊断与审批只写 stderr。退出码：成功 `0`、运行失败 `1`、CLI/config/session 错误 `2`、取消 `130`。

## 架构

```text
CLI/config
  → runAgent
      → ChatProvider
      → ToolRunner
          → hard policy
          → prepare/preview
          → approval
          → execute
      → SessionJournal
      → Reporter(text/jsonl)
```

主要文件：

- `src/agent.ts` — 顺序 provider/tool 状态机
- `src/provider.ts` — OpenAI-compatible streaming 与 bounded retry
- `src/tools.ts` — tool schema、gate、执行与 shell runner
- `src/workspace.ts` — 文件系统 authority
- `src/session.ts` — append-only journal、lock、resume
- `src/reporter.ts` — text / JSONL projection
- `src/cli.ts` — composition root

## 验证

```bash
npm run typecheck
npm test
npm run test:integration
npm run check
```

Integration tests 构建真实 `dist/index.js`，启动本地 OpenAI-compatible SSE fake server，再 spawn CLI 验证：final answer、503 零输出重试、partial stream 保留且不重试、read tool loop、非 TTY mutation deny、显式 mutation allow、session resume 与跨 workspace 拒绝。测试不访问真实模型。

## 暂不包含

MCP、TUI、Desktop、subagent/worktree、context compaction、goal/journal 运维层和 model profiles。它们应在 execution kernel 稳定后按独立、可验收的纵向 Issue 演进。

## License

MIT
