import { z } from 'zod';

export const BRIEFING_MAX_SESSIONS = 32;
export const BRIEFING_MAX_SOURCES = 256;
export const BRIEFING_MAX_SOURCES_PER_SESSION = 32;
export const BRIEFING_MAX_TITLE_LENGTH = 160;
export const BRIEFING_FALLBACK_TITLE = 'Agent session';
export const BRIEFING_MAX_URL_LENGTH = 2048;
export const BRIEFING_MAX_EXCERPT_BYTES = 1024;
export const BRIEFING_MAX_SNAPSHOT_BYTES = 48 * 1024;

export const briefingContextSchema = z.object({
  id: z.string(),
  organizationId: z.string().nullable(),
  name: z.string(),
});
export const briefingSourceSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  kind: z.enum(['activity', 'pull_request', 'blocker', 'artifact']),
  title: z.string().max(BRIEFING_MAX_TITLE_LENGTH),
  url: z.string().max(BRIEFING_MAX_URL_LENGTH),
  occurredAt: z.string().datetime(),
  excerpt: z
    .string()
    .refine(
      value => briefingUtf8End(value, BRIEFING_MAX_EXCERPT_BYTES) === value.length,
      'Excerpt exceeds UTF-8 byte limit'
    )
    .optional(),
});
export const briefingSummaryErrorSchema = z.enum([
  'model_pricing_unavailable',
  'invalid_model_pricing',
  'input_too_large',
  'spend_limit_too_low',
  'model_not_allowed',
  'balance_unavailable',
  'permission_unavailable',
  'gateway_declined',
  'invalid_summary',
  'time_limit',
  'generation_failed',
]);
export const briefingSummarySchema = z.object({
  status: z.enum(['disabled', 'pending', 'running', 'ready', 'failed', 'unavailable']),
  text: z.string().nullable(),
  model: z.string().nullable(),
  costMicrodollars: z.number(),
  chargeStatus: z.enum(['pending', 'settled']),
  estimatedCostMicrodollars: z.number().nullable(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  error: briefingSummaryErrorSchema.nullable(),
});
export const briefingScorecardSchema = z.object({
  sessions: z.number(),
  pullRequests: z.number(),
  blockers: z.number(),
});
export const briefingCoverageSchema = z.object({
  activity: z.literal('partial'),
  blockers: z.literal('partial'),
  pullRequests: z.literal('partial'),
});
export const briefingReportSchema = z.object({
  id: z.string(),
  createdAt: z.string().datetime(),
  capturedAt: z.string().datetime(),
  truncated: z.boolean(),
  timezone: z.string(),
  context: briefingContextSchema,
  localDate: z.string(),
  nightStartAt: z.string().datetime(),
  cutoffAt: z.string().datetime(),
  morningEndAt: z.string().datetime(),
  publishedAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
  readAt: z.string().datetime().nullable(),
  dismissedAt: z.string().datetime().nullable(),
  scorecard: briefingScorecardSchema,
  coverage: briefingCoverageSchema,
  sessions: z
    .array(
      z.object({
        sessionId: z.string(),
        title: z.string().max(BRIEFING_MAX_TITLE_LENGTH),
        url: z.string().max(BRIEFING_MAX_URL_LENGTH),
        status: z.string().nullable(),
        sources: z.array(briefingSourceSchema).max(BRIEFING_MAX_SOURCES_PER_SESSION),
      })
    )
    .max(BRIEFING_MAX_SESSIONS),
  sources: z.array(briefingSourceSchema).max(BRIEFING_MAX_SOURCES),
  summary: briefingSummarySchema,
  expiresAt: z.string().datetime(),
});
export const briefingEstimateSchema = z.object({
  model: z.string(),
  estimatedCostMicrodollars: z.number(),
  maximumCostMicrodollars: z.number(),
  maxDurationSeconds: z.number(),
  estimateToken: z.string(),
  canGenerate: z.boolean(),
  unavailableReason: briefingSummaryErrorSchema.nullable(),
});
export const briefingContextPreferencesSchema = z.object({
  context: briefingContextSchema,
  enabled: z.boolean(),
  model: z.string(),
  maxDurationSeconds: z.number().int(),
  maxSpendMicrodollars: z.number().int(),
});
export const briefingPreferencesSchema = z.object({
  timezone: z.string(),
  nightStart: z.string(),
  morningStart: z.string(),
  morningEnd: z.string(),
  language: z.string(),
  notificationsEnabled: z.boolean(),
  defaultModel: z.string(),
  contexts: z.array(briefingContextPreferencesSchema),
});
export type BriefingContext = z.infer<typeof briefingContextSchema>;
export type BriefingSource = z.infer<typeof briefingSourceSchema>;
export type BriefingSummary = z.infer<typeof briefingSummarySchema>;
export type BriefingScorecard = z.infer<typeof briefingScorecardSchema>;
export type BriefingCoverage = z.infer<typeof briefingCoverageSchema>;
export type BriefingReport = z.infer<typeof briefingReportSchema>;
export type BriefingEstimate = z.infer<typeof briefingEstimateSchema>;
export type BriefingPreferences = z.infer<typeof briefingPreferencesSchema>;
export type BriefingContextPreferences = z.infer<typeof briefingContextPreferencesSchema>;
export const DEFAULT_BRIEFING_SCHEDULE = {
  nightStart: '22:00',
  morningStart: '08:00',
  morningEnd: '12:00',
} as const;
export const DEFAULT_BRIEFING_MAX_DURATION_SECONDS = 600;
export const DEFAULT_BRIEFING_MAX_SPEND_MICRODOLLARS = 2_000_000;
export function briefingHasActivity(scorecard: BriefingScorecard): boolean {
  return scorecard.sessions > 0;
}
export function isBriefingVisible(report: BriefingReport, now = Date.now()): boolean {
  return (
    report.publishedAt !== null &&
    report.dismissedAt === null &&
    Date.parse(report.publishedAt) <= now &&
    Date.parse(report.expiresAt) > now &&
    briefingHasActivity(report.scorecard)
  );
}
// A key name is a credential key when one of its tokens is a credential word, or
// when a credential word inside a token is preceded immediately by a qualifier.
// Tokens split at separators, digits, and camelCase humps, so ordinary words that
// merely contain those letters stay intact. This policy matches
// packages/auto-routing-contracts/src/normalize.ts, which screens provider-hint
// keys the same way; it is repeated here because this package is bundled into the
// mobile app and must not depend on the server routing package.
const CREDENTIAL_KEY_WORDS = [
  'apikey',
  'authorization',
  'cookie',
  'credential',
  'key',
  'keyid',
  'pass',
  'passkey',
  'passphrase',
  'passwd',
  'password',
  'pwd',
  'secret',
  'token',
];
// A credential word that ends the token still names a credential when a product or
// vendor prefix precedes it (`mysqlpassword`, `mytoken`); generic words are excluded
// so `turnkey`, `monkey` and `hockey` stay ordinary.
const CREDENTIAL_SUFFIX_WORDS = [
  'apikey',
  'credential',
  'passphrase',
  'passwd',
  'password',
  'pwd',
  'secret',
  'token',
];
// A vendor name joined directly to a short password word (`dbpass`, `pgpass`,
// `mongopass`) is a credential key only when the vendor is listed here, because a
// broader rule would also classify ordinary words that end in `pass`, such as
// `compass`. The list holds the products whose clients ship such a key name.
const CREDENTIAL_KEY_QUALIFIERS = [
  'access',
  'account',
  'api',
  'app',
  'auth',
  'client',
  'db',
  'encryption',
  'master',
  'mongo',
  'mssql',
  'mysql',
  'oracle',
  'pg',
  'postgres',
  'postgresql',
  'private',
  'public',
  'redis',
  'root',
  'secret',
  'service',
  'session',
  'signing',
  'sql',
  'subscription',
];
const CREDENTIAL_QUALIFIER_WINDOW = Math.max(
  ...CREDENTIAL_KEY_QUALIFIERS.map(qualifier => qualifier.length)
);
const PRIVATE_KEY_BLOCK = /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g;
const BEARER_VALUE = /\bbearer\s+[^\s,;"}]+/gi;
// A key name and its assignment separator. Key names are scanned on their own, apart
// from the value they assign. `(?![=>])` keeps comparison operators and arrows from
// being read as an assignment, and a quote between the name and the separator belongs
// to a quoted key, bare or escaped (`{"password":`, `{\"password\":`).
const CREDENTIAL_KEY = new RegExp(
  String.raw`([A-Za-z_$][\w$.-]{0,63})\\?["']?\s*(?::=|[:=])(?![=>])\s*`,
  'g'
);
// The value a scanned key assigns, at the position the key ended. A quoted value may
// escape a quote with a backslash, and it ends on its line. A shell command that
// embeds JSON escapes the quotes themselves (`{\"password\":\"...\"}`), so a value may
// also open and close with an escaped quote, which then has to end at a boundary
// outside the quoted string. An unquoted value never starts on a quote and stops only
// at whitespace, a quote, a list separator, or the `&` that starts a following pair,
// so one pair never swallows the next (`user=bob&password=...`). Every other
// punctuation character stays inside the value, so a value containing one is still
// replaced as a whole.
const QUOTED_VALUE =
  String.raw`"(?:[^"\\\n]|\\.)*"` +
  '|' +
  String.raw`\\"[^"\\\n]*\\"(?=[\s,;:.!?})\]]|$)` +
  '|' +
  String.raw`'(?:[^'\\\n]|\\.)*'` +
  '|' +
  String.raw`\\'[^'\\\n]*\\'(?=[\s,;:.!?})\]]|$)`;
const ASSIGNMENT_VALUE = new RegExp(
  String.raw`^(?:` + QUOTED_VALUE + String.raw`|(?!\\?["'])[^\s,;"'&]+)`
);
// A header value carries an authentication scheme together with its payload, so an
// unquoted value may also span whitespace there. Closing brackets stay outside it to
// keep surrounding structure intact.
const HEADER_VALUE = new RegExp(
  String.raw`^(?:` + QUOTED_VALUE + String.raw`|(?!\\?["'])[^\n,;"'&\]})]+)`
);
// A command-line flag that names a credential carries its value in the following
// whitespace-separated argument, which no assignment separator marks. The capture
// groups are: the leading boundary, the flag, the gap, and the value.
const CREDENTIAL_FLAG_SOURCE =
  String.raw`(^|\s)(--?[A-Za-z][\w-]*)(\s+)(` + QUOTED_VALUE + String.raw`|(?!\\?["'])[^\s,;"'&]+)`;
// Credential value shapes that carry no key name of their own. An opaque run is 48
// characters or more, or 32 or more when it mixes letters with digits, so file paths,
// words, and short identifiers in evidence survive.
const CREDENTIAL_VALUE_SHAPES: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /\b(?:AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AIPA|ANPA|ANVA|APKA|AROA)[A-Z0-9]{16}\b/g,
    '[redacted credential]',
  ],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[redacted credential]'],
  [/\b(?:sk-|ghp_|github_pat_|glpat-|xox[baprs]-)[A-Za-z0-9_-]+/g, '[redacted token]'],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, '[redacted token]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[redacted token]'],
  [/\b[A-Za-z0-9_-]{48,}\b/g, '[redacted value]'],
  [/\b(?=[A-Za-z0-9_]*[0-9])(?=[A-Za-z0-9_]*[A-Za-z])[A-Za-z0-9_]{32,}\b/g, '[redacted value]'],
];
const EMAIL_ADDRESS = /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g;
const URL_QUERY = /(https?:\/\/[^\s?]+)\?[^\s]+/g;
const REDACTION_PLACEHOLDER = /^\s*["']?\[redacted/;
// A token that continues a credential past the value screening replaces is treated as
// credential material only when it looks like an encoded secret rather than prose or an
// identifier: 20 characters or more that mix letters with digits, 32 characters or more
// in any mix, or 10 or more that mix letters with digits and carry an encoding character.
// The comparison stops at an assignment, so a following pair is classified on its own
// key name.
const RESIDUAL_OPAQUE_TOKEN = new RegExp(
  String.raw`^(?:` +
    String.raw`(?=[A-Za-z0-9+/=_-]{20,}$)(?=[A-Za-z0-9+/=_-]*[0-9])(?=[A-Za-z0-9+/=_-]*[A-Za-z])[A-Za-z0-9+/=_-]+` +
    String.raw`|[A-Za-z0-9+/=_-]{32,}` +
    String.raw`|(?=[A-Za-z0-9+/=_-]{10,}$)(?=.*[+/])(?=[A-Za-z0-9+/=_-]*[0-9])(?=[A-Za-z0-9+/=_-]*[A-Za-z])[A-Za-z0-9+/=_-]+` +
    String.raw`)$`
);

function splitCredentialKeyTokens(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(token => token.length > 0);
}

function isCredentialToken(token: string): boolean {
  const singular = token.endsWith('s') ? token.slice(0, -1) : token;
  if (CREDENTIAL_KEY_WORDS.some(word => word === token || word === singular)) return true;
  for (const word of CREDENTIAL_KEY_WORDS) {
    for (let index = token.indexOf(word); index !== -1; index = token.indexOf(word, index + 1)) {
      if (CREDENTIAL_SUFFIX_WORDS.includes(word) && index + word.length === token.length)
        return true;
      // A qualifier counts only when it ends immediately before the occurrence, so
      // the scan before each occurrence never needs more than the longest qualifier.
      const window = token.slice(Math.max(0, index - CREDENTIAL_QUALIFIER_WINDOW), index);
      if (CREDENTIAL_KEY_QUALIFIERS.some(qualifier => window.endsWith(qualifier))) return true;
    }
  }
  return false;
}

function isCredentialKeyName(key: string): boolean {
  return splitCredentialKeyTokens(key).some(isCredentialToken);
}

/**
 * The value that screening replaces for a credential key at `from`. An authorization
 * header carries an authentication scheme and its payload as one value, so it may
 * span whitespace.
 */
function credentialValue(name: string, text: string, from: number): string | undefined {
  const pattern = splitCredentialKeyTokens(name).includes('authorization')
    ? HEADER_VALUE
    : ASSIGNMENT_VALUE;
  return pattern.exec(text.slice(from))?.[0];
}

/**
 * Every credential flag in the text, with the position and text of the value it carries.
 * A flag that does not name a credential is not consumed, so a credential flag that
 * follows it is examined on its own.
 */
function credentialFlagSites(text: string): Array<{ valueStart: number; value: string }> {
  const pattern = new RegExp(CREDENTIAL_FLAG_SOURCE, 'g');
  const sites: Array<{ valueStart: number; value: string }> = [];
  let searchFrom = 0;
  for (;;) {
    pattern.lastIndex = searchFrom;
    const match = pattern.exec(text);
    if (!match) return sites;
    const flag = match[2] ?? '';
    const value = match[4] ?? '';
    const valueStart = match.index + match[0].length - value.length;
    searchFrom = Math.max(valueStart - 1, match.index + 1);
    if (isCredentialKeyName(flag.replace(/^-+/, ''))) sites.push({ valueStart, value });
  }
}

/**
 * True when screening leaves credential material in an excerpt: a value it cannot
 * resolve, or an opaque token that continues a credential past the value it replaces.
 */
function briefingExcerptCarriesCredential(text: string): boolean {
  const tailAfter = (from: number): string | undefined => {
    const tail = (text.slice(from).split('\n')[0] ?? '').trim();
    return tail.length === 0 ? undefined : tail;
  };
  const isOpaque = (tail: string): boolean =>
    RESIDUAL_OPAQUE_TOKEN.test((tail.split(/\s+/)[0] ?? '').split('=')[0] ?? '');
  for (const match of text.matchAll(CREDENTIAL_KEY)) {
    const name = match[1];
    if (!name || !isCredentialKeyName(name)) continue;
    const valueStart = (match.index ?? 0) + match[0].length;
    const value = credentialValue(name, text, valueStart);
    const tail = tailAfter(valueStart + (value?.length ?? 0));
    if (tail === undefined) continue;
    if (value === undefined || isOpaque(tail)) return true;
  }
  for (const { valueStart, value } of credentialFlagSites(text)) {
    if (REDACTION_PLACEHOLDER.test(value)) continue;
    const tail = tailAfter(valueStart + value.length);
    if (tail !== undefined && isOpaque(tail)) return true;
  }
  return false;
}

/** Replaces the value of every credential flag. */
function redactCredentialFlags(text: string): string {
  const pieces: string[] = [];
  let cursor = 0;
  for (const { valueStart, value } of credentialFlagSites(text)) {
    if (valueStart < cursor || REDACTION_PLACEHOLDER.test(value)) continue;
    pieces.push(text.slice(cursor, valueStart), '[redacted credential]');
    cursor = valueStart + value.length;
  }
  if (pieces.length === 0) return text;
  pieces.push(text.slice(cursor));
  return pieces.join('');
}

/** Replaces the value of every credential assignment. */
function redactCredentialAssignments(text: string): string {
  const pieces: string[] = [];
  let cursor = 0;
  for (const key of text.matchAll(CREDENTIAL_KEY)) {
    const name = key[1];
    if (!name || !isCredentialKeyName(name)) continue;
    const start = key.index ?? 0;
    if (start < cursor) continue;
    const valueStart = start + key[0].length;
    const assigned = credentialValue(name, text, valueStart);
    if (!assigned || REDACTION_PLACEHOLDER.test(assigned)) continue;
    pieces.push(text.slice(cursor, start), '[redacted credential]');
    cursor = valueStart + assigned.length;
  }
  if (pieces.length === 0) return text;
  pieces.push(text.slice(cursor));
  return pieces.join('');
}

export function redactBriefingExcerpt(
  value: string,
  maxBytes = BRIEFING_MAX_EXCERPT_BYTES
): string {
  let redacted = value
    .replace(PRIVATE_KEY_BLOCK, '[redacted key]')
    .replace(BEARER_VALUE, '[redacted credential]');
  redacted = redactCredentialAssignments(redactCredentialFlags(redacted));
  for (const [shape, replacement] of CREDENTIAL_VALUE_SHAPES) {
    redacted = redacted.replace(shape, replacement);
  }
  redacted = redacted.replace(EMAIL_ADDRESS, '[redacted email]').replace(URL_QUERY, '$1');
  return truncateBriefingUtf8(redacted, maxBytes);
}

/**
 * Excerpt evidence for a prompt sent beyond Kilo. Returns the screened text, or
 * `undefined` when screening still finds credential material, so the caller
 * withholds the field instead of sending it.
 */
export function redactBriefingExcerptOrDrop(
  value: string,
  maxBytes = BRIEFING_MAX_EXCERPT_BYTES
): string | undefined {
  const redacted = redactBriefingExcerpt(value, maxBytes);
  return briefingExcerptCarriesCredential(value) ? undefined : redacted;
}

/**
 * A title for a session or a source. The report schema requires one, so a title that
 * screening cannot clear becomes a neutral fallback.
 */
export function redactBriefingTitle(value: string, maxBytes = BRIEFING_MAX_TITLE_LENGTH): string {
  return redactBriefingExcerptOrDrop(value, maxBytes) ?? BRIEFING_FALLBACK_TITLE;
}

export function truncateBriefingUtf8(value: string, maxBytes: number): string {
  const end = briefingUtf8End(value, maxBytes);
  return end === value.length ? value : value.slice(0, end);
}

function briefingUtf8End(value: string, maxBytes: number): number {
  let bytes = 0;
  let end = 0;
  while (end < value.length) {
    const code = value.charCodeAt(end);
    const next = value.charCodeAt(end + 1);
    const pair = code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
    const width = pair ? 4 : code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
    if (bytes + width > maxBytes) break;
    bytes += width;
    end += pair ? 2 : 1;
  }
  return end;
}
