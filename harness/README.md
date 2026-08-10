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
`verifier-status` is also local and read-only.
Do not use `--apply` until the governance bootstrap is merged and reviewed.

The governance bootstrap is an explicit operator procedure. Its PR reports its
protected-path change through the informational `protected-paths` job. Verify
the bootstrap's exact head SHA and `verify` result, merge that exact SHA once,
then configure branch protection on the default branch with exactly these
required checks:

- `verify`;
- `one-cli/independent-verifier`.

Pin both `verify` and `one-cli/independent-verifier` to the built-in GitHub
Actions App ID `15368`. Enable strict checks and admin
enforcement, disable force pushes and deletions, dismiss stale reviews, require
last-push approval and at least one approval, and require no checks beyond the
two pinned checks. Enable the repository Actions setting that permits workflows
to approve pull request reviews, and require the review actor
`github-actions[bot]`. An owner can apply the one-time bootstrap explicitly:

```bash
gh api --method PUT repos/beforeload/one-cli/actions/permissions/workflow \
  -f default_workflow_permissions=read \
  -F can_approve_pull_request_reviews=true

gh api --method PUT repos/beforeload/one-cli/branches/main/protection \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "checks": [
      { "context": "verify", "app_id": 15368 },
      { "context": "one-cli/independent-verifier", "app_id": 15368 }
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_last_push_approval": true,
    "required_approving_review_count": 1
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

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
The journal rolls into bounded, hash-chained segments without losing sequence
or tamper evidence during long unattended runs.
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
EOF
```

The local GitHub credential must be an installation token for the pinned
`ONE_CLI_BUILDER_APP_ID`. Before any applied `run` or `seed`, the harness calls
the read-only `/installation` endpoint and requires `contents`, `issues`, and
`pull_requests` write plus `administration:read`, while rejecting
administration, checks, Actions, workflow, variable, and secret write authority.
The administration read grant is used only to inspect Actions workflow settings
and branch protection before product execution. An owner OAuth login is not an
accepted fallback.

The independent verifier has no local key, custom App, or repository secret.
GitHub Actions supplies an ephemeral `GITHUB_TOKEN` as the built-in App identity.
That token is used only for GitHub API, review, and merge operations; model
inference uses the runner-local proxy and never receives it.
The Actions verifier never calls `/installation`, branch-protection, ruleset, or
Actions-permission APIs. It requires `GITHUB_ACTIONS=true`, the exact
`GITHUB_REPOSITORY` and event repository, and validates `/user` as
`github-actions[bot]` user ID `41898282` when that endpoint is available.
The local builder GitHub identity must remain least privilege and must not have
checks, review, administration-write, ruleset-write, or branch-protection-write
authority.
Branch-protection bootstrap remains an operator action;
no runtime or verifier code has an endpoint that changes protection.

## Trusted independent verifier

`.github/workflows/independent-verifier.yml` runs on `pull_request_target` for
every normal and protected PR. GitHub supplies workflow text from the trusted
default branch. The job checks out the exact event base SHA into `trusted/`,
installs and builds only that trusted tree, and checks out the
PR head separately into `untrusted/` with persisted credentials disabled. No
file or command from `untrusted/` is executed. Both verifier and merge jobs run
only on exact `[self-hosted, macOS, one-cli-verifier]` labels, with no hosted
fallback. The required first job is named `one-cli/independent-verifier`.

`harness/verifier-policy.yml` pins the base repository, default branch, trusted
workflow path, Git blob SHA and policy version, required `verify` check name and
GitHub Actions App ID `15368`, emitted check name and App ID, review actor
`github-actions[bot]` with user ID `41898282`, protected paths, bounds, merge
method, and exactly two semantic profiles. The policy pins the trusted workflow
blob, while that workflow pins the canonical policy hash; both are checked
before any applied verifier operation. The workflow emits
`one-cli/independent-verifier` for every PR. Normal paths become
deterministically eligible only after the exact head's pinned `verify` check
succeeds.

Protected changes are classified from `git diff --name-only` over the exact base
and head commit objects. Their complete binary/full-index diff also comes from
those local objects, never GitHub's REST patch field. Missing objects, malformed
paths, duplicate or wrong-App checks, oversized evidence, or any command
truncation fails closed. Immediately before review and again before exact-head
merge, the script re-fetches the repository `default_branch`, PR, and
default-branch head and requires the same repository, default branch, base SHA,
and head SHA. It also revalidates exact-head check App provenance before review,
and exact-head check App and approval actor/commit provenance before merge.
Base advancement fails and relies on the resulting new workflow run.

Two independent profiles make separate OpenAI-compatible calls to the
runner-local proxy. Defaults are `claude-opus-4.8`, `gpt-5.4`,
`http://127.0.0.1:8085/v1`, and the non-secret placeholder key `local-proxy`.
Repository variables may override both model IDs and the localhost base URL;
the equivalent host variables are `ONE_CLI_VERIFIER_MODEL_A`,
`ONE_CLI_VERIFIER_MODEL_B`, and `ONE_CLI_VERIFIER_BASE_URL`. Repository
variables take precedence over host defaults. Pull-request-controlled values
are never accepted. Both calls receive bounded, secret-redacted diff evidence.
Responses are strict JSON. Models are veto-only: deterministic
gates establish eligibility, while either veto rejects it; model text can never
authorize a merge. Malformed output or profile collapse fails closed. The App
submits a `commit_id`-bound review and validates the pinned bot actor. Only after
that required job has completed successfully does a second job revalidate the
exact repository, PR, checks, review, base, default-branch head, and
mergeability, then merge with GitHub's atomic `sha` precondition. The workflow
token never reads branch-protection or ruleset APIs; the local governance
readiness port proves the workflow blob/policy hash and the full protection
contract, including both required checks pinned to App ID `15368`, before
product execution, while GitHub's merge API enforces the live rules.

The same owner read port inventories repository runners and reports a strict
`runner-health` check. Product work is blocked unless at least one runner with
all three pinned labels is online and non-busy.

Install the official runner beneath `ONE_CLI_HOME` with the protected bootstrap
script. It is dry-run by default. Before applying, copy the SHA-256 from the
official `actions/runner` release and mint a short-lived repository registration
token; neither value is written by the script.

```bash
ONE_CLI_HOME="$HOME/.one-cli" \
  ONE_CLI_RUNNER_SHA256="<official-release-sha256>" \
  ONE_CLI_RUNNER_REGISTRATION_TOKEN="<short-lived-repository-token>" \
  scripts/bootstrap-verifier-runner.sh --apply
```

The script downloads only the pinned official release asset over HTTPS,
verifies its checksum, registers only `beforeload/one-cli` with custom label
`one-cli-verifier`, then installs and starts the official launchd service. The
registration token is unset before service installation and is never persisted.

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
Stale harness locks are reclaimed through an atomic recovery mutex with
owner-token and inode revalidation, preventing both permanent crash stalls and
split ownership.

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
