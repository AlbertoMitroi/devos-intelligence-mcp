# devos-intelligence-mcp image: deps, test and runtime stages (decision M2, M4).
# Same pinned base as devos-angular-intelligence: Node.js 24 LTS runs the TypeScript sources directly (type stripping)
# and node:sqlite reads index.sqlite. The runtime stage has no npm dependencies at all.
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c

FROM ${NODE_IMAGE} AS base
ENV DEBIAN_FRONTEND=noninteractive
# git reads the agent's working repository (HEAD, remote, ancestors, changed files); pinned to the Debian 12 package.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git=1:2.39.5-0+deb12u3 ca-certificates=20250419~deb12u2 \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system --add safe.directory '*'
# The safe.directory entry above: the workspace is a read-only bind mount owned by another user, and the server only
# runs read-only git commands in it.
ENV NODE_OPTIONS=--disable-warning=ExperimentalWarning

FROM base AS deps
WORKDIR /opt/devos-intelligence-mcp
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

# Type check and unit tests; a failing test fails the build. Integration tests run from scripts/verify.sh.
FROM deps AS test
COPY . .
RUN npx tsc -p tsconfig.json \
 && node --test --test-reporter=spec "tests/unit/*.test.ts"

FROM base AS runtime
ENV DEVOS_MCP_GENERATIONS=/generations \
    DEVOS_MCP_CACHE=/cache \
    HOME=/tmp
WORKDIR /opt/devos-intelligence-mcp
COPY package.json ./
COPY src ./src
RUN mkdir -p /generations /cache && chmod 1777 /cache
USER node
ENTRYPOINT ["node", "/opt/devos-intelligence-mcp/src/cli.ts"]
CMD ["serve"]
