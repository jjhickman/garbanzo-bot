# Releases

This project uses semantic versioning and tag-driven Docker image releases.

## Release Flow

1. Ensure `main` is green:

```bash
npm run check
npm run gh:dependabot
```

2. Bump version in `package.json` and create git tag:

```bash
# patch/minor/major as needed
npm version patch
```

This creates a commit and tag like `v0.1.1`.

3. Push commit + tag:

```bash
git push origin main --follow-tags
```

4. GitHub Actions publish release artifacts:

- `ghcr.io/jjhickman/garbanzo:vX.Y.Z`
- `ghcr.io/jjhickman/garbanzo:X.Y.Z`
- `ghcr.io/jjhickman/garbanzo:latest` (only for non-prerelease tags)
- native bundles attached to release:
  - `garbanzo-linux-x64.tar.gz`
  - `garbanzo-macos.tar.gz`
  - `garbanzo-windows-x64.zip`

5. Open a release checklist issue from `.github/ISSUE_TEMPLATE/release-checklist.yml` and track deploy verification.

## Version Injection Behavior

- Docker build uses `APP_VERSION` build arg.
- Runtime exposes `GARBANZO_VERSION` env var.
- `!release` message header auto-includes version from:
  1. `GARBANZO_VERSION`, else
  2. `package.json` version.
- `!release changelog` broadcasts the latest changelog section with version header.

## Native Binary Strategy

We use `@yao-pkg/pkg` in CI to generate host-native binaries on Linux, macOS, and Windows runners.

- Workflow: `.github/workflows/release-native-binaries.yml`
- Trigger: tag push (`v*`)
- Output: compressed portable bundle with executable + runtime config/template files

Notes:

- Native binary artifacts are intended for convenience/testing and lightweight deployments.
- Docker remains the default and best-supported production deployment path.

## Deploying a Released Image

Set `APP_VERSION` in your `.env` before deploy, then pull and restart:

```bash
APP_VERSION=0.1.1 docker compose pull garbanzo
APP_VERSION=0.1.1 docker compose up -d
```

## Manual Workflow Dispatch

You can run `Release Docker Image` manually from Actions with an explicit version input (e.g., `v0.2.0`).
