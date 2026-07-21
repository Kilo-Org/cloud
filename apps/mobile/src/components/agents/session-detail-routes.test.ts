import { type KiloSessionId } from 'cloud-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

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
  it('still uses the base path (no spawned=1) — spawned param is owned by the spawn path', () => {
    // Regression: the existing helper is unchanged. Spawned-aware callers
    // go through `getSpawnedAgentSessionPath` directly so the non-spawn
    // paths (push notifications, deep links, etc.) keep their original
    // byte-for-byte navigation target.
    const router = { replace: vi.fn(() => undefined) };
    replaceWithAgentSession(router, SESSION_ID, ORG_ID);
    expect(router.replace).toHaveBeenCalledWith(getAgentSessionPath(SESSION_ID, ORG_ID));
  });
});
