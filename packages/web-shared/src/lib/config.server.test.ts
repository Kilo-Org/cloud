import { describe, it, expect } from '@jest/globals';
import { resolveInstanceUrlTemplate } from './config.server';

describe('resolveInstanceUrlTemplate', () => {
  describe('kill switch (KILOCLAW_INSTANCE_URL_TEMPLATE=legacy)', () => {
    it('returns empty (legacy routing) when set to the kill-switch sentinel in production', () => {
      expect(resolveInstanceUrlTemplate('legacy', 'production', 'https://claw.kilo.ai')).toBe('');
    });

    it('matches the sentinel case-insensitively', () => {
      expect(resolveInstanceUrlTemplate('Legacy', 'production', 'https://claw.kilo.ai')).toBe('');
      expect(resolveInstanceUrlTemplate('LEGACY', 'production', 'https://claw.kilo.ai')).toBe('');
    });

    it('also disables per-instance URLs in dev when set', () => {
      expect(resolveInstanceUrlTemplate('legacy', 'development', 'http://localhost:8795')).toBe('');
    });

    it('treats an explicit empty string as "unset" (falls through to defaults), not as a kill switch', () => {
      // Platform env pipelines often coerce empty values to "unset", so
      // empty string must not be the rollback signal.
      expect(resolveInstanceUrlTemplate('', 'production', 'https://claw.kilo.ai')).toBe(
        'https://{label}.kiloclaw.ai'
      );
      expect(resolveInstanceUrlTemplate('', 'development', 'http://localhost:8795')).toBe(
        'http://{label}.kiloclaw.localhost:8795'
      );
    });
  });

  describe('production defaults', () => {
    it('defaults to the canonical prod template when no override is set', () => {
      expect(resolveInstanceUrlTemplate(undefined, 'production', 'https://claw.kilo.ai')).toBe(
        'https://{label}.kiloclaw.ai'
      );
    });

    it('honors an explicit override in production', () => {
      expect(
        resolveInstanceUrlTemplate(
          'https://{label}.preview.kiloclaw.ai',
          'production',
          'https://claw.kilo.ai'
        )
      ).toBe('https://{label}.preview.kiloclaw.ai');
    });
  });

  describe('development / test defaults', () => {
    it('derives a loopback-parity template from a localhost KILOCLAW_API_URL', () => {
      expect(resolveInstanceUrlTemplate(undefined, 'development', 'http://localhost:8795')).toBe(
        'http://{label}.kiloclaw.localhost:8795'
      );
    });

    it('derives a loopback-parity template from a 127.0.0.1 KILOCLAW_API_URL', () => {
      expect(resolveInstanceUrlTemplate(undefined, 'development', 'http://127.0.0.1:8795')).toBe(
        'http://{label}.kiloclaw.localhost:8795'
      );
    });

    it('preserves the port from KILOCLAW_API_URL when non-default', () => {
      expect(resolveInstanceUrlTemplate(undefined, 'development', 'http://localhost:9999')).toBe(
        'http://{label}.kiloclaw.localhost:9999'
      );
    });

    it('preserves the scheme from KILOCLAW_API_URL', () => {
      expect(resolveInstanceUrlTemplate(undefined, 'development', 'https://localhost:8795')).toBe(
        'https://{label}.kiloclaw.localhost:8795'
      );
    });

    it('falls back to the wrangler dev port when KILOCLAW_API_URL is missing', () => {
      expect(resolveInstanceUrlTemplate(undefined, 'development', undefined)).toBe(
        'http://{label}.kiloclaw.localhost:8795'
      );
    });

    it('falls back when KILOCLAW_API_URL is unparsable', () => {
      expect(resolveInstanceUrlTemplate(undefined, 'development', 'not a url')).toBe(
        'http://{label}.kiloclaw.localhost:8795'
      );
    });

    it('uses the fallback template when KILOCLAW_API_URL points at a non-loopback host', () => {
      // Remote staging — dev mode with a non-local worker. We don't try
      // to derive a wildcard host for it; fall back to the loopback
      // template. Operators who want a real per-instance URL on remote
      // staging set KILOCLAW_INSTANCE_URL_TEMPLATE explicitly.
      expect(resolveInstanceUrlTemplate(undefined, 'development', 'https://staging.kilo.ai')).toBe(
        'http://{label}.kiloclaw.localhost:8795'
      );
    });

    it('defaults loopback-parity in test mode too', () => {
      expect(resolveInstanceUrlTemplate(undefined, 'test', 'http://localhost:8795')).toBe(
        'http://{label}.kiloclaw.localhost:8795'
      );
    });

    it('honors a dev-parity override', () => {
      expect(
        resolveInstanceUrlTemplate(
          'http://{label}.kiloclaw.localhost:8795',
          'development',
          'http://localhost:8795'
        )
      ).toBe('http://{label}.kiloclaw.localhost:8795');
    });
  });
});
