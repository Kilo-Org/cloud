# pr-review-d957: re-applying the GitHub-stub temp fixture edits from prior verifier logs

The sanctioned temp edits to `apps/mobile/e2e/github-api-stub/server.mjs` (9 threads
[a,b,c open + r1-r6 resolved], 8 long-patch files, `/files` route, page cap 5,
per-fixture counts) exist only inside `e2e-verifier-r0.log` / `-r1.log` as Edit-tool
unified diffs — no patch file was ever saved.

Extraction traps (cost ~30min in r3):
1. Each Edit block appears TWICE consecutively in the log (terminal echo) — dedupe
   consecutive identical blocks (12 blocks → 6 unique).
2. The diffs' context lines lost leading whitespace (a log artifact; dedent varies per
   hunk: 2-4 spaces) — they do NOT match the pristine file, so `git apply` of the
   concatenated hunks fails.
3. The `+` lines and the `@@` line numbers ARE intact; `@@` numbers are in
   evolving-file coordinates (each Edit diffed the already-edited file).

Working recipe: `git apply` hunks 1-2 (their context survived), then for hunks 3-6
extract only the `+` lines, re-indent to match sibling code, and insert by anchored line
surgery at the real file locations (thread-array close, `conversationComment(2006,...)`,
`changed_files: 2,` triple, before the check-runs route). r1's page-cap edit (not in r0)
goes in the `PrReviewThreads` handler verbatim from the r1 log. Verify with
`node --check` plus curl probes: `/pulls/1/files` → 8 files with 4-13KB patches;
GraphQL `PrReviewThreads` page 1 → 5 threads hasNextPage=true, page 2 → 4 threads
(r4-r6,c). r3's ready-made hunk files and insert content are in
`$SCRATCH/e2e-r3/hunk*.patch` / `hunk*-insert.txt`.
