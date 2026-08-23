# The API image (technical design §17). Build context is the repository root:
#   docker build -f docker/api.Dockerfile .
# though in practice docker-compose.prod.yml owns both of those arguments.
#
# node:22 rather than 24: the workspace's engines field promises >=22, and the
# production image should sit on the floor of that promise, not the ceiling --
# a runtime-only feature of a newer Node would otherwise creep in unnoticed.
# pnpm is installed by exact version rather than through corepack because the
# image build must not depend on corepack's signature-key service being up.

FROM node:22-bookworm-slim AS base
RUN npm install -g pnpm@10.33.2

FROM base AS build
WORKDIR /app
# pnpm's dev-to-prod reinstall purges node_modules and asks first; there is
# no TTY in a build, so the answer has to be pre-given.
ENV CI=true

# Manifests first, so the dependency layer survives source edits.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/config/package.json packages/config/
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
# No BuildKit-only syntax anywhere in this file: the build must succeed on a
# plain `docker compose build` whether or not the host has buildx.
RUN pnpm install --frozen-lockfile --filter @vyuha/api...

COPY packages ./packages
COPY apps/api ./apps/api
RUN pnpm --filter @vyuha/shared build && pnpm --filter @vyuha/api build

# Re-resolve with --prod: devDependencies (nest CLI, tsx, vitest, types)
# leave node_modules, production dependencies and the workspace links stay.
RUN pnpm install --frozen-lockfile --prod --filter @vyuha/api...

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production

# The build these bytes came from, readable at /api/v1/health. Defaulted so a
# local build works; the release passes the real values.
ARG APP_VERSION=0.0.0
ARG GIT_COMMIT=unknown
ARG BUILT_AT=""
ENV APP_VERSION=${APP_VERSION}
ENV GIT_COMMIT=${GIT_COMMIT}
ENV BUILT_AT=${BUILT_AT}
WORKDIR /app/apps/api

# The pnpm layout is symlinks into the root .pnpm store and a workspace link
# to packages/shared, so the copied paths must keep their relative positions.
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/apps/api/node_modules /app/apps/api/node_modules
COPY --from=build /app/apps/api/package.json /app/apps/api/package.json
COPY --from=build /app/apps/api/dist /app/apps/api/dist
# Migrations ship in the image so deploy is `compose run api node
# dist/platform/db/migrate.js` -- no checkout needed on the host.
COPY --from=build /app/apps/api/drizzle /app/apps/api/drizzle
COPY --from=build /app/packages/shared/package.json /app/packages/shared/package.json
COPY --from=build /app/packages/shared/dist /app/packages/shared/dist
COPY --from=build /app/packages/shared/node_modules /app/packages/shared/node_modules

USER node
EXPOSE 3000

# The liveness route touches no dependency, so a red health here means the
# process itself is wedged, not that Postgres blinked (that is /ready's job).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT ?? 3000}/api/v1/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", "dist/main.js"]
