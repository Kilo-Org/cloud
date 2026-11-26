import { DEFAULT_BENCHMARK_USER_ID } from '@kilocode/auto-routing-contracts';
import { KILO_API_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import {
  audienceLabel,
  audienceSetLabel,
  isAdmissionControl,
  isMultiAudience,
  issuerLabel,
  writeKiloTokenAdmissionLine,
} from '@kilocode/worker-utils/kilo-token-admission-observation';
import { userAgentProductFromHeaders } from '@kilocode/web-shared/lib/admin/admin-access-log';
import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';

/** Server-owned `label=subject` list naming the bot subjects of each cohort. */
export const KILO_TOKEN_ADMISSION_COHORTS_VARIABLE = 'KILO_TOKEN_ADMISSION_COHORTS';

const CONFIGURED_COHORTS = ['bouncer_watch', 'kwf_work_sessions', 'kwf_other'] as const;
type ConfiguredCohort = (typeof CONFIGURED_COHORTS)[number];

export type InternalBotCohort =
  | ConfiguredCohort
  | 'benchmark'
  | 'internal_bot_unlisted'
  | 'not_internal_bot';

export type AdmissionCohorts = ReadonlyMap<string, ConfiguredCohort>;

const NO_COHORTS: AdmissionCohorts = new Map();

function isConfiguredCohort(label: string): label is ConfiguredCohort {
  return (CONFIGURED_COHORTS as readonly string[]).includes(label);
}

/**
 * Parses `label=subject[,label=subject…]`. The whole list is refused, so every
 * bot reads as `internal_bot_unlisted`, when any entry is malformed, names an
 * unknown label, repeats a subject, or names the default benchmark user, which
 * is always `benchmark`. Unset or empty means no configured cohorts.
 */
export function parseAdmissionCohorts(raw: string): AdmissionCohorts {
  if (raw.trim() === '') return NO_COHORTS;
  const cohorts = new Map<string, ConfiguredCohort>();
  for (const entry of raw.split(',')) {
    const parts = entry.split('=');
    if (parts.length !== 2) return NO_COHORTS;
    const label = parts[0].trim();
    const subject = parts[1].trim();
    if (
      !isConfiguredCohort(label) ||
      subject === '' ||
      subject === DEFAULT_BENCHMARK_USER_ID ||
      cohorts.has(subject)
    ) {
      return NO_COHORTS;
    }
    cohorts.set(subject, label);
  }
  return cohorts;
}

// Parsed once per distinct value: a request compares one string.
let parsedRaw: string | undefined;
let parsedCohorts: AdmissionCohorts = NO_COHORTS;

function configuredCohorts(): AdmissionCohorts {
  const raw = getEnvVariable(KILO_TOKEN_ADMISSION_COHORTS_VARIABLE);
  if (raw !== parsedRaw) {
    parsedRaw = raw;
    parsedCohorts = parseAdmissionCohorts(raw);
  }
  return parsedCohorts;
}

/**
 * The Q9 cohort of a signature-verified token. A cohort requires the signed
 * `tokenSource: 'internal-bot'`, which only `POST /api/internal/bot-token`
 * sets; an MCP catalog token for the benchmark user is `not_internal_bot`. A
 * bot subject the configuration does not name, including a benchmark run
 * under an overridden bot user, is `internal_bot_unlisted`.
 */
export function internalBotCohort(
  claims: { kiloUserId?: unknown; tokenSource?: unknown },
  cohorts: AdmissionCohorts
): InternalBotCohort {
  if (claims.tokenSource !== 'internal-bot') return 'not_internal_bot';
  if (typeof claims.kiloUserId !== 'string') return 'internal_bot_unlisted';
  if (claims.kiloUserId === DEFAULT_BENCHMARK_USER_ID) return 'benchmark';
  return cohorts.get(claims.kiloUserId) ?? 'internal_bot_unlisted';
}

/**
 * An observed label from unsigned headers, never proof of the client.
 * `cli_marked`: `X-KILOCODE-EDITORNAME: Kilo CLI …`, or a user agent starting
 * `opencode-kilo-provider` or `Kilo-Code/`, which the Kilo CLI sends on most
 * calls. `unmarked`: some other client header; the CLI itself sends a few
 * calls with only its runtime's user agent, so an unmarked call may still be
 * the CLI. `unknown`: neither header.
 */
export function admissionClientFromHeaders(
  headers: Headers
): 'cli_marked' | 'unmarked' | 'unknown' {
  const editorName = headers.get('x-kilocode-editorname');
  const product = userAgentProductFromHeaders(headers);
  if (
    editorName?.startsWith('Kilo CLI') ||
    product?.startsWith('opencode-kilo-provider') ||
    product?.startsWith('Kilo-Code/')
  ) {
    return 'cli_marked';
  }
  return editorName === null && product === null ? 'unknown' : 'unmarked';
}

/**
 * Reports a web bearer decision on a signature-verified token, admitted or
 * refused, when the token names more than one audience or is an internal bot
 * token presented to `kilo-api`. Observing before the audience refusal keeps a
 * bot that lost `kilo-api` access visible instead of reading as zero. An
 * admitted token of the control subject is reported too; a refused one never
 * counts as control.
 *
 * The caller checks the flag first, so a disabled observer does no work.
 */
export function observeWebBearerAdmission(
  headers: Headers,
  claims: { readonly [claim: string]: unknown },
  policyAudience: string,
  outcome: string
): void {
  const cohort = internalBotCohort(claims, configuredCohorts());
  const multi = isMultiAudience(claims.aud);
  const botKiloApiCall = cohort !== 'not_internal_bot' && policyAudience === KILO_API_AUDIENCE;
  const control = outcome === 'admitted' && !multi && isAdmissionControl(claims);
  if (!botKiloApiCall && !multi && !control) return;
  writeKiloTokenAdmissionLine({
    event: 'kilo_token_admission',
    v: 1,
    boundary: 'web_bearer',
    policy_audience: audienceLabel(policyAudience),
    outcome,
    multi,
    control,
    aud_set: audienceSetLabel(claims.aud),
    issuer: issuerLabel(claims),
    cohort,
    client: admissionClientFromHeaders(headers),
  });
}
