# AI Attributions Tracking - Cloudflare Worker

This Cloudflare Worker tracks AI attributions in Kilo Code by capturing line-level changes when users accept or reject file edits. It uses Durable Objects with SQLite storage for efficient querying and attribution of AI-generated code.

## Development

There's still some rough edges which means you need to setup your local secret store before running the dev server. Do that with this command:

```sh
npx wrangler secrets-store secret create 342a86d9e3a94da698e82d0c6e2a36f0 --name NEXTAUTH_SECRET_DEV --scopes workers --value 'SECRET_HERE'
npx wrangler secrets-store secret create 342a86d9e3a94da698e82d0c6e2a36f0 --name ADMIN_SECRET --scopes workers --value 'SECRET_HERE'
```

```bash
pnpm dev
```

The development server will start on `http://localhost:8787` by default.
