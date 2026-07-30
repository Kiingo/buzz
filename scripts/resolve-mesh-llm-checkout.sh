#!/usr/bin/env bash
set -euo pipefail

expected_rev="${1:?expected mesh-llm revision}"
manifest_path="${2:-desktop/src-tauri/Cargo.toml}"
checkout_root="${CARGO_HOME:-$HOME/.cargo}/git/checkouts"

# Cargo metadata is authoritative for the checkout actually selected by the
# lockfile. This avoids depending on Cargo's opaque checkout directory name or
# on a fixed CARGO_HOME layout (Hermit sets its own CARGO_HOME in CI).
metadata_json="$(cargo metadata --manifest-path "${manifest_path}" --format-version 1 2>/dev/null || true)"
resolved_manifest=""
if [[ -n "${metadata_json}" ]]; then
  resolved_manifest="$(python3 -c '
import json, sys

expected = sys.argv[1]
metadata = json.load(sys.stdin)
for package in metadata["packages"]:
    source = package.get("source") or ""
    if package["name"] == "mesh-llm-sdk" and source.endswith("#" + expected):
        print(package["manifest_path"])
        break
' "${expected_rev}" <<< "${metadata_json}" || true)"
fi

if [[ -n "${resolved_manifest}" ]]; then
  metadata_root="$(git -C "$(dirname "${resolved_manifest}")" rev-parse --show-toplevel 2>/dev/null || true)"
  metadata_rev="$(git -C "${metadata_root}" rev-parse HEAD 2>/dev/null || true)"
  if [[ "${metadata_rev}" == "${expected_rev}" && -f "${metadata_root}/scripts/prepare-llama.sh" ]]; then
    printf '%s\n' "${metadata_root}"
    exit 0
  fi
fi

if [[ ! -d "${checkout_root}" ]]; then
  echo "mesh-llm checkout root does not exist after cargo fetch: ${checkout_root}" >&2
  exit 1
fi

while IFS= read -r candidate; do
  if [[ ! -f "${candidate}/scripts/prepare-llama.sh" ]]; then
    continue
  fi
  actual_rev="$(git -C "${candidate}" rev-parse HEAD 2>/dev/null || true)"
  if [[ "${actual_rev}" == "${expected_rev}" ]]; then
    printf '%s\n' "${candidate}"
    exit 0
  fi
done < <(find "${checkout_root}" -mindepth 2 -maxdepth 2 -type d -print)

echo "mesh-llm checkout for ${expected_rev} not found after cargo fetch" >&2
exit 1
