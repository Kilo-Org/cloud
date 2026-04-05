# KiloClaw Google Setup

Docker image that guides users through connecting their Google account to KiloClaw.

## What it does

1. Validates the user's session token (JWT)
2. Signs into gcloud, creates/selects a GCP project, enables Google APIs
3. Guides user through creating a Desktop OAuth client in Google Cloud Console
4. Runs a local OAuth flow to obtain refresh tokens
5. Encrypts credentials with the worker's public key
6. POSTs the encrypted bundle to the KiloClaw worker

## Usage

```bash
docker run -it ghcr.io/kilo-org/google-setup --token="YOUR_SESSION_JWT"
```

For local development against a local worker:

```bash
docker run -it --network host ghcr.io/kilo-org/google-setup \
  --token="YOUR_SESSION_JWT" \
  --worker-url=http://localhost:8795
```

> **Note:** `--network host` is only needed when using `--worker-url` pointing to localhost.
> The OAuth flow uses a manual code-paste flow, so no port mapping is required.

## Publishing

The image is hosted on GitHub Container Registry at `ghcr.io/kilo-org/google-setup`.

### Prerequisites

- Docker with buildx support
- GitHub CLI (`gh`) with `write:packages` scope

### Steps

```bash
# 1. Add write:packages scope (one-time)
gh auth refresh -h github.com -s write:packages

# 2. Login to GHCR
echo $(gh auth token) | docker login ghcr.io -u $(gh api user -q .login) --password-stdin

# 3. Create multi-arch builder (one-time)
docker buildx create --use --name multiarch

# 4. Build and push (amd64 + arm64)
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/kilo-org/google-setup:latest \
  --push \
  kiloclaw/google-setup/
```

### Tagging a release

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/kilo-org/google-setup:latest \
  -t ghcr.io/kilo-org/google-setup:v2.0.0 \
  --push \
  kiloclaw/google-setup/
```

## Making the package public

By default, GHCR packages are private. To make it public:

1. Go to https://github.com/orgs/Kilo-Org/packages/container/google-setup/settings
2. Under "Danger Zone", click "Change visibility" and select "Public"
