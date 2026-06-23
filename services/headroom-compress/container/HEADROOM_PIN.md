# Headroom Pin

- Upstream repo: `https://github.com/headroomlabs-ai/headroom`
- Commit: `da1a3973ed79d89617087ec315e77fb82356c03b`
- Version: `0.27.0`
- Preferred source-build image tag: `headroom-compress:0.27.0-da1a397`
- Deployed fallback image tag: `headroom-compress:0.27.0-ghcr9f5f0de`
- Deployed fallback source: `ghcr.io/chopratejas/headroom@sha256:9f5f0de34dbb4c2ba2b60ebba9bb2c28c9a07664629f3c1c0e9ea86cead62631`
- Cloudflare Registry image: `registry.cloudflare.com/e115e769bcdd4c3d66af59d3332cb394/headroom-compress:0.27.0-ghcr9f5f0de`
- Platform: `linux/amd64`

Build from `../container-build-context/Dockerfile`. Do not deploy `latest`.

On arm64 Docker Desktop, the pinned source build currently fails because amd64
Rust tooling segfaults under QEMU. Use a native amd64 builder for source builds.
