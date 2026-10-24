# Code Review Instructions

# WHAT TO REVIEW

**Flag these (high confidence only):**

- A security issue in one lens. Name the lens in the comment. If two lenses fit, the victim decides: cross-user or cross-tenant data exposure is `users`; credential, session, role, or scope mechanics are `auth`.
  - `platform` - harm to Kilo: billing and credit accounting, usage metering, quotas and limits, signup and abuse controls, entitlement gating such as free models, cost or resource blow-up, availability.
  - `users` - harm to a Kilo user or organization: cross-user or cross-tenant reads and writes, IDOR, missing ownership or authorization check, invitations and sharing, session or account takeover, private-data leaks.
  - `third-party` - harm to others through Kilo: SSRF and outbound fetch, spam or abuse through agents, provider or integration credential misuse, supply-chain execution, chains that cross the platform and user boundaries.
  - `auth` - credential and identity lifecycle: sign-in, recovery, linking, organization switching, credential refresh, logout, revoke, suspend, delete, machine identity, and the roles and scopes on those paths.
- Runtime errors (null/undefined access, missing await)
- Logic bugs (wrong conditions, off-by-one)
- Typos that cause runtime errors
- Breaking API changes
- MCP write exposure: a mutation newly published to the Kilo MCP catalog (`services/kilo-mcp/catalog.json`, generated from `apps/web/src/scripts/mcp-catalog/`) that issues or rotates credentials or tokens, reads or writes secrets, changes organization membership or authorization, deploys, charges or purchases, or deletes data - flag the path unless the PR explains why an MCP agent may call it

**Skip these:**

- Style preferences
- TODO comments
- console.log statements
- Generated files (lock files, migration snapshots & journals)
- Patterns already used elsewhere in the codebase

**Database migrations (.sql files - DO review these):**

- Table-locking DDL (`CREATE INDEX`, `ALTER TABLE`) on populated tables - flag if not using `CONCURRENTLY`
- Adding `NOT NULL` without a `DEFAULT` on existing columns
- Dropping columns/tables that may still be read by running application code
- Large backfills or data transforms without batching
- Missing partial index opportunities (e.g. `WHERE col IS NOT NULL`)

# SECURITY EVIDENCE

Report a security issue only from code you read. Every security comment names the lens, the boundary the changed code crosses, and the missing protection. Only `CRITICAL` needs the whole chain:

```
actor -> input -> boundary -> impact -> preconditions
```

A chain that harms both the platform and its users is `third-party`.

Check each protection that the changed line needs before you call it missing:

- Authentication, authorization, and ownership.
- Tenant filter on every read and write.
- Input validation and output encoding.
- Rate limit, size limit, and time limit.
- Idempotency, atomicity, and race safety for money, credits, and metering.
- Secret and private-data redaction in logs, errors, and events.
- Outbound host allowlist for any fetch or webhook.

Do not assume that a protection exists in code you did not read. Follow the changed caller when the repository has it. If a caller, a dependency, or a deployment setting stays unavailable, report the gap as `[INFERENCE]` in the summary. Do not state that an exploit succeeded.

Map the severity:

- CRITICAL: the diff proves the full chain.
- WARNING: a named protection is absent on a path the diff reaches.
- SUGGESTION: hardening.
- An unproven concern goes in the summary, not in a comment.

# COMMENT FORMAT

```
**[SEVERITY]:** Brief description

Explanation of the issue.
```

**Severities:** CRITICAL (blocks merge), WARNING (should fix), SUGGESTION (nice to have)

## Suggestion Blocks (for typos and simple fixes)

For single-line fixes, use GitHub's suggestion syntax.

**CRITICAL RULES FOR SUGGESTION BLOCKS:**

1. The suggestion block REPLACES the ENTIRE commented line
2. Put ONLY the corrected version of that ONE line inside the block
3. Do NOT include the old/wrong code
4. Do NOT include multiple lines or surrounding context
5. Do NOT include both before and after versions

### CORRECT Example

If line 42 has a typo: `return searchTerm ? `${baseUrl}&name=${searchTem}` : baseUrl;`

Post this comment on line 42:

````markdown
**CRITICAL:** Variable name typo - `searchTem` should be `searchTerm`

```suggestion
  return searchTerm ? `${baseUrl}&name=${searchTerm}` : baseUrl;
```
````

### WRONG Examples (do NOT do these)

**WRONG - includes both old and new code:**

```suggestion
  return searchTerm ? `${baseUrl}&name=${searchTem}` : baseUrl;
  return searchTerm ? `${baseUrl}&name=${searchTerm}` : baseUrl;
```

**WRONG - includes multiple lines/context:**

```suggestion
const buildUrl = (searchTerm: string): string => {
  const baseUrl = `${API}/?page=1`;
  return searchTerm ? `${baseUrl}&name=${searchTerm}` : baseUrl;
};
```

**WRONG - shows a diff format:**

```suggestion
- return searchTerm ? `${baseUrl}&name=${searchTem}` : baseUrl;
+ return searchTerm ? `${baseUrl}&name=${searchTerm}` : baseUrl;
```

The suggestion block replaces ONLY the line you commented on. Put ONLY the corrected version of that single line.

## Summary Format

Use this EXACT format for the summary comment. ALWAYS start with `<!-- kilo-review -->` marker.

### When Issues Found:

```markdown
<!-- kilo-review -->

## Code Review Summary

**Status:** X Issues Found | **Recommendation:** Address before merge

### Executive Summary

One concise sentence naming the highest-risk issue and affected area.

**Assumptions:** `[INFERENCE]` gaps and unproven concerns, or `none`.

### Overview

| Severity   | Count |
| ---------- | ----- |
| CRITICAL   | X     |
| WARNING    | X     |
| SUGGESTION | X     |

<details>
<summary><b>Issue Details (click to expand)</b></summary>

#### CRITICAL

| File          | Line | Issue       |
| ------------- | ---- | ----------- |
| `src/file.ts` | 42   | Description |

</details>

<details>
<summary><b>Files Reviewed (X files)</b></summary>

- `src/file.ts` - X issues

</details>
```

### When No Issues Found:

```markdown
<!-- kilo-review -->

## Code Review Summary

**Status:** No Issues Found | **Recommendation:** Merge

### Executive Summary

One concise sentence describing the reviewed scope and confidence level.

**Assumptions:** `[INFERENCE]` gaps and unproven concerns, or `none`.

<details>
<summary><b>Files Reviewed (X files)</b></summary>

- `src/file.ts`
- `src/other.ts`

</details>
```
