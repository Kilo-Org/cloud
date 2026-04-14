# KiloClaw Google Setup

Docker image that guides users through connecting their Google account to KiloClaw.

## Modes

### Solo (default)

For individual users doing the full setup themselves — creates a GCP project, enables APIs, sets up OAuth, authorizes Google Workspace access, and uploads credentials.

```bash
docker run -it ghcr.io/kilo-org/google-setup --token="YOUR_SESSION_JWT"
```

### Admin

For org admins who set up GCP infra once, then share credentials with members. Creates the project, enables APIs, configures OAuth, sets up Pub/Sub push infra, and grants member permissions.

```bash
docker run -it ghcr.io/kilo-org/google-setup --admin
```

After setup, the admin shares the member command (printed at the end) with org members.

### Member

For org members whose admin has already set up the GCP project and OAuth client. Authorizes the member's Google account and uploads credentials.

```bash
docker run -it ghcr.io/kilo-org/google-setup \
  --token="YOUR_SESSION_JWT" \
  --client-id="ADMIN_PROVIDED_CLIENT_ID" \
  --client-secret="ADMIN_PROVIDED_CLIENT_SECRET" \
  --project-id="ADMIN_PROVIDED_PROJECT_ID" \
  --instance-id="ORG_INSTANCE_ID"
```

`--instance-id` is the KiloClaw instance ID of the organization (visible in the Kilo web app). Without it, credentials upload to the member's personal instance instead of the org instance.

## Additional flags

| Flag                            | Description                                                                |
| ------------------------------- | -------------------------------------------------------------------------- |
| `--token=<jwt>`                 | Session JWT from kilo.ai (required for solo and member modes)              |
| `--instance-id=<uuid>`          | Target a specific org instance                                             |
| `--worker-url=<url>`            | Override the kiloclaw worker URL (default: `https://claw.kilosessions.ai`) |
| `--gmail-push-worker-url=<url>` | Override the Gmail push worker URL                                         |
| `--client-id=<id>`              | OAuth client ID (member mode)                                              |
| `--client-secret=<secret>`      | OAuth client secret (member mode)                                          |
| `--project-id=<pid>`            | GCP project ID (member mode)                                               |
| `--admin`                       | Run in admin mode                                                          |

## Local development

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
