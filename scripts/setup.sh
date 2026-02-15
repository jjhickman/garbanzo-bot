#!/bin/bash
# Wrapper for the interactive setup wizard.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

node scripts/setup.mjs
