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
- Generated files (lock files, migration snapshots and journals)
- Patterns already used elsewhere in the codebase

**Database migrations (.sql files - DO review these):**

- Table-locking DDL (`CREATE INDEX`, `ALTER TABLE`) on populated tables; flag if not using `CONCURRENTLY`
- Adding `NOT NULL` without a `DEFAULT` on existing columns
- Dropping columns or tables that may still be read by running application code
- Large backfills or data transforms without batching
- Missing partial index opportunities (for example, `WHERE col IS NOT NULL`)
