import { describe, expect, test } from '@jest/globals';
import { describeKiloDataset } from './catalog-description';
import { GetKiloUsageCostInputSchema, QueryKiloDatasetInputSchema } from './contracts';

describe('describeKiloDataset recipes', () => {
  test('returns validated recipes for usage-cost discovery', () => {
    const output = describeKiloDataset({ dataset: 'microdollar_usage', includeExamples: true });

    expect(output.recipes?.map(recipe => recipe.id)).toEqual(
      expect.arrayContaining([
        'usage_cost_yesterday',
        'usage_cost_by_model_last_7_days',
        'usage_cost_daily_trend',
        'raw_usage_cost_total_day',
      ])
    );

    for (const recipe of output.recipes ?? []) {
      const result =
        recipe.tool === 'get_kilo_usage_cost'
          ? GetKiloUsageCostInputSchema.safeParse(recipe.input)
          : QueryKiloDatasetInputSchema.safeParse(recipe.input);

      expect(result.success).toBe(true);
    }

    expect(output.recipes?.find(recipe => recipe.id === 'usage_cost_yesterday')).toMatchObject({
      tool: 'get_kilo_usage_cost',
      input: { period: 'yesterday', timezone: null },
    });
    expect(
      output.recipes?.find(recipe => recipe.id === 'usage_cost_by_model_last_7_days')
    ).toMatchObject({
      tool: 'query_kilo_dataset',
      input: { mode: 'aggregate', groupBy: ['model'] },
    });
    expect(output.recipes?.find(recipe => recipe.id === 'usage_cost_daily_trend')).toMatchObject({
      tool: 'query_kilo_dataset',
      input: { mode: 'timeseries', bucket: 'day' },
    });
  });

  test('omits recipes when examples are disabled', () => {
    const output = describeKiloDataset({ dataset: 'microdollar_usage', includeExamples: false });

    expect(output.recipes).toBeUndefined();
  });
});
