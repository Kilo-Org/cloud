import { parseUsageQueueFraExposure } from './usage-queue-config';
import { isFraUsageQueueSelected } from './usage-queue-policy';

const enabled = { enabled: true, exposure: 1 };
const payer = { kiloUserId: 'oauth/synthetic' };

test.each(['', 'bad', '0x1', '0b1', '0o1', 'NaN', 'Infinity', '1e309', '-0.1', '1.01'])(
  'invalid FRA exposure %s selects nobody',
  value => {
    expect(parseUsageQueueFraExposure(value)).toBe(0);
    expect(
      isFraUsageQueueSelected({ ...enabled, exposure: parseUsageQueueFraExposure(value) }, payer)
    ).toBe(false);
  }
);
test.each(['0', '0.01', '0.1', '1', '1.0', '1e-2'])('accepts decimal FRA exposure %s', value =>
  expect(parseUsageQueueFraExposure(value)).toBe(Number(value))
);

test('FRA cohort has stable boundaries and launch cannot be bypassed', () => {
  expect(isFraUsageQueueSelected({ ...enabled, exposure: 0.8961 }, payer)).toBe(false);
  expect(isFraUsageQueueSelected({ ...enabled, exposure: 0.8962 }, payer)).toBe(true);
  expect(isFraUsageQueueSelected({ ...enabled, exposure: 0 }, payer)).toBe(false);
  expect(isFraUsageQueueSelected({ ...enabled, enabled: false }, payer)).toBe(false);
  expect(isFraUsageQueueSelected(enabled, { kiloUserId: '' })).toBe(false);
  expect(isFraUsageQueueSelected(enabled, payer)).toBe(true);
});

test('FRA organization casing/member changes preserve the payer cohort and personal IDs keep case', () => {
  const organizationId = 'a1b2c3d4-e5f6-47a8-9b0c-d1e2f3a4b5c6';
  for (const kiloUserId of ['member-a', 'oauth/member-b']) {
    for (const id of [organizationId, organizationId.toUpperCase()]) {
      expect(
        isFraUsageQueueSelected(
          { ...enabled, exposure: 0.8826 },
          { kiloUserId, organizationId: id }
        )
      ).toBe(false);
      expect(
        isFraUsageQueueSelected(
          { ...enabled, exposure: 0.8827 },
          { kiloUserId, organizationId: id }
        )
      ).toBe(true);
    }
  }
  expect(isFraUsageQueueSelected({ ...enabled, exposure: 0.7 }, payer)).toBe(false);
  expect(
    isFraUsageQueueSelected({ ...enabled, exposure: 0.7 }, { kiloUserId: 'OAUTH/SYNTHETIC' })
  ).toBe(true);
});

test('FRA exposure grows a stable monotonic payer cohort from none to all', () => {
  const payers = Array.from({ length: 1000 }, (_, i) => ({ kiloUserId: `payer-${i}` }));
  let previous = new Set<string>();
  for (const exposure of [0, 0.01, 0.1, 0.5, 1]) {
    const selected = new Set(
      payers
        .filter(payer => isFraUsageQueueSelected({ ...enabled, exposure }, payer))
        .map(payer => payer.kiloUserId)
    );
    for (const id of previous) expect(selected.has(id)).toBe(true);
    if (exposure === 0) expect(selected.size).toBe(0);
    else expect(selected.size).toBeGreaterThan(previous.size);
    previous = selected;
  }
  expect(previous.size).toBe(payers.length);
});
