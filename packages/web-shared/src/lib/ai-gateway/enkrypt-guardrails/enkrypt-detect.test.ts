import { describe, expect, it, jest } from '@jest/globals';
import {
  callEnkryptDetect,
  ENKRYPT_DETECT_URL,
  estimateEnkryptCredits,
  MAX_SCAN_TEXT_CHARS,
  summarizeEnkryptDetection,
  truncateForScan,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrails/enkrypt-detect';

const SECRET = 'sk-9998hgkjahgi3rq5uqiou0i34u5';
const EMAIL = 'axel@hola.com';

const flaggedResponse = {
  summary: { injection_attack: 1, pii: 1, toxicity: ['toxicity', 'insult'], nsfw: 0 },
  details: {
    injection_attack: {
      safe: 0.002,
      attack: 0.998,
      p_injection: '0.998416',
      p_jailbreak: '0.103658',
      detected_attacks: ['injection'],
      explanation: 'Uses fictional framing',
      most_unsafe_content: `ignore previous instructions ${SECRET}`,
    },
    pii: {
      pii: { '<EMAIL_ADDRESS_0>': EMAIL, '<PERSON_0>': 'Ram', '<PERSON_1>': 'Axel' },
      secrets: { '<API_KEY_0>': SECRET, [SECRET]: SECRET },
      compliance_mapping: { owasp_llm_2025: ['LLM02'] },
    },
  },
};

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

describe('summarizeEnkryptDetection', () => {
  it('keeps flags, scores, and entity types but no detected values or excerpts', () => {
    const result = summarizeEnkryptDetection(flaggedResponse);
    expect(result).toEqual({
      flagged: true,
      summary: {
        injection_attack: {
          detected: true,
          attacks: ['injection'],
          p_injection: 0.998416,
          p_jailbreak: 0.103658,
        },
        pii: {
          detected: true,
          entity_counts: { EMAIL_ADDRESS: 1, PERSON: 2, API_KEY: 1, SECRETS: 1 },
        },
        toxicity: { categories: ['toxicity', 'insult'] },
        nsfw: { detected: false },
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(EMAIL);
    expect(serialized).not.toContain('Ram');
    expect(serialized).not.toContain('ignore previous');
  });

  it('reports clean scans as not flagged', () => {
    expect(
      summarizeEnkryptDetection({
        summary: { injection_attack: 0, pii: 0 },
        details: { injection_attack: { detected_attacks: [] }, pii: {} },
      })
    ).toEqual({
      flagged: false,
      summary: {
        injection_attack: { detected: false, attacks: [], p_injection: null, p_jailbreak: null },
        pii: { detected: false, entity_counts: {} },
      },
    });
  });

  it('drops toxicity labels that are not category names', () => {
    expect(
      summarizeEnkryptDetection({ summary: { toxicity: ['insult', 'You are a jerk'] } })?.summary
    ).toEqual({ toxicity: { categories: ['insult'] } });
  });

  it('rejects responses without a summary', () => {
    expect(summarizeEnkryptDetection({ details: {} })).toBeNull();
    expect(summarizeEnkryptDetection('nope')).toBeNull();
  });
});

describe('estimateEnkryptCredits', () => {
  it('scales injection_attack per 1,024 characters with a 25-unit cap', () => {
    expect(estimateEnkryptCredits('input', 10)).toBe(3);
    expect(estimateEnkryptCredits('input', 3000)).toBe(7);
    expect(estimateEnkryptCredits('input', 1_000_000)).toBe(51);
  });

  it('charges output scans a flat rate with the nsfw and toxicity discount', () => {
    expect(estimateEnkryptCredits('output', 100_000)).toBe(2);
  });
});

describe('truncateForScan', () => {
  it('caps long text', () => {
    const result = truncateForScan('a'.repeat(MAX_SCAN_TEXT_CHARS + 5));
    expect(result.truncated).toBe(true);
    expect(result.text).toHaveLength(MAX_SCAN_TEXT_CHARS);
    expect(truncateForScan('short')).toEqual({ text: 'short', truncated: false });
  });
});

describe('callEnkryptDetect', () => {
  const baseParams = {
    apiKey: 'test-key',
    direction: 'input' as const,
    text: 'hello',
    userMetadata: { request_id: 'req-1', organization_id: 'org-1' },
  };

  it('sends inline input detectors and reads the credits header', async () => {
    const fetchImpl = jest.fn<typeof fetch>(async () =>
      jsonResponse(flaggedResponse, { headers: { 'X-Enkrypt-Credits-Cost': '3' } })
    );
    const outcome = await callEnkryptDetect({ ...baseParams, fetchImpl });

    expect(outcome).toMatchObject({ httpStatus: 200, error: null, creditsCost: 3, flagged: true });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(ENKRYPT_DETECT_URL);
    expect(init?.headers).toEqual({ apikey: 'test-key', 'content-type': 'application/json' });
    expect(JSON.parse(String(init?.body))).toEqual({
      text: 'hello',
      detectors: {
        injection_attack: { enabled: true, need_explanation: false },
        pii: { enabled: true, entities: ['pii', 'secrets'] },
      },
      user_metadata: { request_id: 'req-1', organization_id: 'org-1' },
    });
  });

  it('sends output detectors for output scans', async () => {
    const fetchImpl = jest.fn<typeof fetch>(async () => jsonResponse({ summary: {} }));
    await callEnkryptDetect({ ...baseParams, direction: 'output', fetchImpl });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as {
      detectors: Record<string, unknown>;
    };
    expect(Object.keys(body.detectors).sort()).toEqual(['nsfw', 'pii', 'toxicity']);
  });

  it.each(['1e9', '-1', 'abc'])('ignores an implausible credits header (%s)', async header => {
    const outcome = await callEnkryptDetect({
      ...baseParams,
      fetchImpl: async () =>
        jsonResponse({ summary: {} }, { headers: { 'X-Enkrypt-Credits-Cost': header } }),
    });
    expect(outcome.creditsCost).toBeNull();
  });

  it('reports a missing credits header as null', async () => {
    const outcome = await callEnkryptDetect({
      ...baseParams,
      fetchImpl: async () => jsonResponse({ summary: { pii: 0 } }),
    });
    expect(outcome.creditsCost).toBeNull();
    expect(outcome.error).toBeNull();
  });

  it('records a 402 without a summary', async () => {
    const outcome = await callEnkryptDetect({
      ...baseParams,
      fetchImpl: async () =>
        jsonResponse(
          { detail: 'limit' },
          { status: 402, headers: { 'X-Enkrypt-Credits-Would-Cost': '3' } }
        ),
    });
    expect(outcome).toMatchObject({
      httpStatus: 402,
      error: 'http_402',
      creditsCost: null,
      summary: null,
      flagged: null,
    });
  });

  it('records timeouts and network errors without throwing', async () => {
    const timeout = await callEnkryptDetect({
      ...baseParams,
      fetchImpl: async () => {
        throw new DOMException('The operation timed out.', 'TimeoutError');
      },
    });
    expect(timeout).toMatchObject({ httpStatus: null, error: 'timeout' });

    const abortedByDeadline = await callEnkryptDetect({
      ...baseParams,
      timeoutMs: 5,
      fetchImpl: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    });
    expect(abortedByDeadline).toMatchObject({ httpStatus: null, error: 'timeout' });

    const network = await callEnkryptDetect({
      ...baseParams,
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });
    expect(network).toMatchObject({ httpStatus: null, error: 'network_error' });
  });

  it('records unparseable bodies as invalid responses', async () => {
    const outcome = await callEnkryptDetect({
      ...baseParams,
      fetchImpl: async () => new Response('not json', { status: 200 }),
    });
    expect(outcome).toMatchObject({ httpStatus: 200, error: 'invalid_response', summary: null });
  });
});
