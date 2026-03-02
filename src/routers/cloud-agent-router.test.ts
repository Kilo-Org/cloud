import { describe, expect, it, jest, beforeEach, beforeAll } from '@jest/globals';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import type { User } from '@kilocode/db/schema';
import * as cloudAgentModule from '@/lib/cloud-agent/cloud-agent-client';

describe('cloudAgentRouter.deleteSession', () => {
  let testUser: User;
  let deleteSessionSpy: jest.SpiedFunction<
    typeof cloudAgentModule.CloudAgentClient.prototype.deleteSession
  >;

  beforeEach(() => {
    // Spy on the deleteSession method
    deleteSessionSpy = jest.spyOn(cloudAgentModule.CloudAgentClient.prototype, 'deleteSession');
  });

  afterEach(() => {
    // Restore after each test
    deleteSessionSpy.mockRestore();
  });

  beforeAll(async () => {
    testUser = await insertTestUser({
      google_user_email: 'test-cloud-agent@example.com',
      google_user_name: 'Cloud Agent Test User',
      is_admin: false,
    });
  });

  it('should call CloudAgentClient.deleteSession with correct sessionId', async () => {
    const sessionId = 'agent_12345678-1234-1234-1234-123456789abc';
    deleteSessionSpy.mockResolvedValue({ success: true });

    const caller = await createCallerForUser(testUser.id);
    const result = await caller.cloudAgent.deleteSession({ sessionId });

    expect(result).toEqual({ success: true });
    expect(deleteSessionSpy).toHaveBeenCalledWith(sessionId);
    expect(deleteSessionSpy).toHaveBeenCalledTimes(1);
  });

  it('should return the result from CloudAgentClient', async () => {
    const sessionId = 'agent_abcdef01-2345-6789-abcd-ef0123456789';
    deleteSessionSpy.mockResolvedValue({ success: true });

    const caller = await createCallerForUser(testUser.id);
    const result = await caller.cloudAgent.deleteSession({ sessionId });

    expect(result).toEqual({ success: true });
  });

  it('should handle errors from CloudAgentClient gracefully', async () => {
    const sessionId = 'agent_11111111-2222-3333-4444-555555555555';
    deleteSessionSpy.mockRejectedValue(new Error('Network error'));

    const caller = await createCallerForUser(testUser.id);

    await expect(caller.cloudAgent.deleteSession({ sessionId })).rejects.toThrow('Network error');
  });

  it('should require authentication', async () => {
    // Create a caller without a valid user - this will throw
    await expect(createCallerForUser('non-existent-user-id')).rejects.toThrow();
  });

  it('should handle failure response from CloudAgentClient', async () => {
    const sessionId = 'agent_00000000-0000-0000-0000-000000000000';
    deleteSessionSpy.mockResolvedValue({ success: false });

    const caller = await createCallerForUser(testUser.id);
    const result = await caller.cloudAgent.deleteSession({ sessionId });

    expect(result).toEqual({ success: false });
  });
});
