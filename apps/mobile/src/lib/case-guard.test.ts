// Source guard for the "casing is the catalog's job" class: code must never
// re-case display text, because `String.prototype.toUpperCase()` /
// `toLowerCase()` ignore the active language (a Turkish `i` uppercases to
// `İ`, not `I`). A bare call is only allowed where the result is not shown —
// search folding, a comparison or a stable composition key — and every such
// site is listed below with its reason. Locale-aware `toLocaleUpperCase()` /
// `toLocaleLowerCase()` calls stay allowed.
//
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { readdirSync, readFileSync } from 'node:fs';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { dirname, join, relative } from 'node:path';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Files that may hold a bare `toUpperCase()` / `toLowerCase()` call, each with
 * the reason the result never reaches the screen. A new call in any other file
 * fails the guard; a new call in a listed file must come with its own review.
 */
const ALLOWED_NON_DISPLAY: Readonly<Record<string, string>> = {
  'i18n/language-rows.ts': 'language-tag search prefix',
  'lib/format.ts': 'currency-code comparison key',
  'lib/github-pr-url.ts': 'URL scheme/host comparison',
  'lib/glanceable/widget-actions.ts': 'repository full-name comparison',
  'lib/hooks/use-trusted-hosts.ts': 'trusted-host comparison key',
  'lib/pr-review/recent-prs.ts': 'recents composition key',
  'lib/pr-review/pending-review-provider.tsx': 'draft composition key',
  'lib/route-registry.ts': 'route composition key',
  'lib/persist/encrypted-kv.ts': 'SQLite pragma comparison',
  'lib/kilo-pass/subscription-card-state.ts': 'app-account-token comparison',
  'lib/kilo-pass/dev-storekit-refund.ts': 'refund-status comparison',
  'lib/voice-input/voice-input-language.ts': 'language-tag normalization',
  'lib/model-picker-rows.ts': 'model search folding',
  'lib/repo-picker-filter.ts': 'repo search folding',
  'lib/use-new-session-repos.ts': 'repo key normalization',
  'lib/organization-invoice-download.ts': 'filename comparison',
  'lib/agent-attachments/validate.ts': 'file-extension normalization',
  'lib/auth/passkey-client.ts': 'credential-error classification',
  'lib/auth/passkey-client.ts': 'credential-error classification key',
  'lib/auth/use-native-auth.ts': 'email normalization',
  'lib/telemetry/install-error-reporting.ts': 'hostname comparison',
  'lib/pr-review/diff/highlight.ts': 'file-extension normalization',
  'lib/pr-review/diff/navigator-file-filter.ts': 'search folding',
  'lib/pr-review/merge/merge-result-banner-store.ts': 'review-key composition',
  'lib/pr-review/viewed-files.ts': 'viewed-file key composition',
  'lib/pr-review/provider-pr-url.ts': 'URL scheme/host comparison',
  'components/login/idle-auth.tsx': 'email normalization',
  'components/organization/invite-member-sheet.tsx': 'email normalization',
  'components/share/share-destination-list.tsx': 'search folding',
  'components/pr-review/discussion/comment-row.tsx': 'login comparison',
  'components/pr-review/discussion/pr-review-discussion-list.tsx': 'login comparison',
  'components/pr-review/merge/pr-merge-section-parts.tsx': 'merge-method key normalization',
  'components/agents/attachment-picker.ts': 'file-extension/mime normalization',
  'components/agents/code-block-model.ts': 'language-identifier normalization',
  'components/agents/live-session-filters.ts': 'search folding',
  'components/agents/markdown-html.tsx': 'HTML tag-name comparison',
  'components/agents/markdown-image.tsx': 'hostname comparison',
  'components/agents/markdown-link-confirm.ts': 'hostname comparison',
  'components/agents/new-session-prefill.ts': 'repo full-name comparison',
  'components/agents/repo-selector.tsx': 'repo key normalization',
  'components/agents/session-terminal-error.ts': 'service-message classification',
  'components/agents/tool-card-image-cache.ts': 'mime-subtype normalization',
  'components/agents/tool-list-model.ts': 'status-note comparison',
  'app/(app)/kiloclaw/[instance-id]/settings/model-list.tsx': 'model search folding',
};

/** The `.toUpperCase(` / `.toLowerCase(` call the class is about. */
const BARE_CASE_CALL = /\.to(?:Upper|Lower)Case\(/g;

/** Keeps a comment that mentions the call from satisfying or failing the guard. */
function stripComments(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, match => match.replaceAll(/[^\n]/g, ''))
    .replaceAll(/\/\/[^\n]*/g, '');
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(full);
    }
    const isSource = entry.name.endsWith('.ts') || entry.name.endsWith('.tsx');
    if (!isSource || entry.name.includes('.test.')) {
      return [];
    }
    return [full];
  });
}

const scannedFiles = ['components', 'lib', 'app'].flatMap(dir => sourceFiles(join(SRC, dir)));

describe('case guard', () => {
  it('re-cases display text only through the catalog, never a bare case call', () => {
    const violations = scannedFiles.flatMap(file => {
      const relativePath = relative(SRC, file);
      const code = stripComments(readFileSync(file, 'utf8'));
      const calls = [...code.matchAll(BARE_CASE_CALL)];
      return calls.length > 0 && !Object.hasOwn(ALLOWED_NON_DISPLAY, relativePath)
        ? [relativePath]
        : [];
    });
    expect(
      violations,
      'use the active locale (toLocaleUpperCase/toLocaleLowerCase) or add a reasoned allowlist entry'
    ).toEqual([]);
  });

  it('never raises a bare case call in the permission card or the choice row', () => {
    const files = [
      'components/ui/choice-row.tsx',
      'components/agents/permission-card.tsx',
    ] as const;
    for (const relativePath of files) {
      const code = stripComments(readFileSync(join(SRC, relativePath), 'utf8'));
      expect(
        [...code.matchAll(BARE_CASE_CALL)],
        `${relativePath} must let the catalog carry the case`
      ).toEqual([]);
      expect(code, `${relativePath} must not re-case a label`).not.toContain('capitalize');
    }
  });
});
