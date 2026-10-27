/**
 * Canonical identities for Kilo's GitHub review bot.
 *
 * A GitHub App's bot account is always named `<app-slug>[bot]` and carries
 * `type: 'Bot'` in REST payloads. `normalizeGitHubLogin` folds the suffix away
 * so callers that only have a login (webhook payloads) and callers that also
 * have the account type (REST comment authors) agree on identity.
 *
 * Slugs come from the GitHub App configuration (`GITHUB_APP_SLUG` and
 * `GITHUB_LITE_APP_SLUG` in services/git-token-service and
 * services/cloud-agent-next). The numeric ids are the same apps' bot user ids
 * (`GITHUB_APP_BOT_USER_ID`, `GITHUB_LITE_APP_BOT_USER_ID`); they survive an
 * app rename, which changes the slug.
 */
export const KILO_GITHUB_BOT_SLUGS: Record<string, true> = {
  kiloconnect: true,
  'kiloconnect-development': true,
  'kiloconnect-lite': true,
  'kilo-code': true,
  'kilo-code-bot': true,
  'kilo-code-review-bot': true,
  kilocode: true,
};

export const KILO_GITHUB_BOT_USER_IDS: Record<string, true> = {
  '240665456': true, // kiloconnect[bot]
  '242397087': true, // kiloconnect-development[bot]
  '257753004': true, // kiloconnect-lite[bot]
};

export function normalizeGitHubLogin(login: string): string {
  return login
    .trim()
    .toLowerCase()
    .replace(/\[bot\]$/, '');
}

export function isKiloGitHubBotLogin(login: string | undefined): boolean {
  return login !== undefined && KILO_GITHUB_BOT_SLUGS[normalizeGitHubLogin(login)] === true;
}

/** Exact identity: a GitHub App bot account belonging to Kilo. */
export function isKiloReviewBotAuthor(author: {
  login: string;
  type: string;
  id?: number | null;
}): boolean {
  if (author.type !== 'Bot') return false;
  if (isKiloGitHubBotLogin(author.login)) return true;
  return author.id != null && KILO_GITHUB_BOT_USER_IDS[String(author.id)] === true;
}
