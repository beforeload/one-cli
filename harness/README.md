# Cold-start harness

This is a host process, not a Cursor agent. It runs the built `dist/index.js` and
the authenticated `gh` executable as bounded, no-shell subprocesses. It never
uses the Cursor SDK.

Build and inspect:

```bash
npm run build
node harness/dist/index.js doctor --workspace "$PWD"
node harness/dist/index.js verifier-status --workspace "$PWD"
node harness/dist/index.js seed --workspace "$PWD"          # dry-run
node harness/dist/index.js status --workspace "$PWD"
node harness/dist/index.js run --once --workspace "$PWD"
```

`seed`, `install`, and `uninstall` are dry-run unless `--apply` is supplied.
`run` remains the applied product loop for launchd, while explicit
`run --dry-run` exits after read-only verifier configuration inspection without
starting subprocesses, taking a lock, appending the journal, or writing GitHub.
`verifier-status` is also local and read-only; it never authenticates as the
Verifier App.
Do not use `--apply` until the governance bootstrap is merged and reviewed.

The governance bootstrap is an explicit operator procedure. Its PR reports its
protected-path change through the informational `protected-paths` job. Verify
the bootstrap's exact head SHA and `verify` result, merge that exact SHA once,
then configure branch protection on the default branch with exactly these
required checks:

- `verify`;
- `one-cli/independent-verifier`.

Pin `verify` to the GitHub Actions App ID and
`one-cli/independent-verifier` to the dedicated Verifier App ID where GitHub's
branch-protection API supports App restrictions. Enable strict checks and admin
enforcement, disable force pushes and deletions, dismiss stale reviews, require
last-push approval and at least one approval, and require no checks beyond the
two pinned checks. Require the review actor `one-cli-verifier[bot]`.
`protected-paths` remains a non-required
informational job. Runtime code never removes, restores, or otherwise lowers
these rules. Applied seeding requires
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
GH_TOKEN=replace-with-least-privilege-builder-installation-token
ONE_CLI_BUILDER_APP_ID=replace-with-builder-app-id
ONE_CLI_VERIFIER_APP_ID=replace-with-public-decimal-app-id
EOF
```

The local GitHub credential must be an installation token for the pinned
`ONE_CLI_BUILDER_APP_ID`. Before any applied `run` or `seed`, the harness calls
the read-only `/installation` endpoint and requires `contents`, `issues`, and
`pull_requests` write while rejecting administration, checks, Actions,
workflow, variable, and secret write authority. An owner OAuth login is not an
accepted fallback.

The non-secret Verifier App ID is duplicated locally only so `doctor` can pin
remote branch protection and App identity. Verifier App and semantic-model secrets must be GitHub Actions secrets. They
must never appear in `$ONE_CLI_HARNESS_ENV_FILE`, `$ONE_CLI_HOME`, launchd, or a
local process environment. The local harness strips recognized verifier names
from worker and builder environments and `doctor` fails closed when it finds
one. Local builds use a strict credential-free environment. The local builder
GitHub identity must be least privilege and must not have checks, review,
administration, ruleset, or branch-protection authority.

The Verifier App permissions must be exactly `checks:write`,
`pull_requests:write`, `contents:read`, and `metadata:read`; any additional
permission fails closed.
Branch-protection bootstrap remains an operator action;
no runtime or verifier code has an endpoint that changes protection.

## Trusted independent verifier

`.github/workflows/independent-verifier.yml` runs on `pull_request_target` for
every normal and protected PR. GitHub supplies workflow text from the trusted
default branch. The job checks out the exact event base SHA into `trusted/`,
installs and builds only that trusted tree without secrets, and checks out the
PR head separately into `untrusted/` with persisted credentials disabled. No
file or command from `untrusted/` is executed. Verifier App and model secrets
are provided only to the final trusted script step.

`harness/verifier-policy.yml` pins the base repository, default branch, trusted
workflow path, Git blob SHA and policy version, required `verify` check name and
GitHub Actions App ID, emitted check name, review App
slug/actor, protected paths, bounds, merge method, and exactly two independent
semantic profiles. The workflow emits `one-cli/independent-verifier` for every
PR. Normal paths become deterministically eligible only after the exact head's
pinned `verify` check succeeds.

Protected changes are classified from `git diff --name-only` over the exact base
and head commit objects. Their complete binary/full-index diff also comes from
those local objects, never GitHub's REST patch field. Missing objects, malformed
paths, duplicate or wrong-App checks, oversized evidence, or any command
truncation fails closed. Immediately before review and again before exact-head
merge, the script re-fetches the PR and requires the same base repository,
default branch, base SHA, and head SHA. Immediately before merge it also
re-reads strict protection, the default-branch head, and the expected merge
base. Base advancement fails and relies on the resulting new workflow run.

Two independent model profiles receive bounded, secret-redacted diff evidence
as untrusted data and return strict JSON. Models are veto-only: deterministic
gates establish eligibility, while either veto rejects it; model text can never
authorize a merge. Malformed output or profile collapse fails closed. The App
submits a `commit_id`-bound review, validates the pinned bot actor, publishes an
App-bound check operation, and merges with GitHub's atomic `sha` precondition.
Stale heads naturally receive separate terminal checks and cannot block
rediscovery of a new head.

## Delivery behavior

Each 30-minute tick acquires the host lock and first runs the read-only live
governance readiness port. Any failed invariant blocks product and recovery
with zero product calls. Once ready, it runs only the least-privilege product
lane, validates the non-executable parent, and uses strict JSON status,
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
