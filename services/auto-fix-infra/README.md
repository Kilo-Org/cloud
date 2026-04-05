# Kilo Auto Fix Worker

Cloudflare Worker for automated issue fixing via PR creation.

## Overview

This worker handles the Auto Fix workflow:

1. Receives dispatch requests when issues are labeled with `kilo-auto-fix`
2. Orchestrates PR creation using Cloud Agent
3. Reports status back to the Next.js backend

## Architecture

- **Durable Object**: `AutoFixOrchestrator` - Manages fix session state
- **Cloud Agent Integration**: Creates PRs using the Cloud Agent API
- **Backend Communication**: Updates fix ticket status via internal API

## Development

```bash
# Install dependencies
pnpm install

# Start development server
pnpm dev

# Type check
pnpm typecheck

# Deploy to production
pnpm deploy
```

## Environment Variables

See `.dev.vars.example` for required environment variables.

## Related

- Main application: `../../src`
- Auto Triage worker: `../cloudflare-auto-triage-infra`
- Cloud Agent worker: `../cloud-agent`
