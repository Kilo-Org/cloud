# kilocode-backend

## Getting Started

0. If you're running on a mac and are looking for (a likely incomplete) set of system software prerequisites, here is [how I set up my macos dev env](dev/macos%20dev-environment%20installation.txt).

Make sure both git and pnpm are up to date:

```bash
pnpm install
git lfs pull
```

1. Pull environment variables from Vercel

```bash
pnpm i -g vercel
vercel login
vercel link --project kilocode-app
vercel env pull
```

2. Run the database:

```bash
cd dev
docker compose up -d
```

3. Set up the database

```bash
pnpm drizzle migrate
```

You will need to rerun this every time you pull new migrations.

If you wish to make a new migration, make changes to the schema and run:

```bash
pnpm drizzle generate
```

4. Run the development server:

```bash
pnpm dev
```

5. When testing Stripe, start Stripe forwarding

Installation via brew as described in [macos dev env](dev/macos%20dev-environment%20installation.txt)

```bash
pnpm stripe
```

IMPORTANT: copy the webhook signing secret to .env.development.local, and assign to `STRIPE_WEBHOOK_SECRET`

## Environment Variables

Environment variables are managed through Vercel. For local development, pull the latest ones using:

```bash
vercel env pull
```

### Adding a new environment variable

```bash
vercel env add FOO
```

### Updating environment variables

```bash
vercel env update FOO
```

### Accessing environment variables in code

In TypeScript, you can use the [`getEnvVariable`](src/lib/dotenvx.ts:3) helper for consistent access:

```typescript
import { getEnvVariable } from '@/lib/dotenvx';

console.info(getEnvVariable('FOO')); // bar
```

## External resources

- [Google Cloud OAuth setup](https://console.cloud.google.com/auth/clients?project=kilocode)
- [Vercel project](https://vercel.com/kilocode/kilocode-backend)
- [Supabase project](https://vercel.com/kilocode/kilocode-backend)

## API Token Authentication

This application uses JWT (JSON Web Tokens) for API authentication. When a user generates a token through the `/api/token` endpoint, they receive a signed JWT that includes:

- Subject (user ID)
- Issuance timestamp
- Expiration date (30 days by default)
- kiloUserId (user identifier)
- version (token version, currently 3)

The tokens are signed using the `NEXTAUTH_SECRET` environment variable, which should be securely set in your deployment environment.

To use a token with the API:

1. Obtain a token through the `/api/token` endpoint (requires user authentication)
2. Include the token in your API requests using the Authorization header:
   ```
   Authorization: Bearer your-jwt-token
   ```

Each token is validated cryptographically using the secret key to ensure it hasn't been tampered with.

## Token Version 3 (25 March 2025)

On 25 March 2025, the token format was updated to version 3, to force everyone to log in again, in order to get a consistent situation across Postgres/Orb/Stripe. As part of this the kiloUserId prefix was changed from `google:` to `oauth/google:`, to make sure all associations in Orb are fresh.

## Token Version 2 (March 2025)

In March 2025, the token format was updated to version 2, which includes the following changes:

- JWT token field `kiloId` renamed to `kiloUserId`
- JWT version bumped to 2
- All version 1 tokens are invalidated and users will need to re-authenticate

This change standardizes the naming convention across the application and improves clarity

## Model Selection Component

The [`ModelSelector`](src/components/models/ModelSelector.tsx:33) component provides a comprehensive interface for selecting AI models and providers. It works by fetching model and provider data from the database through the OpenRouter integration.

### How it works

1. **Data Loading**: The component uses the [`useModelSelector`](src/components/models/hooks.ts) hook, which internally calls [`useOpenRouterModelsAndProviders`](src/app/api/openrouter/hooks.ts)
2. **API Endpoint**: The hook fetches data from the [`/api/openrouter/models-by-provider`](src/app/api/openrouter/models-by-provider/route.ts) endpoint, which queries the `models_by_provider` database table
3. **Data Structure**: The API returns a normalized structure with providers that include their models directly, along with comprehensive metadata like data policies, pricing, and capabilities
4. **Filtering & Selection**: The component provides extensive filtering options (by provider location, data policy, pricing, context length, etc.) and allows users to select specific models or entire providers
5. **Fallback Mechanism**: If the API request fails or returns invalid data, the hook falls back to a static backup JSON file ([`openrouter-models-by-provider-backup.json`](src/data/openrouter-models-by-provider-backup.json)) to ensure the application remains functional

### Data Synchronization

The model and provider data is stored in the `models_by_provider` database table and needs to be periodically synchronized with OpenRouter's API to ensure we have the latest information. The synchronization process populates the database table, which is then served through the API endpoint with edge caching (60 seconds) for optimal performance.

A backup JSON file is maintained for fallback purposes and can be updated using:

```bash
pnpm script:run openrouter sync-providers-backup
```

This script ([`sync-providers-backup.ts`](src/scripts/openrouter/sync-providers-backup.ts)) fetches the latest provider information and models from OpenRouter's API and generates the backup JSON file.

## Dependency Graphs

You can generate dependency graphs for any source file using [dependency-cruiser](https://github.com/sverweij/dependency-cruiser). This requires `graphviz` to be installed (`brew install graphviz` on macOS).

To generate a dependency graph for a specific file:

```bash
npx depcruise src/path/to/file.tsx --include-only "^src" --output-type dot | dot -T svg > /tmp/dependency-graph.svg && open /tmp/dependency-graph.svg
```

For example, to visualize dependencies for the sign-in page:

```bash
npx depcruise src/app/users/sign_in/page.tsx --include-only "^src" --output-type dot | dot -T svg > /tmp/dependency-graph.svg && open /tmp/dependency-graph.svg
```

The `--include-only "^src"` flag limits the graph to files within the `src` directory, excluding external dependencies.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

## Testing with Read Replica

The application supports read replicas for multi-region deployment. To test this locally:

1. Start both database containers:

```bash
cd dev
docker compose up -d
```

This starts:

- Primary database on port `5432`
- Replica database on port `5433`

2. Run migrations on both databases:

```bash
pnpm drizzle migrate
POSTGRES_URL=postgresql://postgres:postgres@localhost:5433/postgres pnpm drizzle migrate
```

3. Add to your `.env.development.local`:

```bash
POSTGRES_REPLICA_US_URL=postgresql://postgres:postgres@localhost:5433/postgres
VERCEL_REGION=sfo1
```

Setting `VERCEL_REGION` to a US region (`sfo1`, `iad1`, `pdx1`, or `cle1`) will make the app use the replica for read operations via `readDb`.

**Note:** This is a simplified setup where both databases are independent (not actually replicating). This allows testing the code paths and connection logic without setting up true PostgreSQL streaming replication. For production, Supabase handles the actual replication.

## Proxy to production

> ‼️ Use this with caution!

You can spin up a dev server to hit our production database. Just run:

```sh
pnpm dev:prod-db
```

Login with the fake-login provider with an email like:

```
my-fullname@admin.example.com
```

## Local development behind HTTPS tunnel

To test the app behind an HTTPS tunnel, you can use `ngrok`. First, install it:

```sh
brew install ngrok
```

Then, start the dev server and expose it:

```sh
ngrok http 3000
```

This will tell you the URL that's being used, copy it, and write it to your `.env.development.local` file, like this:

```sh
APP_URL_OVERRIDE=https://lucile-unparenthesized-subaurally.ngrok-free.dev/
NEXTAUTH_URL=https://lucile-unparenthesized-subaurally.ngrok-free.dev/
```

Then restart the dev server, and you should be able to access the app behind the tunnel.

### But ... why?

Some OAuth providers restrict `redirect_uri` to be HTTPS, and others explicitly block `localhost` for security reasons.

## Common errors
### Error - Duplicate Vercel Project Causing MaxDuration Errors on PRs

GitHub PRs were showing Vercel build errors referencing `MaxDuration`, despite deployments working correctly on the Enterprise Vercel account.

The issue was caused by a duplicate Vercel project (named “cloud”) existing in a separate account, which was still connected to the GitHub repository. This resulted in GitHub receiving deployment signals from both projects.

### Fix

- Identified and deleted the duplicate “cloud” project in the secondary Vercel account.
- Confirmed that only the intended Enterprise Vercel project remained connected to the GitHub repository.
- Verified that new PRs no longer triggered duplicate Vercel notifications or `MaxDuration` errors.
