# Local BYOK KMS service

Implements the `/encrypt` and `/decrypt` contract from
`docs/plans/byok-kms-envelope-encryption.md` for local development. Key
wrapping goes to [local-kms](https://github.com/nsmithuk/local-kms), a
KMS-compatible mock, seeded with `alias/byok-local` from `seed.yaml`. Calls are
SigV4-signed, so pointing `BYOK_KMS_ENDPOINT` and `BYOK_KMS_KEY_ID` at real AWS
KMS uses the same code path.

```bash
docker compose -f dev/docker-compose.yml up -d local-kms
pnpm dev:byok-kms
```

Then set in `.env.local` and restart the web app:

```
BYOK_KMS_SERVICE_URL=http://127.0.0.1:8901
BYOK_KMS_SERVICE_TOKEN=dev-byok-kms-token
```

| Variable | Default |
|---|---|
| `BYOK_KMS_SERVICE_PORT` | `8901` |
| `BYOK_KMS_SERVICE_TOKEN` | `dev-byok-kms-token` |
| `BYOK_KMS_TRANSPORT_ENCRYPTION_KEY` | falls back to `BYOK_ENCRYPTION_KEY` |
| `BYOK_KMS_ENDPOINT` | `http://127.0.0.1:8900` (`KILO_KMS_PORT` in compose) |
| `BYOK_KMS_KEY_ID` | `alias/byok-local` |
| `AWS_REGION` | `eu-west-1` |
