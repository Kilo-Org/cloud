import { isFraUsageQueueSelected } from './usage-queue-policy';

const enabled = { enabled: true };

test.each([
  { name: 'personal payer', context: { kiloUserId: 'oauth/synthetic' } },
  { name: 'arbitrary-string payer', context: { kiloUserId: 'not-a-uuid' } },
  {
    name: 'organization payer',
    context: {
      kiloUserId: 'member-a',
      organizationId: 'a1b2c3d4-e5f6-47a8-9b0c-d1e2f3a4b5c6',
    },
  },
])('$name uses the queue in an enabled production FRA deployment', ({ context }) => {
  expect(isFraUsageQueueSelected(enabled, context)).toBe(true);
});

test.each([
  { name: 'disabled deployment', config: { enabled: false }, context: { kiloUserId: 'oauth/x' } },
  { name: 'missing payer', config: enabled, context: { kiloUserId: '' } },
])('$name is not selected', ({ config, context }) => {
  expect(isFraUsageQueueSelected(config, context)).toBe(false);
});
