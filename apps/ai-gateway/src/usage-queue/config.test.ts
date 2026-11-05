import type * as QueueConfig from '@kilocode/usage-queue/vercel/config';

test.each([undefined, '', 'cloudflare', 'VERCEL', 'other'])(
  'Vercel transport requires exact opt-in (%s)',
  transport => {
    const original = { ...process.env };
    try {
      process.env.VERCEL_TARGET_ENV = 'staging';
      process.env.VERCEL_ENV = 'preview';
      process.env.BYOK_ENCRYPTION_KEY = 'synthetic-key';
      if (transport === undefined) delete process.env.USAGE_QUEUE_TRANSPORT;
      else process.env.USAGE_QUEUE_TRANSPORT = transport;
      jest.isolateModules(() => {
        expect(
          jest.requireActual<typeof QueueConfig>('@kilocode/usage-queue/vercel/config')
            .USAGE_VERCEL_QUEUE_ENABLED
        ).toBe(false);
      });
    } finally {
      process.env = original;
    }
  }
);

test.each(
  [
    { target: 'staging', vercel: 'preview', enabled: true },
    { target: 'staging', vercel: undefined, enabled: true },
    { target: 'staging', vercel: 'production', enabled: false },
    { target: 'production', vercel: 'production', enabled: false },
    { target: 'preview', vercel: 'preview', enabled: false },
    { target: undefined, vercel: undefined, enabled: false },
  ].flatMap(config => [undefined, 'false', 'true'].map(legacyFlag => ({ ...config, legacyFlag })))
)(
  'one Vercel selector: $target / $vercel / legacy=$legacyFlag',
  ({ target, vercel, enabled, legacyFlag }) => {
    const original = { ...process.env };
    try {
      for (const [key, value] of Object.entries({
        USAGE_QUEUE_TRANSPORT: 'vercel',
        USAGE_QUEUE_ONLY_ENABLED: legacyFlag,
        VERCEL_TARGET_ENV: target,
        VERCEL_ENV: vercel,
        BYOK_ENCRYPTION_KEY: 'synthetic-key',
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      jest.isolateModules(() => {
        expect(
          jest.requireActual<typeof QueueConfig>('@kilocode/usage-queue/vercel/config')
            .USAGE_VERCEL_QUEUE_ENABLED
        ).toBe(enabled);
      });
    } finally {
      process.env = original;
    }
  }
);

test('production cannot select the Vercel transport', () => {
  const original = { ...process.env };
  try {
    process.env.VERCEL_TARGET_ENV = 'production';
    process.env.VERCEL_ENV = 'production';
    process.env.USAGE_QUEUE_TRANSPORT = 'vercel';
    process.env.BYOK_ENCRYPTION_KEY = 'synthetic-key';
    jest.isolateModules(() => {
      expect(
        jest.requireActual<typeof QueueConfig>('@kilocode/usage-queue/vercel/config')
          .USAGE_VERCEL_QUEUE_ENABLED
      ).toBe(false);
    });
  } finally {
    process.env = original;
  }
});
