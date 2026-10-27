import type { EnkryptGuardrailScanSummary } from '@kilocode/db/schema-types';

export const ENKRYPT_DETECT_URL = 'https://api.enkryptai.com/guardrails/detect';
export const ENKRYPT_DETECT_TIMEOUT_MS = 15_000;
export const MAX_SCAN_TEXT_CHARS = 50_000;

export type ScanDirection = 'input' | 'output';

const PII_ENTITIES = ['pii', 'secrets'];

export const ENKRYPT_DETECTORS: Record<ScanDirection, Record<string, unknown>> = {
  input: {
    injection_attack: { enabled: true, need_explanation: false },
    pii: { enabled: true, entities: PII_ENTITIES },
  },
  output: {
    pii: { enabled: true, entities: PII_ENTITIES },
    toxicity: { enabled: true },
    nsfw: { enabled: true },
  },
};

const INJECTION_ATTACK_CREDITS_PER_UNIT = 2;
const INJECTION_ATTACK_UNIT_CHARS = 1024;
const MAX_LENGTH_SCALED_UNITS = 25;
const PII_CREDITS = 1;
const TOXICITY_AND_NSFW_CREDITS = 1;

/**
 * Fallback for responses without `X-Enkrypt-Credits-Cost`, following
 * https://docs.enkryptai.com/resources/credits. The header is authoritative.
 */
export function estimateEnkryptCredits(direction: ScanDirection, textChars: number): number {
  if (direction === 'output') return PII_CREDITS + TOXICITY_AND_NSFW_CREDITS;
  const units = Math.min(
    Math.max(1, Math.ceil(textChars / INJECTION_ATTACK_UNIT_CHARS)),
    MAX_LENGTH_SCALED_UNITS
  );
  return PII_CREDITS + INJECTION_ATTACK_CREDITS_PER_UNIT * units;
}

export function truncateForScan(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_SCAN_TEXT_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_SCAN_TEXT_CHARS), truncated: true };
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function probability(value: unknown): number | null {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
}

const DETECTED_ATTACKS: ReadonlySet<string> = new Set(['injection', 'jailbreak']);
const CATEGORY_LABEL = /^[a-z_]{1,64}$/;
const PII_PLACEHOLDER = /^<([A-Z][A-Z0-9_]{0,63}?)_\d+>$/;

/**
 * Detected PII and secret values are keyed by placeholders such as
 * `<EMAIL_ADDRESS_0>`. Only the entity type is kept; values never leave this
 * function, and a key that is not a placeholder counts under its category so a
 * raw value used as a key is never stored either.
 */
function piiEntityCounts(details: unknown): Record<string, number> {
  const counts: Record<string, number> = {};
  if (!isObject(details)) return counts;
  for (const [category, detected] of Object.entries(details)) {
    if (!CATEGORY_LABEL.test(category) || category === 'compliance_mapping') continue;
    if (!isObject(detected)) continue;
    for (const key of Object.keys(detected)) {
      const entity = PII_PLACEHOLDER.exec(key)?.[1] ?? category.toUpperCase();
      counts[entity] = (counts[entity] ?? 0) + 1;
    }
  }
  return counts;
}

export function summarizeEnkryptDetection(body: unknown): {
  summary: EnkryptGuardrailScanSummary;
  flagged: boolean;
} | null {
  if (!isObject(body) || !isObject(body.summary)) return null;
  const summary = body.summary;
  const details = isObject(body.details) ? body.details : {};
  const result: EnkryptGuardrailScanSummary = {};

  if ('injection_attack' in summary) {
    const injection = isObject(details.injection_attack) ? details.injection_attack : {};
    result.injection_attack = {
      detected: summary.injection_attack === 1,
      attacks: Array.isArray(injection.detected_attacks)
        ? injection.detected_attacks.filter(
            (attack): attack is string => typeof attack === 'string' && DETECTED_ATTACKS.has(attack)
          )
        : [],
      p_injection: probability(injection.p_injection),
      p_jailbreak: probability(injection.p_jailbreak),
    };
  }

  if ('pii' in summary) {
    const entityCounts = piiEntityCounts(details.pii);
    result.pii = {
      detected:
        (typeof summary.pii === 'number' && summary.pii > 0) ||
        Object.keys(entityCounts).length > 0,
      entity_counts: entityCounts,
    };
  }

  if ('toxicity' in summary) {
    result.toxicity = {
      categories: Array.isArray(summary.toxicity)
        ? summary.toxicity.filter(
            (category): category is string =>
              typeof category === 'string' && CATEGORY_LABEL.test(category)
          )
        : [],
    };
  }

  if ('nsfw' in summary) {
    result.nsfw = { detected: summary.nsfw === 1 };
  }

  const flagged =
    result.injection_attack?.detected === true ||
    result.pii?.detected === true ||
    (result.toxicity?.categories.length ?? 0) > 0 ||
    result.nsfw?.detected === true;

  return { summary: result, flagged };
}

export type EnkryptDetectOutcome = {
  httpStatus: number | null;
  error: string | null;
  latencyMs: number;
  creditsCost: number | null;
  summary: EnkryptGuardrailScanSummary | null;
  flagged: boolean | null;
};

function parseCreditsHeader(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const credits = Number(value);
  return Number.isFinite(credits) && credits >= 0 ? Math.ceil(credits) : null;
}

export async function callEnkryptDetect(params: {
  apiKey: string;
  direction: ScanDirection;
  text: string;
  userMetadata: Record<string, string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<EnkryptDetectOutcome> {
  const { apiKey, direction, text, userMetadata, fetchImpl = fetch } = params;
  const startedAt = performance.now();
  const elapsed = () => Math.round(performance.now() - startedAt);

  let response: Response;
  try {
    response = await fetchImpl(ENKRYPT_DETECT_URL, {
      method: 'POST',
      headers: { apikey: apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        text,
        detectors: ENKRYPT_DETECTORS[direction],
        user_metadata: userMetadata,
      }),
      signal: AbortSignal.timeout(params.timeoutMs ?? ENKRYPT_DETECT_TIMEOUT_MS),
    });
  } catch (error) {
    const isTimeout = isObject(error) && error.name === 'TimeoutError';
    return {
      httpStatus: null,
      error: isTimeout ? 'timeout' : 'network_error',
      latencyMs: elapsed(),
      creditsCost: null,
      summary: null,
      flagged: null,
    };
  }

  const creditsCost = parseCreditsHeader(response.headers.get('x-enkrypt-credits-cost'));
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return {
      httpStatus: response.status,
      error: `http_${response.status}`,
      latencyMs: elapsed(),
      creditsCost,
      summary: null,
      flagged: null,
    };
  }

  let detection: ReturnType<typeof summarizeEnkryptDetection>;
  try {
    detection = summarizeEnkryptDetection(await response.json());
  } catch {
    detection = null;
  }
  return {
    httpStatus: response.status,
    error: detection ? null : 'invalid_response',
    latencyMs: elapsed(),
    creditsCost,
    summary: detection?.summary ?? null,
    flagged: detection?.flagged ?? null,
  };
}
