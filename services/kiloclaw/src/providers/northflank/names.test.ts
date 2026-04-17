import { describe, expect, it } from 'vitest';
import { northflankNameFromKey, northflankResourceNames } from './names';

describe('Northflank naming helpers', () => {
  it('keeps instance-keyed sandbox IDs readable and within strict resource limits', async () => {
    const name = await northflankNameFromKey('ki_1234567890abcdef1234567890abcdef');

    expect(name).toBe('kc-ki-1234567890abcdef1234567890abcdef');
    expect(name).toHaveLength(38);
    expect(name).toMatch(/^[a-z][a-z0-9-]*[a-z0-9]$/);
  });

  it('sanitizes unsupported characters without changing valid deterministic input', async () => {
    await expect(northflankNameFromKey('KI_test.VALUE')).resolves.toBe('kc-ki-test-value');
  });

  it('uses a stable hash fallback for overlong keys', async () => {
    const key = 'legacy-user-id-that-is-far-too-long-for-northflank-project-and-volume-names';
    const name = await northflankNameFromKey(key);

    expect(name).toBe(await northflankNameFromKey(key));
    expect(name).toMatch(/^kc-[0-9a-f]{24}$/);
    expect(name.length).toBeLessThanOrEqual(39);
  });

  it('uses one strict name for project, service, volume, and secret recovery', async () => {
    await expect(northflankResourceNames('ki_1234567890abcdef1234567890abcdef')).resolves.toEqual({
      projectName: 'kc-ki-1234567890abcdef1234567890abcdef',
      serviceName: 'kc-ki-1234567890abcdef1234567890abcdef',
      volumeName: 'kc-ki-1234567890abcdef1234567890abcdef',
      secretName: 'kc-ki-1234567890abcdef1234567890abcdef',
    });
  });
});
