import { selectTerminalOwner, type TerminalOwnerCandidate } from './terminal-owner';

function candidate(
  kiloSessionId: string,
  cloudAgentSessionId: string,
  routeReady: boolean | undefined
): TerminalOwnerCandidate {
  return { kiloSessionId, cloudAgentSessionId, routeReady };
}

describe('selectTerminalOwner', () => {
  it('prefers the viewed session when its route is ready', () => {
    expect(
      selectTerminalOwner({
        loadedKiloSessionId: 'ses_viewed',
        candidates: [
          candidate('ses_viewed', 'workspace_viewed', true),
          candidate('ses_sibling', 'workspace_sibling', true),
        ],
      })
    ).toBe('workspace_viewed');
  });

  it('prefers the viewed session while its readiness is unknown instead of a sibling', () => {
    expect(
      selectTerminalOwner({
        loadedKiloSessionId: 'ses_viewed',
        candidates: [
          candidate('ses_sibling', 'workspace_sibling', true),
          candidate('ses_viewed', 'workspace_viewed', undefined),
        ],
      })
    ).toBe('workspace_viewed');
  });

  it('falls back to a ready sibling when the viewed route is not ready', () => {
    expect(
      selectTerminalOwner({
        loadedKiloSessionId: 'ses_viewed',
        candidates: [
          candidate('ses_viewed', 'workspace_viewed', false),
          candidate('ses_sibling', 'workspace_sibling', true),
        ],
      })
    ).toBe('workspace_sibling');
  });

  it('never binds a not-ready viewed session to a stopped sibling', () => {
    expect(
      selectTerminalOwner({
        loadedKiloSessionId: 'ses_viewed',
        candidates: [
          candidate('ses_viewed', 'workspace_viewed', false),
          candidate('ses_stopped', 'workspace_stopped', false),
        ],
      })
    ).toBe('workspace_viewed');
  });

  it('picks a ready sibling in the worktree-only view', () => {
    expect(
      selectTerminalOwner({
        loadedKiloSessionId: null,
        candidates: [
          candidate('ses_stopped', 'workspace_stopped', false),
          candidate('ses_live', 'workspace_live', true),
        ],
      })
    ).toBe('workspace_live');
  });

  it('picks the first known session when nothing is ready', () => {
    expect(
      selectTerminalOwner({
        loadedKiloSessionId: null,
        candidates: [
          candidate('ses_a', 'workspace_a', false),
          candidate('ses_b', 'workspace_b', undefined),
        ],
      })
    ).toBe('workspace_a');
  });

  it('returns null without candidates', () => {
    expect(selectTerminalOwner({ loadedKiloSessionId: 'ses_viewed', candidates: [] })).toBeNull();
  });
});
