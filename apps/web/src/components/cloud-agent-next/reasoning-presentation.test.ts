import { getReasoningHeader, getReasoningPresentation } from './reasoning-presentation';

it.each([
  [undefined, { start: 0 }, true, 'Thinking'],
  ['Inspect the parser', { start: 0 }, true, 'Thinking: Inspect the parser'],
  [undefined, { start: 0 }, false, 'Thought'],
  ['Inspect the parser', { start: 0 }, false, 'Thought: Inspect the parser'],
  [undefined, { start: 100, end: 1300 }, false, 'Thought: 1.2s'],
  ['Inspect the parser', { start: 100, end: 1300 }, false, 'Thought: Inspect the parser · 1.2s'],
  ['Inspect the parser', { start: 100, end: 100 }, false, 'Thought: Inspect the parser · 0ms'],
  [undefined, { start: 100, end: 0 }, false, 'Thought: 0ms'],
  [undefined, { start: 0, end: 999 }, false, 'Thought: 999ms'],
  [undefined, { start: 0, end: 1000 }, false, 'Thought: 1.0s'],
  [undefined, { start: 0, end: 60000 }, false, 'Thought: 1m 0s'],
  [undefined, { start: 0, end: 123456 }, false, 'Thought: 2m 3s'],
  [undefined, { start: 0, end: 3600000 }, false, 'Thought: 1h 0m'],
  [undefined, { start: 0, end: 86400000 }, false, 'Thought: 1d 0h'],
] as const)('formats reasoning header %j %j (streaming=%s)', (title, time, streaming, expected) => {
  expect(getReasoningHeader(title, time, streaming)).toBe(expected);
});

it.each([
  [
    '**Inspect the parser**\n\nRead the implementation.',
    { title: 'Inspect the parser', body: 'Read the implementation.' },
  ],
  [
    '## Check `parse` [calls](https://example.com) ##\n\n- Read the tests',
    { title: 'Check parse calls', body: '- Read the tests' },
  ],
  [
    'Review the changes\r\n------------------\r\n\r\nCheck the result.',
    { title: 'Review the changes', body: 'Check the result.' },
  ],
  [
    '<h3>Check <em>provider</em> status</h3>\n\nContinue.',
    { title: 'Check provider status', body: 'Continue.' },
  ],
  ['__Summary__', { title: 'Summary', body: '' }],
  [
    'Plain reasoning.\n\n**Later heading**\nMore text.',
    { body: 'Plain reasoning.\n\n**Later heading**\nMore text.' },
  ],
  ['**Important** because this is prose.', { body: '**Important** because this is prose.' }],
  [
    '[REDACTED]\n**Review**\n\nKeep [REDACTED] the readable text.',
    { title: 'Review', body: 'Keep  the readable text.' },
  ],
  ['**Review**\n\n<!-- -->', { title: 'Review', body: '' }],
  ['<!-- -->', { body: '' }],
  ['**Review**\n\n<!--\nKeep reading.', { title: 'Review', body: 'Keep reading.' }],
  ['[REDACTED]\n[REDACTED]\n\t', { body: '' }],
] as const)('presents reasoning %j without losing readable content', (text, expected) => {
  expect(getReasoningPresentation(text)).toEqual(expected);
});
