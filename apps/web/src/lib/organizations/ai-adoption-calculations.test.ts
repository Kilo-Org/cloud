import {
  normalizeComponentScore,
  hasActivity,
  calculateUserMetricsForDate,
  calculateFrequencyScore,
  calculateDepthScore,
  calculateCoverageScore,
  calculateUserScore,
  calculateWeeklyTrends,
  AI_ADOPTION_THRESHOLDS,
  type UserMetrics,
  type DailyActivityData,
  type MemberInfo,
} from './ai-adoption-calculations';

describe('AI Adoption Calculations', () => {
  describe('normalizeComponentScore', () => {
    it('should return 0 when rawValue is 0', () => {
      expect(normalizeComponentScore(0, 10, 10)).toBe(0);
    });

    it('should return full points when rawValue equals threshold', () => {
      expect(normalizeComponentScore(10, 10, 10)).toBe(10);
    });

    it('should return half points when rawValue is half of threshold', () => {
      expect(normalizeComponentScore(5, 10, 10)).toBe(5);
    });

    it('should cap at pointsPerComponent when rawValue exceeds threshold', () => {
      expect(normalizeComponentScore(20, 10, 10)).toBe(10);
    });

    it('should handle decimal thresholds correctly', () => {
      expect(normalizeComponentScore(0.5, 1, 13.33)).toBeCloseTo(6.665, 2);
    });
  });

  describe('hasActivity', () => {
    it('should return false when all frequency components are 0', () => {
      const metrics: UserMetrics = {
        agentInteractionsPerDay: 0,
        autocompleteAcceptance: 0,
        cloudAgentSessions: 0,
        reviewerAgentRuns: 0,
        queriesPerHourWorked: 0,
        suggestionsAcceptedPercent: 0,
        multiAgentChains: 0,
        weeklyAIUsagePercent: 0,
        twoAgentAdoptionPercent: 0,
        fourAgentAdoptionPercent: 0,
        weekdayUsageBreadth: 0,
      };
      expect(hasActivity(metrics)).toBe(false);
    });

    it('should return true when agentInteractionsPerDay > 0', () => {
      const metrics: UserMetrics = {
        agentInteractionsPerDay: 1,
        autocompleteAcceptance: 0,
        cloudAgentSessions: 0,
        reviewerAgentRuns: 0,
        queriesPerHourWorked: 0,
        suggestionsAcceptedPercent: 0,
        multiAgentChains: 0,
        weeklyAIUsagePercent: 0,
        twoAgentAdoptionPercent: 0,
        fourAgentAdoptionPercent: 0,
        weekdayUsageBreadth: 0,
      };
      expect(hasActivity(metrics)).toBe(true);
    });

    it('should return true when any frequency component > 0', () => {
      const metrics: UserMetrics = {
        agentInteractionsPerDay: 0,
        autocompleteAcceptance: 0,
        cloudAgentSessions: 0,
        reviewerAgentRuns: 5,
        queriesPerHourWorked: 0,
        suggestionsAcceptedPercent: 0,
        multiAgentChains: 0,
        weeklyAIUsagePercent: 0,
        twoAgentAdoptionPercent: 0,
        fourAgentAdoptionPercent: 0,
        weekdayUsageBreadth: 0,
      };
      expect(hasActivity(metrics)).toBe(true);
    });
  });

  describe('calculateUserMetricsForDate', () => {
    it('should calculate metrics correctly for a user with activity', () => {
      const member: MemberInfo = {
        userId: 'user1',
        email: 'user1@example.com',
      };

      const activityData: DailyActivityData = {
        agentInteractions: new Map([
          ['2024-01-01', new Map([['user1', 5]])],
          ['2023-12-31', new Map([['user1', 3]])],
          ['2023-12-30', new Map([['user1', 2]])],
        ]),
        autocomplete: new Map([
          ['2024-01-01', new Map([['user1', 10]])],
          ['2023-12-31', new Map([['user1', 8]])],
        ]),
        cloudAgentSessions: new Map([['2024-01-01', new Map([['user1', 1]])]]),
        codeReviews: new Map([['2024-01-01', new Map([['user1', 1]])]]),
      };

      const currentDate = new Date('2024-01-01T00:00:00Z');
      const dateStr = '2024-01-01';

      const metrics = calculateUserMetricsForDate(member, dateStr, currentDate, activityData);

      expect(metrics.agentInteractionsPerDay).toBe(5);
      expect(metrics.autocompleteAcceptance).toBe(10);
      expect(metrics.cloudAgentSessions).toBe(1);
      expect(metrics.reviewerAgentRuns).toBe(1);
      expect(metrics.queriesPerHourWorked).toBe(5 / 8); // Only agent interactions, not autocomplete
      expect(metrics.multiAgentChains).toBe(1); // min(5, 1, 1)
    });

    it('should return 0 for multiAgentChains when not all agent types are used', () => {
      const member: MemberInfo = {
        userId: 'user1',
        email: 'user1@example.com',
      };

      const activityData: DailyActivityData = {
        agentInteractions: new Map([['2024-01-01', new Map([['user1', 5]])]]),
        autocomplete: new Map([['2024-01-01', new Map([['user1', 10]])]]),
        cloudAgentSessions: new Map(), // No cloud agent sessions
        codeReviews: new Map([['2024-01-01', new Map([['user1', 1]])]]),
      };

      const currentDate = new Date('2024-01-01T00:00:00Z');
      const dateStr = '2024-01-01';

      const metrics = calculateUserMetricsForDate(member, dateStr, currentDate, activityData);

      expect(metrics.multiAgentChains).toBe(0);
    });

    it('should calculate coverage metrics based on 7-day lookback', () => {
      const member: MemberInfo = {
        userId: 'user1',
        email: 'user1@example.com',
      };

      // User has activity on 5 out of 7 days
      const activityData: DailyActivityData = {
        agentInteractions: new Map([
          ['2024-01-01', new Map([['user1', 1]])],
          ['2023-12-31', new Map([['user1', 1]])],
          ['2023-12-30', new Map([['user1', 1]])],
          ['2023-12-29', new Map([['user1', 1]])],
          ['2023-12-28', new Map([['user1', 1]])],
        ]),
        autocomplete: new Map(),
        cloudAgentSessions: new Map(),
        codeReviews: new Map(),
      };

      const currentDate = new Date('2024-01-01T00:00:00Z');
      const dateStr = '2024-01-01';

      const metrics = calculateUserMetricsForDate(member, dateStr, currentDate, activityData);

      expect(metrics.weeklyAIUsagePercent).toBeCloseTo((5 / 7) * 100, 1);
      expect(metrics.twoAgentAdoptionPercent).toBe(0); // Only 1 agent type used
      expect(metrics.fourAgentAdoptionPercent).toBe(0);
    });
  });

  describe('calculateFrequencyScore', () => {
    it('should return 0 for empty metrics', () => {
      const metricsForDay = new Map<string, UserMetrics>();
      expect(calculateFrequencyScore(metricsForDay)).toBe(0);
    });

    it('should return 0 when no users have activity', () => {
      const metricsForDay = new Map<string, UserMetrics>([
        [
          'user1',
          {
            agentInteractionsPerDay: 0,
            autocompleteAcceptance: 0,
            cloudAgentSessions: 0,
            reviewerAgentRuns: 0,
            queriesPerHourWorked: 0,
            suggestionsAcceptedPercent: 0,
            multiAgentChains: 0,
            weeklyAIUsagePercent: 0,
            twoAgentAdoptionPercent: 0,
            fourAgentAdoptionPercent: 0,
            weekdayUsageBreadth: 0,
          },
        ],
      ]);
      expect(calculateFrequencyScore(metricsForDay)).toBe(0);
    });

    it('should calculate correct score for single user at threshold', () => {
      const metricsForDay = new Map<string, UserMetrics>([
        [
          'user1',
          {
            agentInteractionsPerDay: AI_ADOPTION_THRESHOLDS.frequency.agentInteractionsPerDay,
            autocompleteAcceptance: AI_ADOPTION_THRESHOLDS.frequency.autocompleteAcceptance,
            cloudAgentSessions: AI_ADOPTION_THRESHOLDS.frequency.cloudAgentSessions,
            reviewerAgentRuns: AI_ADOPTION_THRESHOLDS.frequency.reviewerAgentRuns,
            queriesPerHourWorked: 0,
            suggestionsAcceptedPercent: 0,
            multiAgentChains: 0,
            weeklyAIUsagePercent: 0,
            twoAgentAdoptionPercent: 0,
            fourAgentAdoptionPercent: 0,
            weekdayUsageBreadth: 0,
          },
        ],
      ]);
      expect(calculateFrequencyScore(metricsForDay)).toBe(40); // Max score
    });

    it('should average scores across multiple active users', () => {
      const metricsForDay = new Map<string, UserMetrics>([
        [
          'user1',
          {
            agentInteractionsPerDay: 10, // Full score (10 points)
            autocompleteAcceptance: 0,
            cloudAgentSessions: 0,
            reviewerAgentRuns: 0,
            queriesPerHourWorked: 0,
            suggestionsAcceptedPercent: 0,
            multiAgentChains: 0,
            weeklyAIUsagePercent: 0,
            twoAgentAdoptionPercent: 0,
            fourAgentAdoptionPercent: 0,
            weekdayUsageBreadth: 0,
          },
        ],
        [
          'user2',
          {
            agentInteractionsPerDay: 5, // Half score (5 points)
            autocompleteAcceptance: 0,
            cloudAgentSessions: 0,
            reviewerAgentRuns: 0,
            queriesPerHourWorked: 0,
            suggestionsAcceptedPercent: 0,
            multiAgentChains: 0,
            weeklyAIUsagePercent: 0,
            twoAgentAdoptionPercent: 0,
            fourAgentAdoptionPercent: 0,
            weekdayUsageBreadth: 0,
          },
        ],
      ]);
      expect(calculateFrequencyScore(metricsForDay)).toBe(7.5); // Average of 10 and 5
    });
  });

  describe('calculateDepthScore', () => {
    it('should return 0 for empty metrics', () => {
      const metricsForDay = new Map<string, UserMetrics>();
      expect(calculateDepthScore(metricsForDay)).toBe(0);
    });

    it('should calculate correct score at threshold', () => {
      const metricsForDay = new Map<string, UserMetrics>([
        [
          'user1',
          {
            agentInteractionsPerDay: 1, // Need some activity
            autocompleteAcceptance: 0,
            cloudAgentSessions: 0,
            reviewerAgentRuns: 0,
            queriesPerHourWorked: AI_ADOPTION_THRESHOLDS.depth.queriesPerHourWorked,
            suggestionsAcceptedPercent: AI_ADOPTION_THRESHOLDS.depth.suggestionsAcceptedPercent,
            multiAgentChains: AI_ADOPTION_THRESHOLDS.depth.multiAgentChains,
            weeklyAIUsagePercent: 0,
            twoAgentAdoptionPercent: 0,
            fourAgentAdoptionPercent: 0,
            weekdayUsageBreadth: 0,
          },
        ],
      ]);
      expect(calculateDepthScore(metricsForDay)).toBeCloseTo(40, 1); // Max score (13.33 * 3)
    });
  });

  describe('calculateCoverageScore', () => {
    it('should return 0 for empty metrics', () => {
      const metricsForDay = new Map<string, UserMetrics>();
      expect(calculateCoverageScore(metricsForDay)).toBe(0);
    });

    it('should calculate correct score at threshold', () => {
      const metricsForDay = new Map<string, UserMetrics>([
        [
          'user1',
          {
            agentInteractionsPerDay: 1, // Need some activity
            autocompleteAcceptance: 0,
            cloudAgentSessions: 0,
            reviewerAgentRuns: 0,
            queriesPerHourWorked: 0,
            suggestionsAcceptedPercent: 0,
            multiAgentChains: 0,
            weeklyAIUsagePercent: 100,
            twoAgentAdoptionPercent: 100,
            fourAgentAdoptionPercent: 100,
            weekdayUsageBreadth: 100,
          },
        ],
      ]);
      expect(calculateCoverageScore(metricsForDay)).toBe(20); // Max score (5 * 4)
    });
  });

  describe('calculateUserScore', () => {
    it('should return zeros when user has no activity', () => {
      const userMetricsByDate = new Map<string, Map<string, UserMetrics>>([
        [
          '2024-01-01',
          new Map([
            [
              'user1',
              {
                agentInteractionsPerDay: 0,
                autocompleteAcceptance: 0,
                cloudAgentSessions: 0,
                reviewerAgentRuns: 0,
                queriesPerHourWorked: 0,
                suggestionsAcceptedPercent: 0,
                multiAgentChains: 0,
                weeklyAIUsagePercent: 0,
                twoAgentAdoptionPercent: 0,
                fourAgentAdoptionPercent: 0,
                weekdayUsageBreadth: 0,
              },
            ],
          ]),
        ],
      ]);

      const scores = calculateUserScore('user1', userMetricsByDate);
      expect(scores.frequency).toBe(0);
      expect(scores.depth).toBe(0);
      expect(scores.coverage).toBe(0);
      expect(scores.total).toBe(0);
    });

    it('should average scores across multiple days with activity', () => {
      const userMetricsByDate = new Map<string, Map<string, UserMetrics>>([
        [
          '2024-01-01',
          new Map([
            [
              'user1',
              {
                agentInteractionsPerDay: 10, // Max threshold
                autocompleteAcceptance: 20, // Max threshold
                cloudAgentSessions: 1,
                reviewerAgentRuns: 1,
                queriesPerHourWorked: 1,
                suggestionsAcceptedPercent: 50,
                multiAgentChains: 1,
                weeklyAIUsagePercent: 100,
                twoAgentAdoptionPercent: 100,
                fourAgentAdoptionPercent: 100,
                weekdayUsageBreadth: 100,
              },
            ],
          ]),
        ],
        [
          '2024-01-02',
          new Map([
            [
              'user1',
              {
                agentInteractionsPerDay: 5, // Half threshold
                autocompleteAcceptance: 10, // Half threshold
                cloudAgentSessions: 0,
                reviewerAgentRuns: 0,
                queriesPerHourWorked: 0.5,
                suggestionsAcceptedPercent: 25,
                multiAgentChains: 0,
                weeklyAIUsagePercent: 50,
                twoAgentAdoptionPercent: 0,
                fourAgentAdoptionPercent: 0,
                weekdayUsageBreadth: 50,
              },
            ],
          ]),
        ],
      ]);

      const scores = calculateUserScore('user1', userMetricsByDate);

      // Day 1: frequency=40, depth=40, coverage=20 (total=100)
      // Day 2: frequency=10, depth=13.33, coverage=5 (total=28.33)
      // Average: frequency=25, depth=26.67, coverage=12.5 (total=64.17)
      expect(scores.frequency).toBeCloseTo(25, 0);
      expect(scores.depth).toBeCloseTo(26.7, 0);
      expect(scores.coverage).toBeCloseTo(12.5, 0);
      expect(scores.total).toBeCloseTo(64.2, 0);
    });

    it('should only count days with activity', () => {
      const userMetricsByDate = new Map<string, Map<string, UserMetrics>>([
        [
          '2024-01-01',
          new Map([
            [
              'user1',
              {
                agentInteractionsPerDay: 10,
                autocompleteAcceptance: 0,
                cloudAgentSessions: 0,
                reviewerAgentRuns: 0,
                queriesPerHourWorked: 1.25,
                suggestionsAcceptedPercent: 50,
                multiAgentChains: 0,
                weeklyAIUsagePercent: 100,
                twoAgentAdoptionPercent: 0,
                fourAgentAdoptionPercent: 0,
                weekdayUsageBreadth: 100,
              },
            ],
          ]),
        ],
        [
          '2024-01-02',
          new Map([
            [
              'user1',
              {
                agentInteractionsPerDay: 0, // No activity
                autocompleteAcceptance: 0,
                cloudAgentSessions: 0,
                reviewerAgentRuns: 0,
                queriesPerHourWorked: 0,
                suggestionsAcceptedPercent: 0,
                multiAgentChains: 0,
                weeklyAIUsagePercent: 0,
                twoAgentAdoptionPercent: 0,
                fourAgentAdoptionPercent: 0,
                weekdayUsageBreadth: 0,
              },
            ],
          ]),
        ],
      ]);

      const scores = calculateUserScore('user1', userMetricsByDate);

      // Should only average day 1, not day 2
      expect(scores.frequency).toBe(10);
      expect(scores.depth).toBeCloseTo(26.7, 0);
      expect(scores.coverage).toBe(10);
    });
  });

  describe('calculateWeeklyTrends', () => {
    it('should return null for empty data', () => {
      expect(calculateWeeklyTrends([])).toBeNull();
    });

    it('should return null for single data point', () => {
      const data = [{ frequency: 10, depth: 10, coverage: 5 }];
      expect(calculateWeeklyTrends(data)).toBeNull();
    });

    it('should calculate upward trend correctly', () => {
      const data = [
        { frequency: 10, depth: 10, coverage: 5 }, // total: 25
        { frequency: 20, depth: 20, coverage: 10 }, // total: 50
      ];

      const trends = calculateWeeklyTrends(data);
      expect(trends).not.toBeNull();
      expect(trends?.frequency.change).toBe(100); // 10 -> 20 is 100% increase
      expect(trends?.frequency.trend).toBe('up');
      expect(trends?.total.change).toBe(100); // 25 -> 50 is 100% increase
      expect(trends?.total.trend).toBe('up');
    });

    it('should calculate downward trend correctly', () => {
      const data = [
        { frequency: 20, depth: 20, coverage: 10 },
        { frequency: 10, depth: 10, coverage: 5 },
      ];

      const trends = calculateWeeklyTrends(data);
      expect(trends).not.toBeNull();
      expect(trends?.frequency.change).toBe(-50); // 20 -> 10 is 50% decrease
      expect(trends?.frequency.trend).toBe('down');
    });

    it('should calculate neutral trend for small changes', () => {
      const data = [
        { frequency: 10, depth: 10, coverage: 5 },
        { frequency: 10.05, depth: 10, coverage: 5 }, // 0.5% change
      ];

      const trends = calculateWeeklyTrends(data);
      expect(trends).not.toBeNull();
      expect(trends?.frequency.trend).toBe('neutral'); // < 1% change
    });

    it('should handle zero to non-zero transition', () => {
      const data = [
        { frequency: 0, depth: 0, coverage: 0 },
        { frequency: 10, depth: 10, coverage: 5 },
      ];

      const trends = calculateWeeklyTrends(data);
      expect(trends).not.toBeNull();
      expect(trends?.frequency.change).toBe(100); // 0 -> 10 is treated as 100%
      expect(trends?.frequency.trend).toBe('up');
    });
  });
});
