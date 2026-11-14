import { type KiloSessionId } from '@kilocode/cloud-agent-sdk';
import { type Href } from 'expo-router';
import { describe, expect, it } from 'vitest';

import {
  getAgentSessionPath,
  getSpawnedAgentSessionPath,
  replaceWithAgentSession,
} from './session-detail-routes';

const SESSION_ID: KiloSessionId = 'ses_12345678901234567890123456' as KiloSessionId;
const ORG_ID = 'org_abc123';

describe('getSpawnedAgentSessionPath', () => {
  it('appends spawned=1 to the personal (no-org) path', () => {
    expect(getSpawnedAgentSessionPath(SESSION_ID)).toBe(
      `/(app)/agent-chat/${SESSION_ID}?spawned=1`
    );
  });

  it('joins spawned=1 with & when an organizationId is already on the path', () => {
    expect(getSpawnedAgentSessionPath(SESSION_ID, ORG_ID)).toBe(
      `/(app)/agent-chat/${SESSION_ID}?organizationId=${ORG_ID}&spawned=1`
    );
  });

  it('does not rewrite the base path returned by getAgentSessionPath', () => {
    // Sanity: the base path is what we hand to the function; the helper
    // must not rewrite it, only suffix it.
    expect(getAgentSessionPath(SESSION_ID)).toBe(`/(app)/agent-chat/${SESSION_ID}`);
    expect(getAgentSessionPath(SESSION_ID, ORG_ID)).toBe(
      `/(app)/agent-chat/${SESSION_ID}?organizationId=${ORG_ID}`
    );
  });
});

describe('replaceWithAgentSession', () => {
  it('replaces with the org-scoped detail path, not the spawn path', () => {
    // Regression: the non-spawn callers (push notifications, deep links) keep
    // their original navigation target. `spawned=1` belongs to
    // `getSpawnedAgentSessionPath`; the literal expectation below fails when
    // this destination loses its `organizationId` or gains the spawn param.
    const destinations: Href[] = [];
    const router = { replace: (href: Href) => destinations.push(href) };

    replaceWithAgentSession(router, SESSION_ID, ORG_ID);

    expect(destinations).toEqual([
      '/(app)/agent-chat/ses_12345678901234567890123456?organizationId=org_abc123',
    ]);
  });
});
