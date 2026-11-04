import { describe, expect, test } from '@jest/globals';
import { parseExecutionOrder, parseRoutingDetails } from './routing-details';

const productionRecord = `{"schema_version":1,"usage_id":"00000000-0000-4000-8000-000000000001","created_at":"2026-11-04T13:32:13.604Z","requested_model":"anthropic/claude-haiku-4.5","api_kind":"chat_completions","owner_type":"organization","steps":[{"step":"custom-llm","outcome":"skipped","reason":"no-match"},{"step":"direct-byok-model","outcome":"skipped","reason":"no-match"},{"step":"byok-key","outcome":"skipped","reason":"no-candidates"},{"step":"kilo","outcome":"selected","gateway":"vercel","bounded_spending":false,"organization_disabled_vercel_ai_gateway":false,"kilo_ignored_providers":[]}],"byok_candidates":[],"result":{"kind":"provider","route":"kilo","provider_type":"vercel","byok_provider_ids":[],"payer":"kilo","is_free":false},"vercel":{"metadata":{"anthropic":{"usage":{"input_tokens":9}},"gateway":{"routing":{"originalModelId":"anthropic/claude-haiku-4.5","resolvedProvider":"bedrock","fallbacksAvailable":["vertexAnthropic"],"planningReasoning":"BYOK credentials available for: bedrock, vertexAnthropic. System credentials planned for: bedrock, vertexAnthropic. Total execution order: bedrock(BYOK) → vertexAnthropic(BYOK) → bedrock(system) → vertexAnthropic(system)","canonicalSlug":"anthropic/claude-haiku-4.5","finalProvider":"bedrock","modelAttemptCount":1,"modelAttempts":[{"canonicalSlug":"anthropic/claude-haiku-4.5","success":true,"providerAttemptCount":1,"providerAttempts":[{"provider":"bedrock","credentialType":"byok","success":true,"startTime":1793799527929,"endTime":1793799528567,"providerRequestId":"04e8455b","statusCode":200,"inferenceEndpoint":{"slug":"eu-central-1","scope":"specific","geoRegion":"eu","providerRegion":"eu-central-1"}}]}],"totalProviderAttemptCount":1,"affinity":{"outcome":"skipped_below_min_prefix"},"clientSessionId":"secret-session","clientSessionIdSource":"fingerprint"},"cost":"0","marketCost":"0.0000979","generationId":"gen_01M6KCH7EPQKNJCFMF37V2P1KN"}}},"enkrypt":{"settings":{"status":"ready","scan_tool_results":true,"detectors":[{"detector":"injection_attack","action":"block"},{"detector":"pii","action":"log","pii_entities":["secrets"]}]},"verdict":"block","unavailable_reason":null,"added_latency_ms":191,"scans":[{"scan":"blocking","detectors_enabled":["injection_attack"],"detectors_blocking":["injection_attack"],"verdict_cache":"miss","total_characters":148,"total_segments":1,"cached_characters":0,"cached_segments":0,"scanned_characters":148,"decision":"blocked","error":null,"detectors_fired":["injection_attack"],"attempts":1,"credits_cost":2,"latency_ms":197,"verdict_cache_write":"skipped"}]}}`;

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

const expectedVercel = {
  original_model: 'anthropic/claude-haiku-4.5',
  resolved_provider: 'bedrock',
  final_provider: 'bedrock',
  execution_order: [
    { provider: 'bedrock', credential: 'BYOK' },
    { provider: 'vertexAnthropic', credential: 'BYOK' },
    { provider: 'bedrock', credential: 'system' },
    { provider: 'vertexAnthropic', credential: 'system' },
  ],
  fallbacks_available: ['vertexAnthropic'],
  affinity: { outcome: 'skipped_below_min_prefix', pinned_provider: null },
  attempts: [
    {
      model: 'anthropic/claude-haiku-4.5',
      provider: 'bedrock',
      credential_type: 'byok',
      success: true,
      status_code: 200,
      duration_ms: 638,
      error: null,
      region: {
        slug: 'eu-central-1',
        scope: 'specific',
        geo_region: 'eu',
        provider_region: 'eu-central-1',
      },
    },
  ],
  generation_id: 'gen_01M6KCH7EPQKNJCFMF37V2P1KN',
};

const expectedEnkrypt = {
  settings: {
    status: 'ready',
    scan_tool_results: true,
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
      detectors_enabled: ['injection_attack'],
      detectors_blocking: ['injection_attack'],
      verdict_cache: 'miss',
      total_characters: 148,
      total_segments: 1,
      cached_characters: 0,
      cached_segments: 0,
      scanned_characters: 148,
      decision: 'blocked',
      error: null,
      detectors_fired: ['injection_attack'],
      attempts: 1,
      credits_cost: 2,
      latency_ms: 197,
      verdict_cache_write: 'skipped',
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
      vercel: expectedVercel,
      enkrypt: expectedEnkrypt,
    });
  });

  test('passes steps, BYOK candidates, and result through', () => {
    const parsed = parseRoutingDetails(productionRecord);

    expect(parsed?.steps).toEqual(expectedSteps);
    expect(parsed?.byok_candidates).toEqual([]);
    expect(parsed?.result).toEqual(expectedResult);
  });

  test('keeps the Vercel routing summary, including execution order and attempts', () => {
    const parsed = parseRoutingDetails(productionRecord);

    expect(parsed?.vercel).toEqual(expectedVercel);
    expect(parsed?.vercel?.execution_order).toHaveLength(4);
    expect(parsed?.vercel?.attempts[0]?.duration_ms).toBe(638);
  });

  test('returns the Enkrypt guardrail report', () => {
    expect(parseRoutingDetails(productionRecord)?.enkrypt).toEqual(expectedEnkrypt);
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
      vercel: null,
      enkrypt: null,
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
      vercel: {
        original_model: null,
        resolved_provider: null,
        final_provider: 'bedrock',
        execution_order: [],
        fallbacks_available: [],
        affinity: null,
        attempts: [],
        generation_id: 'gen_1',
      },
      enkrypt: null,
    });
  });

  test('returns null vercel when gateway metadata has no routing', () => {
    const body = JSON.stringify({
      steps: [],
      byok_candidates: [],
      result: null,
      vercel: { metadata: { gateway: { generationId: 'gen_1' } } },
    });

    expect(parseRoutingDetails(body)?.vercel).toBeNull();
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

describe('parseExecutionOrder', () => {
  test('returns an empty list without the execution order marker', () => {
    expect(parseExecutionOrder('anthropic(BYOK) → bedrock(system)')).toEqual([]);
    expect(parseExecutionOrder('')).toEqual([]);
  });

  test('parses the planned providers and credentials after the marker', () => {
    expect(
      parseExecutionOrder(
        'BYOK credentials available for: anthropic. Total execution order: anthropic(BYOK) → bedrock(system)'
      )
    ).toEqual([
      { provider: 'anthropic', credential: 'BYOK' },
      { provider: 'bedrock', credential: 'system' },
    ]);
  });

  test('ignores malformed parts', () => {
    expect(
      parseExecutionOrder(
        'Total execution order: anthropic(BYOK) → broken → bedrock(system) → (system) → x(y)z → '
      )
    ).toEqual([
      { provider: 'anthropic', credential: 'BYOK' },
      { provider: 'bedrock', credential: 'system' },
    ]);
  });
});
