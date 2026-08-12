ARG VENLINKS_NODE_IMAGE=node:22-bookworm-slim
ARG VENLINKS_NPM_REGISTRY=https://registry.npmjs.org
ARG VENLINKS_DEBIAN_MIRROR=http://deb.debian.org/debian
ARG VENLINKS_DEBIAN_SECURITY_MIRROR=http://deb.debian.org/debian-security

FROM ${VENLINKS_NODE_IMAGE} AS web-build

WORKDIR /app/web
ARG BUILD_NODE_OPTIONS=--max-old-space-size=1536
ARG NEXT_BUILD_CPUS=1
ARG PNPM_VERSION=11.7.0
ARG VENLINKS_NPM_REGISTRY
ENV NEXT_TELEMETRY_DISABLED=1
ENV CI=1
ENV NODE_OPTIONS=${BUILD_NODE_OPTIONS}
ENV NEXT_BUILD_CPUS=${NEXT_BUILD_CPUS}
ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}

RUN npm install --global pnpm@${PNPM_VERSION} --registry=${VENLINKS_NPM_REGISTRY} \
    && pnpm config set registry ${VENLINKS_NPM_REGISTRY}

COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./
RUN --mount=type=cache,target=/pnpm/store pnpm install --frozen-lockfile --store-dir=/pnpm/store --registry=${VENLINKS_NPM_REGISTRY}

COPY VERSION /app/VERSION
COPY CHANGELOG.md /app/CHANGELOG.md
COPY web ./
RUN --mount=type=cache,target=/app/web/.next/cache pnpm run typecheck && NEXT_SKIP_BUILD_TYPECHECK=1 pnpm run build
RUN set -eux; \
    mkdir -p /app/sharp-runtime/node_modules/.pnpm; \
    find node_modules/.pnpm -mindepth 1 -maxdepth 1 -type d -name '@img+sharp-*' -exec cp -a {} /app/sharp-runtime/node_modules/.pnpm/ \;; \
    test -n "$(find /app/sharp-runtime/node_modules/.pnpm -mindepth 1 -maxdepth 1 -type d -name '@img+sharp-linux-*' -print -quit)"; \
    test -n "$(find /app/sharp-runtime/node_modules/.pnpm -mindepth 1 -maxdepth 1 -type d -name '@img+sharp-libvips-linux-*' -print -quit)"

FROM ${VENLINKS_NODE_IMAGE}

WORKDIR /app
ARG VENLINKS_DEBIAN_MIRROR
ARG VENLINKS_DEBIAN_SECURITY_MIRROR
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV VENLINKS_DATA_DIR=/app/web/.data
ENV VENLINKS_INTERNAL_ORIGIN=http://127.0.0.1:3000
ENV NODE_OPTIONS=--max-old-space-size=384
ENV UV_THREADPOOL_SIZE=2

RUN set -eux; \
    find /etc/apt -type f \( -name '*.list' -o -name '*.sources' \) \
        -exec sed -i \
        -e "s|http://deb.debian.org/debian-security|${VENLINKS_DEBIAN_SECURITY_MIRROR}|g" \
        -e "s|http://deb.debian.org/debian|${VENLINKS_DEBIAN_MIRROR}|g" {} +; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates ffmpeg fonts-noto-cjk; \
    rm -rf /var/lib/apt/lists/*
RUN mkdir -p /app/web/scripts

COPY VERSION /app/VERSION
COPY CHANGELOG.md /app/CHANGELOG.md
COPY --from=web-build /app/web/public /app/web/public
COPY --from=web-build /app/web/.next/standalone /app/web
COPY --from=web-build /app/web/.next/static /app/web/.next/static
COPY --from=web-build /app/sharp-runtime/node_modules/.pnpm /app/web/node_modules/.pnpm
COPY web/scripts/reset-admin-password.mjs /app/web/scripts/reset-admin-password.mjs
COPY web/scripts/generation-runtime.mjs /app/web/scripts/generation-runtime.mjs
COPY web/scripts/generation-worker.mjs /app/web/scripts/generation-worker.mjs

RUN cd /app/web && node -e "require('sharp')"

EXPOSE 3000
CMD ["sh", "-c", "cd /app/web && PORT=3000 node server.js"]
