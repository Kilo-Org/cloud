import { expect, it } from 'vitest';

import { parseReasoningDefault } from './parse-reasoning-default';

it('defaults to collapsed for missing/invalid', () => {
  expect(parseReasoningDefault(null)).toBe(false);
  expect(parseReasoningDefault('nonsense')).toBe(false);
});

it('reads true/false', () => {
  expect(parseReasoningDefault('true')).toBe(true);
  expect(parseReasoningDefault('false')).toBe(false);
});
