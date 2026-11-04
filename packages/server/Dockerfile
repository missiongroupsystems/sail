# One image, role flags: node dist/index.js --role=app|worker|mcp
FROM node:22-slim AS build
ARG SAIL_VERSION=dev
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@10.17.1 --activate
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
RUN pnpm install --frozen-lockfile --filter @sail/server... --ignore-scripts
COPY packages/shared packages/shared
COPY packages/server packages/server
RUN pnpm --filter @sail/server build

FROM node:22-slim AS runtime
ARG SAIL_VERSION=dev
ENV NODE_ENV=production SAIL_VERSION=${SAIL_VERSION} PORT=8080
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.17.1 --activate
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
RUN pnpm install --frozen-lockfile --prod --filter @sail/server... --ignore-scripts && pnpm store prune
COPY --from=build /repo/packages/server/dist packages/server/dist
COPY packages/server/drizzle packages/server/drizzle
WORKDIR /app/packages/server
USER node
EXPOSE 8080
CMD ["node", "dist/index.js", "--role=app"]
