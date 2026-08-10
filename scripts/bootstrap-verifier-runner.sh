#!/bin/bash
set -euo pipefail

MODE=dry-run
if [[ "${1:-}" == "--apply" && $# -eq 1 ]]; then
  MODE=apply
elif [[ $# -ne 0 ]]; then
  echo "usage: scripts/bootstrap-verifier-runner.sh [--apply]" >&2
  exit 2
fi

ONE_CLI_HOME="${ONE_CLI_HOME:-$HOME/.one-cli}"
RUNNER_VERSION="${ONE_CLI_RUNNER_VERSION:-2.336.0}"
RUNNER_SHA256="${ONE_CLI_RUNNER_SHA256:-}"
RUNNER_HOME="$ONE_CLI_HOME/github-actions-runner"
REPOSITORY_URL="https://github.com/beforeload/one-cli"
RUNNER_LABEL="one-cli-verifier"
RUNNER_NAME="${ONE_CLI_RUNNER_NAME:-one-cli-verifier-$(hostname -s)}"

case "$ONE_CLI_HOME" in
  /*) ;;
  *) echo "ONE_CLI_HOME must be absolute" >&2; exit 2 ;;
esac
if [[ ! "$RUNNER_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "ONE_CLI_RUNNER_VERSION must be a release version" >&2
  exit 2
fi
if [[ "$MODE" == apply && ! "$RUNNER_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
  echo "ONE_CLI_RUNNER_SHA256 must be the official lowercase SHA-256" >&2
  exit 2
fi
if [[ "$MODE" == apply && ! "${ONE_CLI_RUNNER_REGISTRATION_TOKEN:-}" =~ ^[A-Za-z0-9_]{20,255}$ ]]; then
  echo "ONE_CLI_RUNNER_REGISTRATION_TOKEN must contain a short-lived repository registration token" >&2
  exit 2
fi
if [[ "$MODE" == apply && "$(uname -s)" != "Darwin" ]]; then
  echo "The verifier runner is pinned to macOS" >&2
  exit 2
fi

case "$(uname -m)" in
  arm64) RUNNER_ARCH=osx-arm64 ;;
  x86_64) RUNNER_ARCH=osx-x64 ;;
  *) echo "Unsupported runner architecture" >&2; exit 2 ;;
esac

ASSET="actions-runner-${RUNNER_ARCH}-${RUNNER_VERSION}.tar.gz"
DOWNLOAD_URL="https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${ASSET}"

if [[ "$MODE" == dry-run ]]; then
  cat <<EOF
Dry run; no files, registration, or services were changed.
runner home: $RUNNER_HOME
official asset: $DOWNLOAD_URL
required labels: self-hosted, macOS, $RUNNER_LABEL
apply requires:
  ONE_CLI_RUNNER_SHA256=<official release checksum>
  ONE_CLI_RUNNER_REGISTRATION_TOKEN=<short-lived repo registration token>
command:
  scripts/bootstrap-verifier-runner.sh --apply
EOF
  exit 0
fi

umask 077
mkdir -p "$ONE_CLI_HOME"
if [[ -e "$RUNNER_HOME" ]]; then
  echo "Runner home already exists; refusing to replace it: $RUNNER_HOME" >&2
  exit 1
fi
archive="$(mktemp "$ONE_CLI_HOME/.runner.XXXXXX.tar.gz")"
cleanup() {
  rm -f "$archive"
  unset ONE_CLI_RUNNER_REGISTRATION_TOKEN
}
trap cleanup EXIT

curl --fail --location --proto '=https' --tlsv1.2 \
  --retry 3 --retry-all-errors --connect-timeout 15 --max-time 300 \
  --output "$archive" "$DOWNLOAD_URL"
printf '%s  %s\n' "$RUNNER_SHA256" "$archive" | shasum -a 256 --check

mkdir "$RUNNER_HOME"
tar -xzf "$archive" -C "$RUNNER_HOME"
cd "$RUNNER_HOME"
./config.sh \
  --unattended \
  --url "$REPOSITORY_URL" \
  --token "$ONE_CLI_RUNNER_REGISTRATION_TOKEN" \
  --name "$RUNNER_NAME" \
  --labels "$RUNNER_LABEL" \
  --work _work \
  --replace
unset ONE_CLI_RUNNER_REGISTRATION_TOKEN
./svc.sh install
./svc.sh start

echo "Installed and started repository verifier runner in $RUNNER_HOME"
