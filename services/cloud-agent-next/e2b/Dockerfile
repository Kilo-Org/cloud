FROM docker.io/library/node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c

ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    KILO_PLATFORM=cloud-agent \
    KILO_DISABLE_AUTOUPDATE=true \
    pnpm_config_store_dir=/var/cache/kilo/pnpm-store

RUN test "$(dpkg --print-architecture)" = amd64 && \
    apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl git git-lfs gh jq openssh-client unzip && \
    git lfs install --system --skip-repo && \
    rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/usr/local \
    COREPACK_HOME=/var/cache/kilo/corepack \
    COREPACK_DEFAULT_TO_LATEST=0 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

RUN corepack enable && \
    corepack prepare pnpm@11.1.2 --activate && \
    pnpm add --global --store-dir /opt/pnpm-build-store \
        --allow-build=bun --allow-build=@kilocode/cli bun@1.3.14 @kilocode/cli@7.4.20 && \
    test "$(bun --version)" = 1.3.14 && \
    test "$(kilo --version)" = 7.4.20 && \
    test "$(kilocode --version)" = 7.4.20 && \
    test "$(pnpm --version)" = 11.1.2

RUN useradd --create-home --uid 1001 --shell /bin/bash user && \
    mkdir -p /opt/kilo /opt/kilo-cloud /workspace /var/cache/kilo/pnpm-store && \
    chown user:user /workspace /var/cache/kilo/pnpm-store && \
    chown -R user:user /var/cache/kilo/corepack

COPY control-wrapper.js /opt/kilo/kilocode-control-wrapper.js
COPY restore-session.js /usr/local/bin/kilo-restore-session.js
COPY bb /usr/local/bin/bb
COPY kilo-git-credential /opt/kilo-cloud/kilo-git-credential
COPY runtime-manifest.json /opt/kilo/runtime-manifest.json

RUN chmod 0555 /opt/kilo/kilocode-control-wrapper.js /usr/local/bin/kilo-restore-session.js \
    /usr/local/bin/bb /opt/kilo-cloud/kilo-git-credential && \
    chmod 0444 /opt/kilo/runtime-manifest.json && \
    ln -s /opt/kilo-cloud/kilo-git-credential /usr/local/bin/kilo-git-credential && \
    git config --system credential.helper /opt/kilo-cloud/kilo-git-credential && \
    git config --system credential.useHttpPath false && \
    git config --system http.followRedirects false && \
    test -x /usr/bin/timeout

USER user
WORKDIR /workspace
