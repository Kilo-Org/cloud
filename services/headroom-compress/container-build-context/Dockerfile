# syntax=docker/dockerfile:1.7

ARG HEADROOM_REF=da1a3973ed79d89617087ec315e77fb82356c03b
ARG TARGETPLATFORM=linux/amd64
ARG PYTHON_VERSION=3.13
ARG PYTHON_SITE_PACKAGES=/usr/local/lib/python${PYTHON_VERSION}/site-packages

FROM --platform=${TARGETPLATFORM} alpine:3.22 AS source
ARG HEADROOM_REF
RUN apk add --no-cache ca-certificates curl tar
WORKDIR /src
RUN curl -fsSL "https://github.com/headroomlabs-ai/headroom/archive/${HEADROOM_REF}.tar.gz" \
  | tar -xz --strip-components=1

FROM --platform=${TARGETPLATFORM} python:${PYTHON_VERSION}-slim AS builder

ARG PYTHON_SITE_PACKAGES

RUN apt-get update && \
  apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    curl \
    g++ \
    patchelf \
  && rm -rf /var/lib/apt/lists/*

ENV CARGO_HOME=/usr/local/cargo \
    RUSTUP_HOME=/usr/local/rustup \
    PATH=/usr/local/cargo/bin:${PATH}
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
  | sh -s -- -y --no-modify-path --profile minimal -c rustfmt -c clippy --default-toolchain 1.95.0

WORKDIR /build
COPY --from=source /src/pyproject.toml /src/uv.lock /src/README.md ./
COPY --from=source /src/Cargo.toml /src/Cargo.lock /src/rust-toolchain.toml ./
COPY --from=source /src/crates/ crates/
COPY --from=source /src/headroom/ headroom/

ARG HEADROOM_EXTRAS=proxy,code
RUN --mount=type=cache,target=/root/.cache/pip \
    --mount=type=cache,target=/root/.cargo/registry \
    --mount=type=cache,target=/build/target \
    python -m pip install ".[${HEADROOM_EXTRAS}]"

RUN cd /tmp && python -c "from headroom._core import DiffCompressor, SmartCrusher; print(f'headroom core OK: {DiffCompressor.__name__}, {SmartCrusher.__name__}')"

RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target \
    cargo build --release --locked --bin headroom-proxy && \
    cp target/release/headroom-proxy /usr/local/bin/headroom-proxy

FROM --platform=${TARGETPLATFORM} python:${PYTHON_VERSION}-slim AS runtime

ARG RUNTIME_USER=nonroot
ARG RUNTIME_HOME=/home/nonroot
ARG PYTHON_SITE_PACKAGES

RUN apt-get update && \
  apt-get install -y --no-install-recommends ca-certificates curl && \
  rm -rf /var/lib/apt/lists/*

COPY --from=builder ${PYTHON_SITE_PACKAGES} ${PYTHON_SITE_PACKAGES}
COPY --from=builder /usr/local/bin/headroom /usr/local/bin/headroom
COPY --from=builder /usr/local/bin/headroom-proxy /usr/local/bin/headroom-proxy

RUN mkdir -p ${RUNTIME_HOME}/.cache/huggingface ${RUNTIME_HOME}/.headroom /data && \
  if [ "$RUNTIME_USER" = "nonroot" ]; then \
    groupadd --gid 1000 nonroot && \
    useradd --uid 1000 --gid nonroot --create-home nonroot && \
    chown -R nonroot:nonroot /data ${RUNTIME_HOME}; \
  fi

USER ${RUNTIME_USER}
WORKDIR ${RUNTIME_HOME}

ENV HEADROOM_HOST=0.0.0.0 \
    HEADROOM_PORT=8787 \
    HEADROOM_IN_DOCKER=1 \
    HF_HOME=${RUNTIME_HOME}/.cache/huggingface \
    TRANSFORMERS_CACHE=${RUNTIME_HOME}/.cache/huggingface \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    OMP_NUM_THREADS=1

RUN HEADROOM_STATELESS=true \
    HEADROOM_TELEMETRY=off \
    HEADROOM_SKIP_UPSTREAM_CHECK=1 \
    HEADROOM_MODEL_LIMITS='{"context_limits":{"kilo/anthropic/claude-sonnet-4.6":1000000}}' \
    python -c "from headroom import compress; text=('alpha beta gamma delta epsilon zeta eta theta\\n' * 256); result=compress([{'role':'user','content':text}], model='kilo/anthropic/claude-sonnet-4.6', model_limit=1000000, compress_user_messages=True, protect_recent=0, min_tokens_to_compress=10); print(f'headroom warmup OK: {result.tokens_before}->{result.tokens_after}')"

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["curl", "--fail", "--silent", "http://127.0.0.1:8787/readyz"]

ENTRYPOINT ["headroom", "proxy"]
CMD ["--host", "0.0.0.0", "--port", "8787"]
