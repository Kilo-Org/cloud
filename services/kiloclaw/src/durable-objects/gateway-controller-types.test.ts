import { describe, expect, it } from 'vitest';
import {
  ControllerVersionResponseSchema,
  FileWriteResponseSchema,
} from './gateway-controller-types';

describe('FileWriteResponseSchema', () => {
  it('accepts written and validation-warning results', () => {
    expect(FileWriteResponseSchema.parse({ etag: 'etag-1' })).toEqual({ etag: 'etag-1' });
    expect(
      FileWriteResponseSchema.parse({
        outcome: 'openclaw-validation-warning',
        valid: false,
        reason: 'invalid',
        issues: [{ path: 'gateway.mode', message: 'Expected local', allowedValues: ['local'] }],
      })
    ).toMatchObject({ outcome: 'openclaw-validation-warning', reason: 'invalid' });
  });
});

describe('ControllerVersionResponseSchema', () => {
  it('accepts legacy version responses without capability hints', () => {
    expect(
      ControllerVersionResponseSchema.parse({
        version: '2026.5.20.1200',
        commit: 'abc123',
        openclawVersion: null,
        openclawCommit: null,
      })
    ).toEqual({
      version: '2026.5.20.1200',
      commit: 'abc123',
      openclawVersion: null,
      openclawCommit: null,
    });
  });

  it('accepts version responses with api version and capability hints', () => {
    expect(
      ControllerVersionResponseSchema.parse({
        version: '2026.5.20.1200',
        commit: 'abc123',
        apiVersion: 1,
        capabilities: ['config.read', 'files.import-openclaw-workspace', 'kilo-cli.run'],
      })
    ).toEqual({
      version: '2026.5.20.1200',
      commit: 'abc123',
      apiVersion: 1,
      capabilities: ['config.read', 'files.import-openclaw-workspace', 'kilo-cli.run'],
    });
  });

  it('rejects malformed capability names', () => {
    const result = ControllerVersionResponseSchema.safeParse({
      version: '2026.5.20.1200',
      commit: 'abc123',
      capabilities: ['Config.Read'],
    });

    expect(result.success).toBe(false);
  });

  it('rejects unsorted capability names', () => {
    const result = ControllerVersionResponseSchema.safeParse({
      version: '2026.5.20.1200',
      commit: 'abc123',
      capabilities: ['kilo-cli.run', 'config.read'],
    });

    expect(result.success).toBe(false);
  });

  it('rejects duplicate capability names', () => {
    const result = ControllerVersionResponseSchema.safeParse({
      version: '2026.5.20.1200',
      commit: 'abc123',
      capabilities: ['config.read', 'config.read'],
    });

    expect(result.success).toBe(false);
  });
});
