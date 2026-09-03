FROM docker.io/oven/bun:1.3.14-slim@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04

ENV NODE_ENV=production

USER 0:0
COPY --chown=0:0 --chmod=0444 onprem/dist/provisioner.js /opt/kilo-onprem/provisioner.js
RUN chmod 0555 /opt/kilo-onprem

USER 1000:1000
WORKDIR /opt/kilo-onprem
ENTRYPOINT ["/usr/local/bin/bun", "/opt/kilo-onprem/provisioner.js"]
CMD ["--config", "/etc/kilo-onprem/config/config.json"]
