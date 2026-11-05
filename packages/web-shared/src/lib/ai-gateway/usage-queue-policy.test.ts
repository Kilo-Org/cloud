import { isSfoUsageQueueSelected } from './usage-queue-policy';

const eligible = { kiloUserId: 'oauth/synthetic' };
const enabled = { enabled: true };

test('eligible SFO payer is selected without an exposure or allowlist gate', () => {
  expect(isSfoUsageQueueSelected(enabled, eligible)).toBe(true);
  expect(isSfoUsageQueueSelected(enabled, { kiloUserId: 'payer:日本語' })).toBe(true);
});

test('disabled production selection selects nobody', () => {
  expect(isSfoUsageQueueSelected({ enabled: false }, eligible)).toBe(false);
});

test('missing user identity selects nobody', () => {
  expect(isSfoUsageQueueSelected(enabled, { kiloUserId: '' })).toBe(false);
});
