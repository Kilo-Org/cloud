import type * as ServerConfig from '@kilocode/web-shared/lib/config.server';
import type * as QueueConfig from '@kilocode/usage-queue/vercel/config';
import type * as SfoPolicy from '@kilocode/web-shared/lib/ai-gateway/usage-queue-policy';

test.each([undefined, '', 'cloudflare', 'VERCEL', 'other'])(
  'Vercel transport requires exact opt-in (%s)',
  transport => {
    const original = { ...process.env };
    try {
      process.env.USAGE_QUEUE_ONLY_ENABLED = 'true';
      process.env.VERCEL_TARGET_ENV = 'staging';
      process.env.VERCEL_ENV = 'preview';
      process.env.BYOK_ENCRYPTION_KEY = 'synthetic-key';
      if (transport === undefined) delete process.env.USAGE_QUEUE_TRANSPORT;
      else process.env.USAGE_QUEUE_TRANSPORT = transport;
      jest.isolateModules(() => {
        const actual = jest.requireActual<typeof ServerConfig>(
          '@kilocode/web-shared/lib/config.server'
        );
        expect(actual.USAGE_QUEUE_ONLY_ENABLED).toBe(true);
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
        const actual = jest.requireActual<typeof ServerConfig>(
          '@kilocode/web-shared/lib/config.server'
        );
        expect(
          jest.requireActual<typeof QueueConfig>('@kilocode/usage-queue/vercel/config')
            .USAGE_VERCEL_QUEUE_ENABLED
        ).toBe(enabled);
        expect(actual.USAGE_QUEUE_ONLY_ENABLED).toBe(enabled);
      });
    } finally {
      process.env = original;
    }
  }
);

test.each(
  [undefined, 'vercel'].flatMap(transport =>
    [
      { region: 'sfo1', master: 'true', exposure: '1', selected: true },
      { region: 'sfo1', master: 'true', exposure: '0', selected: false },
      { region: 'sfo1', master: 'false', exposure: '1', selected: false },
      { region: 'fra1', master: 'true', exposure: '1', selected: false },
    ].map(config => ({ ...config, transport }))
  )
)(
  'production Cloudflare SFO selection survives transport=$transport, region=$region, master=$master, exposure=$exposure',
  ({ transport, region, master, exposure, selected }) => {
    const original = { ...process.env };
    try {
      process.env.VERCEL_TARGET_ENV = 'production';
      process.env.VERCEL_ENV = 'production';
      process.env.VERCEL_REGION = region;
      process.env.USAGE_QUEUE_ONLY_ENABLED = master;
      process.env.USAGE_QUEUE_SFO_EXPOSURE = exposure;
      process.env.BYOK_ENCRYPTION_KEY = 'synthetic-key';
      delete process.env.USAGE_QUEUE_SFO_USER_IDS;
      if (transport === undefined) delete process.env.USAGE_QUEUE_TRANSPORT;
      else process.env.USAGE_QUEUE_TRANSPORT = transport;
      jest.isolateModules(() => {
        const actual = jest.requireActual<typeof ServerConfig>(
          '@kilocode/web-shared/lib/config.server'
        );
        const { isSfoUsageQueueSelected } = jest.requireActual<typeof SfoPolicy>(
          '@kilocode/web-shared/lib/ai-gateway/usage-queue-policy'
        );
        expect(actual.USAGE_QUEUE_ONLY_ENABLED).toBe(false);
        expect(
          jest.requireActual<typeof QueueConfig>('@kilocode/usage-queue/vercel/config')
            .USAGE_VERCEL_QUEUE_ENABLED
        ).toBe(false);
        expect(
          isSfoUsageQueueSelected(actual.USAGE_QUEUE_SFO_CONFIG, { kiloUserId: 'test-payer' })
        ).toBe(selected);
      });
    } finally {
      process.env = original;
    }
  }
);
