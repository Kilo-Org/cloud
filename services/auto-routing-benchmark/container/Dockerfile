# Decider-benchmark runner container.
#
# Runs one pinned `kilo` CLI (@kilocode/cli) case at a time. `wrangler deploy` builds and
# pushes this image automatically.
#
# The base image digest and KILO_CLI_VERSION are pinned so that a deploy which changes
# nothing here measures the same CLI. Bumping KILO_CLI_VERSION changes what the benchmark
# measures: read "CLI under test" in the README first.
FROM node:22-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
ARG KILO_CLI_VERSION=7.8.27
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git python3 g++ make \
  && update-ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g "@kilocode/cli@${KILO_CLI_VERSION}"
WORKDIR /app
COPY server.mjs ./
EXPOSE 3000
CMD ["node", "server.mjs"]
