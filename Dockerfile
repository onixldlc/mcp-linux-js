# syntax=docker/dockerfile:1.7

FROM oven/bun:1.1-alpine AS builder
WORKDIR /build
COPY package.json tsconfig.json ./
COPY src ./src
RUN bun install --frozen-lockfile 2>/dev/null || bun install
RUN mkdir -p dist && \
    bun build src/index.ts --compile --target=bun-linux-x64 --outfile dist/mcp-shell-bun

FROM debian:bookworm-slim
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates wget && \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder /build/dist/mcp-shell-bun /usr/local/bin/mcp-shell-bun
RUN chmod +x /usr/local/bin/mcp-shell-bun

ENV TRANSPORT=http \
    HOST=0.0.0.0 \
    PORT=3000
# SHELL_MCP_TOKEN required at runtime for HTTP
# ALLOW_COMMANDS optional; unset = unrestricted lab mode

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1

ENTRYPOINT ["/usr/local/bin/mcp-shell-bun"]
