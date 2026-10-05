import assert from 'node:assert/strict';
import test from 'node:test';
import { firewallCopyBody } from './firewall.js';

const rewrites = [
  { from: '/api/gateway/', to: '/api/v1/' },
  { from: '/api/gateway/v1/', to: '/api/v1/' },
  { from: '/api/openrouter/', to: '/api/v1/' },
  { from: '/api/openrouter/v1/', to: '/api/v1/' },
];

function pathGroup(op: string, value: string | string[]) {
  return { conditions: [{ type: 'path', op, value }] };
}

void test('firewallCopyBody keeps the writable config and drops read-only fields', () => {
  const copy = firewallCopyBody(
    {
      id: 'config-id',
      version: 7,
      ownerId: 'team-id',
      projectKey: 'project-key',
      updatedAt: '2026-10-05',
      changes: [],
      firewallEnabled: true,
      crs: {
        gen: { active: true, action: 'deny' },
        php: { active: false, action: 'log' },
      },
      managedRules: {
        owasp: { active: true, action: 'deny', userId: 'user-id', updatedAt: '2026-10-05' },
      },
      rules: [
        {
          id: 'rule-id',
          name: 'Block a user agent',
          description: 'Scraper',
          active: true,
          conditionGroup: [{ conditions: [{ type: 'user_agent', op: 'eq', value: 'bot/1.0' }] }],
          action: { mitigate: { action: 'deny' } },
          valid: true,
          validationErrors: null,
        },
      ],
      ips: [{ id: 'ip-id', hostname: '*', ip: '203.0.113.7', action: 'deny' }],
    },
    []
  );

  assert.deepEqual(copy.body, {
    firewallEnabled: true,
    rules: [
      {
        name: 'Block a user agent',
        description: 'Scraper',
        active: true,
        conditionGroup: [{ conditions: [{ type: 'user_agent', op: 'eq', value: 'bot/1.0' }] }],
        action: { mitigate: { action: 'deny' } },
      },
    ],
    ips: [{ hostname: '*', ip: '203.0.113.7', action: 'deny' }],
    crs: {
      gen: { active: true, action: 'deny' },
      php: { active: false, action: 'log' },
    },
    managedRules: { owasp: { active: true, action: 'deny' } },
  });
  assert.deepEqual(copy.rewrites, []);
  assert.deepEqual(copy.review, []);
});

void test('firewallCopyBody rewrites path prefixes, longest first, and drops duplicate groups', () => {
  const copy = firewallCopyBody(
    {
      firewallEnabled: true,
      rules: [
        {
          name: 'Inference paths',
          active: true,
          conditionGroup: [
            pathGroup('eq', '/api/gateway/chat/completions'),
            pathGroup('pre', '/api/gateway/v1/'),
            pathGroup('pre', '/api/openrouter/v1/'),
            pathGroup('inc', ['/api/gateway/messages', '/api/device-auth/codes']),
            pathGroup('pre', '/api/device-auth/codes/'),
          ],
          action: { mitigate: { action: 'rate_limit' } },
        },
      ],
      ips: [],
    },
    rewrites
  );

  const [rule] = copy.body.rules as Array<{ conditionGroup: unknown }>;
  assert.deepEqual(rule?.conditionGroup, [
    pathGroup('eq', '/api/v1/chat/completions'),
    pathGroup('pre', '/api/v1/'),
    pathGroup('inc', ['/api/v1/messages', '/api/device-auth/codes']),
    pathGroup('pre', '/api/device-auth/codes/'),
  ]);
  assert.deepEqual(copy.rewrites, [
    {
      rule: 'Inference paths',
      from: '/api/gateway/chat/completions',
      to: '/api/v1/chat/completions',
    },
    { rule: 'Inference paths', from: '/api/gateway/v1/', to: '/api/v1/' },
    { rule: 'Inference paths', from: '/api/openrouter/v1/', to: '/api/v1/' },
    { rule: 'Inference paths', from: '/api/gateway/messages', to: '/api/v1/messages' },
  ]);
});

void test('firewallCopyBody flags conditions it cannot rewrite safely', () => {
  const copy = firewallCopyBody(
    {
      firewallEnabled: true,
      rules: [
        {
          name: 'Regex path',
          active: true,
          conditionGroup: [pathGroup('re', '^/api/gateway/.*')],
          action: { mitigate: { action: 'deny' } },
        },
        {
          name: 'Host match',
          active: true,
          conditionGroup: [{ conditions: [{ type: 'host', op: 'eq', value: 'app.kilo.ai' }] }],
          action: { mitigate: { action: 'deny' } },
          valid: false,
        },
      ],
      ips: [],
    },
    rewrites
  );

  assert.deepEqual(copy.review, [
    'Regex path: path condition with op re was not rewritten',
    'Host match: Vercel marks this rule as invalid',
    'Host match: matches on host, which differs between projects',
  ]);
});

void test('firewallCopyBody refuses configs it cannot copy faithfully', () => {
  assert.throws(
    () => firewallCopyBody({ firewallEnabled: true, rules: [], ips: [], rulesets: [{}] }, []),
    /uses rulesets/
  );
  assert.throws(
    () => firewallCopyBody({ firewallEnabled: true, rules: [], ips: [], conditions: [{}] }, []),
    /uses conditions/
  );
  assert.throws(() => firewallCopyBody({ rules: [], ips: [] }, []), /no firewallEnabled flag/);
});
