import { extractRawUsageRenderResults, stripRawToolCallMarkup } from './raw-tool-call-markup';

describe('stripRawToolCallMarkup', () => {
  it('removes complete function call blocks while preserving prose', () => {
    const text = `<function_calls><invoke name="kilo_usage_query_kilo_dataset"></invoke></function_calls>

Here is the validated answer.

Now let me render a chart: <function_calls><invoke name="browser_action"></invoke></function_calls>`;

    expect(stripRawToolCallMarkup(text)).toBe('Here is the validated answer.');
  });

  it('removes a streaming function call block through the end of the part', () => {
    const text = `Here is the table.

Now rendering: <function_calls><invoke name="browser_action"><parameter name="url">data:text/html,`;

    expect(stripRawToolCallMarkup(text)).toBe('Here is the table.');
  });

  it('removes function result render blocks and orphan closing tags', () => {
    const text = `<function_result><invoke name="kilo_usage_render_result"><parameter name="type">chart</parameter><parameter name="data">[{"date":"2026-06-23","totalCostUsd":0.052}]</parameter></invoke></function_result>

</function_calls>

The bar chart above shows code review costs.`;

    expect(stripRawToolCallMarkup(text)).toBe('The bar chart above shows code review costs.');
  });

  it('extracts raw usage render result blocks for local rendering', () => {
    const text = `<function_result><invoke name="kilo_usage_render_result"><parameter name="type">chart</parameter><parameter name="chartType">bar</parameter><parameter name="title">Code Review Costs</parameter><parameter name="dataset">code_reviews</parameter><parameter name="metric">totalCostUsd</parameter><parameter name="data">[{"date":"2026-06-23","totalCostUsd":0.052}]</parameter></invoke></function_result>`;

    expect(extractRawUsageRenderResults(text)).toEqual([
      {
        type: 'chart',
        chartType: 'bar',
        title: 'Code Review Costs',
        dataset: 'code_reviews',
        metric: 'totalCostUsd',
        scopeType: undefined,
        startDate: undefined,
        endDate: undefined,
        data: [{ date: '2026-06-23', totalCostUsd: 0.052 }],
      },
    ]);
  });
});
