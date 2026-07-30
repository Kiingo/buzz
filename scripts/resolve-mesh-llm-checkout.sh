#!/usr/bin/env bash
set -euo pipefail

expected_rev="${1:?expected mesh-llm revision}"
checkout_root="${CARGO_HOME:-$HOME/.cargo}/git/checkouts"

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
