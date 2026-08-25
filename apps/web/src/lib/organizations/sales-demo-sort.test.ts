import { describe, expect, test } from '@jest/globals';
import { compareOrganizationsForDefault } from './sales-demo-sort';

describe('compareOrganizationsForDefault', () => {
  test('sorts a demo org created later before an older non-demo org', () => {
    const olderNonDemo = {
      organizationId: 'org-aaa',
      created_at: '2024-01-01T00:00:00.000Z',
    };
    const laterDemo = {
      organizationId: 'org-bbb',
      created_at: '2025-01-01T00:00:00.000Z',
      isSalesDemo: true,
    };

    expect([olderNonDemo, laterDemo].sort(compareOrganizationsForDefault)).toEqual([
      laterDemo,
      olderNonDemo,
    ]);
  });

  test('keeps created_at then organizationId order for two non-demo orgs', () => {
    const newer = {
      organizationId: 'org-bbb',
      created_at: '2025-01-01T00:00:00.000Z',
    };
    const older = {
      organizationId: 'org-aaa',
      created_at: '2024-01-01T00:00:00.000Z',
    };
    const sameAgeAfter = {
      organizationId: 'org-ccc',
      created_at: '2025-01-01T00:00:00.000Z',
    };

    expect([newer, older, sameAgeAfter].sort(compareOrganizationsForDefault)).toEqual([
      older,
      newer,
      sameAgeAfter,
    ]);
  });
});
