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
  });

  test('omits recipes when examples are disabled', () => {
    const output = describeKiloDataset({ dataset: 'microdollar_usage', includeExamples: false });

    expect(output.recipes).toBeUndefined();
  });
});
