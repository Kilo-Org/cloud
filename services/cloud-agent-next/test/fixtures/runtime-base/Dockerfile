# Minimal runtime-base fixture for the process fault matrix and runtime-upgrade E2E.
# It is not `Dockerfile.containers` and not a wrangler image. It has the pinned Bun
# runtime and no Kilo bytes: the runtime is delivered at launch by the installer
# embedded in `runtimeLaunchCommand()`.
#
# The Bun version is a required build argument supplied by ensureFixtureImage from
# RUNTIME_DISTRIBUTION.bun; there is no private default here.
ARG BUN_VERSION
FROM oven/bun:${BUN_VERSION}

# No curl: the installer downloads with Bun's fetch. A local HTTPS intercept CA is
# supplied through NODE_EXTRA_CA_CERTS. Mount a volume at the reserved root to model
# a persisted filesystem across runtime upgrades.
RUN mkdir -p /opt/kilo-cloud/cli /opt/kilo-cloud/control /opt/kilo-cloud/releases /usr/local/bin

CMD ["/bin/sh", "-c", "echo 'supply runtimeLaunchCommand(); see test/e2e/runtime-upgrade.ts' >&2; exit 70"]
