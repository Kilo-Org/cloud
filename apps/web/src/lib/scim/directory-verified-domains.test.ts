import { describe, expect, test } from '@jest/globals';

// The WorkOS client is constructed at module scope from `WORKOS_API_KEY`, and
// the key in `.env.test` is deliberately invalid, so the SDK call is stubbed.
// What is under test is the filter applied to its answer, which is a security
// boundary: it decides which domains may authorize binding — and therefore
// taking over — an existing Kilo account.
// `jest.mock` is hoisted above the module under test, which constructs its
// client at module scope, so the stub has to be created inside the factory
// and retrieved afterwards rather than captured from an outer `const`.
jest.mock('@workos-inc/node', () => {
  const getOrganization = jest.fn();
  const getOrganizationByExternalId = jest.fn();
  return {
    WorkOS: jest.fn().mockImplementation(() => ({
      organizations: { getOrganization, getOrganizationByExternalId },
    })),
    __getOrganization: getOrganization,
    __getOrganizationByExternalId: getOrganizationByExternalId,
  };
});

const {
  __getOrganization: getOrganization,
  __getOrganizationByExternalId: getOrganizationByExternalId,
} = jest.requireMock<{
  __getOrganization: jest.Mock;
  __getOrganizationByExternalId: jest.Mock;
}>('@workos-inc/node');

import {
  dnsVerifiedDomains,
  getDnsVerifiedDomainsByExternalId,
  listDnsVerifiedDomains,
  VerifiedDomainLookupError,
  VerifiedDomainOwnerMissingError,
} from './directory-verified-domains';

function domain(name: string, state: string, verificationStrategy: string) {
  return {
    object: 'organization_domain',
    id: `org_domain_${name}`,
    domain: name,
    state,
    verificationStrategy,
  };
}

describe('listDnsVerifiedDomains', () => {
  test('keeps only domains verified through DNS', async () => {
    getOrganization.mockResolvedValueOnce({
      domains: [
        domain('dns.test', 'verified', 'dns'),
        // Verified, but by a dashboard tick rather than a DNS record. WorkOS
        // also accepts `state: 'verified'` directly on organization create, so
        // this is an assertion by whoever held access, not evidence of
        // control — and it must not authorize an account takeover.
        domain('manual.test', 'verified', 'manual'),
        domain('pending.test', 'pending', 'dns'),
        domain('failed.test', 'failed', 'dns'),
      ],
    });

    await expect(listDnsVerifiedDomains('org_1')).resolves.toEqual(['dns.test']);
  });

  test('lowercases and drops blanks, so the comparison is on the mailbox host', async () => {
    getOrganization.mockResolvedValueOnce({
      domains: [domain('MiXeD.TEST', 'verified', 'dns'), domain('   ', 'verified', 'dns')],
    });

    await expect(listDnsVerifiedDomains('org_1')).resolves.toEqual(['mixed.test']);
  });

  test('reports an unreachable WorkOS rather than an empty set', async () => {
    // An empty set is a refusal, which is terminal and parks the event. A
    // failed lookup says nothing about the address, so it has to be
    // distinguishable or an outage would discard valid binds.
    getOrganization.mockRejectedValueOnce(new Error('503 upstream'));

    await expect(listDnsVerifiedDomains('org_1')).rejects.toBeInstanceOf(VerifiedDomainLookupError);
  });

  test('separates a missing organization from an outage, so the event can park', async () => {
    // A 404 is a completed answer. Reported as a lookup failure it would reach
    // the Worker as a 5xx, which it classifies `unavailable` and never parks,
    // holding the one shared cursor for every directory.
    const notFound = Object.assign(new Error('Not found'), { status: 404 });
    getOrganization.mockRejectedValueOnce(notFound);

    await expect(listDnsVerifiedDomains('org_gone')).rejects.toBeInstanceOf(
      VerifiedDomainOwnerMissingError
    );
    // And not the transient class, which is what decides hold versus park.
    getOrganization.mockRejectedValueOnce(notFound);
    await expect(listDnsVerifiedDomains('org_gone')).rejects.not.toBeInstanceOf(
      VerifiedDomainLookupError
    );
  });

  test('answers no verified domains when WorkOS omits the field', async () => {
    // Typed as present by the SDK, but read as optional elsewhere in this repo.
    // Dereferencing it would throw a TypeError the caller turns into the same
    // un-parkable 500.
    getOrganization.mockResolvedValueOnce({});

    await expect(listDnsVerifiedDomains('org_1')).resolves.toEqual([]);
  });
});

describe('dnsVerifiedDomains', () => {
  test('keeps domains verified through DNS and drops manual, pending and failed ones', () => {
    expect(
      dnsVerifiedDomains({
        domains: [
          domain('dns.test', 'verified', 'dns'),
          domain('manual.test', 'verified', 'manual'),
          domain('pending.test', 'pending', 'dns'),
          domain('failed.test', 'failed', 'dns'),
        ],
      } as never)
    ).toEqual(['dns.test']);
  });

  test('trims, lowercases and drops blanks', () => {
    expect(
      dnsVerifiedDomains({
        domains: [domain('  MiXeD.TEST ', 'verified', 'dns'), domain('   ', 'verified', 'dns')],
      } as never)
    ).toEqual(['mixed.test']);
  });

  test('answers none when the field is missing', () => {
    expect(dnsVerifiedDomains({} as never)).toEqual([]);
  });
});

describe('getDnsVerifiedDomainsByExternalId', () => {
  test('reads the WorkOS organization linked to the Kilo organization and keeps DNS-verified domains', async () => {
    getOrganizationByExternalId.mockResolvedValueOnce({
      domains: [domain('dns.test', 'verified', 'dns'), domain('manual.test', 'verified', 'manual')],
    });

    await expect(getDnsVerifiedDomainsByExternalId('kilo-org-1')).resolves.toEqual(['dns.test']);
    expect(getOrganizationByExternalId).toHaveBeenCalledWith('kilo-org-1');
  });

  test('answers null when no WorkOS organization carries the external id', async () => {
    getOrganizationByExternalId.mockRejectedValueOnce(
      Object.assign(new Error('Not found'), { status: 404 })
    );

    await expect(getDnsVerifiedDomainsByExternalId('kilo-org-1')).resolves.toBeNull();
  });

  test('reports any other failure as a lookup error', async () => {
    getOrganizationByExternalId.mockRejectedValueOnce(new Error('503 upstream'));

    await expect(getDnsVerifiedDomainsByExternalId('kilo-org-1')).rejects.toBeInstanceOf(
      VerifiedDomainLookupError
    );
  });
});
