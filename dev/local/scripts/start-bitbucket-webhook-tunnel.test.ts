import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveBitbucketWebhookTunnelPlan } from './start-bitbucket-webhook-tunnel';

test('uses KiloClaw named tunnel app hostname for stable Bitbucket webhook URL', () => {
  const plan = resolveBitbucketWebhookTunnelPlan(
    {
      TUNNEL_NAME: 'kilo-dev',
      TUNNEL_APP_HOSTNAME: 'app-dev.example.com',
    },
    '3000'
  );

  assert.equal(plan.mode, 'named');
  assert.deepEqual(plan.cloudflaredArgs, ['tunnel', 'run', 'kilo-dev']);
  assert.equal(plan.webhookBaseUrl, 'https://app-dev.example.com');
});

test('lets Bitbucket-specific named tunnel settings override shared tunnel settings', () => {
  const plan = resolveBitbucketWebhookTunnelPlan(
    {
      TUNNEL_NAME: 'kilo-dev',
      TUNNEL_APP_HOSTNAME: 'app-dev.example.com',
      BITBUCKET_CODE_REVIEW_TUNNEL_NAME: 'bitbucket-review-dev',
      BITBUCKET_CODE_REVIEW_WEBHOOK_HOSTNAME: 'bitbucket-review-dev.example.com',
    },
    '3000'
  );

  assert.equal(plan.mode, 'named');
  assert.deepEqual(plan.cloudflaredArgs, ['tunnel', 'run', 'bitbucket-review-dev']);
  assert.equal(plan.webhookBaseUrl, 'https://bitbucket-review-dev.example.com');
});

test('keeps quick tunnel behavior when no named tunnel is configured', () => {
  const plan = resolveBitbucketWebhookTunnelPlan({}, '3000');

  assert.equal(plan.mode, 'quick');
  assert.deepEqual(plan.cloudflaredArgs, ['tunnel', '--url', 'http://localhost:3000']);
  assert.equal(plan.webhookBaseUrl, null);
});
