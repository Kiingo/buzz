#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
temp_root=$(mktemp -d "${TMPDIR:-/tmp}/buzz-sidecar-stubs.XXXXXX")
trap 'rm -rf -- "$temp_root"' EXIT

rustc() {
    if [[ "${1:-}" != "-vV" ]]; then
        echo "fake rustc only supports -vV" >&2
        exit 64
    fi

    printf '%s\n' \
        'rustc 1.95.0' \
        'binary: rustc' \
        'commit-hash: sidecar-contract-test' \
        'commit-date: 2026-09-21' \
        "host: ${MOCK_RUSTC_HOST:?}" \
        'release: 1.95.0'
}

pnpm() {
    printf '%s\n' "$*" >>"${MOCK_PNPM_LOG:?}"
}

export -f rustc pnpm

assert_exact_binaries() {
    local binaries_dir=$1
    shift

    local expected_file="$temp_root/expected"
    local actual_file="$temp_root/actual"
    printf '%s\n' "$@" | sort >"$expected_file"
    (
        shopt -s nullglob
        for path in "$binaries_dir"/*; do
            [[ -f "$path" ]] && basename "$path"
        done
    ) | sort >"$actual_file"

    if ! diff -u "$expected_file" "$actual_file"; then
        echo "unexpected sidecar placeholders in $binaries_dir" >&2
        exit 1
    fi
}

run_ensure_recipe() {
    local target=$1
    local label=$2
    shift 2

    local workspace="$temp_root/ensure-$label"
    mkdir -p "$workspace"
    MOCK_RUSTC_HOST="$target" \
        just --justfile "$repo_root/Justfile" \
        --working-directory "$workspace" \
        _ensure-sidecar-stubs >/dev/null
    assert_exact_binaries "$workspace/desktop/src-tauri/binaries" "$@"
}

run_release_recipe() {
    local target=$1
    local label=$2
    shift 2

    local workspace="$temp_root/release-$label"
    local pnpm_log="$workspace/pnpm.log"
    mkdir -p "$workspace/desktop"
    MOCK_PNPM_LOG="$pnpm_log" \
        just --justfile "$repo_root/Justfile" \
        --working-directory "$workspace" \
        desktop-release-build "$target" >/dev/null
    assert_exact_binaries "$workspace/desktop/src-tauri/binaries" "$@"
    grep -Fxq 'install' "$pnpm_log"
    grep -Fxq "tauri build --features mesh-llm --target $target" "$pnpm_log"
}

windows_target=x86_64-pc-windows-msvc
windows_binaries=(
    "buzz-$windows_target.exe"
    "buzz-acp-$windows_target.exe"
    "buzz-agent-$windows_target.exe"
    "buzz-dev-mcp-$windows_target.exe"
    "git-credential-nostr-$windows_target.exe"
)

linux_target=x86_64-unknown-linux-gnu
linux_binaries=(
    "buzz-$linux_target"
    "buzz-acp-$linux_target"
    "buzz-agent-$linux_target"
    "buzz-backend-kubernetes-$linux_target"
    "buzz-dev-mcp-$linux_target"
    "git-credential-nostr-$linux_target"
)

run_ensure_recipe "$windows_target" windows "${windows_binaries[@]}"
run_ensure_recipe "$linux_target" linux "${linux_binaries[@]}"
run_release_recipe "$windows_target" windows "${windows_binaries[@]}"
run_release_recipe "$linux_target" linux "${linux_binaries[@]}"

echo "sidecar stub contract passed for Windows and non-Windows targets"
