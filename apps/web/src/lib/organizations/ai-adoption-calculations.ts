export const MAX_FREQUENCY_SCORE = 40;
export const MAX_DEPTH_SCORE = 40;
export const MAX_COVERAGE_SCORE = 20;
export const MAX_TOTAL_SCORE = 100;

export const FREQUENCY_POINTS_PER_COMPONENT = 10;
export const DEPTH_POINTS_PER_COMPONENT = 13.33; // 3 components × 13.33 ≈ 40
export const COVERAGE_POINTS_PER_COMPONENT = 5;

export const COVERAGE_LOOKBACK_DAYS = 7;
export const DAYS_IN_WEEK = 7;
export const MIN_AGENT_TYPES_FOR_TWO_PLUS = 2;
export const MIN_AGENT_TYPES_FOR_FOUR_PLUS = 4;

export const STANDARD_WORKDAY_HOURS = 8;
export const MOCK_SUGGESTIONS_ACCEPTED_PERCENT = 70;

export const MIN_DATA_POINTS_FOR_TRENDS = 2;
export const TREND_NEUTRAL_THRESHOLD_PERCENT = 1;

export const SCORE_DECIMAL_PLACES = 1;
export const SCORE_ROUNDING_MULTIPLIER = 10;

export const AI_ADOPTION_THRESHOLDS = {
  frequency: {
    agentInteractionsPerDay: 10,
    autocompleteAcceptance: 20,
    cloudAgentSessions: 1,
    reviewerAgentRuns: 1,
  },
  depth: {
    queriesPerHourWorked: 1,
    suggestionsAcceptedPercent: 50,
    multiAgentChains: 1,
  },
  coverage: {
    weeklyAIUsagePercent: 100,
    twoAgentAdoptionPercent: 100,
    fourAgentAdoptionPercent: 100,
    weekdayUsageBreadth: 100,
  },
} as const;

export type UserMetrics = {
  agentInteractionsPerDay: number;
  autocompleteAcceptance: number;
  cloudAgentSessions: number;
  reviewerAgentRuns: number;
  queriesPerHourWorked: number;
  suggestionsAcceptedPercent: number;
  multiAgentChains: number;
  weeklyAIUsagePercent: number;
  twoAgentAdoptionPercent: number;
  fourAgentAdoptionPercent: number;
  weekdayUsageBreadth: number;
};

export type DailyActivityData = {
  agentInteractions: Map<string, Map<string, number>>; // date -> userId -> count
  autocomplete: Map<string, Map<string, number>>; // date -> userId -> accepted suggestions count
  cloudAgentSessions: Map<string, Map<string, number>>;
  codeReviews: Map<string, Map<string, number>>;
};

export type MemberInfo = {
  userId: string;
  email: string;
};

export function normalizeComponentScore(
  rawValue: number,
  threshold: number,
  pointsPerComponent: number
): number {
  return Math.min(1, rawValue / threshold) * pointsPerComponent;
}

export function hasActivity(userMetrics: UserMetrics): boolean {
  return (
    userMetrics.agentInteractionsPerDay > 0 ||
    userMetrics.autocompleteAcceptance > 0 ||
    userMetrics.cloudAgentSessions > 0 ||
    userMetrics.reviewerAgentRuns > 0
  );
}

export function buildActivityDataMaps(
  agentInteractionsData: Array<{ userId: string; date: string; requestCount: number }>,
  autocompleteData: Array<{ userId: string; date: string; acceptedCount: number }>,
  cloudAgentSessionsData: Array<{ userId: string; date: string; sessionCount: number }>,
  codeReviewsData: Array<{ userId: string | null; date: string; reviewCount: number }>
): DailyActivityData {
  const activityData: DailyActivityData = {
    agentInteractions: new Map(),
    autocomplete: new Map(),
    cloudAgentSessions: new Map(),
    codeReviews: new Map(),
  };

  agentInteractionsData.forEach(row => {
    if (!activityData.agentInteractions.has(row.date)) {
      activityData.agentInteractions.set(row.date, new Map());
    }
    const dateMap = activityData.agentInteractions.get(row.date);
    if (dateMap) {
      dateMap.set(row.userId, row.requestCount);
    }
  });

  autocompleteData.forEach(row => {
    if (!activityData.autocomplete.has(row.date)) {
      activityData.autocomplete.set(row.date, new Map());
    }
    const dateMap = activityData.autocomplete.get(row.date);
    if (dateMap) {
      dateMap.set(row.userId, row.acceptedCount);
    }
  });

  cloudAgentSessionsData.forEach(row => {
    if (!activityData.cloudAgentSessions.has(row.date)) {
      activityData.cloudAgentSessions.set(row.date, new Map());
    }
    const dateMap = activityData.cloudAgentSessions.get(row.date);
    if (dateMap) {
      dateMap.set(row.userId, row.sessionCount);
    }
  });

  codeReviewsData.forEach(row => {
    if (row.userId) {
      if (!activityData.codeReviews.has(row.date)) {
        activityData.codeReviews.set(row.date, new Map());
      }
      const dateMap = activityData.codeReviews.get(row.date);
      if (dateMap) {
        dateMap.set(row.userId, row.reviewCount);
      }
    }
  });

  return activityData;
}

export function calculateUserMetricsForDate(
  member: MemberInfo,
  dateStr: string,
  currentDate: Date,
  activityData: DailyActivityData
): UserMetrics {
  const agentInteractionsForDay =
    activityData.agentInteractions.get(dateStr)?.get(member.userId) || 0;
  const autocompleteAcceptedCountForDay =
    activityData.autocomplete.get(dateStr)?.get(member.userId) || 0;
  const cloudAgentSessionsForDay =
    activityData.cloudAgentSessions.get(dateStr)?.get(member.userId) || 0;
  const codeReviewsForDay = activityData.codeReviews.get(dateStr)?.get(member.userId) || 0;

  // Autocomplete is excluded from queries-per-hour because it is a rate, not a count.
  const queriesPerHourWorked = agentInteractionsForDay / STANDARD_WORKDAY_HOURS;

  const suggestionsAcceptedPercent = MOCK_SUGGESTIONS_ACCEPTED_PERCENT;

  const multiAgentChains =
    agentInteractionsForDay > 0 && cloudAgentSessionsForDay > 0 && codeReviewsForDay > 0
      ? Math.min(agentInteractionsForDay, cloudAgentSessionsForDay, codeReviewsForDay)
      : 0;

  let daysWithActivity = 0;
  const agentTypesUsed = new Set<string>();
  const weekdayActivity = new Set<number>(); // 0-6 for days of week

  for (let i = 0; i < COVERAGE_LOOKBACK_DAYS; i++) {
    const checkDate = new Date(currentDate);
    checkDate.setDate(checkDate.getDate() - i);
    const checkDateStr = checkDate.toISOString().split('T')[0];

    const hasAgentInteractions =
      (activityData.agentInteractions.get(checkDateStr)?.get(member.userId) || 0) > 0;
    const hasAutocomplete =
      (activityData.autocomplete.get(checkDateStr)?.get(member.userId) || 0) > 0;
    const hasCloudAgent =
      (activityData.cloudAgentSessions.get(checkDateStr)?.get(member.userId) || 0) > 0;
    const hasCodeReview = (activityData.codeReviews.get(checkDateStr)?.get(member.userId) || 0) > 0;

    const hasAnyActivity =
      hasAgentInteractions || hasAutocomplete || hasCloudAgent || hasCodeReview;

    if (hasAnyActivity) {
      daysWithActivity++;
      weekdayActivity.add(checkDate.getDay());
    }

    if (hasAgentInteractions) agentTypesUsed.add('agent');
    if (hasAutocomplete) agentTypesUsed.add('autocomplete');
    if (hasCloudAgent) agentTypesUsed.add('cloud');
    if (hasCodeReview) agentTypesUsed.add('review');
  }

  const weeklyAIUsagePercent = (daysWithActivity / COVERAGE_LOOKBACK_DAYS) * 100;

  const twoAgentAdoptionPercent = agentTypesUsed.size >= MIN_AGENT_TYPES_FOR_TWO_PLUS ? 100 : 0;

  const fourAgentAdoptionPercent = agentTypesUsed.size >= MIN_AGENT_TYPES_FOR_FOUR_PLUS ? 100 : 0;

  const weekdayUsageBreadth = (weekdayActivity.size / DAYS_IN_WEEK) * 100;

  return {
    agentInteractionsPerDay: agentInteractionsForDay,
    autocompleteAcceptance: autocompleteAcceptedCountForDay,
    cloudAgentSessions: cloudAgentSessionsForDay,
    reviewerAgentRuns: codeReviewsForDay,

    queriesPerHourWorked,
    suggestionsAcceptedPercent,
    multiAgentChains,

    weeklyAIUsagePercent,
    twoAgentAdoptionPercent,
    fourAgentAdoptionPercent,
    weekdayUsageBreadth,
  };
}

export function calculateMetricScore(
  metricsForDay: Map<string, UserMetrics>,
  getUserValue: (metrics: UserMetrics) => number,
  threshold: number,
  pointsPerComponent: number
): number {
  if (metricsForDay.size === 0) return 0;

  const normalizedScores = Array.from(metricsForDay.values())
    .filter(hasActivity)
    .map(userMetrics => {
      const rawValue = getUserValue(userMetrics);
      return normalizeComponentScore(rawValue, threshold, pointsPerComponent);
    });

  if (normalizedScores.length === 0) return 0;

  const avgScore =
    normalizedScores.reduce((sum, score) => sum + score, 0) / normalizedScores.length;
  return avgScore;
}

export function calculateFrequencyScore(metricsForDay: Map<string, UserMetrics>): number {
  return Math.min(
    MAX_FREQUENCY_SCORE,
    calculateMetricScore(
      metricsForDay,
      m => m.agentInteractionsPerDay,
      AI_ADOPTION_THRESHOLDS.frequency.agentInteractionsPerDay,
      FREQUENCY_POINTS_PER_COMPONENT
    ) +
      calculateMetricScore(
        metricsForDay,
        m => m.autocompleteAcceptance,
        AI_ADOPTION_THRESHOLDS.frequency.autocompleteAcceptance,
        FREQUENCY_POINTS_PER_COMPONENT
      ) +
      calculateMetricScore(
        metricsForDay,
        m => m.cloudAgentSessions,
        AI_ADOPTION_THRESHOLDS.frequency.cloudAgentSessions,
        FREQUENCY_POINTS_PER_COMPONENT
      ) +
      calculateMetricScore(
        metricsForDay,
        m => m.reviewerAgentRuns,
        AI_ADOPTION_THRESHOLDS.frequency.reviewerAgentRuns,
        FREQUENCY_POINTS_PER_COMPONENT
      )
  );
}

export function calculateDepthScore(metricsForDay: Map<string, UserMetrics>): number {
  return Math.min(
    MAX_DEPTH_SCORE,
    calculateMetricScore(
      metricsForDay,
      m => m.queriesPerHourWorked,
      AI_ADOPTION_THRESHOLDS.depth.queriesPerHourWorked,
      DEPTH_POINTS_PER_COMPONENT
    ) +
      calculateMetricScore(
        metricsForDay,
        m => m.suggestionsAcceptedPercent,
        AI_ADOPTION_THRESHOLDS.depth.suggestionsAcceptedPercent,
        DEPTH_POINTS_PER_COMPONENT
      ) +
      calculateMetricScore(
        metricsForDay,
        m => m.multiAgentChains,
        AI_ADOPTION_THRESHOLDS.depth.multiAgentChains,
        DEPTH_POINTS_PER_COMPONENT
      )
  );
}

export function calculateCoverageScore(metricsForDay: Map<string, UserMetrics>): number {
  return Math.min(
    MAX_COVERAGE_SCORE,
    calculateMetricScore(
      metricsForDay,
      m => m.weeklyAIUsagePercent,
      AI_ADOPTION_THRESHOLDS.coverage.weeklyAIUsagePercent,
      COVERAGE_POINTS_PER_COMPONENT
    ) +
      calculateMetricScore(
        metricsForDay,
        m => m.twoAgentAdoptionPercent,
        AI_ADOPTION_THRESHOLDS.coverage.twoAgentAdoptionPercent,
        COVERAGE_POINTS_PER_COMPONENT
      ) +
      calculateMetricScore(
        metricsForDay,
        m => m.fourAgentAdoptionPercent,
        AI_ADOPTION_THRESHOLDS.coverage.fourAgentAdoptionPercent,
        COVERAGE_POINTS_PER_COMPONENT
      ) +
      calculateMetricScore(
        metricsForDay,
        m => m.weekdayUsageBreadth,
        AI_ADOPTION_THRESHOLDS.coverage.weekdayUsageBreadth,
        COVERAGE_POINTS_PER_COMPONENT
      )
  );
}

export function generateDailyTimeseries(
  startDate: string,
  endDate: string,
  members: MemberInfo[],
  activityData: DailyActivityData
): {
  timeseries: Array<{
    datetime: string;
    frequency: number;
    depth: number;
    coverage: number;
  }>;
  userMetricsByDate: Map<string, Map<string, UserMetrics>>;
} {
  const userMetricsByDate = new Map<string, Map<string, UserMetrics>>();
  const start = new Date(startDate);
  const end = new Date(endDate);
  const timeseries = [];
  const currentDate = new Date(start);

  while (currentDate <= end) {
    const timestamp = currentDate.toISOString();
    const dateStr = currentDate.toISOString().split('T')[0];

    if (!userMetricsByDate.has(dateStr)) {
      const metricsForDate = new Map<string, UserMetrics>();
      members.forEach(member => {
        const metrics = calculateUserMetricsForDate(member, dateStr, currentDate, activityData);
        metricsForDate.set(member.userId, metrics);
      });
      userMetricsByDate.set(dateStr, metricsForDate);
    }

    const metricsForDay = userMetricsByDate.get(dateStr);
    if (!metricsForDay) {
      currentDate.setDate(currentDate.getDate() + 1);
      continue;
    }

    const frequency = calculateFrequencyScore(metricsForDay);
    const depth = calculateDepthScore(metricsForDay);
    const coverage = calculateCoverageScore(metricsForDay);

    timeseries.push({
      datetime: timestamp,
      frequency: Math.round(frequency * SCORE_ROUNDING_MULTIPLIER) / SCORE_ROUNDING_MULTIPLIER,
      depth: Math.round(depth * SCORE_ROUNDING_MULTIPLIER) / SCORE_ROUNDING_MULTIPLIER,
      coverage: Math.round(coverage * SCORE_ROUNDING_MULTIPLIER) / SCORE_ROUNDING_MULTIPLIER,
    });

    currentDate.setDate(currentDate.getDate() + 1);
  }

  return { timeseries, userMetricsByDate };
}

export function calculateUserScore(
  userId: string,
  userMetricsByDate: Map<string, Map<string, UserMetrics>>
): {
  frequency: number;
  depth: number;
  coverage: number;
  total: number;
} {
  let frequencySum = 0;
  let depthSum = 0;
  let coverageSum = 0;
  let daysWithActivity = 0;

  userMetricsByDate.forEach(metricsForDay => {
    const metrics = metricsForDay.get(userId);
    if (!metrics || !hasActivity(metrics)) return;

    const dayFrequency = Math.min(
      MAX_FREQUENCY_SCORE,
      normalizeComponentScore(
        metrics.agentInteractionsPerDay,
        AI_ADOPTION_THRESHOLDS.frequency.agentInteractionsPerDay,
        FREQUENCY_POINTS_PER_COMPONENT
      ) +
        normalizeComponentScore(
          metrics.autocompleteAcceptance,
          AI_ADOPTION_THRESHOLDS.frequency.autocompleteAcceptance,
          FREQUENCY_POINTS_PER_COMPONENT
        ) +
        normalizeComponentScore(
          metrics.cloudAgentSessions,
          AI_ADOPTION_THRESHOLDS.frequency.cloudAgentSessions,
          FREQUENCY_POINTS_PER_COMPONENT
        ) +
        normalizeComponentScore(
          metrics.reviewerAgentRuns,
          AI_ADOPTION_THRESHOLDS.frequency.reviewerAgentRuns,
          FREQUENCY_POINTS_PER_COMPONENT
        )
    );

    const dayDepth = Math.min(
      MAX_DEPTH_SCORE,
      normalizeComponentScore(
        metrics.queriesPerHourWorked,
        AI_ADOPTION_THRESHOLDS.depth.queriesPerHourWorked,
        DEPTH_POINTS_PER_COMPONENT
      ) +
        normalizeComponentScore(
          metrics.suggestionsAcceptedPercent,
          AI_ADOPTION_THRESHOLDS.depth.suggestionsAcceptedPercent,
          DEPTH_POINTS_PER_COMPONENT
        ) +
        normalizeComponentScore(
          metrics.multiAgentChains,
          AI_ADOPTION_THRESHOLDS.depth.multiAgentChains,
          DEPTH_POINTS_PER_COMPONENT
        )
    );

    const dayCoverage = Math.min(
      MAX_COVERAGE_SCORE,
      normalizeComponentScore(
        metrics.weeklyAIUsagePercent,
        AI_ADOPTION_THRESHOLDS.coverage.weeklyAIUsagePercent,
        COVERAGE_POINTS_PER_COMPONENT
      ) +
        normalizeComponentScore(
          metrics.twoAgentAdoptionPercent,
          AI_ADOPTION_THRESHOLDS.coverage.twoAgentAdoptionPercent,
          COVERAGE_POINTS_PER_COMPONENT
        ) +
        normalizeComponentScore(
          metrics.fourAgentAdoptionPercent,
          AI_ADOPTION_THRESHOLDS.coverage.fourAgentAdoptionPercent,
          COVERAGE_POINTS_PER_COMPONENT
        ) +
        normalizeComponentScore(
          metrics.weekdayUsageBreadth,
          AI_ADOPTION_THRESHOLDS.coverage.weekdayUsageBreadth,
          COVERAGE_POINTS_PER_COMPONENT
        )
    );

    frequencySum += dayFrequency;
    depthSum += dayDepth;
    coverageSum += dayCoverage;
    daysWithActivity++;
  });

  if (daysWithActivity === 0) {
    return { frequency: 0, depth: 0, coverage: 0, total: 0 };
  }

  const avgFrequency = frequencySum / daysWithActivity;
  const avgDepth = depthSum / daysWithActivity;
  const avgCoverage = coverageSum / daysWithActivity;

  return {
    frequency: Math.round(avgFrequency * SCORE_ROUNDING_MULTIPLIER) / SCORE_ROUNDING_MULTIPLIER,
    depth: Math.round(avgDepth * SCORE_ROUNDING_MULTIPLIER) / SCORE_ROUNDING_MULTIPLIER,
    coverage: Math.round(avgCoverage * SCORE_ROUNDING_MULTIPLIER) / SCORE_ROUNDING_MULTIPLIER,
    total:
      Math.round((avgFrequency + avgDepth + avgCoverage) * SCORE_ROUNDING_MULTIPLIER) /
      SCORE_ROUNDING_MULTIPLIER,
  };
}

export function calculateWeeklyTrends(
  data: Array<{ frequency: number; depth: number; coverage: number }>
) {
  if (data.length < MIN_DATA_POINTS_FOR_TRENDS) return null;

  const firstDay = data[0];
  const lastDay = data[data.length - 1];

  const calculateChange = (current: number, previous: number) => {
    if (previous === 0) return current > 0 ? 100 : 0;
    return ((current - previous) / previous) * 100;
  };

  const getTrend = (change: number): 'up' | 'down' | 'neutral' => {
    if (Math.abs(change) < TREND_NEUTRAL_THRESHOLD_PERCENT) return 'neutral';
    return change > 0 ? 'up' : 'down';
  };

  const firstTotal = firstDay.frequency + firstDay.depth + firstDay.coverage;
  const lastTotal = lastDay.frequency + lastDay.depth + lastDay.coverage;

  const frequencyChange = calculateChange(lastDay.frequency, firstDay.frequency);
  const depthChange = calculateChange(lastDay.depth, firstDay.depth);
  const coverageChange = calculateChange(lastDay.coverage, firstDay.coverage);
  const totalChange = calculateChange(lastTotal, firstTotal);

  return {
    frequency: {
      change: frequencyChange,
      trend: getTrend(frequencyChange),
    },
    depth: {
      change: depthChange,
      trend: getTrend(depthChange),
    },
    coverage: {
      change: coverageChange,
      trend: getTrend(coverageChange),
    },
    total: {
      change: totalChange,
      trend: getTrend(totalChange),
    },
  };
}
