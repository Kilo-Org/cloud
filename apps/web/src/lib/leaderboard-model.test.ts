import { describe, expect, test } from '@jest/globals';

import { normalizeLeaderboardModel } from './leaderboard-model';

describe('normalizeLeaderboardModel', () => {
  test.each([
    ['anthropic/claude-sonnet-4.5', 'claude-sonnet-4.5'],
    ['vendor/anthropic/claude-sonnet-4.5', 'claude-sonnet-4.5'],
    ['claude-sonnet-4.5', 'claude-sonnet-4.5'],
    ['acme/model/', 'model'],
    [' acme/model ', 'model'],
    ['openrouter/auto', 'openrouter/auto'],
    ['openrouter/free', 'openrouter/free'],
    ['acme/model:free', 'model:free'],
    ['acme/model:nitro', 'model'],
    ['acme/model:exacto:free', 'model'],
    ['~deepseek/unresolved-latest', 'unresolved-latest'],
  ])('%s -> %s', (model, expected) => {
    expect(normalizeLeaderboardModel(model)).toBe(expected);
  });
});
