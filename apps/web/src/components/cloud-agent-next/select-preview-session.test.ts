import type { CloudAgentWorktreeId } from '@kilocode/session-ingest-contracts';
import type { PreviewTarget } from '../../../../../services/cloud-agent-next/src/shared/preview-target';
import {
  canOpenWorkspacePreview,
  gatePreviewTarget,
  selectPreviewTarget,
} from './select-preview-session';

const WORKTREE_ID = 'worktree_12345678-1234-4234-9234-123456789abc' as CloudAgentWorktreeId;
const OTHER_WORKTREE_ID = 'worktree_87654321-4321-4321-8321-cba987654321' as CloudAgentWorktreeId;
const WORKSPACE_ID = 'workspace_12345678-1234-4234-9234-123456789abc';

describe('selectPreviewTarget', () => {
  it('uses the grouped worktree regardless of the viewed chat', () => {
    expect(
      selectPreviewTarget({
        selectedWorktreeId: WORKTREE_ID,
        sessionId: WORKSPACE_ID,
      })
    ).toEqual({ worktreeId: WORKTREE_ID } satisfies PreviewTarget);
  });

  it('uses the grouped worktree in a worktree-only view', () => {
    expect(
      selectPreviewTarget({
        selectedWorktreeId: OTHER_WORKTREE_ID,
        sessionId: null,
      })
    ).toEqual({ worktreeId: OTHER_WORKTREE_ID });
  });

  it('uses the grouped worktree for a new sibling even when its session is not ready', () => {
    expect(
      selectPreviewTarget({
        selectedWorktreeId: WORKTREE_ID,
        sessionId: undefined,
      })
    ).toEqual({ worktreeId: WORKTREE_ID });
  });

  it('accepts a standalone workspace session when no worktree is grouped', () => {
    expect(
      selectPreviewTarget({
        selectedWorktreeId: null,
        sessionId: WORKSPACE_ID,
      })
    ).toEqual({ cloudAgentSessionId: WORKSPACE_ID } satisfies PreviewTarget);
  });

  it('returns null without a worktree or a control-plane session', () => {
    expect(
      selectPreviewTarget({
        selectedWorktreeId: null,
        sessionId: 'ses_12345678901234567890123456',
      })
    ).toBeNull();
    expect(
      selectPreviewTarget({
        selectedWorktreeId: null,
        sessionId: null,
      })
    ).toBeNull();
  });
});

describe('canOpenWorkspacePreview', () => {
  it('offers a preview only for control-plane workspace sessions', () => {
    expect(canOpenWorkspacePreview('workspace_12345678-1234-4234-9234-123456789abc')).toBe(true);
    expect(canOpenWorkspacePreview('agent_12345678-1234-4234-9234-123456789abc')).toBe(false);
    expect(canOpenWorkspacePreview('ses_12345678901234567890123456')).toBe(false);
    expect(canOpenWorkspacePreview(null)).toBe(false);
    expect(canOpenWorkspacePreview(undefined)).toBe(false);
  });
});

describe('gatePreviewTarget', () => {
  const target: PreviewTarget = { worktreeId: WORKTREE_ID };

  it('passes the target when the viewer may open a terminal', () => {
    expect(gatePreviewTarget(target, true)).toBe(target);
  });

  it('refuses the target when the viewer may not open a terminal', () => {
    expect(gatePreviewTarget(target, false)).toBeNull();
    expect(gatePreviewTarget(null, true)).toBeNull();
  });
});
