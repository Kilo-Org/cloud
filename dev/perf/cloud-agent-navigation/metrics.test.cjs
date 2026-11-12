const { test } = require('node:test');
const assert = require('node:assert/strict');
const { localOrigin, median, requestPath, summarize, fixtureSchema } = require('./metrics.cjs');

test('only local targets are accepted, and network output omits credentials and queries', () => {
  assert.equal(localOrigin('http://localhost:3001/cloud'), 'http://localhost:3001');
  assert.throws(() => localOrigin('https://app.kilo.ai'));
  assert.throws(() => localOrigin('http://token@localhost:3000'));
  assert.equal(
    requestPath('http://localhost/api/trpc/list?input=private&ticket=secret'),
    '/api/trpc/list'
  );
});

test('reports medians and explicitly marks missed budgets', () => {
  assert.equal(median([4, 1, 3, 2]), 2.5);
  const summary = summarize(
    [100, 300, 200, 400].map(contentMs => ({
      name: 'opened',
      contentMs,
      budgetMs: 150,
      requests: [{ decodedBytes: 1024 }],
    }))
  );
  assert.deepEqual(summary, [
    {
      name: 'opened',
      samples: 4,
      medianContentMs: 250,
      medianDecodedBytes: 1024,
      budgetMs: 150,
      withinBudget: false,
    },
  ]);
});

test('fixture interaction names cannot escape profile output paths', () => {
  assert.equal(
    fixtureSchema.safeParse({
      initialPath: '/cloud/chat',
      initialReadySelector: 'main',
      interactions: [{ name: '../secret', clickSelector: 'button', readySelector: 'main' }],
    }).success,
    false
  );
});
