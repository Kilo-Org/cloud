import { describe, expect, it } from 'vitest';
import {
  extractProcedureName,
  extractOrgIdFromUrl,
  BALANCE_REQUIRED_MUTATIONS,
} from './balance-validation.js';

describe('balance-validation', () => {
  describe('extractProcedureName', () => {
    it('extracts procedure name from valid tRPC path', () => {
      expect(extractProcedureName('/trpc/initiateSessionStream')).toBe('initiateSessionStream');
      expect(extractProcedureName('/trpc/sendMessageStream')).toBe('sendMessageStream');
      expect(extractProcedureName('/trpc/deleteSession')).toBe('deleteSession');
    });

    it('handles paths with query strings', () => {
      expect(extractProcedureName('/trpc/initiateSessionStream?batch=1')).toBe(
        'initiateSessionStream'
      );
    });

    it('returns null for non-tRPC paths', () => {
      expect(extractProcedureName('/api/health')).toBeNull();
      expect(extractProcedureName('/health')).toBeNull();
      expect(extractProcedureName('/')).toBeNull();
    });

    it('returns null for malformed tRPC paths', () => {
      expect(extractProcedureName('/trpc')).toBeNull();
      expect(extractProcedureName('/trpc/')).toBeNull();
    });
  });

  describe('extractOrgIdFromUrl', () => {
    it('extracts orgId from basic URL with simple string value', () => {
      const input = { kilocodeOrganizationId: 'org-123' };
      const url = new URL(
        `https://example.com/trpc/test?input=${encodeURIComponent(JSON.stringify(input))}`
      );
      expect(extractOrgIdFromUrl(url)).toBe('org-123');
    });

    it('handles URL-encoded values without double-decoding (regression test)', () => {
      // This canary string was used to detect the original double-decoding bug.
      // When URL-encoded:
      // - `%` in `95%` becomes `%25`
      // - `+` becomes `%2B`
      // If double-decoding occurred, `%25` would incorrectly become `%`
      const canaryString = 'decode test +95% and 75%';
      const input = { kilocodeOrganizationId: canaryString };
      const url = new URL(
        `https://example.com/trpc/test?input=${encodeURIComponent(JSON.stringify(input))}`
      );

      // url.searchParams.get() decodes once, and JSON.parse handles the rest
      // The function should NOT double-decode
      expect(extractOrgIdFromUrl(url)).toBe(canaryString);
    });

    it('returns undefined when input parameter is missing', () => {
      const url = new URL('https://example.com/trpc/test');
      expect(extractOrgIdFromUrl(url)).toBeUndefined();
    });

    it('throws an error when input parameter is invalid JSON', () => {
      const url = new URL('https://example.com/trpc/test?input=not-valid-json');
      expect(() => extractOrgIdFromUrl(url)).toThrow('Failed to parse tRPC input');
    });

    it('returns undefined when kilocodeOrganizationId field is missing from input', () => {
      const input = { sessionId: 'session-456' };
      const url = new URL(
        `https://example.com/trpc/test?input=${encodeURIComponent(JSON.stringify(input))}`
      );
      expect(extractOrgIdFromUrl(url)).toBeUndefined();
    });

    it('returns undefined when kilocodeOrganizationId is not a string', () => {
      const input = { kilocodeOrganizationId: 12345 };
      const url = new URL(
        `https://example.com/trpc/test?input=${encodeURIComponent(JSON.stringify(input))}`
      );
      expect(extractOrgIdFromUrl(url)).toBeUndefined();
    });

    it('returns undefined when input is null', () => {
      const url = new URL(`https://example.com/trpc/test?input=${encodeURIComponent('null')}`);
      expect(extractOrgIdFromUrl(url)).toBeUndefined();
    });
  });

  describe('BALANCE_REQUIRED_MUTATIONS', () => {
    it('contains expected V2 mutation procedures', () => {
      expect(BALANCE_REQUIRED_MUTATIONS.has('initiateFromKilocodeSessionV2')).toBe(true);
      expect(BALANCE_REQUIRED_MUTATIONS.has('sendMessageV2')).toBe(true);
      expect(BALANCE_REQUIRED_MUTATIONS.has('prepareSession')).toBe(true);
    });

    it('does not contain non-balance-required procedures', () => {
      expect(BALANCE_REQUIRED_MUTATIONS.has('deleteSession')).toBe(false);
      expect(BALANCE_REQUIRED_MUTATIONS.has('getSessionLogs')).toBe(false);
    });
  });
});
