#!/bin/sh
# Refuse a commit whose text breaks the language rules.
#
# Install it once, from the root of the repository:
#
#   ln -sf ../../scripts/pre-commit.sh .git/hooks/pre-commit
#
# Git tracks no hook, so this file is the copy that a clone carries and the
# link above is the copy that git runs. A person who never installs the link
# still gets the same check from `npm test`.
#
# This exists because the person, not the script, was the hole. The scanner
# reported findings and a commit went through twice anyway. The first time the
# scanner exited zero. The second time a chain used `;` where it needed `&&`.
# Both times the answer was a resolution to take more care, and that resolution
# is the thing that failed already.
#
# Only the language scan runs here. It is fast, and it catches what slips past
# somebody who concentrates on something else. A failed build is loud on its
# own, and a slow hook is one that people turn off.
#
# You can bypass this with `git commit --no-verify`. That is deliberate. A gate
# that nobody can open is worse than one that asks you to say so out loud.
ROOT=$(git rev-parse --show-toplevel) || exit 1

# Only the staged paths. Two people share this checkout, and a scan of the
# whole tree refused a commit over a file that somebody else had half written.
# Somebody bypassed the gate twice for that reason, which equals no gate at
# all. A
# file that nobody staged is caught the moment its owner stages it, and `npm
# test` reads everything regardless.
STAGED=$(git diff --cached --name-only --diff-filter=ACM)
if [ -z "$STAGED" ]; then
  exit 0
fi

# The npm script holds the path to the scan. This hook holds no second copy of
# it, because the two copies drift and the stale one is the one that runs.
# shellcheck disable=SC2086
(cd "$ROOT" && npm run --silent check-language -- $STAGED) || {
  echo ''
  echo 'pre-commit: the language rules refused this commit.'
  echo 'Fix the findings above, or run `git commit --no-verify` and be able to say why.'
  exit 1
}
