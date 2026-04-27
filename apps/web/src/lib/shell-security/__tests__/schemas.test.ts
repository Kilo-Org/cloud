import { describe, it, expect } from '@jest/globals';
import { ShellSecurityRequestSchema } from '../schemas';

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

describe('ShellSecurityRequestSchema', () => {
  it('accepts a valid payload', () => {
    const result = ShellSecurityRequestSchema.safeParse(VALID_PAYLOAD);
    expect(result.success).toBe(true);
  });

  it('accepts minimal payload without optional fields', () => {
    // Minimal valid payload: non-plugin method so pluginVersion is not
    // required, no publicIp, no deep scan, no findings.
    const minimal = {
      apiVersion: '2026-04-01',
      source: { platform: 'kiloclaw', method: 'api' },
      audit: {
        ts: 1000,
        summary: { critical: 0, warn: 0, info: 0 },
        findings: [],
      },
    };
    const result = ShellSecurityRequestSchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });

  it('rejects plugin-method payload missing pluginVersion', () => {
    // superRefine requires pluginVersion when method === 'plugin'.
    const result = ShellSecurityRequestSchema.safeParse({
      ...VALID_PAYLOAD,
      source: { platform: 'openclaw', method: 'plugin' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts non-plugin methods without pluginVersion', () => {
    // Non-plugin callers (api, webhook, cloud-agent) have no plugin
    // involved and shouldn't be forced to send a version string.
    const baseAudit = {
      ts: 1000,
      summary: { critical: 0, warn: 0, info: 0 },
      findings: [],
    };
    for (const method of ['api', 'webhook', 'cloud-agent'] as const) {
      const result = ShellSecurityRequestSchema.safeParse({
        apiVersion: '2026-04-01',
        source: { platform: 'openclaw', method },
        audit: baseAudit,
      });
      expect(result.success).toBe(true);
    }
  });

  it('rejects payload with non-semver pluginVersion', () => {
    const result = ShellSecurityRequestSchema.safeParse({
      ...VALID_PAYLOAD,
      source: { ...VALID_PAYLOAD.source, pluginVersion: 'banana' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts pluginVersion with prerelease and build metadata', () => {
    const result = ShellSecurityRequestSchema.safeParse({
      ...VALID_PAYLOAD,
      source: { ...VALID_PAYLOAD.source, pluginVersion: '1.2.3-beta.4+build.5' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects wrong apiVersion', () => {
    const result = ShellSecurityRequestSchema.safeParse({
      ...VALID_PAYLOAD,
      apiVersion: '2025-01-01',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid source platform', () => {
    const result = ShellSecurityRequestSchema.safeParse({
      ...VALID_PAYLOAD,
      source: { ...VALID_PAYLOAD.source, platform: 'unknown' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid source method', () => {
    const result = ShellSecurityRequestSchema.safeParse({
      ...VALID_PAYLOAD,
      source: { ...VALID_PAYLOAD.source, method: 'smoke-signal' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing audit', () => {
    const { audit: _, ...noAudit } = VALID_PAYLOAD;
    const result = ShellSecurityRequestSchema.safeParse(noAudit);
    expect(result.success).toBe(false);
  });

  it('accepts a finding with remediation field entirely omitted', () => {
    // Regression guard: OpenClaw audit output omits `remediation` on some
    // findings rather than setting it to null. The schema must treat the
    // field as .nullable().optional(), not just .nullable(). Reverting to
    // plain .nullable() would 400 every real-world audit submission.
    const result = ShellSecurityRequestSchema.safeParse({
      ...VALID_PAYLOAD,
      audit: {
        ...VALID_PAYLOAD.audit,
        findings: [
          {
            checkId: 'fs.config.perms_world_readable',
            severity: 'critical',
            title: 'Config file is world-readable',
            detail: '/root/.openclaw/openclaw.json mode=644',
            // NOTE: `remediation` intentionally not set
          },
        ],
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid finding severity', () => {
    const result = ShellSecurityRequestSchema.safeParse({
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
    const result = ShellSecurityRequestSchema.safeParse(noSource);
    expect(result.success).toBe(false);
  });

  it('rejects invalid publicIp', () => {
    const result = ShellSecurityRequestSchema.safeParse({
      ...VALID_PAYLOAD,
      publicIp: '<script>alert(1)</script>',
    });
    expect(result.success).toBe(false);
  });

  it('accepts valid IPv6 publicIp', () => {
    const result = ShellSecurityRequestSchema.safeParse({
      ...VALID_PAYLOAD,
      publicIp: '2001:db8::1',
    });
    expect(result.success).toBe(true);
  });

  it('rejects non-object payload', () => {
    expect(ShellSecurityRequestSchema.safeParse('hello').success).toBe(false);
    expect(ShellSecurityRequestSchema.safeParse(42).success).toBe(false);
    expect(ShellSecurityRequestSchema.safeParse(null).success).toBe(false);
  });
});
