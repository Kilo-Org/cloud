import { stripRawToolCallMarkup } from './raw-tool-call-markup';

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
});
