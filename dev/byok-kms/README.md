# Local BYOK KMS service

Implements the `POST /data-key` and `POST /decrypt` contract below for local
development. Key wrapping goes to [local-kms](https://github.com/nsmithuk/local-kms), a
KMS-compatible mock, seeded with `alias/byok-local` from `seed.yaml`. Calls are
SigV4-signed, so pointing `BYOK_KMS_ENDPOINT` and `BYOK_KMS_KEY_ID` at real AWS
KMS uses the same code path.

`pnpm dev:start` starts `local-kms` and this service (`byok-kms`) as part of the
core group, and points `BYOK_KMS_SERVICE_URL` / `BYOK_KMS_SERVICE_TOKEN` in
`.env.local` at it, using the worktree's port offset. To run it by hand:

```bash
docker compose -f dev/docker-compose.yml up -d local-kms
pnpm dev:byok-kms
```

## Contract

The service only creates and retrieves data keys. The BYOK key never leaves the
app, so request bodies carry no secret material and there is no transport-layer
encryption. Every request is a `POST` with a JSON body and an
`authorization: Bearer <BYOK_KMS_SERVICE_TOKEN>` header. Nothing is sent in the
URL.

Every request carries `key_id`, `owner_type` (`user` or `organization`),
`owner_id` and `provider_id`, which become the KMS encryption context.

`POST /data-key` creates a data key. The request also accepts an optional
`actor_user_id`, used only for logging.

```json
{ "data_key": "<base64>", "wrapped_dek": "<base64>", "kms_key_id": "<id>", "kms_key_version": "1" }
```

`POST /decrypt` retrieves a data key. The request also carries the stored
`wrapped_dek`, `kms_key_id` and `kms_key_version`.

```json
{ "data_key": "<base64>" }
```

KMS authenticates the context on `POST /decrypt`, so the identifiers logged for
a successful retrieval cannot be spoofed by the caller. A retrieval with a
context that does not match returns `403` and is logged with
`identifiers_verified: false`. A KMS failure returns `502`, an invalid body
`400`, a missing or wrong token `401`, any other method `405` and any other
path `404`. Each request is logged as one JSON line for rate limiting and
alerting. Data keys and wrapped data keys are never logged.

| Variable | Default |
|---|---|
| `BYOK_KMS_SERVICE_PORT` | `8901` |
| `BYOK_KMS_SERVICE_TOKEN` | `dev-byok-kms-token` |
| `BYOK_KMS_ENDPOINT` | `http://127.0.0.1:8900` (`KILO_KMS_PORT` in compose) |
| `BYOK_KMS_KEY_ID` | `alias/byok-local` |
| `AWS_REGION` | `eu-west-1` |
