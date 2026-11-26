import {
  CLOUD_AGENT_NEXT_AUDIENCE,
  KILO_API_AUDIENCE,
  KILO_GATEWAY_AUDIENCE,
  SESSION_INGEST_AUDIENCE,
} from './internal-service-token-audiences';

/**
 * Observe-only Q9 telemetry at the legacy signed-token boundaries. It never
 * changes a verdict.
 *
 * A line is written only for a token whose signature verified, so a forged or
 * expired token never produces one. Every value is a fixed label chosen here:
 * the token, its subject, its organization, raw claim values, the route, the
 * headers and the caller address never leave.
 *
 * Off unless `KILO_TOKEN_ADMISSION_OBSERVATION_ENABLED` is exactly `true`.
 * Vercel functions read it from `process.env`; Workers read the same variable
 * there, because `nodejs_compat` fills `process.env` from vars and secrets for
 * compatibility dates from 2025-04-01.
 */
export const KILO_TOKEN_ADMISSION_OBSERVATION_FLAG = 'KILO_TOKEN_ADMISSION_OBSERVATION_ENABLED';
/** The one owned synthetic subject whose accepted single-audience tokens prove delivery. */
export const KILO_TOKEN_ADMISSION_CONTROL_SUBJECT = 'KILO_TOKEN_ADMISSION_CONTROL_SUBJECT';

export type KiloTokenAdmissionBoundary = 'web_bearer' | 'resource' | 'policy' | 'exact_audience';

export type KiloTokenAdmissionLine = {
  event: 'kilo_token_admission';
  v: 1;
  boundary: KiloTokenAdmissionBoundary;
  policy_audience: string;
  /** `admitted`, or the refusal reason of a signature-verified token. */
  outcome: string;
  /**
   * The `aud` claim is an array of two or more entries, counted before any
   * labelling; `aud_set` can collapse unknown or repeated names into one label.
   */
  multi: boolean;
  /**
   * An accepted single-audience or audience-less token of the configured
   * control subject that is not an internal bot token. A control line never
   * enters a multi-audience or cohort count.
   */
  control: boolean;
  /** Labelled audiences in fixed order joined with `+`; `none` when absent. */
  aud_set: string;
  issuer: 'runtime_authorization' | 'cloud_agent_authority' | 'internal_bot' | 'unknown';
  /** Web bearer only. */
  cohort?: string;
  /** Web bearer only: unsigned header markers, an observed label and not proof. */
  client?: string;
};

// The four labelled audiences, then any other name, then a list longer than
// the read cap. The fixed order keeps one `aud_set` value per combination.
const AUDIENCE_LABELS: readonly string[] = [
  KILO_API_AUDIENCE,
  KILO_GATEWAY_AUDIENCE,
  SESSION_INGEST_AUDIENCE,
  CLOUD_AGENT_NEXT_AUDIENCE,
  'other',
  'more',
];
const OTHER_AUDIENCE_BIT = 4;
const MORE_AUDIENCES_BIT = 5;
const MAX_AUDIENCE_NAMES_READ = 8;

export function isKiloTokenAdmissionObservationEnabled(): boolean {
  return (
    typeof process !== 'undefined' &&
    process.env?.[KILO_TOKEN_ADMISSION_OBSERVATION_FLAG] === 'true'
  );
}

export function isMultiAudience(aud: unknown): boolean {
  return Array.isArray(aud) && aud.length > 1;
}

/**
 * The configured control subject, or null. A value with surrounding or inner
 * whitespace, a comma, or the `bot-` prefix of bot accounts configures none.
 */
export function parseAdmissionControlSubject(raw: string): string | null {
  return raw === '' || /[\s,]/.test(raw) || raw.startsWith('bot-') ? null : raw;
}

// Parsed once per distinct value: a verified token costs one string compare.
let parsedControlRaw: string | undefined;
let controlSubject: string | null = null;

/**
 * True for the signed claims of the configured control subject that are
 * neither an internal bot token nor multi-audience. Call only while
 * observation is enabled.
 */
export function isAdmissionControl(claims: { readonly [claim: string]: unknown }): boolean {
  const raw = process.env?.[KILO_TOKEN_ADMISSION_CONTROL_SUBJECT] ?? '';
  if (raw !== parsedControlRaw) {
    parsedControlRaw = raw;
    controlSubject = parseAdmissionControlSubject(raw);
  }
  return (
    controlSubject !== null &&
    claims.kiloUserId === controlSubject &&
    claims.tokenSource !== 'internal-bot' &&
    !isMultiAudience(claims.aud)
  );
}

// Bit of one audience name in `AUDIENCE_LABELS`; every unlisted name is `other`.
function audienceBit(audience: unknown): number {
  const index = typeof audience === 'string' ? AUDIENCE_LABELS.indexOf(audience) : -1;
  return index === -1 || index >= OTHER_AUDIENCE_BIT ? OTHER_AUDIENCE_BIT : index;
}

export function audienceLabel(audience: unknown): string {
  return AUDIENCE_LABELS[audienceBit(audience)];
}

/** Reads at most `MAX_AUDIENCE_NAMES_READ` names of an `aud` claim. */
export function audienceSetLabel(aud: unknown): string {
  if (aud === undefined) return 'none';
  if (!Array.isArray(aud)) return audienceLabel(aud);
  let bits = aud.length > MAX_AUDIENCE_NAMES_READ ? 1 << MORE_AUDIENCES_BIT : 0;
  const read = Math.min(aud.length, MAX_AUDIENCE_NAMES_READ);
  for (let i = 0; i < read; i++) bits |= 1 << audienceBit(aud[i]);
  return AUDIENCE_LABELS.filter((_, bit) => (bits & (1 << bit)) !== 0).join('+');
}

export function issuerLabel(claims: {
  readonly [claim: string]: unknown;
}): KiloTokenAdmissionLine['issuer'] {
  if (claims.runtimeAuthorization !== undefined) return 'runtime_authorization';
  if (claims.cloudAgentAuthority !== undefined) return 'cloud_agent_authority';
  if (claims.tokenSource === 'internal-bot') return 'internal_bot';
  return 'unknown';
}

/** Writes one line. Never throws: telemetry must not refuse or delay a request. */
export function writeKiloTokenAdmissionLine(line: KiloTokenAdmissionLine): void {
  try {
    console.log(JSON.stringify(line));
  } catch {
    // Dropped; the verdict stands.
  }
}

/**
 * Reports a shared verifier's acceptance of a token that names more than one
 * audience, or of a control token. Positional arguments keep the disabled path
 * free of allocation.
 */
export function observeSharedVerifierAdmission(
  boundary: Exclude<KiloTokenAdmissionBoundary, 'web_bearer'>,
  policyAudience: string,
  claims: { readonly [claim: string]: unknown }
): void {
  if (!isKiloTokenAdmissionObservationEnabled()) return;
  const multi = isMultiAudience(claims.aud);
  const control = !multi && isAdmissionControl(claims);
  if (!multi && !control) return;
  writeKiloTokenAdmissionLine({
    event: 'kilo_token_admission',
    v: 1,
    boundary,
    policy_audience: audienceLabel(policyAudience),
    outcome: 'admitted',
    multi,
    control,
    aud_set: audienceSetLabel(claims.aud),
    issuer: issuerLabel(claims),
  });
}
