import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { captureOrganizationMemberJoined as captureOrganizationMemberJoinedType } from './organization-member-analytics';

jest.mock('@/lib/posthog', () => {
  const mockCapture = jest.fn();
  return {
    __esModule: true,
    default: jest.fn(() => ({ capture: mockCapture })),
    mockCapture,
  };
});

let captureOrganizationMemberJoined: typeof captureOrganizationMemberJoinedType;

const posthogMock: { mockCapture: jest.Mock } = jest.requireMock('@/lib/posthog');
const { mockCapture } = posthogMock;

beforeAll(async () => {
  ({ captureOrganizationMemberJoined } = await import('./organization-member-analytics'));
});

describe('captureOrganizationMemberJoined', () => {
  beforeEach(() => {
    mockCapture.mockReset();
  });

  it('captures the distinct id, event name, and role only', () => {
    captureOrganizationMemberJoined('user@example.com', 'member');

    expect(mockCapture).toHaveBeenCalledWith({
      distinctId: 'user@example.com',
      event: 'organization_member_joined',
      properties: { role: 'member' },
    });
  });

  it('never puts userId or email in properties', () => {
    captureOrganizationMemberJoined('user@example.com', 'admin');

    const call = mockCapture.mock.calls[0][0] as { properties: Record<string, unknown> };
    expect(call.properties).not.toHaveProperty('userId');
    expect(call.properties).not.toHaveProperty('email');
    expect(Object.keys(call.properties)).toEqual(['role']);
  });

  it('swallows a capture failure', () => {
    mockCapture.mockImplementation(() => {
      throw new Error('capture failed');
    });

    expect(() => captureOrganizationMemberJoined('user@example.com', 'owner')).not.toThrow();
  });
});
