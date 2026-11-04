# Sail print relay: a small always-on service on the outlet LAN (arm64 and amd64).
# Build: docker buildx build --platform linux/arm64,linux/amd64 -f packages/relay/Dockerfile -t <registry>/sail-relay:<tag> .
FROM node:22-slim AS build
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@10.17.1 --activate
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/relay/package.json packages/relay/
RUN pnpm install --frozen-lockfile --filter @sail/relay... --ignore-scripts
COPY packages/relay packages/relay
RUN pnpm --filter @sail/relay build

FROM node:22-slim
ENV NODE_ENV=production SAIL_RELAY_STATE_FILE=/data/relay.json
WORKDIR /app
COPY --from=build /repo/packages/relay/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
CMD ["node", "dist/index.js"]
