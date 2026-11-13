/** Android intent-filter pathPatterns for app.kilo.ai, mirroring
 * androidPathPatterns() in @kilocode/app-shared/universal-links.
 * Plain .js because the Expo config loader cannot consume workspace TS
 * (same reason env-keys.js exists). Drift is CI-caught by
 * universal-link-paths.test.ts — keep the two in sync there, never silently.
 * A row compiles `*`/`**` to `.*` (crossing `/`); the bare organization row
 * states its own one-segment `[^/]+` so it cannot swallow the web-only pages
 * under it, and no other row's pattern changes.
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
  '/organizations/[^/]+',
  '/pr-review/gitlab/.*',
  '/pr-review/bitbucket/.*',
  '/pr-review/.*/.*/.*',
  '/s/.*',
];
