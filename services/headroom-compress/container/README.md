# Headroom Container

Build pinned Cloudflare Container image from source. This requires a native amd64
builder because Headroom builds Rust extensions:

```bash
cd services/headroom-compress
pnpm run container:build
```

Confirm pushed image:

```bash
pnpm exec wrangler containers images list --filter headroom-compress --json
```

Deploy only the pinned tag referenced in `wrangler.jsonc`. Record returned digest in release notes before deploy.

Current fallback image was mirrored from:

```text
ghcr.io/chopratejas/headroom@sha256:9f5f0de34dbb4c2ba2b60ebba9bb2c28c9a07664629f3c1c0e9ea86cead62631
```
