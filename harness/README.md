# Cold-start harness

This is a host process, not a Cursor agent. It runs the built `dist/index.js` and
the authenticated `gh` executable as bounded, no-shell subprocesses. It never
uses the Cursor SDK.

Build and inspect:

```bash
npm run build
node harness/dist/index.js doctor --workspace "$PWD"
node harness/dist/index.js seed --workspace "$PWD"          # dry-run
node harness/dist/index.js status --workspace "$PWD"
node harness/dist/index.js run --once --workspace "$PWD"
```

`seed`, `install`, and `uninstall` are dry-run unless `--apply` is supplied.
Do not use `--apply` until the governance bootstrap is merged and reviewed.

The governance bootstrap is an explicit operator procedure. Its PR is expected
to fail only the `protected-paths` required context. Verify every other required
check, temporarily remove only that required context from branch protection,
merge the reviewed bootstrap, and immediately restore and verify the context.
Record the resulting merge SHA. Applied seeding requires
`--bootstrap-merge-sha <full-sha>` and verifies through GitHub that the default
branch contains that SHA before creating or changing any roadmap issue.

## Host state and secrets

All mutable state is under `$ONE_CLI_HOME/harness` (default
`~/.one-cli/harness`): append-only `journal.jsonl`, durable seed-operation
reservations, the single-instance lock, and launchd output. No host state
belongs in the repository. `ONE_CLI_HOME`, the environment file, and active
release paths must be canonical, non-symlink paths under that private root.
Active releases are resolved only from
`$ONE_CLI_HOME/autonomy/<repo-key>/releases`.

The launchd job contains only paths. The Node harness loads
`$ONE_CLI_HARNESS_ENV_FILE` (default `~/.one-cli/harness.env`) before spawning
one-cli. The file must be a regular mode-0600 file containing simple
`KEY=value` or `export KEY=value` lines; command substitution and shell syntax
are rejected.

`ONE_CLI_GH_EXECUTABLE` must be an absolute path that resolves to a regular
executable. Symlink inputs such as Homebrew's `/opt/homebrew/bin/gh` are
resolved and checked; broken links, cycles, directories, and non-executable
targets are rejected. `doctor` and `install` may discover `gh` from the
interactive PATH, `/opt/homebrew/bin/gh`, or `/usr/local/bin/gh`; generated
launchd configuration records only the canonical target, so service execution
never depends on PATH.

```bash
umask 077
cat >"$HOME/.one-cli/harness.env" <<'EOF'
OPENAI_API_KEY=replace-on-host
OPENAI_MODEL=replace-on-host
ONE_CLI_GH_EXECUTABLE=/opt/homebrew/bin/gh
EOF
```

## Delivery behavior

Each 30-minute tick acquires the host lock, validates the non-executable parent,
runs doctor and strict JSON status,
reconciles the active attempt, and fails closed for `in_doubt`, `blocked`, or
`waiting_evidence`. During cold-start it reconciles deterministic issue
markers, keeps exactly one open roadmap child `agent-ready`, and invokes:

```text
one-cli autonomy once --roadmap-only --mode auto-merge --output json
```

A child advances only after the issue is closed, its PR is merged, and local
attempt evidence proves post-merge dogfood and release. After the first active
host-private release exists, every invocation resolves and verifies that exact
immutable release instead of workspace `dist`. Bootstrap `dist` is allowed
only before release management starts. At roadmap handoff, the active release
SHA must equal the final child merge SHA. The harness then records one durable
`roadmap.handoff.completed` event bound to the parent, final child, pull, merge,
and release. Later normal ticks accept newer releases only when GitHub proves
they descend from that handoff commit; missing, changed, duplicated, or
pre-handoff evidence fails closed. The harness never records governance
approval.

Issue creation is reserved and fsynced before GitHub is called. An interrupted
reservation is `in_doubt`; restart reconciles exactly one matching marker.
Zero or multiple matches require manual resolution and are never recreated.
Stale harness locks also require explicit operator resolution; automatic
reclaim is intentionally disabled to prevent split ownership.

## launchd

Preview the generated secret-free plist:

```bash
node harness/dist/index.js install --workspace "$PWD"
```

Installation and removal are explicit:

```bash
node harness/dist/index.js install --apply --workspace "$PWD"
node harness/dist/index.js uninstall --apply --workspace "$PWD"
```

The tracked plist is a placeholder template; installation generates absolute
host paths without embedding environment values or credentials.
