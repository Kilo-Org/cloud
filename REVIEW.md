# Code Review Instructions

# WHAT TO REVIEW

**Flag these (high confidence only):**

- Security vulnerabilities (injection, XSS, auth bypass)
- Runtime errors (null/undefined access, missing await)
- Logic bugs (wrong conditions, off-by-one)
- Typos that cause runtime errors
- Breaking API changes

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

<details>
<summary><b>Files Reviewed (X files)</b></summary>

- `src/file.ts`
- `src/other.ts`

</details>
```
