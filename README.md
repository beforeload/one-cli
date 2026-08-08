# one-cli

一个从 0→1 实现的小型、可审计 Coding Agent CLI。重点不是工具数量，而是稳定的运行时边界：tool-call 配对、安全审批、workspace 约束、append-only session、可恢复取消和纯 JSONL 输出。

## 安装与验证

要求 Node.js `>=22.13.0`（`node:sqlite` 无需实验性 flag）和 npm。

```bash
npm ci
npm run check
npm run build

export OPENAI_API_KEY="..."
export OPENAI_MODEL="your-model"
# 可选，默认 https://api.openai.com/v1
export OPENAI_BASE_URL="https://your-compatible-endpoint/v1"
node dist/index.js run -p "阅读 README，告诉我项目如何工作"
```

`npm run check` 依次验证 autonomy contract、typecheck、unit、integration、smoke 和 build。`prepublishOnly` 仍执行完整 check 后再次 build。

## 架构

普通 agent 路径是 `CLI → runAgent → provider/tools/approval → append-only SessionJournal → text/JSONL reporter`。Autonomy 路径是独立的运维层：

```text
namespaced CLI
  → trusted tracked policy (.autonomy)
  → SQLite ledger + fenced leases (host-private)
  → TrustedIntake → normalized maintainer-authored execution issue
  → scheduler → orchestrator → isolated git worktree + Darwin sandbox
  → review/local gates/exact-SHA CI/PR
  → detached exact-merge dogfood
  → immutable release → supervisor
```

主要模块位于 `src/autonomy/`：`config` 关闭并校验策略；`intake` 把外部内容当数据；`maintenance` 与 `schedule` 选择并持久化单一动作；`orchestrator` 驱动 durable state machine；`release` 保存内容寻址的只读运行时和 N-1 rollback。

状态不写入仓库。默认 session 位于 `~/.one-cli/sessions/`，autonomy ledger、bare repo、worktree 与 release 位于 `~/.one-cli/autonomy/<repo-key>/`；可用 `ONE_CLI_HOME` 改写根目录。日志、Issue 和配置不得写入这些 host-private 绝对路径。

## 普通 CLI

```text
one-cli run -p <prompt> [options]
one-cli run --stdin [options]
one-cli sessions [--workspace <dir>]
```

支持 `--resume`、`--workspace`、`--output text|jsonl`、provider/预算选项以及 `--approval deny|ask|auto-edit|all`。非 TTY 的 `ask` fail-closed。Session 只能在原 canonical workspace 恢复；torn 尾记录可修复，内部损坏、seq gap 或未完成 tool operation 会拒绝自动恢复。

## Autonomy authority 与 setup

所有运维命令只存在于 `one-cli autonomy ...` namespace；没有旧式顶层 alias。`.autonomy/product.yml` 的 `mode: auto-merge` 是 trusted tracked **maximum authority**。每次 invocation 即使 maximum 是 `auto-merge` 也默认 `propose`，必须显式传 `--mode auto-pr` 或 `--mode auto-merge` 才能扩大到已授权上限；CLI 永远不能超过 tracked maximum。

```bash
one-cli autonomy doctor --workspace "$PWD"
one-cli autonomy init --workspace "$PWD"
one-cli autonomy once --workspace "$PWD" --mode propose --output json
one-cli autonomy daemon --workspace "$PWD" --mode auto-merge --interval-ms 1800000 --output jsonl
one-cli autonomy status --workspace "$PWD"
one-cli autonomy schedule status --workspace "$PWD"
```

Repository 必须有受保护的 default branch、唯一名为 `verify` 的 required check，以及 `agent-ready`、`source:user`、`maintainer-accepted`、`source:community`、`source:self-discovery`、failure/quarantine 相关 labels。原始用户 Issue 必须同时有 `source:user` 和 `maintainer-accepted` 才可 promotion；它本身绝不执行。只有 author 精确为策略中的 maintainer、包含 trusted marker、字段完整且带 `agent-ready` 的 normalized child issue 才有执行资格。

安全 promotion 接受 workspace 内、regular、非 symlink、最大 256 KiB 的 JSON 文件：

```bash
one-cli autonomy intake promote-user 123 fields.json --workspace "$PWD"
one-cli autonomy intake promote-community finding.json fields.json --workspace "$PWD"
one-cli autonomy intake promote-self finding.json fields.json --workspace "$PWD"
```

Community registry 是 `.autonomy/community.yml` 中的 closed allowlist。`ResearchPort` 是可注入接口；当前 CLI **没有内建 web crawler，也不声称会主动抓取网络**。因此到期的 daemon community scan 会明确报告 `community-scan-pending` 并保持 due；也可通过 intake 命令提交已经预验证的 finding JSON。外部文本会清理 instruction-like 内容，不能提供命令或 authority。

`once` 和 `daemon` 都实际经过 reconcile-first maintenance coordinator。每个 tick 先按 deterministic marker reconcile 所有 reserved intake write；已存在的 Issue/comment 会补记成功，只有能证明未开始 write 且远端不存在时才创建 linked retry，transport outcome 不确定则只隔离该条 intake。随后每次只执行一个 bounded action：reconcile/继续 active issue → promotion 一个 maintainer-accepted user original → 到期的 24h exact-default-branch global dogfood → 获取一个现有 trusted execution issue → 到期的 community scan → idle。Post-merge dogfood 是 active orchestrator attempt 的一部分，不是并行的第二条执行路径。`schedule status` 显示持久化的真实 due timestamp 和当前优先动作。`observe` 不需要 provider credential，也不执行 normalization 或 dogfood mutation。

非 transient 的 worker、diff、local gate 或 exact-SHA CI code failure 会进入 `waiting_evidence`，不会按时间自动恢复。`retry` 必须提交与当前 failure fingerprint 绑定的新 diagnosis evidence（最多 4 KiB 的文本或 workspace regular file）；命令在 coordinator lease 下重新证明或取得该 attempt 的 GitHub claim 后才恢复执行。`cancel` 和 `resolve-in-doubt` 也走同一 recovery boundary，只删除与 durable attempt 完全一致的 own claim；删除结果不确定时保留 `in_doubt` 和 local lease。

```bash
one-cli autonomy retry <attempt-id> --evidence diagnosis.txt --workspace "$PWD"
one-cli autonomy cancel <attempt-id> --workspace "$PWD"
one-cli autonomy resolve-in-doubt <attempt-id> failed --workspace "$PWD"
```

## Post-merge、自更新与 supervisor

合并后会为 exact merge SHA 创建 detached worktree，按顺序执行 `npm ci`、build、受影响时的 targeted integration、最后 `npm run smoke`。不会 inline 修复。失败会保留证据、创建 deduplicated `source:self-discovery` normalized issue（包含 reproduction 与 minimal scenario）、保持原 Issue open、释放原 lease 并终止为 blocked。

成功的 exact artifact（现有 `dist` 和 `node_modules`）会 stage 为 host-private immutable release；candidate state 绑定 `attemptId`、issue digest、policy hash、exact release SHA，以及需要时的 durable approval。自动 promotion 会重新验证同一 binding 和有效 approval，并保留 previous release。手工 promotion 不能只靠 `--mode`：必须先为该 candidate/attempt 记录 durable `promote-release` approval。Release 错误 fail-closed：不清理 worktree、不关闭 Issue、不释放 lease。

```bash
one-cli autonomy release status --workspace "$PWD"
one-cli autonomy release stage <exact-clean-HEAD-sha> --attempt <attempt-id> --workspace "$PWD"
one-cli autonomy approve <attempt-id> --action promote-release --workspace "$PWD"
one-cli autonomy release promote <sha> --workspace "$PWD"
one-cli autonomy release rollback [sha] --workspace "$PWD"
one-cli autonomy supervise --workspace "$PWD" --mode auto-merge --output jsonl
```

Supervisor 只从 active immutable release 的 manifest-resolved entrypoint 启动 `autonomy daemon`；仅连续 early-exit streak 达到阈值时原子 rollback 到 preserved N-1 release，达到 healthy-duration 的 run 会把 streak 清零，历史稀疏失败只保留为 health telemetry。

## Sandbox 与安全边界

普通 file tools 限制在 canonical workspace，拒绝 traversal、NUL、symlink escape 和非 regular file，写入使用 stale-target 检查与原子 rename。普通 agent 的 `shell` **不是 OS sandbox**：`cwd` 不能阻止绝对路径、网络或子进程，因此默认需要审批并限制环境、stdin、timeout、输出和进程组。

Autonomy worktree gate 使用 macOS `sandbox-exec` backend；不可用时 fail-closed。Install 是唯一允许网络的 tracked command，其余 gate 禁网。该机制不是跨平台 container：Linux 部署需要单独的 namespace/container backend，不能把缺失隔离当作成功。

## License

MIT
