import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type {
  trackSecurityAgentRemediationAction as trackSecurityAgentRemediationActionType,
  trackSecurityAgentUiInteraction as trackSecurityAgentUiInteractionType,
} from './posthog-tracking';

jest.mock('@/lib/posthog', () => {
  const mockCapture = jest.fn();

  return {
    __esModule: true,
    default: jest.fn(() => ({ capture: mockCapture })),
    mockCapture,
  };
});

jest.mock('@sentry/nextjs', () => {
  const mockCaptureException = jest.fn();

  return {
    captureException: mockCaptureException,
    mockCaptureException,
  };
});

let trackSecurityAgentRemediationAction: typeof trackSecurityAgentRemediationActionType;
let trackSecurityAgentUiInteraction: typeof trackSecurityAgentUiInteractionType;

const posthogMock: { mockCapture: jest.Mock } = jest.requireMock('@/lib/posthog');
const sentryMock: { mockCaptureException: jest.Mock } = jest.requireMock('@sentry/nextjs');
const { mockCapture } = posthogMock;
const { mockCaptureException } = sentryMock;

beforeAll(async () => {
  ({ trackSecurityAgentRemediationAction, trackSecurityAgentUiInteraction } =
    await import('./posthog-tracking'));
});

describe('Security Agent PostHog tracking', () => {
  beforeEach(() => {
    mockCapture.mockReset();
    mockCaptureException.mockReset();
  });

  it('captures UI interactions with only fixed allowlisted properties', () => {
    const input = {
      distinctId: 'user-123',
      userId: 'user-123',
      interaction: 'finding_detail_opened',
      findingId: 'must-not-leak',
    } as const;

    trackSecurityAgentUiInteraction(input);

    expect(mockCapture).toHaveBeenCalledWith({
      distinctId: 'user-123',
      event: 'security_agent_ui_interaction',
      properties: {
        interaction: 'finding_detail_opened',
        feature: 'security-agent',
        operation: 'ui_interaction',
        userId: 'user-123',
      },
    });
  });

  it('captures remediation actions with trusted organization context only', () => {
    const input = {
      distinctId: 'user-123',
      userId: 'user-123',
      organizationId: 'organization-123',
      action: 'retry',
      attemptId: 'must-not-leak',
      error: 'must-not-leak',
    } as const;

    trackSecurityAgentRemediationAction(input);

    expect(mockCapture).toHaveBeenCalledWith({
      distinctId: 'user-123',
      event: 'security_agent_remediation_action',
      properties: {
        action: 'retry',
        phase: 'accepted',
        feature: 'security-agent',
        operation: 'remediation_action',
        userId: 'user-123',
        organizationId: 'organization-123',
      },
    });
  });

  it('reports UI capture failures without throwing or leaking arbitrary properties', () => {
    const error = new Error('capture failed');
    mockCapture.mockImplementation(() => {
      throw error;
    });

    expect(() =>
      trackSecurityAgentUiInteraction({
        distinctId: 'user-123',
        userId: 'user-123',
        interaction: 'findings_filtered',
      })
    ).not.toThrow();
    expect(mockCaptureException).toHaveBeenCalledWith(error, {
      tags: { source: 'posthog_security_agent_ui_interaction' },
      extra: {
        properties: {
          interaction: 'findings_filtered',
          feature: 'security-agent',
          operation: 'ui_interaction',
          userId: 'user-123',
        },
      },
    });
  });

  it('reports remediation capture failures without throwing', () => {
    const error = new Error('capture failed');
    mockCapture.mockImplementation(() => {
      throw error;
    });

    expect(() =>
      trackSecurityAgentRemediationAction({
        distinctId: 'user-123',
        userId: 'user-123',
        action: 'cancel',
      })
    ).not.toThrow();
    expect(mockCaptureException).toHaveBeenCalledWith(error, {
      tags: { source: 'posthog_security_agent_remediation_action' },
      extra: {
        properties: {
          action: 'cancel',
          phase: 'accepted',
          feature: 'security-agent',
          operation: 'remediation_action',
          userId: 'user-123',
        },
      },
    });
  });
});
