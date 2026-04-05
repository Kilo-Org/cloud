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

Generate an RSA key pair for encrypting environment variables:

```bash
# Generate 4096-bit RSA private key
openssl genrsa -out env-vars-private.pem 4096

# Extract public key from private key
openssl rsa -in env-vars-private.pem -pubout -out env-vars-public.pem

# Base64 encode private key (for builder's ENV_ENCRYPTION_PRIVATE_KEY)
base64 -i env-vars-private.pem | tr -d '\n'

# Base64 encode public key (for backend's USER_DEPLOYMENTS_ENV_VARS_PUBLIC_KEY)
base64 -i env-vars-public.pem | tr -d '\n'
```

Set the environment variables:

- **Builder** (`.dev.vars`): `ENV_ENCRYPTION_PRIVATE_KEY=<base64-encoded-private-key>`
- **Backend** (`.env`): `USER_DEPLOYMENTS_ENV_VARS_PUBLIC_KEY=<base64-encoded-public-key>`

> Note: `tr -d '\n'` removes newlines from the base64 output to create a single-line string suitable for environment variables.

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
