import {
  aggregateCanonicalCostInsightDrivers,
  aggregateNormalizedCanonicalCostInsightDrivers,
  loadCanonicalCostInsightAggregationsByHour,
  mapAiGatewayCanonicalDriver,
  mapCodingPlanCanonicalDriver,
  mapExaCanonicalDriver,
  mapKiloClawCanonicalDriver,
  parseSafeDatabaseInteger,
  type CostInsightQueryExecutor,
} from './canonical-sources';

const userOwner = { type: 'user', id: 'user-1' } as const;

describe('Cost Insights canonical source mapping', () => {
  test('maps AI Gateway dimensions with requested model and inference provider precedence', () => {
    const mapped = mapAiGatewayCanonicalDriver({
      owner: userOwner,
      actorUserId: 'user-1',
      feature: 'cloud-agent',
      apiKind: 'responses',
      requestedModel: 'requested/model',
      resolvedModel: 'resolved/model',
      inferenceProvider: 'inference-provider',
      gatewayProvider: 'gateway-provider',
      totalMicrodollars: 17,
      spendRecordCount: 1,
    });

    expect(mapped.driver).toMatchObject({
      category: 'variable',
      source: 'ai_gateway',
      productKey: 'cloud-agent',
      featureKey: 'responses',
      modelOrPlanKey: 'requested/model',
      providerKey: 'inference-provider',
      actorUserId: 'user-1',
    });
    expect(mapped.unknownTaxonomyValues).toEqual([]);
  });

  test('maps absent AI attribution to other sentinels', () => {
    const mapped = mapAiGatewayCanonicalDriver({
      owner: userOwner,
      actorUserId: 'user-1',
      feature: null,
      apiKind: null,
      requestedModel: null,
      resolvedModel: null,
      inferenceProvider: null,
      gatewayProvider: null,
      totalMicrodollars: 5,
      spendRecordCount: 1,
    });

    expect(mapped.driver).toMatchObject({
      productKey: 'other',
      featureKey: 'other',
      modelOrPlanKey: 'other',
      providerKey: 'other',
    });
    expect(mapped.unknownTaxonomyValues).toEqual([]);
  });

  test('reports unknown AI and Exa taxonomy while preserving bounded fallback mapping', () => {
    const ai = mapAiGatewayCanonicalDriver({
      owner: userOwner,
      actorUserId: 'user-1',
      feature: 'unregistered-feature',
      apiKind: 'unknown-operation',
      requestedModel: 'model',
      resolvedModel: null,
      inferenceProvider: 'provider',
      gatewayProvider: null,
      totalMicrodollars: 8,
      spendRecordCount: 2,
    });
    const exa = mapExaCanonicalDriver({
      owner: userOwner,
      actorUserId: 'user-1',
      path: '/future-path',
      totalMicrodollars: 3,
      spendRecordCount: 1,
    });

    expect(ai.driver.productKey).toBe('other');
    expect(ai.driver.featureKey).toBe('other');
    expect(ai.unknownTaxonomyValues).toHaveLength(2);
    expect(exa.driver).toMatchObject({
      source: 'other',
      productKey: 'exa',
      featureKey: 'other',
      modelOrPlanKey: 'other',
      providerKey: 'exa',
    });
    expect(exa.unknownTaxonomyValues).toEqual([
      expect.objectContaining({ sourceFamily: 'exa', field: 'feature_key' }),
    ]);
  });

  test('keeps allowlisted Exa path as canonical operation key', () => {
    const mapped = mapExaCanonicalDriver({
      owner: userOwner,
      actorUserId: 'user-1',
      path: '/search',
      totalMicrodollars: 3,
      spendRecordCount: 1,
    });

    expect(mapped.driver.featureKey).toBe('search');
    expect(mapped.unknownTaxonomyValues).toEqual([]);
  });

  test('maps Coding Plan and pure-credit KiloClaw scheduled spend', () => {
    const codingPlan = mapCodingPlanCanonicalDriver({
      owner: userOwner,
      actorUserId: 'user-1',
      termKind: 'renewal',
      planId: 'minimax-annual',
      providerId: 'minimax',
      totalMicrodollars: 100,
      spendRecordCount: 1,
    });
    const kiloClaw = mapKiloClawCanonicalDriver({
      owner: userOwner,
      actorUserId: 'user-1',
      isCommit: true,
      featureKey: 'renewal',
      totalMicrodollars: 200,
      spendRecordCount: 1,
    });

    expect(codingPlan.driver).toMatchObject({
      category: 'scheduled',
      source: 'coding_plan',
      productKey: 'coding-plan',
      featureKey: 'renewal',
      modelOrPlanKey: 'minimax-annual',
      providerKey: 'minimax',
    });
    expect(kiloClaw).toMatchObject({
      category: 'scheduled',
      source: 'kiloclaw',
      productKey: 'kiloclaw-hosting',
      featureKey: 'renewal',
      modelOrPlanKey: 'commit',
      providerKey: 'other',
    });
    expect(
      mapKiloClawCanonicalDriver({
        owner: userOwner,
        actorUserId: 'user-1',
        isCommit: false,
        featureKey: 'legacy-description',
        totalMicrodollars: 1,
        spendRecordCount: 1,
      }).featureKey
    ).toBe('other');
  });

  test('aggregates identical normalized drivers and owner totals deterministically', async () => {
    const input = mapExaCanonicalDriver({
      owner: userOwner,
      actorUserId: 'user-1',
      path: '/answer',
      totalMicrodollars: 4,
      spendRecordCount: 1,
    }).driver;
    const aggregation = await aggregateCanonicalCostInsightDrivers([
      input,
      { ...input, totalMicrodollars: 6, spendRecordCount: 2 },
    ]);

    expect(aggregation.totals).toEqual([
      expect.objectContaining({
        owner: userOwner,
        category: 'variable',
        totalMicrodollars: 10,
        spendRecordCount: 3,
      }),
    ]);
    expect(aggregation.drivers).toEqual([
      expect.objectContaining({
        totalMicrodollars: 10,
        spendRecordCount: 3,
        driverKey: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    ]);
  });

  test('rejects matching driver digests with different canonical dimensions', async () => {
    const input = mapExaCanonicalDriver({
      owner: userOwner,
      actorUserId: 'user-1',
      path: '/answer',
      totalMicrodollars: 4,
      spendRecordCount: 1,
    }).driver;
    const normalized = await aggregateCanonicalCostInsightDrivers([input]);
    const driver = normalized.drivers[0];
    if (!driver) throw new Error('Expected normalized canonical driver.');

    expect(() =>
      aggregateNormalizedCanonicalCostInsightDrivers([
        driver,
        { ...driver, providerKey: 'different-provider' },
      ])
    ).toThrow('Canonical Cost Insights driver digest collision.');
  });

  test('keeps multi-hour canonical source aggregates separated by UTC hour', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            hour_start: '2026-06-01 00:00:00+00',
            owned_by_user_id: 'user-1',
            owned_by_organization_id: null,
            actor_user_id: 'user-1',
            raw_product_key: null,
            raw_feature_key: null,
            requested_model: 'model',
            resolved_model: null,
            inference_provider: 'provider',
            gateway_provider: null,
            total_microdollars: '4',
            spend_record_count: '1',
          },
          {
            hour_start: '2026-06-01 01:00:00+00',
            owned_by_user_id: 'user-1',
            owned_by_organization_id: null,
            actor_user_id: 'user-1',
            raw_product_key: null,
            raw_feature_key: null,
            requested_model: 'model',
            resolved_model: null,
            inference_provider: 'provider',
            gateway_provider: null,
            total_microdollars: '6',
            spend_record_count: '2',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const executor = { execute } as unknown as CostInsightQueryExecutor;

    const hourly = await loadCanonicalCostInsightAggregationsByHour(executor, {
      startInclusive: '2026-06-01T00:00:00.000Z',
      endExclusive: '2026-06-01T02:00:00.000Z',
    });

    expect(execute).toHaveBeenCalledTimes(4);
    expect(hourly).toEqual([
      expect.objectContaining({
        hourStart: '2026-06-01T00:00:00.000Z',
        totals: [expect.objectContaining({ totalMicrodollars: 4, spendRecordCount: 1 })],
      }),
      expect.objectContaining({
        hourStart: '2026-06-01T01:00:00.000Z',
        totals: [expect.objectContaining({ totalMicrodollars: 6, spendRecordCount: 2 })],
      }),
    ]);
  });

  test('rejects unsafe database integers instead of rounding them', () => {
    expect(() => parseSafeDatabaseInteger('9007199254740992', 'unsafe aggregate')).toThrow(
      'safe-integer range'
    );
  });
});
