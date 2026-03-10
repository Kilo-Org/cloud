# Plan: Gateway Usage Summary Endpoint

## Issue
https://github.com/Kilo-Org/cloud/issues/921

Add a lightweight authenticated endpoint that returns the current user's quota/usage state for the Kilo gateway.

## Proposed Endpoint

```
GET https://api.kilo.ai/api/gateway/usage
Authorization: Bearer <api_key>
```

### Response Shape

```json
{
  "limits": [
    {
      "period": "daily",
      "used": 150000,
      "limit": 200000,
      "reset_at": "2026-03-11T00:00:00Z"
    }
  ],
  "plan": "pro",
  "balance_usd": 10.50
}
```

## Implementation Steps

### Step 1: Create Endpoint
- File: `src/app/api/gateway/usage/route.ts`
- Method: GET
- Location: `src/app/api/gateway/usage/`

### Step 2: Authentication
- Validate Bearer token against organization API keys
- Reference: `src/lib/tokens.ts` for token validation
- Reference: `src/app/api/gateway/[...path]/route.ts` for auth pattern

### Step 3: Query Usage Data
- Query from `organization_user_usage` table
- Query from `organization_user_limits` table  
- Query from `organization_user_credits` for balance
- Reference: `src/lib/organizations/organization-usage.ts`

### Step 4: Format Response
- Return JSON with limits array, plan, and balance_usd
- Match the response shape from the issue

## Files to Modify

| File | Change |
|------|--------|
| `src/app/api/gateway/usage/route.ts` | Create new endpoint |

## Files to Reference

| File | Purpose |
|------|---------|
| `src/lib/organizations/organization-usage.ts` | Existing usage logic |
| `src/lib/tokens.ts` | Token validation |
| `src/app/api/gateway/[...path]/route.ts` | Auth pattern |
| `src/lib/organizations/organization-types.ts` | Type definitions |

## Testing

```bash
# Test locally:
curl -vvv 'http://localhost:3000/api/gateway/usage' \
  -H 'Authorization: Bearer <test_api_key>'
```

## Notes

- This endpoint enables third-party tools (like OpenClaw) to display usage bars and warn before hitting limits
- Complements per-request token tracking in VS Code extension with server-authoritative summary
- Related: kilocode#4004 (credit usage visibility across clients)
