import { describe, expect, it } from 'vitest';

import { buildNewSessionSourcePaths } from './new-session-source-paths';

describe('buildNewSessionSourcePaths', () => {
  it('routes the cloud choice to the cloud sub-route with the organizationId preserved', () => {
    const paths = buildNewSessionSourcePaths('org-123');
    expect(paths.cloud).toBe('/(app)/agent-chat/new/cloud?organizationId=org-123');
  });

  it('routes the cloud choice to the cloud sub-route without a query string when no organizationId is provided', () => {
    const paths = buildNewSessionSourcePaths();
    expect(paths.cloud).toBe('/(app)/agent-chat/new/cloud');
  });

  it('routes the local choice to the local sub-route with no organizationId even when one is provided (local is personal-only)', () => {
    const paths = buildNewSessionSourcePaths('org-123');
    expect(paths.local).toBe('/(app)/agent-chat/new/local');
  });

  it('routes the local choice to the local sub-route when no organizationId is provided', () => {
    const paths = buildNewSessionSourcePaths();
    expect(paths.local).toBe('/(app)/agent-chat/new/local');
  });
});
