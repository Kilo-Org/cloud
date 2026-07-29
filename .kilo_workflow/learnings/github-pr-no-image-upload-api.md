# No programmatic image upload for PR bodies — use textual evidence

Symptom: a run needs before/after E2E screenshots inline in a PR body and
cannot find an upload path.
Cause: GitHub's `upload/assets` endpoint requires a browser session + CSRF
token (`POST` with a `gh` API token → 404); `gh` has no asset-upload command;
GraphQL has no asset mutation. The orphan-branch + raw-URL workaround violates
the fixture rule (never commit generated E2E fixtures) and pollutes the repo.
Fix: do not probe again. Follow the repo convention (verified 2026-07-28:
zero of 25 open PRs embed images; prior mobile workflow PRs #4773/#4776 carry
none): the Visual Changes table names each verified screenshot file, what it
shows, and the verifier's judgment. Humans wanting pixels re-run the flow or
ask for the images in review.
