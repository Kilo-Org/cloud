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
      "used": 1.50,
      "limit": 2.00,
      "reset_at": "2026-03-11T00:00:00Z"
    }
  ],
  "plan": "pro",
  "balance_usd": 10.50
}
```

All values in **USD** with decimals.

## Implementation Steps

### Step 1: Create Endpoint
- File: `src/app/api/gateway/usage/route.ts`
- Method: GET
- Location: `src/app/api/gateway/usage/`

### Step 2: Authentication
- Use `getUserFromAuth()` from `src/lib/user.server.ts` as the auth entry point
- This validates the Bearer token and returns the authenticated user

### Step 3: Query Usage Data
- Call `getBalanceAndOrgSettings()` to get balance, settings, and plan
- Note: This returns computed balance but NOT raw usage/limit values
- Need to separately query `organization_user_usage` and `organization_user_limits` tables for the limits array
- No existing helper exposes raw usage + limit — may need a new query or helper function
- For non-org users: use `getBalanceForUser()` from `src/lib/user.balance.ts`
- Reference: `src/lib/organizations/organization-usage.ts`

## No-Limit Case
- If user has no limit configured (`microdollar_limit IS NULL`): treat as unlimited
- Return `limits: []` for no-limit case (same as non-org users)

### Step 4: Format Response
- Convert microdollars to USD using `fromMicrodollars()` from `@/lib/utils`
- Compute `reset_at` as next midnight UTC for daily limits
- Return JSON with limits array, plan, and balance_usd

## Files to Modify

| File | Change |
|------|--------|
| `src/app/api/gateway/usage/route.ts` | Create new endpoint |

## Files to Reference

| File | Purpose |
|------|---------|
| `src/lib/organizations/organization-usage.ts` | getBalanceAndOrgSettings() for balance/plan |
| `src/lib/user.server.ts` | getUserFromAuth() - correct auth entry point |
| `src/lib/user.balance.ts` | getBalanceForUser() for non-org users |
| `src/lib/organizations/organization-types.ts` | Type definitions |
| `src/lib/utils.ts` | fromMicrodollars() for unit conversion |

## Response Units
- All values in **USD** (not microdollars or tokens)
- Use `fromMicrodollars()` to convert DB values to USD
- Format: `"used": 1.50` (USD with decimals), `"balance_usd": 10.50`

## Non-Org Users
- If authenticated user has no organizationId: `limits: []`
- Balance still available via `getBalanceForUser()`

## No-Limit Case
- If user has no limit configured (`microdollar_limit IS NULL`): treat as unlimited
- Return `limits: []` for no-limit case (same as non-org users)

## Reset At Computation
- DB doesn't store `reset_at` explicitly
- For daily limits: compute as next midnight UTC

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
