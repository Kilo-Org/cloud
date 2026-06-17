# Decider-benchmark runner container.
#
# Runs the stable `kilo` CLI (@kilocode/cli, dist-tag `latest`) for one decider
# case at a time. `wrangler deploy` builds and pushes this image automatically.
#
# NOTE: `@kilocode/cli@latest` is resolved at IMAGE BUILD time (i.e. at deploy
# time), so each deploy pins whatever version was `latest` then. Re-deploy to
# pick up a newer stable CLI.
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git python3 g++ make \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g @kilocode/cli@latest
WORKDIR /app
COPY server.mjs ./
EXPOSE 3000
CMD ["node", "server.mjs"]
