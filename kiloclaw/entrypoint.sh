#!/bin/sh
# Entrypoint shim: fix volume ownership then drop to non-root user.
# Runs every boot — idempotent. First boot after migration fixes root→openclaw
# ownership; subsequent boots are effectively a no-op.
chown -R openclaw:openclaw /root
exec gosu openclaw /usr/local/bin/start-openclaw.sh
