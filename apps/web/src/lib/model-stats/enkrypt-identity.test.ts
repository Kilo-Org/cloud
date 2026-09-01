import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { EnkryptScore } from '@kilocode/db/schema-types';
import { parseCoverageArguments, runEnkryptCoverage } from '@/scripts/enkrypt-coverage';
import { ENKRYPT_SCORE_EXAMPLES } from '@/tests/fixtures/enkrypt-scores';
import { EnkryptSyncError } from './enkrypt-errors';
import {
  buildEnkryptCoverageReport,
  ENKRYPT_MODEL_MAPPINGS,
  ENKRYPT_REQUIRED_MODEL_IDS,
  matchEnkryptScores,
  parseEnkryptScores,
  type EnkryptCatalogModel,
  type EnkryptIdentity,
  type EnkryptModelMapping,
} from './enkrypt-identity';

const reviewedMappings: EnkryptModelMapping[] = [
  {
    identity: { model_name: 'gpt-oss-120b', provider: 'fireworks', source: 'OpenAI' },
    modelId: 'openai/gpt-oss-120b',
  },
  {
    identity: { model_name: 'glm-4.5', provider: 'novita', source: 'zai-org' },
    modelId: 'z-ai/glm-4.5',
  },
  {
    identity: { model_name: 'Qwen3-8B', provider: 'openai_compatible', source: 'qwen' },
    modelId: 'qwen/qwen3-8b',
  },
];

const metricNames = [
  'risk_score',
  'bias_score',
  'cbrn_score',
  'harmful_score',
  'insecure_code_score',
  'toxicity_score',
  'robustness_score',
  'jailbreak_score',
  'evasion_score',
  'safety_score',
  'nist_score',
  'owasp_score',
] as const;

function score(overrides: Partial<EnkryptScore> = {}): EnkryptScore {
  return { ...reviewedMappings[0].identity, risk_score: 0, safety_score: null, ...overrides };
}

function model(overrides: Partial<EnkryptCatalogModel> = {}): EnkryptCatalogModel {
  return {
    id: 'catalog-openai',
    openrouterId: 'openai/gpt-oss-120b',
    isActive: true,
    isStealth: false,
    ...overrides,
  };
}

const publicModels = reviewedMappings.map(({ modelId }, index) =>
  model({ id: `catalog-${index}`, openrouterId: modelId })
);

function envelope(scores: unknown[]) {
  return { status: 'success', data: { scores } };
}

function examples() {
  return parseEnkryptScores(ENKRYPT_SCORE_EXAMPLES);
}

describe('parseEnkryptScores', () => {
  const invalidEnvelopes: [string, unknown][] = [
    ['null', null],
    ['undefined', undefined],
    ['array', []],
    ['string', 'success'],
    ['empty object', {}],
    ['bare scores', [score()]],
    ['missing status', { data: { scores: [score()] } }],
    ['error status', { status: 'error', data: { scores: [score()] } }],
    ['boolean status', { status: true, data: { scores: [] } }],
    ['wrong status case', { status: 'Success', data: { scores: [] } }],
    ['missing data', { status: 'success', scores: [] }],
    ['null data', { status: 'success', data: null }],
    ['array data', { status: 'success', data: [] }],
    ['missing scores', { status: 'success', data: {} }],
    ['null scores', { status: 'success', data: { scores: null } }],
    ['object scores', { status: 'success', data: { scores: score() } }],
    ['string scores', { status: 'success', data: { scores: 'not-an-array' } }],
  ];

  it.each(invalidEnvelopes)('rejects the entire %s envelope', (_name, value) => {
    expect(() => parseEnkryptScores(value)).toThrow(EnkryptSyncError);
    expect(() => parseEnkryptScores(value)).toThrow(
      expect.objectContaining({ category: 'response_validation' })
    );
  });

  it('accepts an empty scores array without claiming coverage', () => {
    expect(parseEnkryptScores(envelope([]))).toEqual({
      scores: [],
      fetchedCount: 0,
      rejectedCount: 0,
      rejectedRecords: [],
    });
  });

  it('accepts all seven review examples, including all four empty-source GPT identities', () => {
    const parsed = examples();
    expect(parsed).toEqual({
      scores: ENKRYPT_SCORE_EXAMPLES.data.scores,
      fetchedCount: 7,
      rejectedCount: 0,
      rejectedRecords: [],
    });
    expect(
      parsed.scores.slice(3).map(({ model_name, provider, source }) => ({
        model_name,
        provider,
        source,
      }))
    ).toEqual([
      { model_name: 'gpt-5.1', provider: 'fixture-provider', source: '' },
      { model_name: 'gpt-5.2', provider: 'fixture-provider', source: '' },
      { model_name: 'gpt-5.5', provider: 'fixture-provider', source: '' },
      { model_name: 'gpt-5.4-2026-03-05', provider: 'fixture-provider', source: '' },
    ]);
  });

  it('preserves empty, null, absent, and explicit undefined source independently', () => {
    const identities: EnkryptIdentity[] = [
      { model_name: 'example', provider: 'fixture-provider', source: '' },
      { model_name: 'example', provider: 'fixture-provider', source: null },
      { model_name: 'example', provider: 'fixture-provider' },
      { model_name: 'example', provider: 'fixture-provider', source: undefined },
    ];
    const parsed = parseEnkryptScores(envelope(identities));
    expect(parsed.scores).toStrictEqual(identities);
    expect(parsed.scores.map(record => Object.hasOwn(record, 'source'))).toEqual([
      true,
      true,
      false,
      true,
    ]);
  });

  const invalidRecords: [string, unknown][] = [
    ['null', null],
    ['array', []],
    ['string', 'invalid-record'],
    ['empty object', {}],
    ['missing model', { provider: 'fireworks' }],
    ['missing provider', { model_name: 'gpt-oss-120b' }],
    ['empty model', score({ model_name: '' })],
    ['empty provider', score({ provider: '' })],
    ['null model', { ...score(), model_name: null }],
    ['numeric model', { ...score(), model_name: 123 }],
    ['null provider', { ...score(), provider: null }],
    ['numeric provider', { ...score(), provider: 123 }],
    ['numeric source', { ...score(), source: 123 }],
    ['boolean source', { ...score(), source: false }],
    ['object source', { ...score(), source: {} }],
    ['array source', { ...score(), source: [] }],
  ];

  it.each(invalidRecords)(
    'rejects only the %s record and retains original indices',
    (_name, value) => {
      const parsed = parseEnkryptScores(envelope([score(), value, score({ source: '' })]));
      expect(parsed.scores).toEqual([score(), score({ source: '' })]);
      expect(parsed.fetchedCount).toBe(3);
      expect(parsed.rejectedCount).toBe(1);
      expect(parsed.rejectedRecords).toEqual([
        {
          index: 1,
          issues: expect.arrayContaining([expect.objectContaining({ code: expect.any(String) })]),
        },
      ]);
    }
  );

  it('can reject every record without treating a valid envelope as malformed', () => {
    const parsed = parseEnkryptScores(envelope([null, {}, false]));
    expect(parsed.scores).toEqual([]);
    expect(parsed.fetchedCount).toBe(3);
    expect(parsed.rejectedCount).toBe(3);
    expect(parsed.rejectedRecords.map(({ index }) => index)).toEqual([0, 1, 2]);
  });

  describe.each(metricNames)('%s', metric => {
    it.each([0, 0.125, -1, 100, null, undefined])('preserves the accepted value %p', value => {
      const record = { ...score(), [metric]: value };
      expect(parseEnkryptScores(envelope([record])).scores).toStrictEqual([record]);
    });

    it.each(['0', '', 'not-a-score', true, false, {}, [], [1], NaN, Infinity, -Infinity])(
      'rejects the invalid value %p without coercion or exposing its value',
      value => {
        const parsed = parseEnkryptScores(envelope([{ ...score(), [metric]: value }]));
        expect(parsed.scores).toEqual([]);
        expect(parsed.rejectedCount).toBe(1);
        expect(parsed.rejectedRecords).toEqual([
          { index: 0, issues: [{ path: [metric], code: 'invalid_type' }] },
        ]);
      }
    );
  });

  it('preserves raw identity spelling and strips unknown record fields', () => {
    const record = score({ model_name: ' GPT-OSS-120B ', provider: 'Fireworks', source: 'openai' });
    expect(
      parseEnkryptScores({
        ...envelope([{ ...record, unknown_payload: 'unreported-field' }]),
        metadata: { total: 267 },
      }).scores
    ).toStrictEqual([record]);
    expect(
      parseEnkryptScores(envelope([{ ...record, risk_score: 'unreported-value' }])).rejectedRecords
    ).toEqual([{ index: 0, issues: [{ path: ['risk_score'], code: 'invalid_type' }] }]);
  });
});

describe('matchEnkryptScores', () => {
  it('contains exactly the three explicitly reviewed mappings and required gate targets', () => {
    expect(ENKRYPT_MODEL_MAPPINGS).toStrictEqual(reviewedMappings);
    expect(ENKRYPT_REQUIRED_MODEL_IDS).toEqual(reviewedMappings.map(({ modelId }) => modelId));
    const result = matchEnkryptScores(examples().scores, publicModels);
    expect(
      result.matches.map(({ score, model }) => ({
        identity: { model_name: score.model_name, provider: score.provider, source: score.source },
        modelId: model.openrouterId,
      }))
    ).toEqual(reviewedMappings);
    expect(result.unmatchedModelNames).toEqual([
      'gpt-5.1',
      'gpt-5.2',
      'gpt-5.5',
      'gpt-5.4-2026-03-05',
    ]);
    expect(result.ambiguousCount).toBe(0);
    expect(result.missingRequiredModelIds).toEqual([]);
  });

  it.each<Partial<EnkryptIdentity>>([
    { model_name: 'GPT-OSS-120B' },
    { model_name: ' gpt-oss-120b' },
    { model_name: 'gpt-oss-120b ' },
    { model_name: 'gpt_oss_120b' },
    { model_name: 'openai/gpt-oss-120b' },
    { model_name: 'gpt-oss-120b:free' },
    { model_name: 'gpt-oss-120b-2026-03-05' },
    { model_name: 'gpt-oss-120b-thinking' },
    { model_name: 'gpt-oss-120b-instruct' },
    { provider: 'Fireworks' },
    { provider: 'fireworks ' },
    { provider: 'openai' },
    { source: 'openai' },
    { source: 'OpenAI ' },
    { source: '' },
    { source: null },
    { source: undefined },
  ])('does not infer an alias from identity changes %p', overrides => {
    const record = score(overrides);
    const result = matchEnkryptScores([record], publicModels);
    expect(result.matches).toEqual([]);
    expect(result.unmatchedRecords).toEqual([
      {
        identity: {
          model_name: record.model_name,
          provider: record.provider,
          source: record.source,
        },
        reason: 'unreviewed_identity',
      },
    ]);
  });

  it('preserves absent source on unmatched identities instead of inventing a source', () => {
    const identity = { model_name: 'gpt-oss-120b', provider: 'fireworks' };
    expect(matchEnkryptScores([identity], publicModels).unmatchedRecords).toStrictEqual([
      { identity, reason: 'unreviewed_identity' },
    ]);
  });

  it.each<EnkryptIdentity>([
    { model_name: 'example', provider: 'fixture-provider', source: '' },
    { model_name: 'example', provider: 'fixture-provider', source: null },
    { model_name: 'example', provider: 'fixture-provider' },
  ])('does not conflate empty, null, and absent source with %p', identity => {
    const records: EnkryptScore[] = [
      { model_name: 'example', provider: 'fixture-provider', source: '' },
      { model_name: 'example', provider: 'fixture-provider', source: null },
      { model_name: 'example', provider: 'fixture-provider' },
    ];
    const result = matchEnkryptScores(
      records,
      [model()],
      [{ identity, modelId: model().openrouterId }]
    );
    expect(result.matches).toStrictEqual([{ model: model(), score: identity }]);
    expect(result.unmatchedRecords).toHaveLength(2);
    expect(result.ambiguousCount).toBe(0);
  });

  it.each<Partial<EnkryptCatalogModel>>([
    { isActive: false },
    { isActive: null },
    { isStealth: true },
  ])('rejects an unavailable catalog model %p', overrides => {
    const result = matchEnkryptScores([score()], [model(overrides)]);
    expect(result.matches).toEqual([]);
    expect(result.unmatchedRecords).toEqual([
      { identity: reviewedMappings[0].identity, reason: 'unavailable_model' },
    ]);
    expect(result.missingRequiredModelIds).toEqual(ENKRYPT_REQUIRED_MODEL_IDS);
  });

  it.each([
    'kilo/model',
    'kilocode/model',
    'kilo-internal/model',
    'kilo-auto/model',
    'internal/model',
    'private/model',
    'custom/model',
    'openrouter/model',
    'kilo/openai/gpt-oss-120b',
    'bare-model',
    '/model',
    'openai/',
    'openai/model/variant',
    'openai/model name',
    ' openai/model',
  ])('excludes the unsafe public ID %s even with an explicit mapping', modelId => {
    const result = matchEnkryptScores(
      [score()],
      [model({ openrouterId: modelId })],
      [{ identity: reviewedMappings[0].identity, modelId }]
    );
    expect(result.matches).toEqual([]);
    expect(result.unmatchedRecords[0]?.reason).toBe('unavailable_model');
  });

  it.each([
    'openai/gpt-oss-120b:free',
    'openai/gpt-oss-120b:exacto',
    'openai/gpt-oss-120b-thinking',
    'openai/gpt-oss-120b-2026-03-05',
    'openai/gpt-oss-120b-instruct',
    'fireworks/gpt-oss-120b',
    'OpenAI/gpt-oss-120b',
  ])('does not substitute catalog variant %s for the reviewed canonical ID', openrouterId => {
    const result = matchEnkryptScores([score()], [model({ openrouterId })]);
    expect(result.matches).toEqual([]);
    expect(result.unmatchedRecords[0]?.reason).toBe('unavailable_model');
  });

  it('ignores ineligible duplicate catalog rows when one eligible row exists', () => {
    const result = matchEnkryptScores(
      [score()],
      [
        model(),
        model({ id: 'inactive', isActive: false }),
        model({ id: 'stealth', isStealth: true }),
      ]
    );
    expect(result.matches).toEqual([{ model: model(), score: score() }]);
    expect(result.ambiguousCount).toBe(0);
  });

  it.each([false, true])(
    'skips ALL duplicate score candidates regardless of order (%s)',
    reverse => {
      const records = [score(), score({ risk_score: 0.875 }), score(reviewedMappings[1].identity)];
      const result = matchEnkryptScores(reverse ? records.toReversed() : records, publicModels);
      expect(result.matches).toEqual([{ model: publicModels[1], score: records[2] }]);
      expect(result.ambiguousRecords).toEqual([
        { identity: reviewedMappings[0].identity, modelIds: ['openai/gpt-oss-120b'] },
        { identity: reviewedMappings[0].identity, modelIds: ['openai/gpt-oss-120b'] },
      ]);
      expect(result.ambiguousCount).toBe(2);
      expect(result.unmatchedRecords).toEqual([]);
    }
  );

  it('skips an identical repeated record rather than choosing the first', () => {
    const record = score();
    const result = matchEnkryptScores([record, record], [model()]);
    expect(result.matches).toEqual([]);
    expect(result.ambiguousCount).toBe(2);
  });

  it.each([false, true])(
    'skips duplicate catalog targets, including the same row (%s)',
    identical => {
      const result = matchEnkryptScores(
        [score()],
        [model(), model({ id: identical ? model().id : 'another-catalog-row' })]
      );
      expect(result.matches).toEqual([]);
      expect(result.ambiguousCount).toBe(1);
    }
  );

  it('does not mistake duplicate identical mapping declarations for multiple targets', () => {
    const result = matchEnkryptScores(
      [score()],
      [model()],
      [reviewedMappings[0], reviewedMappings[0]]
    );
    expect(result.matches).toEqual([{ model: model(), score: score() }]);
    expect(result.ambiguousCount).toBe(0);
  });

  it('skips ALL reviewed identities that collide on a single target', () => {
    const alternative = score({ provider: 'fixture-provider' });
    const result = matchEnkryptScores(
      [score(), alternative],
      [model()],
      [reviewedMappings[0], { identity: alternative, modelId: model().openrouterId }]
    );
    expect(result.matches).toEqual([]);
    expect(result.ambiguousCount).toBe(2);
  });

  it.each([0, 1, 2])('rejects a multi-target mapping with %i available targets', available => {
    const modelIds = ['openai/gpt-oss-120b', 'z-ai/glm-4.5'];
    const result = matchEnkryptScores(
      [score()],
      publicModels.slice(0, available),
      modelIds.map(modelId => ({
        identity: reviewedMappings[0].identity,
        modelId,
      }))
    );
    expect(result.matches).toEqual([]);
    expect(result.unmatchedRecords).toEqual([]);
    expect(result.ambiguousRecords).toEqual([{ identity: reviewedMappings[0].identity, modelIds }]);
  });

  it.each([false, true])(
    'skips ALL candidates touched by overlapping multi-target mappings (%s)',
    reverse => {
      const records = reviewedMappings.map(({ identity }) => score(identity));
      const mappings = [
        ...reviewedMappings,
        { identity: reviewedMappings[0].identity, modelId: reviewedMappings[1].modelId },
        { identity: reviewedMappings[1].identity, modelId: reviewedMappings[2].modelId },
      ];
      const result = matchEnkryptScores(
        reverse ? records.toReversed() : records,
        reverse ? publicModels.toReversed() : publicModels,
        reverse ? mappings.toReversed() : mappings
      );
      expect(result.matches).toEqual([]);
      expect(result.ambiguousCount).toBe(3);
      expect(result.unmatchedRecords).toEqual([]);
      expect(result.missingRequiredModelIds).toEqual(ENKRYPT_REQUIRED_MODEL_IDS);
    }
  );

  it('skips ALL canonical targets that share one storage ID', () => {
    const result = matchEnkryptScores(
      reviewedMappings.map(({ identity }) => score(identity)),
      publicModels.map(record => ({ ...record, id: 'same-storage-id' }))
    );
    expect(result.matches).toEqual([]);
    expect(result.ambiguousCount).toBe(3);
  });

  it('does not mutate frozen inputs and sorts successful matches by storage ID', () => {
    const records = Object.freeze(
      reviewedMappings.map(({ identity }) => Object.freeze(score(identity)))
    );
    const models = Object.freeze(
      publicModels.toReversed().map(record => Object.freeze({ ...record }))
    );
    const mappings = Object.freeze(
      reviewedMappings.map(mapping =>
        Object.freeze({
          ...mapping,
          identity: Object.freeze({ ...mapping.identity }),
        })
      )
    );
    const result = matchEnkryptScores(records, models, mappings);
    expect(result.matches.map(({ model }) => model.id)).toEqual([
      'catalog-0',
      'catalog-1',
      'catalog-2',
    ]);
    expect(models.map(({ id }) => id)).toEqual(['catalog-2', 'catalog-1', 'catalog-0']);
  });
});

describe('buildEnkryptCoverageReport', () => {
  it('reports seven representative examples, not full 267-record coverage', () => {
    const report = buildEnkryptCoverageReport(examples(), publicModels, 'examples');
    expect(report.evidence).toEqual({
      kind: 'examples',
      scope:
        'representative-only; not full 267-record coverage; metrics and fixture-provider are synthetic',
    });
    expect(report.counters).toEqual({
      fetchedCount: 7,
      acceptedCount: 7,
      matchedCount: 3,
      unmatchedCount: 4,
      ambiguousCount: 0,
      rejectedCount: 0,
    });
    expect(report.matchedRecords).toEqual(reviewedMappings);
    expect(report.requiredGate).toEqual({
      passed: true,
      requiredModelIds: ENKRYPT_REQUIRED_MODEL_IDS,
      missingRequiredModelIds: [],
    });
  });

  it('does not claim supplied sanitized input is independently complete', () => {
    const report = buildEnkryptCoverageReport(examples(), publicModels, 'fullinput');
    expect(report.evidence).toEqual({
      kind: 'fullinput',
      scope: 'supplied sanitized input; completeness not independently verified',
    });
  });

  it('accounts for every record exactly once and fails the required gate on collisions', () => {
    const parsed = parseEnkryptScores(
      envelope([
        score(),
        score({ risk_score: 0.75 }),
        score(reviewedMappings[1].identity),
        score({ model_name: 'unreviewed' }),
        { ...score(), risk_score: 'invalid-value' },
      ])
    );
    const report = buildEnkryptCoverageReport(parsed, publicModels, 'fullinput');
    expect(report.counters).toEqual({
      fetchedCount: 5,
      acceptedCount: 4,
      matchedCount: 1,
      unmatchedCount: 1,
      ambiguousCount: 2,
      rejectedCount: 1,
    });
    const counts = report.counters;
    expect(counts.fetchedCount).toBe(counts.acceptedCount + counts.rejectedCount);
    expect(counts.acceptedCount).toBe(
      counts.matchedCount + counts.unmatchedCount + counts.ambiguousCount
    );
    expect(report.requiredGate).toEqual({
      passed: false,
      requiredModelIds: ENKRYPT_REQUIRED_MODEL_IDS,
      missingRequiredModelIds: ['openai/gpt-oss-120b', 'qwen/qwen3-8b'],
    });
    expect(report.rejectedRecords).toEqual([
      { index: 4, issues: [{ path: ['risk_score'], code: 'invalid_type' }] },
    ]);
  });

  it.each(reviewedMappings)(
    'requires the reviewed target $modelId to be available',
    ({ modelId }) => {
      const report = buildEnkryptCoverageReport(
        examples(),
        publicModels.filter(model => model.openrouterId !== modelId),
        'examples'
      );
      expect(report.requiredGate.passed).toBe(false);
      expect(report.requiredGate.missingRequiredModelIds).toEqual([modelId]);
    }
  );

  it('fails the required gate on empty input', () => {
    const report = buildEnkryptCoverageReport(
      parseEnkryptScores(envelope([])),
      publicModels,
      'fullinput'
    );
    expect(report.requiredGate.passed).toBe(false);
    expect(report.requiredGate.missingRequiredModelIds).toEqual(ENKRYPT_REQUIRED_MODEL_IDS);
    expect(Object.values(report.counters)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('includes only identity, target IDs, counters, and safe rejection diagnostics', () => {
    const records = reviewedMappings.map(({ identity }, index) => {
      const metrics: Partial<EnkryptScore> = Object.fromEntries(
        metricNames.map((metric, metricIndex) => [metric, 123456 + index + metricIndex])
      );
      return { ...identity, ...metrics, extra_payload: 'unreported-extra-field' };
    });
    const report = buildEnkryptCoverageReport(
      parseEnkryptScores(
        envelope([
          ...records,
          { ...score(), risk_score: 'unreported-invalid-score' },
          { model_name: 'unknown', provider: 'fixture-provider' },
          { model_name: 'unknown', provider: 'fixture-provider', source: null },
          { model_name: 'unknown', provider: 'fixture-provider', source: '' },
        ])
      ),
      publicModels,
      'fullinput'
    );
    const serialized = JSON.stringify(report);
    for (const record of records) {
      for (const metric of metricNames) {
        expect(serialized).not.toContain(String(record[metric]));
      }
    }
    expect(serialized).not.toContain('unreported-');
    expect(serialized).not.toContain('catalog-');
    expect(report.matchedRecords).toStrictEqual(reviewedMappings);
    expect(report.unmatchedRecords.map(({ identity }) => identity)).toStrictEqual([
      { model_name: 'unknown', provider: 'fixture-provider' },
      { model_name: 'unknown', provider: 'fixture-provider', source: null },
      { model_name: 'unknown', provider: 'fixture-provider', source: '' },
    ]);
  });
});

describe('enkrypt coverage CLI', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function dependencies() {
    return {
      readInput: jest
        .fn<(path: string) => Promise<unknown>>()
        .mockResolvedValue(ENKRYPT_SCORE_EXAMPLES),
      fetchPublicCatalog: jest.fn<() => Promise<unknown>>().mockResolvedValue({
        data: publicModels.map(({ openrouterId }) => ({ id: openrouterId })),
      }),
    };
  }

  it.each([
    [],
    ['--input'],
    ['--examples', '--input', 'sanitized.json'],
    ['--examples', 'extra'],
    ['--input', '.env'],
    ['--input', 'input.txt'],
    ['--input', '--examples.json'],
    ['--unknown'],
    ['--input', 'one.json', 'two.json'],
  ])(
    'rejects invalid arguments %p without reading input or contacting the catalog',
    async (...args) => {
      const io = dependencies();
      const result = await runEnkryptCoverage(args, io);
      expect(result).toEqual({
        output: {
          error: { category: 'arguments' },
          evidence: 'unspecified',
          usage: '--examples OR --input <sanitized.json>',
        },
        exitCode: 1,
      });
      expect(io.readInput).not.toHaveBeenCalled();
      expect(io.fetchPublicCatalog).not.toHaveBeenCalled();
    }
  );

  it('parses only the two supported argument forms', () => {
    expect(parseCoverageArguments(['--examples'])).toEqual({ evidence: 'examples' });
    expect(parseCoverageArguments(['--input', 'sanitized input.json'])).toEqual({
      evidence: 'fullinput',
      path: 'sanitized input.json',
    });
  });

  it('uses examples without reading any local input file and succeeds on the required gate', async () => {
    const io = dependencies();
    const result = await runEnkryptCoverage(['--examples'], io);
    expect(result.exitCode).toBe(0);
    expect(result.output).toEqual({
      catalogUrl: 'https://api.kilo.ai/api/gateway/models',
      ...buildEnkryptCoverageReport(
        examples(),
        publicModels.map(record => ({
          ...record,
          id: record.openrouterId,
        })),
        'examples'
      ),
    });
    expect(io.readInput).not.toHaveBeenCalled();
    expect(io.fetchPublicCatalog).toHaveBeenCalledTimes(1);
  });

  it('fetches only the fixed public URL without headers or credentials and bounds the request', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: publicModels.map(({ openrouterId }) => ({ id: openrouterId })),
        })
      )
    );
    const result = await runEnkryptCoverage(['--examples']);
    expect(result.exitCode).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('https://api.kilo.ai/api/gateway/models', {
      signal: expect.any(AbortSignal),
      redirect: 'error',
      cache: 'no-store',
    });
  });

  it.each([401, 429, 500])('sanitizes a public catalog HTTP %i failure', async status => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('unreported-response-body', { status }));
    expect(await runEnkryptCoverage(['--examples'])).toEqual({
      output: { error: { category: 'catalog_fetch_or_json' }, evidence: 'examples' },
      exitCode: 1,
    });
  });

  it.each([null, 'unreported-invalid-json'])(
    'rejects an absent or invalid JSON catalog body (%p)',
    async body => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body));
      expect(await runEnkryptCoverage(['--examples'])).toEqual({
        output: { error: { category: 'catalog_fetch_or_json' }, evidence: 'examples' },
        exitCode: 1,
      });
    }
  );

  it('cancels a catalog stream over the byte limit without printing its contents', async () => {
    const cancel = jest.fn<() => void>();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(5 * 1024 * 1024));
        controller.enqueue(new Uint8Array(1));
      },
      cancel,
    });
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body));
    expect(await runEnkryptCoverage(['--examples'])).toEqual({
      output: { error: { category: 'catalog_fetch_or_json' }, evidence: 'examples' },
      exitCode: 1,
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each([null, [], {}, { data: null }, { data: [{ id: '' }] }, { data: [{ id: 1 }] }])(
    'rejects malformed catalog envelopes and identifiers (%p)',
    async catalog => {
      const io = dependencies();
      io.fetchPublicCatalog.mockResolvedValue(catalog);
      expect(await runEnkryptCoverage(['--examples'], io)).toEqual({
        output: { error: { category: 'catalog_validation' }, evidence: 'examples' },
        exitCode: 1,
      });
    }
  );

  it('accepts sanitized JSON input through a fake reader without opening a real file', async () => {
    const io = dependencies();
    const result = await runEnkryptCoverage(['--input', 'sanitized.json'], io);
    expect(io.readInput).toHaveBeenCalledTimes(1);
    expect(io.readInput).toHaveBeenCalledWith('sanitized.json');
    expect(result.exitCode).toBe(0);
    expect(result.output.evidence).toEqual({
      kind: 'fullinput',
      scope: 'supplied sanitized input; completeness not independently verified',
    });
  });

  it('returns a nonzero exit code if a required public model is missing', async () => {
    const io = dependencies();
    io.fetchPublicCatalog.mockResolvedValue({ data: [] });
    const result = await runEnkryptCoverage(['--examples'], io);
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatchObject({
      requiredGate: { passed: false, missingRequiredModelIds: ENKRYPT_REQUIRED_MODEL_IDS },
    });
  });

  it('does not silently deduplicate repeated public catalog entries', async () => {
    const io = dependencies();
    io.fetchPublicCatalog.mockResolvedValue({
      data: [
        ...publicModels.map(({ openrouterId }) => ({ id: openrouterId })),
        { id: 'openai/gpt-oss-120b' },
      ],
    });
    const result = await runEnkryptCoverage(['--examples'], io);
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatchObject({
      counters: { matchedCount: 2, ambiguousCount: 1 },
      requiredGate: { passed: false, missingRequiredModelIds: ['openai/gpt-oss-120b'] },
    });
  });

  it.each([
    'input_read_or_json',
    'response_validation',
    'catalog_fetch_or_json',
    'catalog_validation',
  ])('reports only a safe category for %s failures', async category => {
    const io = dependencies();
    if (category === 'input_read_or_json') {
      io.readInput.mockRejectedValue(new Error('unreported-error-detail'));
    } else if (category === 'response_validation') {
      io.readInput.mockResolvedValue({ status: 'unreported-response-detail' });
    } else if (category === 'catalog_fetch_or_json') {
      io.fetchPublicCatalog.mockRejectedValue(new Error('unreported-response-detail'));
    } else {
      io.fetchPublicCatalog.mockResolvedValue({
        data: [{ id: null, extra: 'unreported-catalog-detail' }],
      });
    }
    expect(await runEnkryptCoverage(['--input', 'sanitized.json'], io)).toEqual({
      output: { error: { category }, evidence: 'fullinput' },
      exitCode: 1,
    });
    if (category === 'input_read_or_json' || category === 'response_validation') {
      expect(io.fetchPublicCatalog).not.toHaveBeenCalled();
    }
  });
});
