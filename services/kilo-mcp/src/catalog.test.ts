import { Validator, type Schema } from '@cfworker/json-schema';
import { describe, expect, it } from 'vitest';
import bundledCatalog from '../catalog.json';
import { searchCatalog } from './search';
import type { Catalog } from './types';

const catalog = bundledCatalog as Catalog;
const organizationId = '12345678-1234-4234-8234-123456789abc';
const cloudAgentSessionId = `workspace_${organizationId}`;

describe.each([
  { prefix: 'cloudAgentNext', scope: {} },
  { prefix: 'organizations.cloudAgentNext', scope: { organizationId } },
])('$prefix egress audit catalog', ({ prefix, scope }) => {
  it('publishes a discoverable, unguarded audit query with its input schema', async () => {
    const path = `${prefix}.getEgressAudit`;
    const [result] = await searchCatalog(path, { catalog, limit: 1 });

    expect(result).toMatchObject({
      path,
      kind: 'query',
      inputSchema: catalog[path].inputSchema,
      tags: expect.arrayContaining(['getegressaudit', 'cursor', 'limit', 'cloudagentsessionid']),
    });
    expect(result?.requiresApproval).toBeUndefined();
  });

  it('validates audit session scope and bounded cursor pagination', () => {
    const validator = new Validator(
      catalog[`${prefix}.getEgressAudit`].inputSchema as Schema,
      '2020-12'
    );
    const input = { ...scope, cloudAgentSessionId };

    for (const pagination of [
      {},
      { cursor: 0, limit: 1 },
      { cursor: Number.MAX_SAFE_INTEGER, limit: 100 },
    ]) {
      expect(validator.validate({ ...input, ...pagination }).valid).toBe(true);
    }

    for (const invalid of [
      scope,
      { ...input, cloudAgentSessionId: 'invalid' },
      { ...input, cursor: -1 },
      { ...input, cursor: 0.5 },
      { ...input, cursor: Number.MAX_SAFE_INTEGER + 1 },
      { ...input, limit: 0 },
      { ...input, limit: 101 },
      { ...input, limit: 1.5 },
      { ...input, limit: '50' },
      { ...input, unknown: true },
    ]) {
      expect(validator.validate(invalid).valid).toBe(false);
    }

    if (prefix.startsWith('organizations.')) {
      expect(validator.validate({ cloudAgentSessionId }).valid).toBe(false);
      expect(validator.validate({ ...input, organizationId: 'invalid' }).valid).toBe(false);
    }
  });

  it('publishes optional boolean auditing for new and cloned prepared sessions', () => {
    const row = catalog[`${prefix}.prepareSession`];
    const validator = new Validator(row.inputSchema as Schema, '2020-12');
    const input = {
      ...scope,
      githubRepo: 'Kilo-Org/kilocode',
      mode: 'code',
      model: 'anthropic/claude-sonnet-4.5',
      egressMode: 'allowlist',
    };

    expect(row.kind).toBe('mutation');
    expect(row.tags).toContain('egressaudit');
    expect(row.searchBlob).toContain('egressAudit');

    for (const variant of [
      { prompt: 'Inspect the repository' },
      {
        cloneFromKiloSessionId: `ses_${'a'.repeat(26)}`,
        autoInitiate: true,
        operationKey: organizationId,
      },
    ]) {
      expect(validator.validate({ ...input, ...variant }).valid).toBe(true);
      expect(validator.validate({ ...input, ...variant, egressAudit: true }).valid).toBe(true);
      expect(validator.validate({ ...input, ...variant, egressAudit: false }).valid).toBe(true);
      expect(validator.validate({ ...input, ...variant, egressAudit: 'true' }).valid).toBe(false);
    }
  });
});
