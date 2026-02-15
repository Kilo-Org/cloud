# CLI V1 Rollout - Inactive User Re-engagement

Grant $1 credit (7-day expiry) to users who used Kilo before but not in the last 30 days.

## Two-Phase Approach

1. **Phase 1 (cohort):** Tags eligible users into `cli-v1-rollout` cohort via SQL
2. **Phase 2 (grant):** Grants credits to cohort members

Both scripts are idempotent - safe to re-run.

## Running the Scripts

**Note:** Production env vars are required. Test `vercel env run` first:

```bash
vercel env run --environment=production -- node -e "console.log(process.env.POSTGRES_URL ? 'OK' : 'NOT SET')"
```

### Phase 1: Tag Cohort

```bash
# Dry run (default) - shows count of users that would be tagged
vercel env run --environment=production -- pnpm script src/scripts/d2025-02-04_cli-v1-rollout-cohort.ts

# Apply
vercel env run --environment=production -- pnpm script src/scripts/d2025-02-04_cli-v1-rollout-cohort.ts --apply
```

### Phase 2: Grant Credits

```bash
# Dry run (default) - shows count of cohort members
vercel env run --environment=production -- pnpm script src/scripts/d2025-02-04_cli-v1-rollout-grant.ts

# Apply
vercel env run --environment=production -- pnpm script src/scripts/d2025-02-04_cli-v1-rollout-grant.ts --apply
```

## Rollout Checklist

1. [ ] Test `vercel env run` with simple command
2. [ ] Run Phase 1 dry run, review user count
3. [ ] Run Phase 1 with `--apply`
4. [ ] Run Phase 2 dry run, verify cohort count matches
5. [ ] Run Phase 2 with `--apply`
6. [ ] Verify credits granted in admin panel

## Fallback (if vercel env run doesn't work)

```bash
vercel env pull .env.production
source .env.production  # or use dotenv-cli
pnpm script src/scripts/d2025-02-04_cli-v1-rollout-cohort.ts
```
