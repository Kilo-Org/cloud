import { describe, it, expect } from '@jest/globals';
import { SecurityAdvisorRequestSchema } from '../schemas';

const VALID_PAYLOAD = {
  apiVersion: '2026-04-01',
  source: {
    platform: 'openclaw',
    method: 'plugin',
    pluginVersion: '1.0.0',
  },
  audit: {
    ts: 1775491369820,
    summary: { critical: 1, warn: 4, info: 1 },
    findings: [
      {
        checkId: 'summary.attack_surface',
        severity: 'info',
        title: 'Attack surface summary',
        detail: 'groups: open=0, allowlist=1...',
        remediation: null,
      },
      {
        checkId: 'fs.config.perms_world_readable',
        severity: 'critical',
        title: 'Config file is world-readable',
        detail: '/root/.openclaw/openclaw.json mode=644...',
        remediation: 'chmod 600 /root/.openclaw/openclaw.json',
      },
    ],
    deep: { gateway: { attempted: true, ok: true } },
    secretDiagnostics: [],
  },
  publicIp: '1.2.3.4',
};

describe('SecurityAdvisorRequestSchema', () => {
  it('accepts a valid payload', () => {
    const result = SecurityAdvisorRequestSchema.safeParse(VALID_PAYLOAD);
    expect(result.success).toBe(true);
  });

  it('accepts payload without optional fields', () => {
    const minimal = {
      apiVersion: '2026-04-01',
      source: { platform: 'kiloclaw', method: 'api' },
      audit: {
        ts: 1000,
        summary: { critical: 0, warn: 0, info: 0 },
        findings: [],
      },
    };
    const result = SecurityAdvisorRequestSchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });

  it('rejects wrong apiVersion', () => {
    const result = SecurityAdvisorRequestSchema.safeParse({
      ...VALID_PAYLOAD,
      apiVersion: '2025-01-01',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid source platform', () => {
    const result = SecurityAdvisorRequestSchema.safeParse({
      ...VALID_PAYLOAD,
      source: { ...VALID_PAYLOAD.source, platform: 'unknown' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid source method', () => {
    const result = SecurityAdvisorRequestSchema.safeParse({
      ...VALID_PAYLOAD,
      source: { ...VALID_PAYLOAD.source, method: 'smoke-signal' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing audit', () => {
    const { audit: _, ...noAudit } = VALID_PAYLOAD;
    const result = SecurityAdvisorRequestSchema.safeParse(noAudit);
    expect(result.success).toBe(false);
  });

  it('rejects invalid finding severity', () => {
    const result = SecurityAdvisorRequestSchema.safeParse({
      ...VALID_PAYLOAD,
      audit: {
        ...VALID_PAYLOAD.audit,
        findings: [
          {
            checkId: 'test',
            severity: 'emergency',
            title: 'Test',
            detail: 'Test',
            remediation: null,
          },
        ],
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing source', () => {
    const { source: _, ...noSource } = VALID_PAYLOAD;
    const result = SecurityAdvisorRequestSchema.safeParse(noSource);
    expect(result.success).toBe(false);
  });

  it('rejects invalid publicIp', () => {
    const result = SecurityAdvisorRequestSchema.safeParse({
      ...VALID_PAYLOAD,
      publicIp: '<script>alert(1)</script>',
    });
    expect(result.success).toBe(false);
  });

  it('accepts valid IPv6 publicIp', () => {
    const result = SecurityAdvisorRequestSchema.safeParse({
      ...VALID_PAYLOAD,
      publicIp: '2001:db8::1',
    });
    expect(result.success).toBe(true);
  });

  it('rejects non-object payload', () => {
    expect(SecurityAdvisorRequestSchema.safeParse('hello').success).toBe(false);
    expect(SecurityAdvisorRequestSchema.safeParse(42).success).toBe(false);
    expect(SecurityAdvisorRequestSchema.safeParse(null).success).toBe(false);
  });
});
