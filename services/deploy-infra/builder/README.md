# Builder - Local Development Setup

## Prerequisites

- Wrangler CLI (`pnpm add -g wrangler`)
- Access to Cloudflare account credentials

## Setup

### 1. Configure Builder Environment

Copy the example env file and fill in the values:

```bash
cp .dev.vars.example .dev.vars
```

### 2. Configure Backend Events URL

Choose one of these options for `BACKEND_EVENTS_URL`:

**Option A: Using ngrok (recommended for external access)**

```bash
ngrok http 3000
# Use the generated URL: https://your-subdomain.ngrok-free.dev/api/user-deployments/webhook
```

**Option B: Using local network IP**

```
http://192.168.x.x:3000/api/user-deployments/webhook
```

### 3. Configure Backend

In the main backend `.env`, ensure this variable matches the builder's `BACKEND_AUTH_TOKEN`:

```
USER_DEPLOYMENTS_API_AUTH_KEY=<same-value-as-BACKEND_AUTH_TOKEN>
```

### 4. Generate Encryption Keys

Generate a dedicated RSA key pair for encrypting environment variables from the repository root:

```bash
pnpm exec tsx dev/generate-rsa-env-keypair.ts -- \
  --out-dir <secure-output-dir> \
  --public-env USER_DEPLOYMENTS_ENV_VARS_PUBLIC_KEY \
  --private-env ENV_ENCRYPTION_PRIVATE_KEY
```

The command requires a new output directory outside the repository, then creates restricted `public.pem`, `private.pem`, `public.env`, and `private.env` files without overwriting existing output. Set the environment variables from the generated env files:

- **Builder** (`.dev.vars`): copy `ENV_ENCRYPTION_PRIVATE_KEY` from `private.env`
- **Backend** (`.env`): copy `USER_DEPLOYMENTS_ENV_VARS_PUBLIC_KEY` from `public.env`

Store `private.pem` and `private.env` in an approved secrets manager and never commit them.

### 5. Run Services

Start the builder:

```bash
cd cloudflare-deploy-infra/builder
wrangler dev
```

Start the backend (in a separate terminal):

```bash
# From project root
pnpm dev
```

## ⚠️ Important Notes

Web app deployments go directly to production. There is no separate dev environment on Cloudflare for deployments.
