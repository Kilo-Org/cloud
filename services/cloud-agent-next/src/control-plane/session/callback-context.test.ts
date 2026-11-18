import { describe, expect, it } from 'vitest';
import type { SessionMetadata } from '../../persistence/session-metadata.js';
import { sessionCallbackContext } from './callback-context.js';

const sessionId = 'workspace_12345678-1234-4234-8234-123456789abc';
const worktreeId = 'worktree_12345678-1234-4234-8234-123456789abc';
const metadata = {
  metadataSchemaVersion: 2,
  identity: { userId: 'user-1', sessionId, orgId: 'org-1' },
  auth: { kiloSessionId: 'ses_1' },
  lifecycle: { version: 1, timestamp: 1 },
  allowSubagentSessions: true,
  workspace: { worktreeId },
} satisfies SessionMetadata;

describe('session callback context', () => {
  it('names the session id for a subagent-enabled workspace chat', () => {
    const context = sessionCallbackContext(metadata);
    expect(context).toContain(`session-id="${sessionId}"`);
    expect(context).toContain(`"url":"workspace:${sessionId}"`);
    expect(context).not.toContain('token');
  });

  it('omits the context when the chat cannot spawn children', () => {
    expect(sessionCallbackContext({ ...metadata, allowSubagentSessions: false })).toBeUndefined();
  });

  it('omits the context without a workspace', () => {
    const { workspace: _workspace, ...withoutWorkspace } = metadata;
    expect(sessionCallbackContext(withoutWorkspace as SessionMetadata)).toBeUndefined();
  });
});
