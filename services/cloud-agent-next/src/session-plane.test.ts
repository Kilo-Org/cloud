import { describe, expect, it } from 'vitest';
import {
  generateSessionId,
  isControlPlaneOwner,
  sessionPlaneForNewOwner,
  sessionPlaneFromId,
  sessionSupportsTerminal,
} from './session-plane.js';
import { PROVIDER_CAPABILITIES, sessionHasTerminal } from './agent-sandbox/capabilities.js';
import { SESSION_ID_RE } from './shared/protocol.js';
import { sessionIdSchema } from './types.js';

describe('session plane identity', () => {
  it('classifies workspace_ as control and everything else as legacy', () => {
    expect(sessionPlaneFromId('workspace_12345678-1234-1234-1234-123456789abc')).toBe('control');
    expect(sessionPlaneFromId('agent_12345678-1234-1234-1234-123456789abc')).toBe('legacy');
    expect(sessionPlaneFromId('agent2_12345678-1234-1234-1234-123456789abc')).toBe('legacy');
  });

  it('accepts agent_ and workspace_ session IDs and rejects agent2_', () => {
    expect(SESSION_ID_RE.test('agent_12345678-1234-1234-1234-123456789abc')).toBe(true);
    expect(SESSION_ID_RE.test('workspace_12345678-1234-1234-1234-123456789abc')).toBe(true);
    expect(SESSION_ID_RE.test('agent2_12345678-1234-1234-1234-123456789abc')).toBe(false);
    expect(SESSION_ID_RE.test('Workspace_12345678-1234-1234-1234-123456789abc')).toBe(false);
    expect(
      sessionIdSchema.safeParse('workspace_12345678-1234-1234-1234-123456789abc').success
    ).toBe(true);
    expect(sessionIdSchema.safeParse('agent2_12345678-1234-1234-1234-123456789abc').success).toBe(
      false
    );
  });

  it('mints workspace_ only for allowlisted owners', () => {
    expect(generateSessionId('legacy').startsWith('agent_')).toBe(true);
    expect(generateSessionId('control').startsWith('workspace_')).toBe(true);
    expect(sessionIdSchema.safeParse(generateSessionId('control')).success).toBe(true);
    expect(sessionPlaneForNewOwner({ CONTROL_PLANE_IDS: 'user-1' }, { userId: 'user-1' })).toBe(
      'control'
    );
    expect(
      sessionPlaneForNewOwner({ CONTROL_PLANE_IDS: 'org-1' }, { userId: 'user-2', orgId: 'org-1' })
    ).toBe('control');
    expect(sessionPlaneForNewOwner({ CONTROL_PLANE_IDS: '*' }, { userId: 'user-3' })).toBe(
      'control'
    );
    expect(sessionPlaneForNewOwner({}, { userId: 'user-1', orgId: 'org-1' })).toBe('legacy');
    expect(isControlPlaneOwner({ CONTROL_PLANE_IDS: 'user-1' }, { userId: 'user-2' })).toBe(false);
  });

  it('supports control-plane terminals independently of legacy provider capabilities', () => {
    const legacySessionId = 'agent_12345678-1234-1234-1234-123456789abc';
    const controlSessionId = 'workspace_12345678-1234-1234-1234-123456789abc';

    expect(sessionSupportsTerminal(legacySessionId)).toBe(true);
    expect(sessionSupportsTerminal(controlSessionId)).toBe(true);
    expect(sessionHasTerminal(controlSessionId, 'cloudflare')).toBe(true);
    expect(sessionHasTerminal(controlSessionId, 'vercel')).toBe(true);
    expect(sessionHasTerminal(legacySessionId, 'cloudflare')).toBe(true);
    expect(sessionHasTerminal(legacySessionId, 'vercel')).toBe(false);
    expect(PROVIDER_CAPABILITIES.vercel.terminal).toBe(false);
  });
});
