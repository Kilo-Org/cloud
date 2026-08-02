# Gateway/auth facts for local efficient-routing E2E (apps/web)

Verified 2026-07-28 on the efficient-custom-pool-e6e3 worktree:

- Session-cookie requests NEVER thread organizationId through `getUserFromAuth` (server.ts: org
  header is read only in the `Authorization:` bearer path, "only used for extension-originated
  requests"). Org-context routing assertions must use the user's own API JWT (rendered in the
  profile page API-key textbox) as `Authorization: Bearer` plus `x-kilocode-organizationid`.
  Never print the token; extract it in-page via `page.evaluate` and use it there.
- Org-context billing charges the ORGANIZATION balance; personal-context charges the user. Top up
  the right entity before real calls.
- Balance top-up needs the denormalized counter: `UPDATE kilocode_users SET
  total_microdollars_acquired=...` (same for `organizations`). Inserting only a
  `credit_transactions` row does NOT change the balance (402 persists).
- Fake login in a browser: `/users/sign_in?fakeUser=...` 307-redirects to NEXTAUTH_URL, which in an
  offset worktree points at a dead port (e.g. 192.168.1.10:3000). The session cookie is set by the
  307 response before the failed redirect — navigate to the target page directly afterwards.
  Robust alternative: `GET /api/auth/csrf` then POST `/api/auth/callback/fake-login`
  (form-encoded csrfToken + email + json:true) via page.evaluate from any loaded page.
- Org model deny list for fixtures: `organizations.settings.model_deny_list` (jsonb array of model
  ids) — immediately makes saved pool entries render `Unavailable` through the web
  annotateConfiguredPool path (enterprise orgs).
