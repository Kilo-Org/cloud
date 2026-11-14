# Test server for the ssh-core integration suite.
#
# One container serves one role, chosen as the command argument: `password`,
# `two-factor` (two keyboard-interactive prompts through PAM) or `silent`
# (accepts TCP, never speaks SSH). Separate containers are what lets password
# and keyboard-interactive authentication use different PAM stacks.
FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    gcc \
    libpam0g-dev \
    openssh-server \
    socat \
  && rm -rf /var/lib/apt/lists/*

COPY docker/pam_two_factor.c /usr/src/pam_two_factor.c
RUN gcc -shared -fPIC -O2 -Wall -Wextra -o \
      /usr/lib/x86_64-linux-gnu/security/pam_two_factor.so \
      /usr/src/pam_two_factor.c -lpam

RUN useradd --create-home --shell /bin/bash user \
  && echo 'user:ssh-core-password' | chpasswd \
  && install -d -m 700 -o user -g user /home/user/.ssh

COPY fixtures/*.pub /usr/src/authorized_keys/
RUN cat /usr/src/authorized_keys/*.pub > /home/user/.ssh/authorized_keys \
  && chown user:user /home/user/.ssh/authorized_keys \
  && chmod 600 /home/user/.ssh/authorized_keys \
  && rm -rf /usr/src/authorized_keys

RUN printf '%s\n' \
      'auth required pam_two_factor.so' \
      'account required pam_permit.so' \
      'session required pam_permit.so' \
      > /etc/pam.d/two-factor

COPY docker/sshd_config.password /etc/ssh/sshd_config.password
COPY docker/sshd_config.twofactor /etc/ssh/sshd_config.twofactor
COPY docker/http_response.sh /usr/local/bin/http-response
RUN chmod +x /usr/local/bin/http-response
COPY docker/entrypoint.sh /usr/local/bin/entrypoint

EXPOSE 2222
ENTRYPOINT ["/usr/local/bin/entrypoint"]
