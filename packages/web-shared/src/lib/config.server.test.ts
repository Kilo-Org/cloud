import { describe, it, expect } from '@jest/globals';
import {
  resolveInstanceUrlTemplate,
  resolveLegacyWorkerUrl,
  resolveProductionDefaultedUrl,
} from './config.server';

const production = { VERCEL_ENV: 'production', VERCEL_TARGET_ENV: 'production' };
const outsideProduction = [
  ['staging', { VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'staging' }],
  ['preview', { VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'preview' }],
  ['preview with a production target', { VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'production' }],
  ['production without a target', { VERCEL_ENV: 'production' }],
  ['local', {}],
] as const;

describe('resolveProductionDefaultedUrl', () => {
  const productionOrigin = 'https://hooks.kilosessions.ai';

  it('defaults to the production origin in the confirmed production deployment', () => {
    expect(resolveProductionDefaultedUrl(undefined, productionOrigin, production)).toBe(
      productionOrigin
    );
    expect(resolveProductionDefaultedUrl('', productionOrigin, production)).toBe(productionOrigin);
  });

  it('keeps an explicit production value in production', () => {
    expect(
      resolveProductionDefaultedUrl('https://hooks-2.kilosessions.ai', productionOrigin, production)
    ).toBe('https://hooks-2.kilosessions.ai');
  });

  describe.each(outsideProduction)('%s', (_name, env) => {
    it('is unconfigured when unset or empty', () => {
      expect(resolveProductionDefaultedUrl(undefined, productionOrigin, env)).toBe('');
      expect(resolveProductionDefaultedUrl('', productionOrigin, env)).toBe('');
    });

    it('uses an explicit nonproduction destination exactly', () => {
      expect(
        resolveProductionDefaultedUrl('https://hooks-staging.example.test', productionOrigin, env)
      ).toBe('https://hooks-staging.example.test');
      expect(resolveProductionDefaultedUrl('http://localhost:8793', productionOrigin, env)).toBe(
        'http://localhost:8793'
      );
    });

    it.each([
      'https://hooks.kilosessions.ai',
      'https://hooks.kilosessions.ai/',
      'https://HOOKS.kilosessions.ai/path',
      'https://hooks.kilosessions.ai.',
      'https://hooks.kilosessions.ai../',
      'https://user@hooks.kilosessions.ai',
      'https://hooks.kilosessions.ai:443',
      'http://hooks.kilosessions.ai',
    ])('refuses the explicit production host %s', value => {
      expect(resolveProductionDefaultedUrl(value, productionOrigin, env)).toBe('');
    });

    it.each([
      'https://cloudflare-webhook-agent-ingest.acct.workers.dev',
      'https://abc123-cloudflare-webhook-agent-ingest.acct.workers.dev/',
    ])('refuses the production Worker workers.dev host %s', value => {
      expect(
        resolveProductionDefaultedUrl(
          value,
          productionOrigin,
          env,
          'cloudflare-webhook-agent-ingest'
        )
      ).toBe('');
    });

    it('keeps a different Worker on workers.dev', () => {
      const dev = 'https://cloudflare-webhook-agent-ingest-dev.acct.workers.dev';
      expect(
        resolveProductionDefaultedUrl(dev, productionOrigin, env, 'cloudflare-webhook-agent-ingest')
      ).toBe(dev);
    });
  });

  it('keeps an explicit workers.dev value in production', () => {
    const value = 'https://cloudflare-webhook-agent-ingest.acct.workers.dev';
    expect(
      resolveProductionDefaultedUrl(
        value,
        productionOrigin,
        production,
        'cloudflare-webhook-agent-ingest'
      )
    ).toBe(value);
  });
});

describe('resolveInstanceUrlTemplate', () => {
  describe('kill switch (KILOCLAW_INSTANCE_URL_TEMPLATE=legacy)', () => {
    it('returns empty (legacy routing) when set to the kill-switch sentinel in production', () => {
      expect(resolveInstanceUrlTemplate('legacy', production)).toBe('');
    });

    it('matches the sentinel case-insensitively', () => {
      expect(resolveInstanceUrlTemplate('Legacy', production)).toBe('');
      expect(resolveInstanceUrlTemplate('LEGACY', production)).toBe('');
    });

    it('also disables per-instance URLs outside production', () => {
      expect(resolveInstanceUrlTemplate('legacy', {})).toBe('');
    });

    it('treats an explicit empty string as "unset", not as a kill switch', () => {
      // Platform env pipelines often coerce empty values to "unset", so
      // empty string must not be the rollback signal.
      expect(resolveInstanceUrlTemplate('', production)).toBe('https://{label}.kiloclaw.ai');
    });
  });

  describe('confirmed production deployment', () => {
    it('defaults to the canonical prod template when no override is set', () => {
      expect(resolveInstanceUrlTemplate(undefined, production)).toBe('https://{label}.kiloclaw.ai');
    });

    it('honors an explicit override in production', () => {
      expect(resolveInstanceUrlTemplate('https://{label}.preview.kiloclaw.ai', production)).toBe(
        'https://{label}.preview.kiloclaw.ai'
      );
    });
  });

  describe.each(outsideProduction)('%s', (_name, env) => {
    it('is unconfigured when unset or empty', () => {
      expect(resolveInstanceUrlTemplate(undefined, env)).toBe('');
      expect(resolveInstanceUrlTemplate('', env)).toBe('');
    });

    it('uses an explicit nonproduction template exactly', () => {
      expect(resolveInstanceUrlTemplate('http://{label}.kiloclaw.localhost:8795', env)).toBe(
        'http://{label}.kiloclaw.localhost:8795'
      );
      expect(resolveInstanceUrlTemplate('https://{label}.claw-staging.example.test', env)).toBe(
        'https://{label}.claw-staging.example.test'
      );
    });

    it.each([
      'https://{label}.kiloclaw.ai',
      'https://{label}.preview.kiloclaw.ai',
      'https://{label}.KILOCLAW.ai',
      'https://{label}.kiloclaw.ai.',
      'https://{label}.kiloclaw.ai..',
      'https://kiloclaw.ai/{label}',
      'https://claw.kilosessions.ai/{label}',
      'https://claw.kilo.ai/{label}',
    ])('refuses the production KiloClaw template %s', template => {
      expect(resolveInstanceUrlTemplate(template, env)).toBe('');
    });

    it.each(['{label}.example.test', '/claw/{label}', 'javascript:{label}'])(
      'refuses the non-http(s) template %s, which a browser could resolve against the app',
      template => {
        expect(resolveInstanceUrlTemplate(template, env)).toBe('');
      }
    );
  });
});

describe('resolveLegacyWorkerUrl', () => {
  it('keeps KILOCLAW_API_URL or the canonical host in production', () => {
    expect(resolveLegacyWorkerUrl(undefined, production)).toBe('https://claw.kilo.ai');
    expect(resolveLegacyWorkerUrl('', production)).toBe('https://claw.kilo.ai');
    expect(resolveLegacyWorkerUrl('https://claw.kilosessions.ai', production)).toBe(
      'https://claw.kilosessions.ai'
    );
  });

  describe.each(outsideProduction)('%s', (_name, env) => {
    it('has no legacy host when KILOCLAW_API_URL is unset', () => {
      expect(resolveLegacyWorkerUrl(undefined, env)).toBe('');
      expect(resolveLegacyWorkerUrl('', env)).toBe('');
    });

    it.each([
      'https://claw.kilo.ai',
      'https://claw.kilosessions.ai/',
      'https://CLAW.kilo.ai.',
      'https://x.kiloclaw.ai',
      '/claw',
    ])('refuses %s', value => {
      expect(resolveLegacyWorkerUrl(value, env)).toBe('');
    });

    it('uses an explicit non-production host exactly', () => {
      expect(resolveLegacyWorkerUrl('http://localhost:8795', env)).toBe('http://localhost:8795');
      expect(resolveLegacyWorkerUrl('https://claw-preview.example.test', env)).toBe(
        'https://claw-preview.example.test'
      );
    });
  });
});
