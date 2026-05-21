FROM node:24.14.1-bookworm

ARG BUN_VERSION=1.3.14
ARG DOTENVX_VERSION=1.66.0
ARG FLYCTL_VERSION=0.4.54
ARG PNPM_VERSION=11.1.2
ARG VERCEL_VERSION=54.3.0
ARG WRANGLER_VERSION=4.90.1

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV FLYCTL_INSTALL=/usr/local/fly
ENV PNPM_HOME=/home/node/.local/share/pnpm
ENV PATH="${PNPM_HOME}:${FLYCTL_INSTALL}/bin:/home/node/.bun/bin:${PATH}"

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bash \
      build-essential \
      ca-certificates \
      curl \
      git \
      git-lfs \
      gnupg \
      jq \
      less \
      openssh-client \
      openssl \
      python3 \
      socat \
      tmux \
      unzip \
      xz-utils \
      zsh \
    && git lfs install --system --skip-repo \
    && rm -rf /var/lib/apt/lists/*

# Keep externally packaged CLIs close to repo's Nix shell and runtime images.
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg; \
    echo "deb [arch=${arch} signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list; \
    curl -fsSL https://downloads.1password.com/linux/keys/1password.asc \
      | gpg --dearmor --output /usr/share/keyrings/1password-archive-keyring.gpg; \
    echo "deb [arch=${arch} signed-by=/usr/share/keyrings/1password-archive-keyring.gpg] https://downloads.1password.com/linux/debian/${arch} stable main" \
      > /etc/apt/sources.list.d/1password.list; \
    mkdir -p /etc/debsig/policies/AC2D62742012EA22/; \
    curl -fsSL https://downloads.1password.com/linux/debian/debsig/1password.pol \
      > /etc/debsig/policies/AC2D62742012EA22/1password.pol; \
    mkdir -p /usr/share/debsig/keyrings/AC2D62742012EA22; \
    curl -fsSL https://downloads.1password.com/linux/keys/1password.asc \
      | gpg --dearmor --output /usr/share/debsig/keyrings/AC2D62742012EA22/debsig.gpg; \
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
      | gpg --dearmor --output /usr/share/keyrings/postgresql-archive-keyring.gpg; \
    echo "deb [signed-by=/usr/share/keyrings/postgresql-archive-keyring.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
      > /etc/apt/sources.list.d/postgresql.list; \
    curl -fsSL https://packages.stripe.dev/api/security/keypair/stripe-cli-gpg/public \
      | gpg --dearmor --output /usr/share/keyrings/stripe-cli-archive-keyring.gpg; \
    echo "deb [signed-by=/usr/share/keyrings/stripe-cli-archive-keyring.gpg] https://packages.stripe.dev/stripe-cli-debian-local stable main" \
      > /etc/apt/sources.list.d/stripe-cli.list; \
    curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
      -o /usr/share/keyrings/cloudflare-main.gpg; \
    echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" \
      > /etc/apt/sources.list.d/cloudflared.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      1password-cli \
      cloudflared \
      gh \
      postgresql-client-18 \
      stripe; \
    rm -rf /var/lib/apt/lists/*

RUN corepack enable \
    && corepack prepare "pnpm@${PNPM_VERSION}" --activate \
    && npm install --global \
      "@dotenvx/dotenvx@${DOTENVX_VERSION}" \
      "vercel@${VERCEL_VERSION}" \
      "wrangler@${WRANGLER_VERSION}"

RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "${arch}" in \
      amd64) bun_arch="x64"; bun_sha256="951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f" ;; \
      arm64) bun_arch="aarch64"; bun_sha256="a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b" ;; \
      *) echo "Unsupported Bun architecture: ${arch}" >&2; exit 1 ;; \
    esac; \
    bun_archive="bun-linux-${bun_arch}.zip"; \
    curl -fsSL \
      "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${bun_archive}" \
      -o "/tmp/${bun_archive}"; \
    echo "${bun_sha256}  /tmp/${bun_archive}" | sha256sum --check --strict; \
    unzip -q "/tmp/${bun_archive}" -d /tmp/bun; \
    install -m 0755 "/tmp/bun/bun-linux-${bun_arch}/bun" /usr/local/bin/bun; \
    ln -sf /usr/local/bin/bun /usr/local/bin/bunx; \
    rm -rf /tmp/bun "/tmp/${bun_archive}"

RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "${arch}" in \
      amd64) fly_arch="x86_64"; fly_sha256="1f1b8fbb023c669a4e722280dd850e6de104bb4327474cecc5f67c7575a4bb91" ;; \
      arm64) fly_arch="arm64"; fly_sha256="6e30278045d397057c1f8d5e10ba8056a1761ae9d651c38dc25f68e39abbba2c" ;; \
      *) echo "Unsupported Fly CLI architecture: ${arch}" >&2; exit 1 ;; \
    esac; \
    fly_archive="flyctl_${FLYCTL_VERSION}_Linux_${fly_arch}.tar.gz"; \
    curl -fsSL \
      "https://github.com/superfly/flyctl/releases/download/v${FLYCTL_VERSION}/${fly_archive}" \
      -o "/tmp/${fly_archive}"; \
    echo "${fly_sha256}  /tmp/${fly_archive}" | sha256sum --check --strict; \
    mkdir -p /tmp/flyctl "${FLYCTL_INSTALL}/bin"; \
    tar -xzf "/tmp/${fly_archive}" -C /tmp/flyctl; \
    install -m 0755 /tmp/flyctl/flyctl "${FLYCTL_INSTALL}/bin/flyctl"; \
    ln -sf "${FLYCTL_INSTALL}/bin/flyctl" /usr/local/bin/flyctl; \
    ln -sf "${FLYCTL_INSTALL}/bin/flyctl" /usr/local/bin/fly; \
    rm -rf /tmp/flyctl "/tmp/${fly_archive}"
