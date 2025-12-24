# syntax=docker/dockerfile:1

FROM node:20-slim AS builder

WORKDIR /app

# Enable pnpm via Corepack (ships with Node.js)
RUN corepack enable

COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm -r build

# Prune devDependencies for runtime
RUN pnpm install --prod --frozen-lockfile

FROM node:20-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

RUN useradd -m -u 10001 datatrust \
  && mkdir -p /config \
  && chown -R datatrust:datatrust /config

COPY --from=builder --chown=datatrust:datatrust /app /app

USER datatrust

EXPOSE 3333

# Provide config via bind-mount or Kubernetes ConfigMap/Secret.
CMD ["node", "packages/mcp-server/dist/cli.js", "--config", "/config/config.json"]

