#!/usr/bin/env bash
# Explicit offline acceptance gate for one frozen platform commit and one signed Treasury app commit.
set -euo pipefail

: "${CROSSREPO_SDK_GIT:?absolute platform Git checkout required}"
: "${CROSSREPO_PLATFORM_COMMIT:?full platform release commit required}"
: "${CROSSREPO_APP_ROOT:?signed Treasury app checkout required}"
: "${CROSSREPO_APP_HEAD:?full Treasury app commit required}"
: "${CROSSREPO_SDK_SHA:?vendored SDK tarball SHA-256 required}"
: "${CROSSREPO_DEPENDENCY_SNAPSHOT:?frozen platform candidate snapshot required}"
[[ "$CROSSREPO_PLATFORM_COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo 'Platform commit must be a full lowercase SHA-1' >&2; exit 1; }
[[ "$CROSSREPO_APP_HEAD" =~ ^[0-9a-f]{40}$ ]] || { echo 'Treasury commit must be a full lowercase SHA-1' >&2; exit 1; }
[[ "$CROSSREPO_SDK_SHA" =~ ^[0-9a-f]{64}$ ]] || { echo 'Vendored SDK checksum must be full lowercase SHA-256' >&2; exit 1; }
for input in "$CROSSREPO_SDK_GIT" "$CROSSREPO_APP_ROOT" "$CROSSREPO_DEPENDENCY_SNAPSHOT"; do
  [[ "$input" == /* ]] || { echo 'Source and snapshot paths must be absolute' >&2; exit 1; }
done
node -e 'if (Number(process.versions.node.split(".")[0]) !== 24) throw new Error("Cross-repository release evidence requires Node 24")'

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
run_root="${CROSSREPO_ROOT:-$(mktemp -d /private/tmp/crossrepo-orders.XXXXXX)}"
if [[ -n "${CROSSREPO_ROOT:-}" ]]; then mkdir "$run_root"; fi
platform_root="$run_root/platform"
mkdir "$platform_root"
git -C "$CROSSREPO_SDK_GIT" archive "$CROSSREPO_PLATFORM_COMMIT" | tar -x -C "$platform_root"
(cd "$platform_root" && git apply --check "$script_dir/fixtures.patch" && git apply "$script_dir/fixtures.patch")
ln -s "$CROSSREPO_DEPENDENCY_SNAPSHOT/node_modules" "$platform_root/node_modules"
ln -s "$CROSSREPO_DEPENDENCY_SNAPSHOT/web/dist" "$platform_root/web/dist"

export CROSSREPO_ROOT="$run_root"
export CROSSREPO_PLATFORM_ROOT="$platform_root"
export CROSSREPO_STACK_DIRECTORY="$platform_root/.test-artifacts/e2e-crossrepo/stack"
export PROTO_E2E_ARTIFACTS="$platform_root/.test-artifacts/e2e-crossrepo"
export PROTO_E2E_ISOLATED=1
export NODE_OPTIONS="--require $platform_root/test/fixtures/offline-network.cjs"
export CROSSREPO_STACK_LAUNCH="(cd \"$platform_root\" && node test/e2e/stack.mjs --no-browser --treasury --app treasury-app) > \"$run_root/stack.log\" 2>&1 &"

(cd "$platform_root" && node test/e2e/stack.mjs --no-browser --treasury --app treasury-app) > "$run_root/stack.log" 2>&1 &
stack_pid=$!
stop_stack() {
  if [[ -d "$CROSSREPO_STACK_DIRECTORY" ]]; then touch "$CROSSREPO_STACK_DIRECTORY/stop"; fi
  wait "$stack_pid" || true
}
trap stop_stack EXIT
for ((attempt=0; attempt<600; attempt++)); do
  if [[ -f "$CROSSREPO_STACK_DIRECTORY/state.json" ]]; then break; fi
  if ! kill -0 "$stack_pid" 2>/dev/null; then cat "$run_root/stack.log"; exit 1; fi
  sleep 0.1
done
if [[ ! -f "$CROSSREPO_STACK_DIRECTORY/state.json" ]]; then
  echo "Offline stack did not start; see $run_root/stack.log" >&2
  exit 1
fi
node "$script_dir/runner.mjs"
echo "Offline cross-repo evidence: $run_root/result.json"
