import type { WorkspaceFailureSubtype } from '../../src/shared/wrapper-bootstrap.js';
import { stripAnsi } from './event-parser.js';
import { redactSecrets } from './redact-output.js';
import { createSafeProcessDiagnostic, isTimeoutTermination, type ExecResult } from './utils.js';
import { workspaceBootstrapError, type WrapperBootstrapError } from './bootstrap-error.js';

const GIT_ERROR_OUTPUT_MAX_BYTES = 4_096;

// One owner for the "real HTTP 429 status token" shape: it drives both the
// git_rate_limited subtype and the provenance's http field, so a change to one
// cannot silently desynchronise the other.
const GIT_HTTP_429_PATTERN = /(?:error|http|status(?:\s+code)?)\s*:?\s*429\b/i;

const GIT_FAILURE_PATTERNS = [
  { subtype: 'sandbox_storage_full', pattern: /no space left on device|disk quota exceeded/i },
  {
    subtype: 'git_authentication_failed',
    pattern: /authentication failed|could not read username|http 401|http 403/i,
  },
  {
    subtype: 'git_rate_limited',
    pattern: new RegExp(`${GIT_HTTP_429_PATTERN.source}|too many requests|rate limit(?:ed)?`, 'i'),
  },
  {
    subtype: 'git_network_failed',
    pattern:
      /remote end hung up|connection (?:reset|timed out)|could not resolve host|failed to connect/i,
  },
  {
    subtype: 'git_pack_corrupt',
    pattern: /bad object|pack.*corrupt|invalid index-pack output|early eof/i,
  },
] as const satisfies ReadonlyArray<{ subtype: WorkspaceFailureSubtype; pattern: RegExp }>;

type GitFailurePatternSubtype = (typeof GIT_FAILURE_PATTERNS)[number]['subtype'];

/** Which classifier branch fired: a timeout, a checkout conflict, a pattern's subtype, or none. */
export type GitFailureMatcher =
  | 'timeout'
  | 'checkout_conflict'
  | GitFailurePatternSubtype
  | 'unmatched';

/**
 * Route class only: a token/credential was injected into the git URL (`managed`)
 * or the plain URL was used (`direct`). `unknown` is reported by callers that do
 * not know the route. Never the URL, host, repository path or token.
 */
export type GitRouteClass = 'managed' | 'direct' | 'unknown';

export type GitFailureProvenance = {
  matcher: GitFailureMatcher;
  operation: 'clone' | 'checkout';
  route: GitRouteClass;
  /** Present only when an actual HTTP status token of 429 was in the output. */
  httpStatus?: 429;
};

/** All values are enums or a fixed number, so the summary is bounded by construction. */
export const GIT_FAILURE_PROVENANCE_MAX_LENGTH = 160;

export function formatGitFailureProvenance(provenance: GitFailureProvenance): string {
  const summary =
    `matcher=${provenance.matcher}` +
    ` http=${provenance.httpStatus ?? 'none'}` +
    ` operation=${provenance.operation}` +
    ` route=${provenance.route}`;
  return summary.slice(0, GIT_FAILURE_PROVENANCE_MAX_LENGTH);
}

export function cleanTerminalOutput(text: string): string {
  return stripAnsi(text)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.split('\r').at(-1) ?? '')
    .map(line =>
      Array.from(line)
        .filter(character => {
          const codePoint = character.codePointAt(0) ?? 0;
          return (
            codePoint === 9 ||
            (codePoint >= 32 && codePoint !== 127 && (codePoint < 128 || codePoint > 159))
          );
        })
        .join('')
    )
    .join('\n');
}

export function boundedUtf8Tail(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return text;
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return bytes
    .subarray(start)
    .toString('utf8')
    .replace(/^\uFFFD/, '');
}

function safeGitOutput(result: ExecResult, redact: (text: string) => string): string | undefined {
  const output = [result.stderr, result.stdout].filter(Boolean).join('\n');
  if (!output) return undefined;
  const cleaned = cleanTerminalOutput(redact(output)).trim();
  return cleaned ? boundedUtf8Tail(cleaned, GIT_ERROR_OUTPUT_MAX_BYTES) : undefined;
}

export function gitFailureDetail(result: ExecResult, redact: (text: string) => string): string {
  const output = safeGitOutput(result, redact);
  return [createSafeProcessDiagnostic(result), output ? `output: ${output}` : undefined]
    .filter((value): value is string => value !== undefined)
    .join(', ');
}

type GitFailureClassification = {
  subtype: WorkspaceFailureSubtype;
  matcher: GitFailureMatcher;
  httpStatus?: 429;
};

function classifyGitFailure(
  result: ExecResult,
  operation: 'clone' | 'checkout'
): GitFailureClassification {
  if (isTimeoutTermination(result)) {
    return {
      subtype: operation === 'clone' ? 'git_clone_timeout' : 'git_checkout_timeout',
      matcher: 'timeout',
    };
  }
  const output = `${result.stderr}\n${result.stdout}`;
  if (
    operation === 'checkout' &&
    /would be overwritten|index\.lock.*exists|unable to create.*index\.lock/i.test(output)
  ) {
    return { subtype: 'git_checkout_conflict', matcher: 'checkout_conflict' };
  }
  const matched = GIT_FAILURE_PATTERNS.find(entry => entry.pattern.test(output));
  if (!matched) return { subtype: 'workspace_setup_unknown', matcher: 'unmatched' };
  return {
    subtype: matched.subtype,
    matcher: matched.subtype,
    ...(GIT_HTTP_429_PATTERN.test(output) ? { httpStatus: 429 as const } : {}),
  };
}

export function gitOperationError(
  result: ExecResult,
  operation: 'clone' | 'checkout',
  redact: (text: string) => string = redactSecrets,
  route: GitRouteClass = 'unknown'
): WrapperBootstrapError {
  const label = operation === 'clone' ? 'Repository clone' : 'Repository checkout';
  const classification = classifyGitFailure(result, operation);
  const message = isTimeoutTermination(result) ? `${label} timed out` : `${label} failed`;
  const provenance: GitFailureProvenance = {
    matcher: classification.matcher,
    operation,
    route,
    ...(classification.httpStatus === undefined ? {} : { httpStatus: classification.httpStatus }),
  };
  return workspaceBootstrapError(
    classification.subtype,
    message,
    gitFailureDetail(result, redact),
    true,
    formatGitFailureProvenance(provenance)
  );
}

export function formatGitFailure(error: WrapperBootstrapError): string {
  return error.detail ? `${error.message}: ${error.detail}` : error.message;
}

export function formatGitResultFailure(
  result: ExecResult,
  message: string,
  redact: (text: string) => string = redactSecrets
): string {
  const detail = gitFailureDetail(result, redact);
  return detail ? `${message}: ${detail}` : message;
}
