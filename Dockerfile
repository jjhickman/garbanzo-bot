# ─── Stage 1: Build ────────────────────────────────────────────────────────────
# Install all dependencies (including devDependencies) and compile TypeScript.
# better-sqlite3 requires native compilation, so we need build tools here.

ARG APP_VERSION=0.0.0

FROM node:25-alpine AS builder

# Build tools for native addons (better-sqlite3)
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy dependency files first (layer caching — these change less often than source).
# The Matrix native crypto dependency is overridden to a local no-native stub
# because E2EE is intentionally unsupported and linux/arm64-musl has no
# upstream prebuild.
COPY package.json package-lock.json ./
COPY stubs/ ./stubs/

# Reproducible install with all dependencies (need devDeps for tsc)
RUN npm ci

# Copy source code and config
COPY tsconfig.json ./
COPY src/ ./src/
COPY config/ ./config/

# Compile TypeScript
RUN npm run build

# Remove devDependencies, keep only production deps
RUN npm prune --omit=dev && rm -rf node_modules/typescript


# ─── Stage 2: Production ──────────────────────────────────────────────────────
# Minimal runtime image. No build tools, no devDeps, no source code.

FROM node:25-alpine

ARG APP_VERSION=0.0.0
LABEL org.opencontainers.image.title="Garbanzo"
LABEL org.opencontainers.image.version="$APP_VERSION"
LABEL org.opencontainers.image.licenses="https://prosperitylicense.com/versions/3.0.0.html"

# dumb-init: proper PID 1 signal handling (SIGTERM → graceful shutdown)
# ffmpeg: video frame extraction for Claude Vision
# yt-dlp: YouTube audio download for transcription (installed via pip — the Alpine
#   edge/community package no longer resolves against the stable base and broke the build)
# curl: health check probe
RUN apk add --no-cache dumb-init ffmpeg curl python3 py3-pip \
    && pip install --no-cache-dir --break-system-packages yt-dlp

WORKDIR /app

# Create non-root user
RUN addgroup -S garbanzo && adduser -S garbanzo -G garbanzo

# Copy production artifacts from builder
COPY --from=builder --chown=garbanzo:garbanzo /app/dist ./dist
COPY --from=builder --chown=garbanzo:garbanzo /app/node_modules ./node_modules
# The Matrix crypto stub is a file: dependency, so npm installs it as a SYMLINK
# (node_modules/@matrix-org/matrix-sdk-crypto-nodejs -> ../../stubs/...). The
# symlink target must exist in this runtime stage too, or matrix-bot-sdk (which
# requires the crypto module at top-level import) fails with "Cannot find
# module" and the Matrix runtime crash-loops. Only Matrix imports the SDK, so a
# missing stubs/ here is invisible to Discord/WhatsApp and to CI (which never
# boots the Matrix platform).
COPY --from=builder --chown=garbanzo:garbanzo /app/stubs ./stubs
COPY --from=builder --chown=garbanzo:garbanzo /app/package.json ./

# Copy runtime config (groups.json is needed at runtime)
COPY --chown=garbanzo:garbanzo config/ ./config/

# Copy persona docs (loaded at runtime by persona.ts)
COPY --chown=garbanzo:garbanzo docs/PERSONA.md ./docs/PERSONA.md
COPY --chown=garbanzo:garbanzo docs/personas/ ./docs/personas/

# Copy D&D PDF template (needed by character feature)
COPY --chown=garbanzo:garbanzo templates/ ./templates/

# Copy Postgres schema SQL used for runtime DB bootstrap/validation
COPY --from=builder --chown=garbanzo:garbanzo /app/src/utils/postgres-schema.sql ./src/utils/postgres-schema.sql

# Create directories for runtime data (will be mounted as volumes)
RUN mkdir -p data data/backups data/voices baileys_auth \
    && chown -R garbanzo:garbanzo data baileys_auth

# Health check — uses the bot's built-in health endpoint
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=15s \
    CMD curl -f http://localhost:3001/health || exit 1

# Expose health check port (documentation only — publish with -p or compose ports:)
EXPOSE 3001

# Runtime environment defaults (override with .env file or docker-compose env_file)
ENV NODE_ENV=production
ENV LOG_LEVEL=info
ENV GARBANZO_VERSION=$APP_VERSION
# Container mode is explicit, not inferred: mutable state (data/, config/,
# baileys_auth/, .env) resolves under /app, matching the volumes below.
ENV GARBANZO_HOME=/app

# Volumes for persistent data
# - data/: SQLite database, backups, voice models
# - baileys_auth/: WhatsApp session (must persist across container restarts)
VOLUME ["/app/data", "/app/baileys_auth"]

# Switch to non-root user
USER garbanzo

# Use dumb-init as PID 1 for proper signal forwarding
CMD ["dumb-init", "node", "dist/index.js"]
