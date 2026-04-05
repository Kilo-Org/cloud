# App Builder - Local Development Setup

## Prerequisites

- Wrangler CLI (`pnpm add -g wrangler`)
- Access to Cloudflare account credentials
- Cloud Agent running locally

## Setup

### Configure Builder Environment

Copy the example env file and fill in the values:

```bash
cp .dev.vars.example .dev.vars
```

### Run Services

Start the builder:

```bash
cd cloudflare-app-builder
wrangler dev
```

Start the backend (in a separate terminal):

```bash
# From project root
pnpm dev
```
