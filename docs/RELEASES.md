# Releases

This project uses semantic versioning and tag-driven Docker image releases.

## Release Flow

1. Ensure `main` is green:

```bash
npm run release:plan
npm run check
npm run gh:dependabot
```

`npm run release:plan` is the recommended dry-run validator. It checks branch state, version/tag consistency, changelog presence, and open Dependabot queue before publishing.

If local artifact folders exist from prior packaging runs, use:

```bash
npm run release:plan -- --clean-artifacts
```

2. Bump version in `package.json` and create git tag:

```bash
# patch/minor/major as needed
npm version patch
```

This creates a commit and tag like `v0.1.3`.

3. Push commit + tag:

```bash
git push origin main --follow-tags
```

4. GitHub Actions publish release artifacts:

- `ghcr.io/jjhickman/garbanzo:vX.Y.Z`
- `ghcr.io/jjhickman/garbanzo:X.Y.Z`
- `ghcr.io/jjhickman/garbanzo:latest` (only for non-prerelease tags)
- optional Docker Hub images (when configured):
  - `<dockerhub-image>:vX.Y.Z`
  - `<dockerhub-image>:X.Y.Z`
  - `<dockerhub-image>:latest` (only for non-prerelease tags)
- native bundles attached to release:
  - `garbanzo-linux-x64.tar.gz`
  - `garbanzo-linux-arm64.tar.gz`
  - `garbanzo-macos-arm64.tar.gz`
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
APP_VERSION=0.1.3 docker compose pull garbanzo
APP_VERSION=0.1.3 docker compose up -d
```

Recommended (production) — use `docker-compose.prod.yml` to disable local builds:

```bash
APP_VERSION=0.1.3 docker compose -f docker-compose.yml -f docker-compose.prod.yml pull garbanzo
APP_VERSION=0.1.3 docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

`docker-compose.prod.yml` also forces pulls so you don't accidentally run a stale cached image.

## Manual Workflow Dispatch

You can run workflows manually from Actions:

- `Release Docker Image` with explicit version input (e.g., `v0.2.0`)
  - optional `git_ref` input to build an existing tag/commit
- `Release Native Binaries` with:
  - optional `git_ref` input (tag/branch/SHA) for build source
  - `release_tag` input (required for manual dispatch) to select which GitHub Release receives assets

This is useful for rerunning release asset generation without creating a new tag.

## Optional Docker Hub Publishing

`Release Docker Image` can push to Docker Hub in addition to GHCR.

Set these repo settings in GitHub (`Settings` -> `Secrets and variables` -> `Actions`):

- Variable `DOCKERHUB_IMAGE` (example: `yourdockerhubuser/garbanzo`)
- Variable `DOCKERHUB_USERNAME` (Docker Hub username, not email)
- Secret `DOCKERHUB_TOKEN` (Docker Hub access token)

If any of these are missing, Docker Hub publish is skipped and GHCR publish still runs.

When Docker Hub publishing is enabled, the workflow also syncs the Docker Hub repository overview from `docs/DOCKERHUB_OVERVIEW.md`.
