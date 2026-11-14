#!/bin/sh
# Test fixture: each container serves one role, chosen by the command argument.
set -eu

mkdir -p /run/sshd
ssh-keygen -A >/dev/null

case "${1:-password}" in
password)
  exec /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config.password
  ;;
two-factor)
  # The stock `sshd` PAM stack becomes the two-prompt one for this container.
  cp /etc/pam.d/two-factor /etc/pam.d/sshd
  exec /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config.twofactor
  ;;
silent)
  # Accepts TCP and never speaks SSH, so connect timeouts can be observed.
  exec socat TCP-LISTEN:2222,reuseaddr,fork EXEC:'/bin/sleep 300'
  ;;
http)
  # Answers every request with a fixed body, so a local forward can prove it
  # reached the server's network.
  exec socat TCP-LISTEN:8080,reuseaddr,fork EXEC:/usr/local/bin/http-response
  ;;
*)
  echo "unknown role: $1" >&2
  exit 1
  ;;
esac
