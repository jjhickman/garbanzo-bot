#!/bin/bash
set -euo pipefail

HOST="github.com"
OWNER_ACCOUNT="${GH_OWNER_ACCOUNT:-jjhickman}"
AUTHOR_ACCOUNT="${GH_AUTHOR_ACCOUNT:-garbanzo-dev}"

command_name="${1:-status}"

usage() {
  cat <<EOF
Usage: bash scripts/gh-workflow.sh <command>

Commands:
  status          Show authenticated accounts
  whoami          Print active GitHub login
  dependabot      List open Dependabot PRs targeting main
  ensure          Verify owner/author accounts are authenticated
  switch-owner    Switch active account to owner (${OWNER_ACCOUNT})
  switch-author   Switch active account to author (${AUTHOR_ACCOUNT})
  login-owner     Login flow, then switch to owner account
  login-author    Login flow, then switch to author account

Environment overrides:
  GH_OWNER_ACCOUNT   (default: ${OWNER_ACCOUNT})
  GH_AUTHOR_ACCOUNT  (default: ${AUTHOR_ACCOUNT})
EOF
}

case "$command_name" in
  status)
    gh auth status
    ;;

  whoami)
    gh api user --jq '.login'
    ;;

  ensure)
    status_output="$(gh auth status 2>/dev/null || true)"
    if [[ "$status_output" != *"$OWNER_ACCOUNT"* ]]; then
      echo "Missing authenticated owner account: $OWNER_ACCOUNT"
      echo "Run: bash scripts/gh-workflow.sh login-owner"
      exit 1
    fi
    if [[ "$status_output" != *"$AUTHOR_ACCOUNT"* ]]; then
      echo "Missing authenticated author account: $AUTHOR_ACCOUNT"
      echo "Run: bash scripts/gh-workflow.sh login-author"
      exit 1
    fi
    echo "Both accounts are authenticated: $OWNER_ACCOUNT, $AUTHOR_ACCOUNT"
    ;;

  dependabot)
    gh pr list --state open --base main --search "author:app/dependabot" --json number,title,url --jq '.[] | "#\(.number)\t\(.title)\t\(.url)"'
    ;;

  switch-owner)
    gh auth switch --hostname "$HOST" --user "$OWNER_ACCOUNT"
    gh api user --jq '.login'
    ;;

  switch-author)
    gh auth switch --hostname "$HOST" --user "$AUTHOR_ACCOUNT"
    gh api user --jq '.login'
    ;;

  login-owner)
    gh auth login --hostname "$HOST" --git-protocol https --web
    gh auth switch --hostname "$HOST" --user "$OWNER_ACCOUNT"
    gh api user --jq '.login'
    ;;

  login-author)
    gh auth login --hostname "$HOST" --git-protocol https --web
    gh auth switch --hostname "$HOST" --user "$AUTHOR_ACCOUNT"
    gh api user --jq '.login'
    ;;

  help|-h|--help)
    usage
    ;;

  *)
    echo "Unknown command: $command_name" >&2
    usage
    exit 1
    ;;
esac
