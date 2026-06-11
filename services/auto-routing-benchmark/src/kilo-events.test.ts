import { describe, expect, it } from 'vitest';
import { parseKiloRunEvents } from './kilo-events';

describe('parseKiloRunEvents', () => {
  it('assembles completed text parts and sums step-finish costs (part.* shape)', () => {
    const lines = [
      JSON.stringify({ type: 'text', part: { text: 'partial', time: { start: 1 } } }), // no end → skipped
      JSON.stringify({ type: 'text', part: { text: 'The answer is', time: { end: 10 } } }),
      JSON.stringify({ type: 'step-finish', part: { cost: 0.0012, tokens: { input: 5 } } }),
      JSON.stringify({ type: 'text', part: { text: '```\n20-40\n```', time: { end: 20 } } }),
      JSON.stringify({ type: 'step-finish', part: { cost: 0.0008 } }),
    ];

    const { text, costUsd } = parseKiloRunEvents(lines);
    expect(text).toBe('The answer is\n```\n20-40\n```');
    expect(costUsd).toBeCloseTo(0.002, 10);
  });

  it('skips unparseable lines without throwing', () => {
    const lines = [
      'not json',
      '',
      JSON.stringify({ type: 'text', part: { text: 'hello', time: { end: 1 } } }),
      '{ broken',
    ];
    const { text, costUsd } = parseKiloRunEvents(lines);
    expect(text).toBe('hello');
    expect(costUsd).toBeNull();
  });

  it('returns null cost when no step-finish event is seen', () => {
    const lines = [JSON.stringify({ type: 'text', part: { text: 'x', time: { end: 1 } } })];
    expect(parseKiloRunEvents(lines).costUsd).toBeNull();
  });

  it('accepts the flattened top-level event shape (evt.text / evt.cost)', () => {
    const lines = [
      JSON.stringify({ type: 'text', text: 'flat answer', time: { end: 5 } }),
      JSON.stringify({ type: 'step-finish', cost: 0.5 }),
    ];
    const { text, costUsd } = parseKiloRunEvents(lines);
    expect(text).toBe('flat answer');
    expect(costUsd).toBe(0.5);
  });

  it('prefers part.* over top-level fields when both present', () => {
    const lines = [
      JSON.stringify({ type: 'text', text: 'top', part: { text: 'nested', time: { end: 1 } } }),
      JSON.stringify({ type: 'step-finish', cost: 9, part: { cost: 0.01 } }),
    ];
    const { text, costUsd } = parseKiloRunEvents(lines);
    expect(text).toBe('nested');
    expect(costUsd).toBe(0.01);
  });

  it('returns empty text and null cost for no relevant events', () => {
    const lines = [
      JSON.stringify({ type: 'tool', part: { name: 'read' } }),
      JSON.stringify({ type: 'start' }),
    ];
    expect(parseKiloRunEvents(lines)).toMatchObject({ text: '', costUsd: null });
  });
});
