import { describe, expect, it } from 'vitest';
import { createSessionForCloudAgentSchema } from '@kilocode/session-ingest-contracts';

const params = {
  sessionId: 'ses_11111111111111111111111111',
  cloudAgentSessionId: 'workspace_11111111-1111-4111-8111-111111111111',
  kiloUserId: 'oauth/worktree-registration-test',
  createdOnPlatform: 'cloud-agent-web',
};

describe('workspace branch registration contract', () => {
  it('accepts omitted branches and strips unknown keys for independent deploys', () => {
    expect(createSessionForCloudAgentSchema.parse({ ...params, futureField: true })).toEqual(
      params
    );
    const previousSchema = createSessionForCloudAgentSchema.omit({ gitBranch: true });
    expect(previousSchema.parse({ ...params, gitBranch: 'kilo/eager-hub-j9o' })).toEqual(params);
  });

  it('validates the optional branch like baseBranch', () => {
    for (const gitBranch of ['kilo/eager-hub-j9o', 'b'.repeat(256)]) {
      expect(createSessionForCloudAgentSchema.parse({ ...params, gitBranch }).gitBranch).toBe(
        gitBranch
      );
    }
    for (const gitBranch of ['', 'b'.repeat(257)]) {
      expect(createSessionForCloudAgentSchema.safeParse({ ...params, gitBranch }).success).toBe(
        false
      );
    }
  });
});
