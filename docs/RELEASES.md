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

2. Bump version in `package.json` and merge via PR:

```bash
# patch/minor/major as needed
# (use --no-git-tag-version so the tag is created on main after merge)
npm version patch --no-git-tag-version

git push -u origin <your-branch>
# open PR, ensure checks pass, merge into main
```

3. Tag `main` and push the tag:

```bash
git checkout main
git pull --ff-only

# create annotated tag on the merge commit
git tag -a vX.Y.Z -m "vX.Y.Z"

# push tag only (main is protected)
git push origin vX.Y.Z
```

4. GitHub Actions publish release artifacts:

Notes:

- The GitHub Release page is created/updated by the release workflows (not by a manual `gh release create`). It may take a few minutes after pushing the tag for the Release to appear and for assets to attach.
- Release notes are generated automatically when a Release is created by CI.

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

5. Create a release checklist issue and track deploy verification:

```bash
npm run release:checklist -- --version=X.Y.Z
```

6. Deploy and verify in one command (optional helper):

```bash
npm run release:deploy:verify -- --version=X.Y.Z --rollback-version=W.Y.Z
```

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
APP_VERSION=0.1.6 docker compose pull garbanzo
APP_VERSION=0.1.6 docker compose up -d
```

Recommended (production) — use `docker-compose.prod.yml` to disable local builds:

```bash
APP_VERSION=0.1.6 docker compose -f docker-compose.yml -f docker-compose.prod.yml pull garbanzo
APP_VERSION=0.1.6 docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

`docker-compose.prod.yml` also forces pulls so you don't accidentally run a stale cached image.

Automated deploy+verify helper (same compose defaults, with optional rollback):

```bash
npm run release:deploy:verify -- --version=0.1.6 --rollback-version=0.1.5
```

## Rollback Playbook

If a deploy introduces problems, roll back to the last known-good release tag.

1. Identify the prior healthy version (example: `0.1.5`).
2. Redeploy with that version:

```bash
APP_VERSION=0.1.5 docker compose -f docker-compose.yml -f docker-compose.prod.yml pull garbanzo
APP_VERSION=0.1.5 docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

3. Verify health and readiness:

```bash
curl -fsS http://127.0.0.1:3001/health
curl -fsS http://127.0.0.1:3001/health/ready
```

4. Post rollback notes in the active release checklist issue (what failed, rollback version, follow-up PR/issue links).

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
