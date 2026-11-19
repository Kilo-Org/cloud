/** Android intent-filter pathPatterns for app.kilo.ai, mirroring
 * androidPathPatterns() in @kilocode/app-shared/universal-links.
 * Plain .js because the Expo config loader cannot consume workspace TS
 * (same reason env-keys.js exists). Drift is CI-caught by
 * universal-link-paths.test.ts — keep the two in sync there, never silently.
 * A row compiles `*`/`**` to `.*`, which crosses `/`; `pathPattern` is a
 * simple glob with no character classes, so a one-segment row cannot be
 * expressed and the organization root is deliberately absent (the table row
 * still serves iOS and the runtime matcher).
 * @type {string[]} */
export const UNIVERSAL_LINK_PATH_PATTERNS = [
  '/home',
  '/profile',
  '/profile/preferences',
  '/credits',
  '/usage',
  '/invoices',
  '/data-exports',
  '/byok',
  '/integrations',
  '/subscriptions/kilo-pass',
  '/cloud/sessions',
  '/cloud/sessions/.*',
  '/security-agent',
  '/security-agent/findings',
  '/security-agent/config',
  '/code-reviews',
  '/code-reviews/.*',
  '/organizations/.*/security-agent',
  '/organizations/.*/security-agent/findings',
  '/organizations/.*/security-agent/config',
  '/organizations/.*/code-reviews',
  '/organizations/.*/code-reviews/.*',
  '/organizations/.*/overview',
  '/organizations/.*/integrations',
  '/organizations/.*/usage-details',
  '/organizations/new',
  '/organizations/create',
  '/pr-review/gitlab/.*',
  '/pr-review/bitbucket/.*',
  '/pr-review/.*/.*/.*',
  '/s/.*',
];
