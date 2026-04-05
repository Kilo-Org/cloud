# Secret Catalog

The secret catalog is a shared, declarative registry of secret types that drives the UI, worker encryption pipeline, and boot script from a single source of truth.

**Package:** `@kilocode/kiloclaw-secret-catalog` (`kiloclaw/packages/secret-catalog/`)

## How it works

```
Catalog entry (data)
    |
    +--> UI renders input fields, labels, icons, validation
    +--> tRPC validates keys + patterns, encrypts, forwards to worker
    +--> Worker DO stores encrypted envelopes (dual-write)
    +--> buildEnvVars() maps field keys to KILOCLAW_ENC_* env vars
    +--> Boot script decrypts and patches openclaw.json
```

Adding a new secret type usually requires only a new catalog entry. New `channel` entries still need the `isEntryConfigured()` bridge updated until the config endpoint returns per-entry status.

## Adding a new secret type

Add an entry to `SECRET_CATALOG_RAW` in `kiloclaw/packages/secret-catalog/src/catalog.ts`:

```ts
{
  id: 'brave-search',              // unique ID, used as map key
  label: 'Brave Search',           // display name in UI
  category: 'tool',                // 'channel' | 'tool' | 'provider' | 'custom'
  icon: 'key',                     // 'send' | 'discord' | 'slack' | 'key'
  order: 1,                        // sort position within category (undefined = last)
  fields: [
    {
      key: 'braveSearchApiKey',    // storage key in DO state + patchSecrets input
      label: 'API Key',            // UI label above input
      placeholder: 'BSA-...',      // placeholder when empty
      placeholderConfigured: 'Enter new key to replace',  // placeholder when configured
      envVar: 'BRAVE_SEARCH_API_KEY',  // container env var name (KILOCLAW_ENC_ prefix added automatically)
      validationPattern: '^BSA-[A-Za-z0-9]{20,}$',  // optional regex (string, not RegExp)
      validationMessage: 'Brave Search keys start with BSA- followed by alphanumeric characters.',
      maxLength: 200,              // enforced by both zod (server) and <input> (client)
    },
  ],
  helpText: 'Get an API key from the Brave Search dashboard.',
  helpUrl: 'https://brave.com/search/api/',
},
```

That's it. The UI, validation, encryption, env var mapping, and sensitivity classification all derive from this entry automatically.

## Entry fields reference

### SecretCatalogEntry

| Field               | Type                      | Required | Description                                                      |
| ------------------- | ------------------------- | -------- | ---------------------------------------------------------------- |
| `id`                | `string`                  | yes      | Unique identifier (e.g. `'telegram'`, `'brave-search'`)          |
| `label`             | `string`                  | yes      | Display name in UI headings                                      |
| `category`          | `SecretCategory`          | yes      | Grouping: `'channel'` \| `'tool'` \| `'provider'` \| `'custom'`  |
| `icon`              | `SecretIconKey`           | yes      | Icon key: `'send'` \| `'discord'` \| `'slack'` \| `'key'`        |
| `fields`            | `SecretFieldDefinition[]` | yes      | One or more secret fields                                        |
| `order`             | `number`                  | no       | Sort position within category (undefined sorts last)             |
| `allFieldsRequired` | `boolean`                 | no       | If true, all fields must be set or cleared together (e.g. Slack) |
| `helpText`          | `string`                  | no       | Inline guidance shown below the input                            |
| `helpUrl`           | `string`                  | no       | Link to external setup docs                                      |
| `injectionMethod`   | `InjectionMethod`         | no       | `'env'` (default) or `'openclaw-secrets'` (future)               |

### SecretFieldDefinition

| Field                   | Type     | Required | Description                                                                  |
| ----------------------- | -------- | -------- | ---------------------------------------------------------------------------- |
| `key`                   | `string` | yes      | Storage key in DO state and `patchSecrets` input (e.g. `'telegramBotToken'`) |
| `label`                 | `string` | yes      | UI label rendered above the input                                            |
| `placeholder`           | `string` | yes      | Input hint when empty                                                        |
| `placeholderConfigured` | `string` | yes      | Input hint when a value is already saved                                     |
| `envVar`                | `string` | yes      | Container env var name (e.g. `'TELEGRAM_BOT_TOKEN'`)                         |
| `validationPattern`     | `string` | no       | Regex string for client + server validation                                  |
| `validationMessage`     | `string` | no       | Error text when validation fails                                             |
| `maxLength`             | `number` | yes      | Max input length (enforced server + client)                                  |

## Lookup helpers

All derived from `SECRET_CATALOG` at module load time:

```ts
import {
  SECRET_CATALOG, // flat array of all entries
  SECRET_CATALOG_MAP, // Map<id, entry>
  ALL_SECRET_FIELD_KEYS, // Set<string> of all field keys
  FIELD_KEY_TO_ENV_VAR, // Map<fieldKey, envVarName>
  ENV_VAR_TO_FIELD_KEY, // Map<envVarName, fieldKey>
  FIELD_KEY_TO_ENTRY, // Map<fieldKey, owning entry>
  ALL_SECRET_ENV_VARS, // Set<string> of all env var names
  getEntriesByCategory, // (category) => sorted entries
  validateFieldValue, // (value, pattern) => boolean
} from '@kilocode/kiloclaw-secret-catalog';
```

## Adding a new icon

If the built-in icons (`send`, `discord`, `slack`, `key`) don't cover your new entry:

1. Add the new key to `SecretIconKeySchema` in `kiloclaw/packages/secret-catalog/src/types.ts`
2. Map it to a React component in `src/app/(app)/claw/components/secret-ui-adapter.ts`

```ts
// types.ts
export const SecretIconKeySchema = z.enum(['send', 'discord', 'slack', 'key', 'search']);

// secret-ui-adapter.ts
import { Search } from 'lucide-react';
const ICON_MAP: Record<SecretIconKey, React.ComponentType<{ className?: string }>> = {
  // ...existing icons...
  search: Search,
};
```

## Adding a new category

Categories control how entries are grouped in the UI. To render a new category section:

1. Add the category to `SecretCategorySchema` in `types.ts` (if not already present)
2. Call `getEntriesByCategory('tool')` in the UI to render entries for that category

The existing categories are: `channel`, `tool`, `provider`, `custom`.

## How secrets flow through the system

### Save flow

1. User enters a token in the UI (`SecretEntrySection`)
2. Client-side validation runs via `validateFieldValue()` from the catalog
3. `patchSecrets` tRPC mutation validates server-side (catalog patterns + `maxLength`)
4. tRPC encrypts the value with `AGENT_ENV_VARS_PUBLIC_KEY` (RSA+AES envelope)
5. Encrypted envelope is forwarded to the worker's `PATCH /api/platform/secrets`
6. Worker DO `updateSecrets()` dual-writes to `channels` (legacy) + `encryptedSecrets` (new)

### Deploy flow

1. `buildUserEnvVars()` calls `buildEnvVars()` with both storage fields
2. `mergeEnvVarsWithSecrets()` decrypts `encryptedSecrets` (keyed by env var names)
3. `decryptChannelTokens()` decrypts `channels` (keyed by field keys, mapped via `FIELD_KEY_TO_ENV_VAR`)
4. Both feed into the `sensitive` bucket
5. Sensitive values are re-encrypted with the per-app env key and prefixed `KILOCLAW_ENC_`
6. The controller's bootstrap decrypts at boot and patches `openclaw.json`

### Backward compatibility

- `patchChannels` tRPC mutation and `/api/platform/channels` worker endpoint still work
- `updateChannels()` delegates to `updateSecrets()` internally
- The dual-write ensures both `channels` and `encryptedSecrets` stay in sync
- The UI uses `patchSecrets` exclusively; `patchChannels` is preserved for any external callers

## Validation patterns

Patterns are stored as strings (not `RegExp`) so they're JSON-serializable across the catalog package boundary. They're compiled to `RegExp` at runtime with caching.

Guidelines for writing patterns:

- Always anchor with `^...$` to match the full value
- Avoid catastrophic backtracking (the catalog test suite checks this)
- Keep patterns permissive enough to accept valid tokens but strict enough to catch obvious mistakes
- The pattern validates format only; length is enforced separately via `maxLength`

## Testing

The catalog package has comprehensive tests in `kiloclaw/packages/secret-catalog/src/__tests__/catalog.test.ts`:

- All entry IDs and field keys are unique
- All icon keys are valid
- All validation patterns compile and don't exhibit catastrophic backtracking
- `FIELD_KEY_TO_ENV_VAR` covers all expected env vars
- `validateFieldValue()` accepts valid tokens, rejects invalid ones
- `getEntriesByCategory()` returns correctly filtered and sorted results

Run tests: `pnpm --filter @kilocode/kiloclaw-secret-catalog test`
