import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type {
  trackCostInsightsAlertAction as trackCostInsightsAlertActionType,
  trackCostInsightsSettingsSaved as trackCostInsightsSettingsSavedType,
  trackCostInsightsSuggestionAction as trackCostInsightsSuggestionActionType,
  trackCostInsightsUiInteraction as trackCostInsightsUiInteractionType,
} from './posthog-tracking';
import { CostInsightsUiInteractionSchema } from './tracking';

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

let trackCostInsightsAlertAction: typeof trackCostInsightsAlertActionType;
let trackCostInsightsSettingsSaved: typeof trackCostInsightsSettingsSavedType;
let trackCostInsightsSuggestionAction: typeof trackCostInsightsSuggestionActionType;
let trackCostInsightsUiInteraction: typeof trackCostInsightsUiInteractionType;

const posthogMock: { mockCapture: jest.Mock } = jest.requireMock('@/lib/posthog');
const sentryMock: { mockCaptureException: jest.Mock } = jest.requireMock('@sentry/nextjs');
const { mockCapture } = posthogMock;
const { mockCaptureException } = sentryMock;

beforeAll(async () => {
  ({
    trackCostInsightsAlertAction,
    trackCostInsightsSettingsSaved,
    trackCostInsightsSuggestionAction,
    trackCostInsightsUiInteraction,
  } = await import('./posthog-tracking'));
});

const personalContext = {
  distinctId: 'user-123',
  userId: 'user-123',
  ownerType: 'personal',
  authorizedRole: 'personal',
} as const;

describe('Cost Insights PostHog tracking', () => {
  beforeEach(() => {
    mockCapture.mockReset();
    mockCaptureException.mockReset();
  });

  it('captures dashboard views with only allowlisted properties', () => {
    const interaction = {
      interaction: 'dashboard_viewed',
      spendAlertsEnabled: false,
      hasActiveAlert: true,
      hasActiveSuggestion: true,
      question: 'must-not-leak',
      thresholdUsd: '250.00',
    } as const;

    trackCostInsightsUiInteraction(personalContext, interaction);

    expect(mockCapture).toHaveBeenCalledWith({
      distinctId: 'user-123',
      event: 'cost_insights_ui_interaction',
      properties: {
        interaction: 'dashboard_viewed',
        feature: 'cost-insights',
        operation: 'ui_interaction',
        userId: 'user-123',
        ownerType: 'personal',
        authorizedRole: 'personal',
        spendAlertsEnabled: false,
        hasActiveAlert: true,
        hasActiveSuggestion: true,
      },
    });
  });

  it('captures organization range selection with trusted context', () => {
    trackCostInsightsUiInteraction(
      {
        distinctId: 'user-456',
        userId: 'user-456',
        ownerType: 'organization',
        organizationId: 'organization-123',
        authorizedRole: 'billing_manager',
      },
      { interaction: 'spend_range_selected', range: '30d' }
    );

    expect(mockCapture).toHaveBeenCalledWith({
      distinctId: 'user-456',
      event: 'cost_insights_ui_interaction',
      properties: {
        interaction: 'spend_range_selected',
        feature: 'cost-insights',
        operation: 'ui_interaction',
        userId: 'user-456',
        ownerType: 'organization',
        authorizedRole: 'billing_manager',
        organizationId: 'organization-123',
        range: '30d',
      },
    });
  });

  it('captures settings transitions without exact financial values', () => {
    const event = {
      ...personalContext,
      spendAlertsTransition: 'enabled',
      anomalyAlertsTransition: 'unchanged',
      costSuggestionsTransition: 'disabled',
      threshold24hTransition: 'changed',
      threshold30dTransition: 'added',
      spendAlertsEnabled: true,
      anomalyAlertsEnabled: true,
      costSuggestionsEnabled: false,
      threshold24hConfigured: true,
      threshold30dConfigured: true,
      spendThresholdMicrodollars: 250_000_000,
    } as const;

    trackCostInsightsSettingsSaved(event);

    expect(mockCapture).toHaveBeenCalledWith({
      distinctId: 'user-123',
      event: 'cost_insights_settings_saved',
      properties: {
        phase: 'accepted',
        spendAlertsTransition: 'enabled',
        anomalyAlertsTransition: 'unchanged',
        costSuggestionsTransition: 'disabled',
        threshold24hTransition: 'changed',
        threshold30dTransition: 'added',
        spendAlertsEnabled: true,
        anomalyAlertsEnabled: true,
        costSuggestionsEnabled: false,
        threshold24hConfigured: true,
        threshold30dConfigured: true,
        feature: 'cost-insights',
        operation: 'save_settings',
        userId: 'user-123',
        ownerType: 'personal',
        authorizedRole: 'personal',
      },
    });
  });

  it('captures accepted 30-day alert acknowledgment', () => {
    trackCostInsightsAlertAction({
      ...personalContext,
      action: 'acknowledge',
      alertKind: 'threshold_30d',
    });

    expect(mockCapture).toHaveBeenCalledWith({
      distinctId: 'user-123',
      event: 'cost_insights_alert_action',
      properties: {
        action: 'acknowledge',
        alertKind: 'threshold_30d',
        phase: 'accepted',
        feature: 'cost-insights',
        operation: 'alert_action',
        userId: 'user-123',
        ownerType: 'personal',
        authorizedRole: 'personal',
      },
    });
  });

  it.each([
    { action: 'open_cta' as const, phase: 'clicked' as const },
    { action: 'dismiss' as const, phase: 'accepted' as const },
  ])('captures suggestion action $action without suggestion identity', ({ action, phase }) => {
    const event = {
      ...personalContext,
      action,
      phase,
      suggestionKind: 'kilo_pass',
      suggestionId: 'must-not-leak',
      ctaHref: 'must-not-leak',
    } as const;

    trackCostInsightsSuggestionAction(event);

    expect(mockCapture).toHaveBeenCalledWith({
      distinctId: 'user-123',
      event: 'cost_insights_suggestion_action',
      properties: {
        action,
        suggestionKind: 'kilo_pass',
        phase,
        feature: 'cost-insights',
        operation: 'suggestion_action',
        userId: 'user-123',
        ownerType: 'personal',
        authorizedRole: 'personal',
      },
    });
  });

  it('reports capture failures without throwing or leaking arbitrary properties', () => {
    const error = new Error('capture failed');
    mockCapture.mockImplementation(() => {
      throw error;
    });

    expect(() =>
      trackCostInsightsUiInteraction(personalContext, {
        interaction: 'ask_kilo_question_submitted',
        source: 'follow_up',
        experience: 'ui_only',
      })
    ).not.toThrow();
    expect(mockCaptureException).toHaveBeenCalledWith(error, {
      tags: { source: 'posthog_cost_insights_ui_interaction' },
      extra: {
        properties: {
          interaction: 'ask_kilo_question_submitted',
          feature: 'cost-insights',
          operation: 'ui_interaction',
          userId: 'user-123',
          ownerType: 'personal',
          authorizedRole: 'personal',
          source: 'follow_up',
          experience: 'ui_only',
        },
      },
    });
  });

  it('rejects free text and mismatched interaction properties at the router boundary', () => {
    expect(
      CostInsightsUiInteractionSchema.safeParse({
        interaction: 'ask_kilo_question_submitted',
        source: 'follow_up',
        experience: 'ui_only',
        question: 'private spend question',
      }).success
    ).toBe(false);
    expect(
      CostInsightsUiInteractionSchema.safeParse({
        interaction: 'spend_range_selected',
        range: '365d',
      }).success
    ).toBe(false);
  });
});
