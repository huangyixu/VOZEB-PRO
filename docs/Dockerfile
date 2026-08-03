ARG VOZEB_PRO_NODE_IMAGE=node:22-bookworm-slim
ARG VOZEB_PRO_NPM_REGISTRY=https://registry.npmjs.org

FROM ${VOZEB_PRO_NODE_IMAGE} AS docs-build

WORKDIR /app
ARG VOZEB_PRO_NPM_REGISTRY
RUN npm install --global pnpm@11.9.0 --registry=${VOZEB_PRO_NPM_REGISTRY} \
    && pnpm config set registry ${VOZEB_PRO_NPM_REGISTRY}
COPY docs/package.json docs/pnpm-lock.yaml docs/pnpm-workspace.yaml ./
RUN --mount=type=cache,target=/pnpm/store pnpm config set store-dir /pnpm/store \
    && pnpm install --frozen-lockfile --ignore-scripts --registry=${VOZEB_PRO_NPM_REGISTRY}
COPY docs ./
COPY CHANGELOG.md /CHANGELOG.md
RUN pnpm run postinstall
RUN pnpm run build

FROM ${VOZEB_PRO_NODE_IMAGE}

WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
RUN groupadd --system --gid 1001 nodejs && useradd --system --uid 1001 --gid nodejs nextjs
COPY --from=docs-build --chown=nextjs:nodejs /app/public ./public
COPY --from=docs-build --chown=nextjs:nodejs /app/index.md ./index.md
COPY --from=docs-build --chown=nextjs:nodejs /app/content ./content
COPY --from=docs-build --chown=nextjs:nodejs /app/.source ./.source
COPY --from=docs-build --chown=nextjs:nodejs /app/source.config.ts ./source.config.ts
COPY --from=docs-build --chown=nextjs:nodejs /CHANGELOG.md /CHANGELOG.md
COPY --from=docs-build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=docs-build --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
