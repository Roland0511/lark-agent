FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.admin.json vitest.config.ts vite.config.ts ./
COPY scripts ./scripts
COPY src ./src
COPY admin ./admin
RUN pnpm build && pnpm prune --prod

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PATH=/app/node_modules/.bin:$PATH
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN groupadd --system agent && useradd --system --gid agent --home-dir /home/agent --create-home agent
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/admin-dist ./admin-dist
RUN mkdir -p /home/agent/.lark-cli /home/agent/.lark-agent/skillhub-cache \
  && chown -R agent:agent /app /home/agent
USER agent
ENV HOME=/home/agent
EXPOSE 3000
CMD ["sh", "-c", "node dist/db/migrate.js && exec node dist/control-plane/main.js"]
