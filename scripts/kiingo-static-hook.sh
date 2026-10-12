#!/usr/bin/env bash
set -euo pipefail

# The fork follows Ross's post-deployment Spot policy. Upstream keeps its own
# existing hook behavior; no environment switch bypasses the installed hooks.
repository_origin="$(git remote get-url origin | tr '[:upper:]' '[:lower:]')"
mode="${1:?expected hook mode}"
if [[ ! "${repository_origin}" =~ ^(https://github\.com/kiingo/buzz(\.git)?/?|git@github\.com:kiingo/buzz(\.git)?)$ ]]; then
  case "${mode}" in
    rust-format) exec just fmt ;;
    rust) exec just test-unit ;;
    desktop) just desktop-check; just desktop-typecheck; exec just desktop-test ;;
    tauri) just desktop-tauri-clippy; exec just desktop-tauri-test ;;
    mobile) just mobile-check; exec just mobile-test ;;
    file-size) exec just file-size-check ;;
    *) echo 'unknown hook mode' >&2; exit 2 ;;
  esac
fi

case "${mode}" in
  rust-format|rust)
    if [[ "${mode}" == 'rust-format' ]]; then
      paths="$(git diff --cached --name-only --diff-filter=ACMR)"
    else
      paths="$(scripts/kiingo-hook-files.sh)"
    fi
    # The hook also runs on native Macs whose system Python predates tomllib.
    # Cargo package names use this deliberately narrow literal form; fail on an
    # unsupported/missing manifest instead of silently broadening source scope.
    package_names="$(printf '%s\n' "${paths}" | python3 -c '
import sys, pathlib, re
packages=set()
for path in sys.stdin.read().splitlines():
    pieces=path.split("/")
    if len(pieces)>2 and pieces[0]=="crates":
        manifest=pathlib.Path("crates")/pieces[1]/"Cargo.toml"
        text=manifest.read_text()
        section=re.search(r"(?ms)^\[package\]\s*\n(.*?)(?=^\[|\Z)",text)
        match=re.search(r"(?m)^name\s*=\s*\"([A-Za-z0-9_-]+)\"\s*(?:#.*)?$",section.group(1)) if section else None
        if not match: raise SystemExit("unsupported Cargo package name")
        packages.add(match.group(1))
for package in sorted(packages): print(package)
')"
    packages=()
    while IFS= read -r package; do
      [[ -z "${package}" ]] || packages+=(--package "${package}")
    done <<< "${package_names}"
    format_packages=("${packages[@]}")
    if ((${#packages[@]} == 0)); then
      format_packages=(--all)
      packages=(--workspace)
    fi
    if [[ "${mode}" == 'rust-format' ]]; then
      exec cargo fmt "${format_packages[@]}"
    fi
    cargo fmt "${format_packages[@]}" -- --check
    exec cargo clippy --locked "${packages[@]}" --lib --bins -- -D warnings
    ;;
  desktop) just desktop-check; exec just desktop-typecheck ;;
  tauri) exec just desktop-tauri-clippy ;;
  mobile) exec just mobile-check ;;
  file-size)
    scripts/kiingo-hook-files.sh >/dev/null
    export CHECK_FILE_SIZES_BASE="$(git merge-base origin/main HEAD)"
    node desktop/scripts/check-file-sizes.mjs
    node web/scripts/check-file-sizes.mjs
    exec node mobile/scripts/check-file-sizes.mjs
    ;;
  *) echo 'unknown hook mode' >&2; exit 2 ;;
esac
