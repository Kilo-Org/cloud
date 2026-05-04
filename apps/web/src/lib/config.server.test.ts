import { describe, it, expect } from '@jest/globals';
import { resolveInstanceUrlTemplate } from './config.server';

describe('resolveInstanceUrlTemplate', () => {
  describe('production', () => {
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

    it('treats an explicit empty string as a kill switch in production', () => {
      // Operators can roll back without a code deploy by setting
      // KILOCLAW_INSTANCE_URL_TEMPLATE= (empty) in Vercel.
      expect(resolveInstanceUrlTemplate('', 'production', 'https://claw.kilo.ai')).toBe('');
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

    it('treats an explicit empty string as an opt-out in dev', () => {
      // Devs who want the legacy path-based flow can set
      // KILOCLAW_INSTANCE_URL_TEMPLATE= (empty) in .env.local.
      expect(resolveInstanceUrlTemplate('', 'development', 'http://localhost:8795')).toBe('');
    });
  });
});
