import { isSfoUsageQueueSelected } from './usage-queue-policy';
import { parseUsageQueueSfoExposure, parseUsageQueueSfoUserIds } from './usage-queue-config';

const eligible = { kiloUserId: 'oauth/synthetic' };
const enabled = { enabled: true, exposure: 1, userIds: null };

test.each([
  '',
  '-0.01',
  '1.01',
  '100',
  'NaN',
  'Infinity',
  '-Infinity',
  'true',
  'bad',
  '0x1',
  '0X1',
  '0b1',
  '0B1',
  '0o1',
  '0O1',
  '0.1.2',
  '1e',
  '1_0',
])('invalid exposure %s fails closed', value => expect(parseUsageQueueSfoExposure(value)).toBe(0));
test.each([
  '0',
  '0.01',
  '0.1',
  '0.25',
  '0.5',
  '1',
  '1.0',
  '1e-2',
  '1E-2',
  '1e+0',
  '.01',
  '+0.1',
  ' 0.1 ',
])('accepts exposure %s', value => expect(parseUsageQueueSfoExposure(value)).toBe(Number(value)));

test('allowlist is optional, exact and supports arbitrary string user IDs', () => {
  expect(parseUsageQueueSfoUserIds('')).toBeNull();
  expect(parseUsageQueueSfoUserIds('["oauth/github/alice","payer:日本語"," id "]')).toEqual(
    new Set(['oauth/github/alice', 'payer:日本語', ' id '])
  );
});
test.each(['bad-json', 'null', '{}', '"oauth/synthetic"', '[1]', '[""]', '["ok",null]'])(
  'invalid allowlist %s selects nobody',
  value => {
    const userIds = parseUsageQueueSfoUserIds(value);
    expect(userIds).toEqual(new Set());
    expect(isSfoUsageQueueSelected({ ...enabled, userIds }, eligible)).toBe(false);
  }
);
test('allowlist restricts selection and cannot bypass rollback switches', () => {
  const userIds = new Set([eligible.kiloUserId]);
  expect(isSfoUsageQueueSelected({ ...enabled, userIds }, eligible)).toBe(true);
  expect(isSfoUsageQueueSelected({ ...enabled, userIds: new Set() }, eligible)).toBe(false);
  expect(isSfoUsageQueueSelected({ ...enabled, userIds, enabled: false }, eligible)).toBe(false);
  expect(isSfoUsageQueueSelected({ ...enabled, userIds, exposure: 0 }, eligible)).toBe(false);
});

test('missing user identity selects nobody', () => {
  expect(isSfoUsageQueueSelected(enabled, { kiloUserId: '' })).toBe(false);
});

test.each([
  ['oauth/synthetic', 0.3, 0.31],
  ['oauth/github/alice', 0.37, 0.38],
  ['payer:日本語', 0.3, 0.31],
  ['internal-canary', 0.7, 0.71],
])('pins stable v1 cohort boundaries for %s', (kiloUserId, below, above) => {
  const payer = {
    kiloUserId,
  };
  expect(isSfoUsageQueueSelected({ ...enabled, exposure: below }, payer)).toBe(false);
  expect(isSfoUsageQueueSelected({ ...enabled, exposure: above }, payer)).toBe(true);
  expect(isSfoUsageQueueSelected({ ...enabled, exposure: 1 }, payer)).toBe(true);
});

test('exposure grows a stable payer cohort monotonically from none to all', () => {
  const payers = Array.from({ length: 1000 }, (_, i) => ({ kiloUserId: `payer-${i}` }));
  let previous = new Set<string>();
  for (const exposure of [0, 0.01, 0.1, 0.5, 1]) {
    const selected = new Set(
      payers
        .filter(payer => isSfoUsageQueueSelected({ ...enabled, exposure }, payer))
        .map(payer => payer.kiloUserId)
    );
    for (const id of previous) expect(selected.has(id)).toBe(true);
    if (exposure === 0) expect(selected.size).toBe(0);
    else expect(selected.size).toBeGreaterThan(previous.size);
    previous = selected;
  }
  expect(previous.size).toBe(payers.length);
});

test('organization cohort is stable across members and uses the organization payer', () => {
  const organizationId = '11111111-1111-4111-8111-111111111111';
  for (const kiloUserId of ['member-a', 'oauth/member-b']) {
    expect(
      isSfoUsageQueueSelected({ ...enabled, exposure: 0.39 }, { kiloUserId, organizationId })
    ).toBe(false);
    expect(
      isSfoUsageQueueSelected({ ...enabled, exposure: 0.4 }, { kiloUserId, organizationId })
    ).toBe(true);
  }
  expect(
    isSfoUsageQueueSelected(
      { ...enabled, userIds: new Set(['member-a']) },
      { kiloUserId: 'member-a', organizationId }
    )
  ).toBe(true);
  expect(
    isSfoUsageQueueSelected(
      { ...enabled, userIds: new Set(['member-a']) },
      { kiloUserId: 'member-b', organizationId }
    )
  ).toBe(false);
});

test('organization UUID casing preserves a monotonic cohort across members and spellings', () => {
  const organizationId = 'a1b2c3d4-e5f6-47a8-9b0c-d1e2f3a4b5c6';
  expect(
    isSfoUsageQueueSelected(
      { ...enabled, exposure: 0.744 },
      { kiloUserId: 'member-a', organizationId }
    )
  ).toBe(false);
  expect(
    isSfoUsageQueueSelected(
      { ...enabled, exposure: 0.7441 },
      { kiloUserId: 'member-a', organizationId }
    )
  ).toBe(true);
  let previouslySelected = false;
  const spellings = [
    organizationId,
    organizationId.toUpperCase(),
    'A1b2C3d4-e5F6-47a8-9B0c-D1e2F3a4B5c6',
  ];
  for (let step = 0; step <= 100; step++) {
    const exposure = step / 100;
    const selected = isSfoUsageQueueSelected(
      { ...enabled, exposure },
      { kiloUserId: 'member-a', organizationId }
    );
    if (previouslySelected) expect(selected).toBe(true);
    for (const spelling of spellings) {
      expect(
        isSfoUsageQueueSelected(
          { ...enabled, exposure },
          { kiloUserId: 'member-b', organizationId: spelling }
        )
      ).toBe(selected);
    }
    previouslySelected = selected;
  }
  expect(previouslySelected).toBe(true);
});

test('personal user IDs retain case-sensitive cohort keys', () => {
  const config = { ...enabled, exposure: 0.5 };
  expect(isSfoUsageQueueSelected(config, { kiloUserId: 'oauth/synthetic' })).toBe(true);
  expect(isSfoUsageQueueSelected(config, { kiloUserId: 'OAUTH/SYNTHETIC' })).toBe(false);
});
