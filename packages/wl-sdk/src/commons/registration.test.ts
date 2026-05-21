import { describe, expect, it } from 'vitest';
import { buildRegistrationDML } from './registration';

describe('buildRegistrationDML', () => {
  it('matches the Go BuildRegistrationSQL output byte-for-byte', () => {
    const sql = buildRegistrationDML({
      handle: 'alice',
      dolthubOrg: 'alice-org',
      displayName: 'Alice',
      ownerEmail: 'a@b.com',
      version: '0.1.0',
    });
    expect(sql).toBe(
      'INSERT INTO rigs (handle, display_name, dolthub_org, hop_uri, owner_email, gt_version, trust_level, registered_at, last_seen) ' +
        "VALUES ('alice', 'Alice', 'alice-org', 'hop://a@b.com/alice/', 'a@b.com', '0.1.0', 1, NOW(), NOW()) " +
        "ON DUPLICATE KEY UPDATE display_name = 'Alice', dolthub_org = 'alice-org', hop_uri = 'hop://a@b.com/alice/', owner_email = 'a@b.com', gt_version = '0.1.0', last_seen = NOW()"
    );
  });

  it('escapes single quotes in displayName', () => {
    const sql = buildRegistrationDML({
      handle: 'alice',
      dolthubOrg: 'alice',
      displayName: "Alice O'Brien",
      ownerEmail: 'a@b.com',
      version: '0.1.0',
    });
    // Go's EscapeSQL doubles single quotes.
    expect(sql).toContain("'Alice O''Brien'");
  });

  it('encodes the hop URI as hop://<email>/<handle>/', () => {
    const sql = buildRegistrationDML({
      handle: 'rig-1',
      dolthubOrg: 'orgX',
      displayName: 'Rig One',
      ownerEmail: 'r1@example.com',
      version: 'v0',
    });
    expect(sql).toContain("'hop://r1@example.com/rig-1/'");
  });

  it('puts the same five values in INSERT and ON DUPLICATE positions', () => {
    // The Go reference uses positional fmt args: h, dn, org, hu, oe, v
    // for the VALUES list, then dn, org, hu, oe, v again (no handle —
    // it's the primary key) for the UPDATE list.
    const sql = buildRegistrationDML({
      handle: 'h1',
      dolthubOrg: 'O',
      displayName: 'D',
      ownerEmail: 'e@x',
      version: 'V',
    });
    // Exactly two occurrences of each non-handle field — once each in
    // VALUES and ON DUPLICATE KEY UPDATE.
    const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;
    expect(count(sql, "'D'")).toBe(2); // displayName
    expect(count(sql, "'O'")).toBe(2); // dolthubOrg
    expect(count(sql, "'e@x'")).toBe(2); // ownerEmail
    expect(count(sql, "'V'")).toBe(2); // version
    expect(count(sql, "'hop://e@x/h1/'")).toBe(2); // hop URI
    // Handle appears once (in VALUES) — the primary key isn't in UPDATE.
    expect(count(sql, "'h1'")).toBe(1);
  });
});
