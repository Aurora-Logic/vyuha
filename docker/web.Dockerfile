# The web image: the static Vite build served by Caddy, which also owns TLS
# and the reverse proxy to the API (technical design §17). Build context is
# the repository root; docker-compose.prod.yml owns the arguments.

FROM node:22-bookworm-slim AS build
RUN npm install -g pnpm@10.33.2
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/config/package.json packages/config/
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @vyuha/web...

COPY packages ./packages
COPY apps/web ./apps/web

# Baked in at build time -- a Vite build inlines import.meta.env. The default
# is the same-origin path, which is correct for this topology: Caddy serves
# the app and proxies /api/* to the API, so the browser never needs another
# origin and the service worker's "never cache /api/" rule keeps applying.
ARG VITE_API_BASE_URL=/api/v1
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}

# What is running. Defaulted rather than required so a local `docker build`
# still works; the release passes the real values (see docs/RELEASE.md) and
# an unstamped build honestly labels itself a development one.
ARG GIT_COMMIT=dev
ARG BUILT_AT=""
ENV GIT_COMMIT=${GIT_COMMIT}
ENV BUILT_AT=${BUILT_AT}

RUN pnpm --filter @vyuha/shared build && pnpm --filter @vyuha/web build

FROM caddy:2-alpine
COPY docker/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/dist /srv
