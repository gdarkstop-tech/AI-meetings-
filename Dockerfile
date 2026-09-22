# syntax=docker/dockerfile:1

# ---------------------------------------------------------------- build stage
FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/observability/package.json packages/observability/
COPY packages/pipeline/package.json packages/pipeline/
COPY packages/policy/package.json packages/policy/
COPY packages/providers/package.json packages/providers/
RUN npm ci

COPY . .
RUN npm run typecheck && npm run lint:boundaries && npm run build:web

# ---------------------------------------------------------------- runtime
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# ffmpeg-static ships its own binary; ca-certificates is needed for provider TLS.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/apps ./apps
COPY --from=build /app/packages ./packages
COPY --from=build /app/scripts ./scripts

# Run as an unprivileged user.
RUN useradd --system --uid 10001 --home /app alia && chown -R alia:alia /app
USER alia

EXPOSE 4000
ENTRYPOINT ["/usr/bin/tini", "--"]
# The API serves the built client; the worker runs from the same image with
# `command: npm run start:worker`.
CMD ["npm", "run", "start:api"]
