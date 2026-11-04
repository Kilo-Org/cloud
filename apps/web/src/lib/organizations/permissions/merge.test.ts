import { stricter } from './merge';

describe('stricter', () => {
  it.each([
    ['allow', 'allow', 'allow'],
    ['allow', 'ask', 'ask'],
    ['allow', 'deny', 'deny'],
    ['ask', 'allow', 'ask'],
    ['ask', 'ask', 'ask'],
    ['ask', 'deny', 'deny'],
    ['deny', 'allow', 'deny'],
    ['deny', 'ask', 'deny'],
    ['deny', 'deny', 'deny'],
  ] as const)('org %s with local %s is %s', (org, local, expected) => {
    expect(stricter(org, local)).toBe(expected);
  });
});
