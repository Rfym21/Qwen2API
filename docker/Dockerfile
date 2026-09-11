# syntax=docker/dockerfile:1

ARG BUN_VERSION=1.3.14
ARG BINARY_SOURCE=build

FROM --platform=$BUILDPLATFORM oven/bun:${BUN_VERSION}-alpine AS base
WORKDIR /app

FROM base AS frontend-build
WORKDIR /app/public
COPY public/package.json public/bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile
COPY public/ ./
RUN bun run --bun build

FROM base AS production-dependencies
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --production

FROM base AS build
ARG TARGETARCH
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY src/ ./src/
COPY tools/build-binary.mjs tools/binary-entry.mjs tools/binary-frontend.mjs ./tools/
COPY --from=frontend-build /app/public/dist ./public/dist
RUN case "$TARGETARCH" in \
      amd64) bun_arch=x64 ;; \
      arm64) bun_arch=arm64 ;; \
      *) echo "Unsupported architecture: $TARGETARCH"; exit 1 ;; \
    esac && \
    bun --no-env-file tools/build-binary.mjs \
      --target "bun-linux-${bun_arch}-musl" --outfile /out/qwen2api

# CI selects this stage to package the same executable it just compiled.
FROM scratch AS prebuilt
ARG TARGETARCH
COPY pkg_dist/docker/${TARGETARCH}/qwen2api /out/qwen2api

FROM ${BINARY_SOURCE} AS selected-binary

FROM alpine:3.24 AS runtime
RUN apk add --no-cache ca-certificates libstdc++ \
    && mkdir -p /app/data /app/logs /app/caches
WORKDIR /app
ENV NODE_ENV=production \
    QWEN2API_RUNTIME_DIR=/app
COPY --from=selected-binary --chmod=0755 /out/qwen2api /usr/local/bin/qwen2api

EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/qwen2api"]
CMD []
