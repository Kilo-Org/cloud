import { describe, expect, test } from '@jest/globals';
import { parseRoutingDetails, requestNotSentReason } from './routing-details';

const productionRecord = `{"schema_version":1,"usage_id":"00000000-0000-4000-8000-000000000001","created_at":"2026-11-04T13:32:13.604Z","requested_model":"anthropic/claude-haiku-4.5","api_kind":"chat_completions","owner_type":"organization","steps":[{"step":"custom-llm","outcome":"skipped","reason":"no-match"},{"step":"direct-byok-model","outcome":"skipped","reason":"no-match"},{"step":"byok-key","outcome":"skipped","reason":"no-candidates"},{"step":"kilo","outcome":"selected","gateway":"vercel","bounded_spending":false,"organization_disabled_vercel_ai_gateway":false,"kilo_ignored_providers":[]}],"byok_candidates":[],"result":{"kind":"provider","route":"kilo","provider_type":"vercel","byok_provider_ids":[],"payer":"kilo","is_free":false},"vercel":{"metadata":{"anthropic":{"usage":{"input_tokens":9}},"gateway":{"routing":{"originalModelId":"anthropic/claude-haiku-4.5","resolvedProvider":"bedrock","fallbacksAvailable":["vertexAnthropic"],"planningReasoning":"BYOK credentials available for: bedrock, vertexAnthropic. System credentials planned for: bedrock, vertexAnthropic. Total execution order: bedrock(BYOK) → vertexAnthropic(BYOK) → bedrock(system) → vertexAnthropic(system)","canonicalSlug":"anthropic/claude-haiku-4.5","finalProvider":"bedrock","modelAttemptCount":1,"modelAttempts":[{"canonicalSlug":"anthropic/claude-haiku-4.5","success":true,"providerAttemptCount":1,"providerAttempts":[{"provider":"bedrock","credentialType":"byok","success":true,"startTime":1793799527929,"endTime":1793799528567,"providerRequestId":"04e8455b","statusCode":200,"inferenceEndpoint":{"slug":"eu-central-1","scope":"specific","geoRegion":"eu","providerRegion":"eu-central-1"}}]}],"totalProviderAttemptCount":1,"affinity":{"outcome":"skipped_below_min_prefix"},"clientSessionId":"secret-session","clientSessionIdSource":"fingerprint"},"cost":"0","marketCost":"0.0000979","generationId":"gen_01M6KCH7EPQKNJCFMF37V2P1KN"}}},"enkrypt":{"settings":{"status":"ready","scan_tool_results":true,"detectors":[{"detector":"injection_attack","action":"block"},{"detector":"pii","action":"log","pii_entities":["secrets"]}]},"verdict":"block","unavailable_reason":null,"added_latency_ms":191,"scans":[{"scan":"blocking","part":"conversation","detectors_enabled":["injection_attack"],"detectors_blocking":["injection_attack"],"verdict_cache":"miss","total_characters":148,"total_segments":1,"cached_characters":0,"cached_segments":0,"omitted_attachments":0,"scanned_characters":148,"decision":"blocked","error":null,"detectors_fired":["injection_attack"],"attempts":1,"credits_cost":2,"latency_ms":197,"verdict_cache_write":"skipped","chunks":1}]}}`;

const expectedSteps = [
  { step: 'custom-llm', outcome: 'skipped', reason: 'no-match' },
  { step: 'direct-byok-model', outcome: 'skipped', reason: 'no-match' },
  { step: 'byok-key', outcome: 'skipped', reason: 'no-candidates' },
  {
    step: 'kilo',
    outcome: 'selected',
    gateway: 'vercel',
    bounded_spending: false,
    organization_disabled_vercel_ai_gateway: false,
    kilo_ignored_providers: [],
  },
];

const expectedResult = {
  kind: 'provider',
  route: 'kilo',
  provider_type: 'vercel',
  byok_provider_ids: [],
  payer: 'kilo',
  is_free: false,
};

const expectedEnkrypt = {
  settings: {
    status: 'ready',
    detectors: [
      { detector: 'injection_attack', action: 'block' },
      { detector: 'pii', action: 'log', pii_entities: ['secrets'] },
    ],
  },
  verdict: 'block',
  unavailable_reason: null,
  added_latency_ms: 191,
  scans: [
    {
      scan: 'blocking',
      part: 'conversation',
      detectors_enabled: ['injection_attack'],
      detectors_blocking: ['injection_attack'],
      verdict_cache: 'miss',
      total_characters: 148,
      total_segments: 1,
      cached_characters: 0,
      cached_segments: 0,
      omitted_attachments: 0,
      scanned_characters: 148,
      decision: 'blocked',
      error: null,
      detectors_fired: ['injection_attack'],
      attempts: 1,
      credits_cost: 2,
      latency_ms: 197,
      verdict_cache_write: 'skipped',
      chunks: 1,
    },
  ],
};

describe('parseRoutingDetails', () => {
  test('summarizes a production record', () => {
    expect(parseRoutingDetails(productionRecord)).toEqual({
      requested_model: 'anthropic/claude-haiku-4.5',
      api_kind: 'chat_completions',
      owner_type: 'organization',
      steps: expectedSteps,
      byok_candidates: [],
      result: expectedResult,
      enkrypt: expectedEnkrypt,
      enkrypt_output: null,
    });
  });

  test('passes steps, BYOK candidates, and result through', () => {
    const parsed = parseRoutingDetails(productionRecord);

    expect(parsed?.steps).toEqual(expectedSteps);
    expect(parsed?.byok_candidates).toEqual([]);
    expect(parsed?.result).toEqual(expectedResult);
  });

  test('returns the Enkrypt guardrail report without its retired tool result setting', () => {
    expect(parseRoutingDetails(productionRecord)?.enkrypt).toEqual(expectedEnkrypt);
    expect(parseRoutingDetails(productionRecord)?.enkrypt?.settings).not.toHaveProperty(
      'scan_tool_results'
    );
  });

  test('drops an Enkrypt report from before scans were split into parts', () => {
    const record = JSON.parse(productionRecord) as Record<string, unknown>;
    const scan: Record<string, unknown> = { ...expectedEnkrypt.scans[0] };
    delete scan.part;
    delete scan.omitted_attachments;

    const parsed = parseRoutingDetails(
      JSON.stringify({ ...record, enkrypt: { ...expectedEnkrypt, scans: [scan] } })
    );

    expect(parsed?.enkrypt).toBeNull();
    expect(parsed?.result).toEqual(expectedResult);
  });

  test('drops a system or conversation scan from before scans were chunked and keeps the rest', () => {
    const record = JSON.parse(productionRecord) as Record<string, unknown>;
    const scan: Record<string, unknown> = { ...expectedEnkrypt.scans[0] };
    delete scan.chunks;

    const parsed = parseRoutingDetails(
      JSON.stringify({ ...record, enkrypt: { ...expectedEnkrypt, scans: [scan] } })
    );

    expect(parsed?.enkrypt).toBeNull();
    expect(parsed?.requested_model).toBe('anthropic/claude-haiku-4.5');
    expect(parsed?.api_kind).toBe('chat_completions');
    expect(parsed?.owner_type).toBe('organization');
    expect(parsed?.steps).toEqual(expectedSteps);
    expect(parsed?.byok_candidates).toEqual([]);
    expect(parsed?.result).toEqual(expectedResult);
  });

  test('returns a chunked system or conversation scan with its chunk count', () => {
    const chunkedScans = [
      { ...expectedEnkrypt.scans[0], part: 'system', total_characters: 40_000, chunks: 3 },
      {
        ...expectedEnkrypt.scans[0],
        part: 'conversation',
        total_characters: 9_000,
        cached_characters: 9_000,
        scanned_characters: 0,
        verdict_cache: 'hit',
        chunks: 0,
      },
    ];
    const record = JSON.parse(productionRecord) as Record<string, unknown>;

    const parsed = parseRoutingDetails(
      JSON.stringify({ ...record, enkrypt: { ...expectedEnkrypt, scans: chunkedScans } })
    );

    expect(parsed?.enkrypt?.scans).toEqual(chunkedScans);
  });

  test('returns an aggregated tools scan with its flagged tools and round-trips it', () => {
    const toolsScan = {
      scan: 'blocking',
      part: 'tools',
      detectors_enabled: ['injection_attack'],
      detectors_blocking: ['injection_attack'],
      verdict_cache: 'hit',
      total_characters: 320,
      cached_characters: 120,
      scanned_characters: 200,
      decision: 'blocked',
      error: null,
      detectors_fired: ['injection_attack'],
      attempts: 1,
      credits_cost: 2,
      latency_ms: 85,
      verdict_cache_write: 'written',
      tools_total: 3,
      tools_cached: 1,
      tools_scanned: 2,
      tools_flagged: 1,
      flagged_tools: [
        { kind: 'tool', name: 'read', detectors_fired: ['injection_attack'], error: null },
      ],
    };
    const record = JSON.parse(productionRecord) as Record<string, unknown>;
    const body = JSON.stringify({
      ...record,
      enkrypt: { ...expectedEnkrypt, scans: [toolsScan] },
    });

    const parsed = parseRoutingDetails(body);

    expect(parsed?.enkrypt?.scans).toEqual([toolsScan]);
    expect(parsed?.enkrypt?.verdict).toBe('block');
    expect(parseRoutingDetails(JSON.stringify(parsed))).toEqual(parsed);
    expect(parsed?.enkrypt?.scans[0]).toEqual(toolsScan);
  });

  test('drops a tools scan in the per-part shape from before tools were aggregated', () => {
    const record = JSON.parse(productionRecord) as Record<string, unknown>;
    const scan = {
      ...expectedEnkrypt.scans[0],
      part: 'tools',
      total_characters: 320,
      total_segments: 3,
      cached_characters: 120,
      cached_segments: 1,
      omitted_attachments: 0,
      scanned_characters: 200,
    };

    const parsed = parseRoutingDetails(
      JSON.stringify({ ...record, enkrypt: { ...expectedEnkrypt, scans: [scan] } })
    );

    expect(parsed?.enkrypt).toBeNull();
    expect(parsed?.result).toEqual(expectedResult);
  });

  test('strips provider response and client session identifiers from the output', () => {
    const serialized = JSON.stringify(parseRoutingDetails(productionRecord));

    for (const privateValue of [
      'secret-session',
      'clientSessionId',
      'providerRequestId',
      '04e8455b',
      'marketCost',
      '0.0000979',
      'planningReasoning',
      'BYOK credentials available',
      'usage_id',
      '00000000-0000-4000-8000-000000000001',
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
    expect(parseRoutingDetails(productionRecord)).not.toHaveProperty('vercel');
  });

  test('parses an older record without newer fields as null for absent parts', () => {
    const olderRecord = JSON.stringify({
      schema_version: 1,
      requested_model: 'openai/gpt-4o-mini',
      api_kind: 'chat_completions',
      owner_type: 'personal',
      steps: [
        {
          step: 'kilo',
          outcome: 'selected',
          gateway: 'openrouter',
          bounded_spending: false,
          kilo_ignored_providers: [],
        },
      ],
      byok_candidates: [],
      result: {
        kind: 'provider',
        route: 'kilo',
        provider_type: 'openrouter',
        byok_provider_ids: [],
        payer: 'kilo',
        is_free: false,
      },
    });

    expect(parseRoutingDetails(olderRecord)).toEqual({
      requested_model: 'openai/gpt-4o-mini',
      api_kind: 'chat_completions',
      owner_type: 'personal',
      steps: [
        {
          step: 'kilo',
          outcome: 'selected',
          gateway: 'openrouter',
          bounded_spending: false,
          kilo_ignored_providers: [],
        },
      ],
      byok_candidates: [],
      result: {
        kind: 'provider',
        route: 'kilo',
        provider_type: 'openrouter',
        byok_provider_ids: [],
        payer: 'kilo',
        is_free: false,
      },
      enkrypt: null,
      enkrypt_output: null,
    });
  });

  test('drops malformed steps and keeps the valid ones', () => {
    const body = JSON.stringify({
      requested_model: 'anthropic/claude-haiku-4.5',
      steps: [
        { outcome: 'selected' },
        42,
        null,
        { step: 'kilo', outcome: 'selected', gateway: 'vercel' },
      ],
      byok_candidates: [],
      result: { kind: 'provider', route: 'kilo' },
    });

    expect(parseRoutingDetails(body)).toMatchObject({
      requested_model: 'anthropic/claude-haiku-4.5',
      steps: [{ step: 'kilo', outcome: 'selected', gateway: 'vercel' }],
    });
  });

  test('drops malformed BYOK candidates and keeps the valid ones', () => {
    const body = JSON.stringify({
      steps: [],
      byok_candidates: [
        { route: 'byok', outcome: 'considered' },
        'bedrock',
        { route: 'byok', provider_id: 'bedrock', outcome: 'considered', priority: 1 },
      ],
      result: { kind: 'provider', route: 'kilo' },
    });

    expect(parseRoutingDetails(body)?.byok_candidates).toEqual([
      { route: 'byok', provider_id: 'bedrock', outcome: 'considered', priority: 1 },
    ]);
  });

  test('drops an unreadable optional field but keeps the step', () => {
    const body = JSON.stringify({
      steps: [{ step: 'kilo', outcome: 7, gateway: 'vercel' }],
      byok_candidates: [],
      result: { kind: 'provider', route: 'kilo' },
    });

    expect(parseRoutingDetails(body)?.steps).toEqual([{ step: 'kilo', gateway: 'vercel' }]);
  });

  test('returns a null enkrypt report when it is malformed and keeps the rest', () => {
    const body = JSON.stringify({
      requested_model: 'anthropic/claude-haiku-4.5',
      steps: [{ step: 'kilo', outcome: 'selected' }],
      byok_candidates: [],
      result: { kind: 'provider', route: 'kilo' },
      vercel: {
        metadata: {
          gateway: { routing: { finalProvider: 'bedrock' }, generationId: 'gen_1' },
        },
      },
      enkrypt: { settings: null, verdict: 'maybe', added_latency_ms: null, scans: [] },
    });

    expect(parseRoutingDetails(body)).toEqual({
      requested_model: 'anthropic/claude-haiku-4.5',
      api_kind: null,
      owner_type: null,
      steps: [{ step: 'kilo', outcome: 'selected' }],
      byok_candidates: [],
      result: { kind: 'provider', route: 'kilo' },
      enkrypt: null,
      enkrypt_output: null,
    });
  });

  test('returns the Enkrypt output guardrail report and drops a malformed one', () => {
    const outputReport = {
      settings: {
        status: 'ready',
        detectors: [{ detector: 'toxicity', action: 'block' }],
      },
      held_back: true,
      held_bytes: 2048,
      held_ms: 1200,
      upstream_read_failed: false,
      output_characters: 512,
      not_scanned_reason: null,
      verdict: 'allow',
      unavailable_reason: null,
      added_latency_ms: 140,
      scans: [
        {
          scan: 'blocking',
          part: 'response',
          detectors_enabled: ['toxicity'],
          detectors_blocking: ['toxicity'],
          verdict_cache: 'off',
          total_characters: 512,
          total_segments: 1,
          cached_characters: 0,
          cached_segments: 0,
          omitted_attachments: 0,
          scanned_characters: 512,
          decision: 'allowed',
          error: null,
          detectors_fired: [],
          attempts: 1,
          credits_cost: 1,
          latency_ms: 140,
        },
      ],
    };
    const record = JSON.parse(productionRecord) as Record<string, unknown>;

    expect(
      parseRoutingDetails(JSON.stringify({ ...record, enkrypt_output: outputReport }))
        ?.enkrypt_output
    ).toEqual(outputReport);
    const malformed = parseRoutingDetails(
      JSON.stringify({ ...record, enkrypt_output: { ...outputReport, verdict: 'maybe' } })
    );
    expect(malformed?.enkrypt_output).toBeNull();
    expect(malformed?.enkrypt).toEqual(expectedEnkrypt);
  });

  test.each(['', 'not json', '{"steps":', '[]', '"x"', 'null', '42', 'true'])(
    'returns null for a body that is not a JSON object: %j',
    body => {
      expect(parseRoutingDetails(body)).toBeNull();
    }
  );

  test('returns a null result when the result is missing', () => {
    const parsed = parseRoutingDetails(
      JSON.stringify({
        requested_model: 'anthropic/claude-haiku-4.5',
        steps: [],
        byok_candidates: [],
      })
    );

    expect(parsed).not.toBeNull();
    expect(parsed?.result).toBeNull();
    expect(parsed?.steps).toEqual([]);
  });

  test('returns a null result when the result is malformed', () => {
    const parsed = parseRoutingDetails(
      JSON.stringify({ steps: [], byok_candidates: [], result: 'provider' })
    );

    expect(parsed?.result).toBeNull();
  });
});

describe('requestNotSentReason', () => {
  test('reads a request the Enkrypt input guardrail blocked as not sent', () => {
    const routing = parseRoutingDetails(productionRecord);

    expect(routing && requestNotSentReason(routing)).toBe('enkrypt-block');
  });

  test.each([
    ['block', 191, 'enkrypt-block'],
    ['unavailable', 5_000, 'enkrypt-unavailable'],
    ['allow', 191, null],
    ['skip', 0, null],
    ['allow', null, 'rejected-before-guardrail'],
    ['block', null, 'rejected-before-guardrail'],
    ['skip', null, 'rejected-before-guardrail'],
  ] as const)('reads verdict %s after waiting %p ms as %p', (verdict, addedLatencyMs, reason) => {
    const enkrypt = parseRoutingDetails(productionRecord)?.enkrypt;
    if (!enkrypt) throw new Error('expected the production record to hold an Enkrypt report');

    expect(
      requestNotSentReason({
        enkrypt: { ...enkrypt, verdict, added_latency_ms: addedLatencyMs },
      })
    ).toBe(reason);
  });

  test('treats a request without the input guardrail as sent', () => {
    expect(requestNotSentReason({ enkrypt: null })).toBeNull();
  });
});
