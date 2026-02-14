#!/bin/bash
# Garbanzo Bot — First-time setup
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

echo "🫘 Garbanzo Bot Setup"
echo "===================="
echo ""

# Check Node.js version
NODE_VERSION=$(node -v 2>/dev/null | sed 's/v//' | cut -d. -f1)
if [[ -z "$NODE_VERSION" ]] || [[ "$NODE_VERSION" -lt 20 ]]; then
  echo "❌ Node.js 20+ required (found: $(node -v 2>/dev/null || echo 'not installed'))"
  exit 1
fi
echo "✅ Node.js $(node -v)"

# Install dependencies
echo ""
echo "📦 Installing dependencies..."
npm install

# Check for .env
if [[ ! -f .env ]]; then
  echo ""
  echo "📝 Creating .env from template..."
  cp .env.example .env
  echo "⚠️  Edit .env and add your API keys before starting the bot"
  echo "   Required: ANTHROPIC_API_KEY or OPENROUTER_API_KEY"
fi

# Install pre-commit hook (gitleaks secret scanning)
echo ""
echo "🔒 Installing pre-commit hook (secret scanning)..."
if [[ -d .git ]]; then
  cp scripts/pre-commit .git/hooks/pre-commit
  chmod +x .git/hooks/pre-commit
  echo "✅ Pre-commit hook installed"
  if command -v gitleaks &>/dev/null; then
    echo "✅ gitleaks $(gitleaks version) detected"
  else
    echo "⚠️  gitleaks not installed — pre-commit hook will skip scanning"
    echo "   Install with: brew install gitleaks"
  fi
else
  echo "⚠️  Not a git repo — skipping hook installation"
fi

# Type check
echo ""
echo "🔍 Running type check..."
npm run typecheck && echo "✅ TypeScript OK" || echo "⚠️  TypeScript errors (run 'npm run typecheck' to see details)"

# Run tests
echo ""
echo "🧪 Running tests..."
npm test && echo "✅ Tests passed" || echo "⚠️  Test failures (run 'npm test' to see details)"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🫘 Setup complete!"
echo ""
echo "Next steps:"
echo "  1. Edit .env with your API keys"
echo "  2. Run: npm run dev"
echo "  3. Scan the QR code with WhatsApp"
echo "  4. Send '@garbanzo hello' in a group"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
