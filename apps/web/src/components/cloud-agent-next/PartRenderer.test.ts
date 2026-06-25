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

  it('strips malformed raw chart JSON while preserving the assistant answer', () => {
    const text = `<function_returns> {"chartType":"bar","title":"costUsd over time","data":{"labels":["2026-06-18","2026-06-19"],"datasets":[{"label":"costUsd","data":[0.15052808,0.10165488]}]}}</parameter> </invoke>

Here is the daily cost breakdown.`;

    expect(stripRawToolCallMarkup(text)).toBe('Here is the daily cost breakdown.');
    expect(extractRawUsageRenderResults(text)).toEqual([
      {
        type: 'chart',
        chartType: 'bar',
        title: 'costUsd over time',
        dataset: undefined,
        metric: 'costUsd',
        scopeType: undefined,
        startDate: undefined,
        endDate: undefined,
        data: [
          { label: '2026-06-18', costUsd: 0.15052808 },
          { label: '2026-06-19', costUsd: 0.10165488 },
        ],
      },
    ]);
  });

  it('preserves unrenderable raw markup when display fallback is enabled', () => {
    const text = `<function_returns><html><body><div id="chart"></div></body></html></function_returns>`;

    expect(stripRawToolCallMarkup(text, { preserveWhenNoRenderableResults: true })).toBe(text);
    expect(extractRawUsageRenderResults(text)).toEqual([]);
  });

  it('extracts raw dataset query function results for local chart rendering', () => {
    const text = `
<function_calls>
<invoke name="kilo_usage__query_kilo_dataset">
<parameter name="mode">timeseries</parameter>
<parameter name="dataset">microdollar_usage</parameter>
<parameter name="metrics">[{ "operation": "sum", "field": "costUsd" }]</parameter>
<parameter name="bucket">day</parameter>
<parameter name="startDate">2026-06-18</parameter>
<parameter name="endDate">2026-06-24</parameter>
</invoke>
</function_calls>
<function_result>
{"type":"timeseries","bucket":"day","metrics":[{"operation":"sum","field":"costUsd"}],"rows":[{"bucketStart":"2026-06-18T00:00:00.000Z","sum_costUsd":1.4230397927999998},{"bucketStart":"2026-06-19T00:00:00.000Z","sum_costUsd":0.27994249249999995}],"scopeType":"me"}
</parameter>
</function_result>

Here's your daily cost trend.`;

    expect(stripRawToolCallMarkup(text, { preserveWhenNoRenderableResults: true })).toBe(
      "Here's your daily cost trend."
    );
    expect(extractRawUsageRenderResults(text)).toEqual([
      {
        type: 'chart',
        chartType: 'bar',
        title: 'Cost over time',
        dataset: 'microdollar_usage',
        metric: 'sum_costUsd',
        scopeType: 'me',
        startDate: '2026-06-18',
        endDate: '2026-06-24',
        data: [
          { bucketStart: '2026-06-18T00:00:00.000Z', sum_costUsd: 1.4230397927999998 },
          {
            bucketStart: '2026-06-19T00:00:00.000Z',
            sum_costUsd: Number('0.27994249249999995'),
          },
        ],
      },
    ]);
  });
});
