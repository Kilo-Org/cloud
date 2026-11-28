import { UTS_FIRST_PARTY_CLIENTS } from '@kilocode/uts-contracts';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FIRST_PARTY_CLIENTS } from '../../src/oauth/clients';

/**
 * The exchange statement's backstop (`uts.require_code_attestation`, migration 0017) names the
 * clients that need device attestation in SQL. That list must be exactly the clients the Worker
 * and the contracts mark `attestation: 'required'`, or a client would escape the backstop (or one
 * would be refused that the Worker serves without attestation).
 */

const MIGRATION = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../migrations/0017_mobile_attestation.sql'
);

/** The quoted client ids in the trigger's `NEW.client_id IN (...)`. */
function triggerClientIds(sql: string): string[] {
  const lists = [...sql.matchAll(/NEW\.client_id IN \(([^)]*)\)/g)];
  if (lists.length !== 1) throw new Error(`expected one client list, found ${lists.length}`);
  return [...lists[0][1].matchAll(/'([^']+)'/g)].map(match => match[1]).sort();
}

describe('the attestation backstop client list', () => {
  const trigger = triggerClientIds(readFileSync(MIGRATION, 'utf8'));

  it('names at least one client', () => {
    expect(trigger.length).toBeGreaterThan(0);
  });

  it("equals the Worker's attestation-required clients", () => {
    const worker = [...FIRST_PARTY_CLIENTS.values()]
      .filter(client => client.attestation === 'required')
      .map(client => client.clientId)
      .sort();
    expect(trigger).toEqual(worker);
  });

  it("equals the contracts' attestation-required clients", () => {
    const contracts = UTS_FIRST_PARTY_CLIENTS.filter(
      client => client.kind === 'public_native' && client.attestation === 'required'
    )
      .map(client => client.clientId)
      .sort();
    expect(trigger).toEqual(contracts);
  });
});
