import { describe, expect, it } from 'vitest';

import { isScopeDashboardMissing, SCOPE_DASHBOARD_ROUTE_NAME } from './security-agent-route-stack';

describe('isScopeDashboardMissing', () => {
  it('is false for the dashboard itself, which leaves the group on Back', () => {
    expect(
      isScopeDashboardMissing({ index: 0, routes: [{ name: SCOPE_DASHBOARD_ROUTE_NAME }] })
    ).toBe(false);
  });

  it('is false for a screen the dashboard opened', () => {
    expect(
      isScopeDashboardMissing({
        index: 1,
        routes: [{ name: SCOPE_DASHBOARD_ROUTE_NAME }, { name: 'settings/notifications' }],
      })
    ).toBe(false);
  });

  it('is true for a screen that is the only route of the Stack', () => {
    expect(
      isScopeDashboardMissing({ index: 0, routes: [{ name: 'settings/notifications' }] })
    ).toBe(true);
  });

  it('is true for a screen opened above screens that are not the dashboard', () => {
    expect(
      isScopeDashboardMissing({
        index: 1,
        routes: [{ name: 'findings/index' }, { name: 'findings/[id]' }],
      })
    ).toBe(true);
  });

  it('ignores a dashboard above the focused screen', () => {
    // The dashboard is the screen the reader moved on from, not a parent.
    expect(
      isScopeDashboardMissing({
        index: 0,
        routes: [{ name: 'settings/notifications' }, { name: SCOPE_DASHBOARD_ROUTE_NAME }],
      })
    ).toBe(true);
  });

  it('is false for an empty Stack', () => {
    expect(isScopeDashboardMissing({ index: 0, routes: [] })).toBe(false);
  });
});
