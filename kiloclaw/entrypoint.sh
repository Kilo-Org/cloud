#!/bin/sh
# Entrypoint shim: fix volume ownership then drop to non-root user.
# Runs every boot — idempotent. First boot after migration fixes root→openclaw
# ownership; subsequent boots are effectively a no-op.
if [ "$(stat -c '%U' /root)" != "openclaw" ]; then
  chown -R openclaw:openclaw /root
fi
exec gosu openclaw /usr/local/bin/start-openclaw.sh
