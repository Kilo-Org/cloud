import { describe, expect, it } from 'vitest';
import { ORGANIZATION_EXPORT_ROLES } from '@kilocode/db/organization-export-access';
import { DownloadRequestSchema, ExportQueueMessageSchema, parseCursor } from './contracts';
import { __test__ } from './databases';

// The Worker re-authorises an organization download against live membership rather than
// trusting the request path, so it must reach the same verdict as the router. Both now
// build from one shared predicate; this pins the values so a change is a visible
// decision here, and catches a hand-written copy reappearing on this side.
describe('organization export roles', () => {
  it('admits owners and admins only', () => {
    expect([...ORGANIZATION_EXPORT_ROLES]).toEqual(['owner', 'admin']);
  });

  it('builds the membership predicate from the shared list', () => {
    const predicate = __test__.callerMayAccess('user-1');
    // Every role in the shared list reaches the SQL, and nothing else does. A stale
    // literal would leave 'member' or 'billing_manager' able to download.
    for (const role of ORGANIZATION_EXPORT_ROLES) {
      expect(predicate.queryChunks.some(chunk => JSON.stringify(chunk).includes(role))).toBe(true);
    }
    const rendered = JSON.stringify(predicate.queryChunks);
    expect(rendered).not.toContain('billing_manager');
    expect(rendered).not.toContain('"member"');
  });

  // The inheritance branch is what the Worker's own copy was missing, which is how an
  // export came to generate, show as ready, and refuse every download.
  it('carries the parent-organization branch', () => {
    const rendered = JSON.stringify(__test__.callerMayAccess('user-1').queryChunks);
    expect(rendered).toContain('parent_organization_id');
    expect(rendered).toContain('deleted_at IS NULL');
  });
});

describe('ExportQueueMessageSchema', () => {
  it('accepts only a versioned durable generation reference', () => {
    expect(
      ExportQueueMessageSchema.safeParse({
        version: 1,
        operation: 'generate',
        exportId: 'f6ba5ce5-9061-4f7f-9ec6-76f047573f1c',
        generation: 0,
      }).success
    ).toBe(true);
    expect(
      ExportQueueMessageSchema.safeParse({
        version: 1,
        operation: 'generate',
        exportId: 'f6ba5ce5-9061-4f7f-9ec6-76f047573f1c',
        generation: -1,
        prompt: 'must not be present',
      }).success
    ).toBe(false);
  });
});

describe('DownloadRequestSchema', () => {
  it('accepts only export identity and derives user scope from auth', () => {
    expect(
      DownloadRequestSchema.safeParse({
        version: 1,
        exportId: 'f6ba5ce5-9061-4f7f-9ec6-76f047573f1c',
      }).success
    ).toBe(true);
    expect(
      DownloadRequestSchema.safeParse({
        version: 1,
        exportId: 'f6ba5ce5-9061-4f7f-9ec6-76f047573f1c',
        kiloUserId: 'other-user',
      }).success
    ).toBe(false);
  });
});

describe('parseCursor', () => {
  it('accepts strict ISO cursors and rejects malformed persisted values', () => {
    expect(parseCursor({ createdAt: '2026-08-03T00:00:00.123456Z', id: 'row-id' })).toEqual({
      createdAt: '2026-08-03T00:00:00.123456Z',
      id: 'row-id',
    });
    expect(parseCursor({ createdAt: 'not-a-date', id: 'row-id' })).toBeNull();
    expect(parseCursor({ createdAt: '2026-08-03T00:00:00.123456Z', id: '' })).toBeNull();
  });
});
