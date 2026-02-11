# Link PostHog to Anonymous Extension Usage

## Problem

Cannot link PostHog analytics (`distinct_id`) with backend usage data (`anon:ip`) for anonymous extension users.

**Current**: PostHog generates `distinct_id` → Backend creates `anon:{ip}` → No connection

**Goal**: Pass PostHog `distinct_id` from extensions to backend via `x-posthog-distinct-id` header

---

## Deployment Order

### ⚠️ CRITICAL: Backend FIRST, Extensions AFTER

**Why**: Backend changes are backward-compatible (new field is nullable, header is optional).

**Order**:
1. ✅ Deploy backend → Extensions sending header before this = header ignored (safe)
2. ✅ Deploy extensions → Can be days/weeks later, no coordination needed

**Independent**: YES - No tight coupling, deploy at your own pace

---

## Repository 1: kilocode-backend (THIS REPO)

**GitHub**: https://github.com/Kilo-Org/cloud

### File 1: `src/db/migrations/0005_add_posthog_distinct_id_to_usage_metadata.sql` (NEW)
```sql
ALTER TABLE microdollar_usage_metadata ADD COLUMN posthog_distinct_id TEXT;

-- Use CONCURRENTLY to avoid blocking writes on large table
-- Note: Cannot be run in a transaction, may need separate execution
CREATE INDEX CONCURRENTLY idx_microdollar_usage_metadata_posthog_distinct_id 
ON microdollar_usage_metadata(posthog_distinct_id);
```

**⚠️ Migration Note**: `CREATE INDEX CONCURRENTLY` cannot run in a transaction. If your migration runner wraps statements in transactions, you may need to:
1. Run the ALTER TABLE in one migration
2. Run the CREATE INDEX CONCURRENTLY separately (or use a non-concurrent index if table is small)

### File 2: `src/db/schema.ts` (line ~615)
**Before**:
```typescript
export const microdollar_usage_metadata = pgTable(
  'microdollar_usage_metadata',
  {
    // ... 14 existing fields ...
    has_tools: boolean(),
  },
  table => [index('idx_microdollar_usage_metadata_created_at').on(table.created_at)]
);
```

**After**:
```typescript
export const microdollar_usage_metadata = pgTable(
  'microdollar_usage_metadata',
  {
    // ... 14 existing fields ...
    has_tools: boolean(),
    posthog_distinct_id: text(), // NEW
  },
  table => [
    index('idx_microdollar_usage_metadata_created_at').on(table.created_at),
    index('idx_microdollar_usage_metadata_posthog_distinct_id').on(table.posthog_distinct_id), // NEW
  ]
);
```

### File 3: `src/app/api/openrouter/[...path]/route.ts` (lines ~250, ~265)
**Before** (line ~265):
```typescript
const usageContext: MicrodollarUsageContext = {
  // ... other fields ...
  posthog_distinct_id: isAnonymousContext(user) ? undefined : user.google_user_email,
  // ... other fields ...
};
```

**After** (add line ~250, modify line ~265):
```typescript
// NEW - line ~250
// Validate and sanitize PostHog distinct_id from header
const rawDistinctId = request.headers.get('x-posthog-distinct-id');
const posthogDistinctIdFromHeader = rawDistinctId && rawDistinctId.length <= 255 && /^[a-zA-Z0-9_-]+$/.test(rawDistinctId)
  ? rawDistinctId
  : undefined;

const usageContext: MicrodollarUsageContext = {
  // ... other fields ...
  posthog_distinct_id: isAnonymousContext(user) 
    ? (posthogDistinctIdFromHeader ?? undefined)  // CHANGED
    : user.google_user_email,
  // ... other fields ...
};
```

**⚠️ Security Note**: Header is validated (max 255 chars, alphanumeric + underscore/hyphen only) to prevent DB bloat from malicious clients.

### File 4: `src/lib/processUsage.ts` (VERIFY ONLY)
Check that `posthog_distinct_id` is included in INSERT around line ~550-600. Likely already works.

---

## Repository 2: Kilo-Org/kilocode (VSCode & JetBrains)

**GitHub**: https://github.com/Kilo-Org/kilocode
**Note**: Both extensions share TypeScript API code

### File 1: `src/core/kilocode/anonymous-id.ts` (NEW)
```typescript
import * as vscode from 'vscode';
import crypto from 'crypto';

const STORAGE_KEY = 'kilocode.posthogAnonymousId';

export async function getPostHogAnonymousId(context: vscode.ExtensionContext): Promise<string> {
  let anonymousId = context.globalState.get<string>(STORAGE_KEY);
  
  if (!anonymousId) {
    const machineId = vscode.env.machineId;
    const hash = crypto.createHash('sha256')
      .update(machineId)
      .update('kilocode-posthog')
      .digest('hex')
      .substring(0, 16);
    
    anonymousId = `vscode-${hash}`;
    await context.globalState.update(STORAGE_KEY, anonymousId); // AWAIT to ensure persistence
  }
  
  return anonymousId;
}
```

**⚠️ Note**: Function is async and awaits `globalState.update()` to ensure ID is persisted before extension deactivates.

### File 2: `src/api/providers/kilocode-openrouter.ts` (line ~60)
**Before**:
```typescript
override customRequestOptions(metadata?: ApiHandlerCreateMessageMetadata) {
  const headers: Record<string, string> = {
    [X_KILOCODE_EDITORNAME]: getEditorNameHeader(),
  };
  
  // ... existing header logic ...
  
  return Object.keys(headers).length > 0 ? { headers } : undefined;
}
```

**After**:
```typescript
override customRequestOptions(metadata?: ApiHandlerCreateMessageMetadata) {
  const headers: Record<string, string> = {
    [X_KILOCODE_EDITORNAME]: getEditorNameHeader(),
  };
  
  // ... existing header logic ...
  
  // NEW: Add PostHog distinct_id
  const distinctId = this.options.posthogDistinctId;
  if (distinctId) {
    headers['x-posthog-distinct-id'] = distinctId;
  }
  
  return Object.keys(headers).length > 0 ? { headers } : undefined;
}
```

### File 3: `src/shared/api.ts`
**Before**:
```typescript
export interface ApiHandlerOptions {
  // ... existing fields ...
}
```

**After**:
```typescript
export interface ApiHandlerOptions {
  // ... existing fields ...
  posthogDistinctId?: string; // NEW
}
```

### File 4: `src/core/webview/ClineProvider.ts`
**Before**:
```typescript
const apiHandler = new KilocodeOpenrouterHandler({
  // ... existing options ...
});
```

**After**:
```typescript
import { getPostHogAnonymousId } from '../kilocode/anonymous-id'; // NEW

const posthogDistinctId = await getPostHogAnonymousId(this.context); // NEW - await async function

const apiHandler = new KilocodeOpenrouterHandler({
  // ... existing options ...
  posthogDistinctId, // NEW
});
```

---

## Validation Queries

```sql
-- Check coverage rate
SELECT 
  COUNT(*) FILTER (WHERE mum.posthog_distinct_id IS NOT NULL) * 100.0 / COUNT(*) as coverage_pct
FROM microdollar_usage mu
JOIN microdollar_usage_metadata mum ON mu.id = mum.id
WHERE mu.kilo_user_id LIKE 'anon:%' AND mu.created_at > NOW() - INTERVAL '7 days';

-- View anonymous users with PostHog tracking
SELECT 
  mu.kilo_user_id,
  mum.posthog_distinct_id,
  COUNT(*) as requests,
  SUM(mu.cost) / 1000000.0 as cost_usd
FROM microdollar_usage mu
JOIN microdollar_usage_metadata mum ON mu.id = mum.id
WHERE mu.kilo_user_id LIKE 'anon:%' AND mum.posthog_distinct_id IS NOT NULL
GROUP BY mu.kilo_user_id, mum.posthog_distinct_id
ORDER BY requests DESC LIMIT 20;
```

---

## Summary

- **2 repositories**, **8 files**
- **1 backend endpoint** creates `anon:ip`: `/api/openrouter/` (no auth + free model)
- **Used by**: VSCode & JetBrains only (not CLI, not web)
- **Deploy**: Backend first (safe), extensions after (independent)
