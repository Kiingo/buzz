#!/usr/bin/env bash
set -euo pipefail

# This is the existing source owner, refreshed before selecting hook scope.
# Never turn a failed fresh read into validation against a stale main ref.
repository_origin="$(git remote get-url origin | tr '[:upper:]' '[:lower:]')"
if [[ "${repository_origin}" =~ ^(https://github\.com/kiingo/buzz(\.git)?/?|git@github\.com:kiingo/buzz(\.git)?)$ ]]; then
  git fetch --quiet --no-tags origin refs/heads/main:refs/remotes/origin/main
fi
git diff --name-only origin/main...HEAD
