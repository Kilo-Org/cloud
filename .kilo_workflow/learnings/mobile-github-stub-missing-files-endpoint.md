# mobile: hermetic GitHub stub lacks GET /pulls/{n}/files — Files-tab E2E 404s

Symptom: PR-review Files tab shows "Pull request unavailable" while Overview loads fine; nextjs logs `githubPrReview.listFiles 404`; the stub request log shows every pinned endpoint hit except `/files`.

Cause: the stub's pinned surface (REST pull/repo/check-runs/statuses + GraphQL review ops) does not cover `GET /repos/{owner}/{repo}/pulls/{n}/files`, which `listFiles` needs.

Fix (one-off workaround): temporarily add a `/files` handler returning patched-file fixtures to `apps/mobile/e2e/github-api-stub/server.mjs`, restart the stub tmux session, verify, then restore `server.mjs` byte-identical. The permanent fix (teach the stub `/files` + pagination) is intentionally out of scope; do it as a dedicated harness change when a run needs Files-tab E2E regularly.
