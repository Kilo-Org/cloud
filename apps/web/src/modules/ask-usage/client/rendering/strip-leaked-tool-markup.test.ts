import { stripLeakedToolMarkup } from './strip-leaked-tool-markup';

describe('stripLeakedToolMarkup', () => {
  it('removes complete function call blocks while preserving prose', () => {
    const text = `<function_calls><invoke name="kilo_usage_query_kilo_dataset"></invoke></function_calls>

Here is the validated answer.

Now let me render a chart: <function_calls><invoke name="browser_action"></invoke></function_calls>`;

    expect(stripLeakedToolMarkup(text)).toBe(
      'Here is the validated answer.\n\nNow let me render a chart:'
    );
  });

  it('removes function result blocks and orphan closing tags', () => {
    const text = `<function_result><invoke name="kilo_usage_render_result"><parameter name="type">chart</parameter><parameter name="data">[{"date":"2026-06-23","totalCostUsd":0.052}]</parameter></invoke></function_result>

</function_calls>
</parameter></invoke>

The bar chart above shows code review costs.`;

    expect(stripLeakedToolMarkup(text)).toBe('The bar chart above shows code review costs.');
  });

  it('removes a streaming block through the current end of text', () => {
    const text = `Here is the table.

Now rendering: <function_calls><invoke name="browser_action"><parameter name="url">data:text/html,`;

    expect(stripLeakedToolMarkup(text)).toBe('Here is the table.\n\nNow rendering:');
  });

  it('removes fake render payloads without returning parsed data', () => {
    const text = `<function_result>
  <invoke name="kilo_usage_render_result">
    <parameter name="type">chart</parameter>
    <parameter name="title">Code Review Costs</parameter>
    <parameter name="data">[{"date":"2026-06-23","totalCostUsd":0.05209422}]</parameter>
  </invoke>
</function_result>

Validated prose remains.`;

    const stripped = stripLeakedToolMarkup(text);
    expect(stripped).toBe('Validated prose remains.');
    expect(stripped).not.toContain('kilo_usage_render_result');
    expect(stripped).not.toContain('totalCostUsd');
  });

  it('preserves normal markdown and angle-bracket prose', () => {
    const text = 'Use `a < b` in examples and keep <not_a_tool> prose.';

    expect(stripLeakedToolMarkup(text)).toBe(text);
  });
});
