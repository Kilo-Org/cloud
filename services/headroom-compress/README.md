# Headroom Compress Worker

Worker-gated Cloudflare Container deployment for Headroom compression only.

Public surface:

- `GET /readyz`
- `POST /v1/compress`

All other Headroom routes return `404` at Worker layer before container fetch.

Required secret:

```bash
pnpm exec wrangler secrets-store secret create HEADROOM_BEARER_TOKEN
```

Build and push pinned source image from a native amd64 builder:

```bash
pnpm run container:build
```

Current deployed fallback tag is `0.27.0-ghcr9f5f0de`, mirrored from the
published `v0.27.0` amd64 image digest because local arm64 Docker cannot build
Headroom's amd64 Rust extension under QEMU.

Deploy:

```bash
pnpm run deploy
```

Smoke test:

```bash
curl --fail https://headroom.kiloapps.io/readyz

curl --fail https://headroom.kiloapps.io/v1/compress \
  -H "authorization: Bearer $HEADROOM_BEARER_TOKEN" \
  -H "content-type: application/json" \
  --data '{"model":"kilo/anthropic/claude-sonnet-4.6","messages":[{"role":"user","content":"hello"}],"config":{"compress_user_messages":true}}'
```

Benchmark compression:

```bash
pnpm run benchmark:compression -- --case logs --repeat 3
pnpm run benchmark:compression -- --list-cases
pnpm run benchmark:compression -- --fixture ./messages.json --json --output report.json
```
