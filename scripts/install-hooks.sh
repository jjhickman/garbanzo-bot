#!/usr/bin/env bash
# Install git hooks for the garbanzo-bot project.
# Run once after cloning: npm run setup:hooks
set -euo pipefail

HOOKS_DIR="$(git rev-parse --show-toplevel)/.git/hooks"

# Pre-commit: secret + PII scanning via gitleaks
cat > "$HOOKS_DIR/pre-commit" << 'HOOK'
#!/usr/bin/env bash
# Pre-commit hook: block secrets and PII from being committed.
# Runs gitleaks on staged files only for fast feedback.

set -euo pipefail

if ! command -v gitleaks &>/dev/null; then
  echo "⚠  gitleaks not installed — skipping secret scan"
  echo "   Install: https://github.com/gitleaks/gitleaks#installing"
  exit 0
fi

echo "🔍 Scanning staged changes for secrets and PII..."
gitleaks git --staged --config .gitleaks.toml --verbose

exit_code=$?
if [ $exit_code -ne 0 ]; then
  echo ""
  echo "❌ Commit blocked: gitleaks found secrets or PII in staged files."
  echo "   Fix the findings above, then try again."
  echo "   If this is a false positive, add an allowlist entry in .gitleaks.toml"
  exit 1
fi

echo "✅ No secrets or PII found in staged changes."
HOOK

chmod +x "$HOOKS_DIR/pre-commit"
echo "✅ Git hooks installed successfully."
