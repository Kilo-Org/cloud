import { describe, expect, it } from 'vitest';

import { securityAgentSingleRouteFixtureRoute } from './security-agent-single-route-fixture';

describe('securityAgentSingleRouteFixtureRoute', () => {
  it('maps a scope and the screen under it', () => {
    expect(
      securityAgentSingleRouteFixtureRoute(
        '/dev/security-agent-single-route-fixture/personal/settings/notifications'
      )
    ).toBe('/security-agent-single-route-fixture?scope=personal&suffix=settings%2Fnotifications');
  });

  it('maps the scope dashboard on its own', () => {
    expect(
      securityAgentSingleRouteFixtureRoute('/dev/security-agent-single-route-fixture/personal')
    ).toBe('/security-agent-single-route-fixture?scope=personal');
  });

  it('ignores a trailing slash', () => {
    expect(
      securityAgentSingleRouteFixtureRoute(
        '/dev/security-agent-single-route-fixture/personal/findings/'
      )
    ).toBe('/security-agent-single-route-fixture?scope=personal&suffix=findings');
  });

  it('reads a link that carries a scheme and a query', () => {
    expect(
      securityAgentSingleRouteFixtureRoute(
        'kiloapp:///dev/security-agent-single-route-fixture/personal/settings/notifications?from=test'
      )
    ).toBe('/security-agent-single-route-fixture?scope=personal&suffix=settings%2Fnotifications');
  });

  it('leaves every other path alone', () => {
    expect(securityAgentSingleRouteFixtureRoute('/dev/home-fixture/connection-lost')).toBeNull();
    expect(securityAgentSingleRouteFixtureRoute('/security-agent/personal')).toBeNull();
    expect(
      securityAgentSingleRouteFixtureRoute('/dev/security-agent-single-route-fixture')
    ).toBeNull();
  });
});
