/**
 * GitHub source diagnostics for the morning briefing.
 *
 * When `collectGithub` returns zero issues, we want to tell the user *why*
 * — bad token type, missing scopes, fine-grained PAT can't see collaborator
 * repos, etc. — instead of a single generic "no issues" string.
 *
 * This module provides the pure pieces of that logic (token classification,
 * scope parsing, message builders). The impure pieces (running `gh api`,
 * reading env vars) live next to `collectGithub` in `index.ts` and feed
 * structured context into `buildGithubEmptySectionLines` /
 * `buildGithubEmptySummary` below.
 */

export type GithubTokenType = 'classic' | 'fine-grained' | 'app' | 'oauth' | 'unknown';

/**
 * Scopes the brief query (`gh search issues --involves @me`) needs to cover
 * private repositories. `public_repo` alone is enough for public issues, but
 * the brief's empty-state path is the user telling us they expected results
 * and got nothing — at that point, suggesting `repo` is the right hint.
 *
 * Only classic PATs have OAuth scopes. Fine-grained PATs use a different
 * permission model and don't surface `X-OAuth-Scopes` at all.
 */
export const RECOMMENDED_BRIEFING_SCOPES = ['repo'] as const;

/**
 * Classify a GitHub token by its prefix. Source:
 * https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-authentication-to-github#githubs-token-formats
 */
export function classifyGithubToken(token: string | undefined | null): GithubTokenType {
  if (!token) return 'unknown';
  if (token.startsWith('ghp_')) return 'classic';
  if (token.startsWith('github_pat_')) return 'fine-grained';
  if (token.startsWith('ghs_')) return 'app';
  if (token.startsWith('gho_')) return 'oauth';
  return 'unknown';
}

/**
 * Parse the `X-OAuth-Scopes` header out of a raw HTTP headers blob (the
 * output of `gh api -i ...`). Returns an empty array if the header is
 * missing, empty, or the input is malformed.
 *
 * Fine-grained PATs return an empty / missing `X-OAuth-Scopes` value — they
 * use the permissions model instead. Callers should branch on token type
 * before interpreting an empty result.
 */
export function parseOAuthScopesHeader(headersBlob: string): string[] {
  // `[ \t]*` instead of `\s*` so the inter-token whitespace can't gobble a
  // newline and pick up the next header line as the scopes value.
  const match = /^x-oauth-scopes:[ \t]*(.*)$/im.exec(headersBlob);
  if (!match) return [];
  return match[1]
    .split(',')
    .map(scope => scope.trim())
    .filter(scope => scope.length > 0);
}

/** Returns the recommended scopes that are NOT in the granted-scopes list. */
export function missingBriefingScopes(grantedScopes: readonly string[]): string[] {
  return RECOMMENDED_BRIEFING_SCOPES.filter(needed => !grantedScopes.includes(needed));
}

/**
 * Discriminated union of all the empty-result situations the brief can
 * surface. Pure builders below render this into markdown + a short summary.
 */
export type GithubEmptyResultContext =
  | {
      tokenType: 'classic';
      login: string;
      scopes: string[];
      missingScopes: string[];
    }
  | {
      tokenType: 'fine-grained';
      login: string;
      accessibleRepoCount: number;
    }
  | {
      tokenType: 'app' | 'oauth' | 'unknown';
      login: string | null;
    };

const FINE_GRAINED_LEARN_MORE_URL =
  'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#fine-grained-personal-access-tokens';

/**
 * Build the bullet-list lines that go under the `## GitHub` section when
 * the query returned zero items but the token IS authenticated. Each line
 * is a separate Markdown line (no leading `- ` — the brief assembler
 * wraps as needed; this returns paragraph-style copy).
 */
export function buildGithubEmptySectionLines(ctx: GithubEmptyResultContext): string[] {
  switch (ctx.tokenType) {
    case 'classic': {
      if (ctx.missingScopes.length === 0) {
        return [
          'No open issues involving you were found.',
          '',
          `Authenticated as \`${ctx.login}\` (classic PAT). Token has the scopes the brief needs — you're likely not involved in any open issues right now.`,
        ];
      }
      const grantedSummary = ctx.scopes.length > 0 ? ctx.scopes.join(', ') : '(none)';
      return [
        'No open issues involving you were found.',
        '',
        `Authenticated as \`${ctx.login}\` (classic PAT).`,
        `Granted scopes: ${grantedSummary}`,
        `Missing scopes useful for KiloClaw: ${ctx.missingScopes.join(', ')}`,
        '',
        "Without `repo`, the brief can't see private repositories. To fix:",
        '  gh auth refresh -h github.com',
        'Or regenerate the token at https://github.com/settings/tokens with `repo` scope.',
      ];
    }
    case 'fine-grained':
      return [
        'No open issues involving you were found.',
        '',
        `Authenticated as \`${ctx.login}\` (fine-grained PAT). Token can see ${ctx.accessibleRepoCount} repositories it was explicitly granted access to.`,
        '',
        "Fine-grained PATs only access the repositories selected when the token was created (the PAT creator's repos, or an org's repos if the org has enabled fine-grained PATs). To include collaborator repos owned by other users, switch to a classic PAT with `repo` scope, or have the resource owner generate a fine-grained PAT scoped to those repos.",
        '',
        'Manage tokens: https://github.com/settings/personal-access-tokens',
        `Learn more: ${FINE_GRAINED_LEARN_MORE_URL}`,
      ];
    case 'app':
    case 'oauth':
    case 'unknown': {
      const loginPart = ctx.login !== null ? `\`${ctx.login}\`` : '`<unknown>`';
      return [
        'No open issues involving you were found.',
        '',
        `Authenticated as ${loginPart} (${ctx.tokenType} token). Could not determine accessible repositories or scopes from this token type.`,
      ];
    }
  }
}

/**
 * One-line summary suitable for the `## Source Status` footer of the
 * briefing markdown.
 */
export function buildGithubEmptySummary(ctx: GithubEmptyResultContext): string {
  switch (ctx.tokenType) {
    case 'classic':
      if (ctx.missingScopes.length > 0) {
        return `0 issues — classic PAT missing scopes: ${ctx.missingScopes.join(', ')}`;
      }
      return `0 issues involving ${ctx.login}`;
    case 'fine-grained':
      return `0 issues — fine-grained PAT for ${ctx.login} sees ${ctx.accessibleRepoCount} repos`;
    case 'app':
    case 'oauth':
    case 'unknown':
      return `0 issues — could not detect token type or scopes`;
  }
}

/**
 * Italic one-line empty state for the `## 🐙 GitHub` section when the
 * token is authenticated, correctly scoped, and simply has no issues
 * involving the user. The scope / token-misconfiguration cases keep the
 * verbose diagnostic from `buildGithubEmptySectionLines` instead — only
 * the genuinely-clean empty case uses this friendly line.
 */
export const GITHUB_EMPTY_LINE = '_GitHub is connected and nothing needs your attention._';

/**
 * True when the empty-result context represents a cleanly-configured
 * token with nothing to surface (classic PAT, no missing scopes), as
 * opposed to a misconfiguration the user should act on.
 */
export function isCleanGithubEmptyResult(ctx: GithubEmptyResultContext): boolean {
  return ctx.tokenType === 'classic' && ctx.missingScopes.length === 0;
}

/**
 * Short TL;DR fragment for the briefing header. Returns an empty string
 * when there is nothing to count so the caller can drop it.
 */
export function formatGithubTldr(count: number): string {
  if (count <= 0) return '';
  return count === 1 ? '1 GitHub issue to review' : `${count} GitHub issues to review`;
}

/**
 * Read the configured GitHub token from the environment. Matches `gh`'s
 * own preference order: `GH_TOKEN` wins over `GITHUB_TOKEN` when both are
 * set (https://cli.github.com/manual/gh_help_environment).
 */
export function readGithubTokenFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const gh = env.GH_TOKEN?.trim();
  if (gh && gh.length > 0) return gh;
  const github = env.GITHUB_TOKEN?.trim();
  if (github && github.length > 0) return github;
  return undefined;
}
