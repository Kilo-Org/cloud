import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { db } from '@/lib/drizzle';
import { slack_bot_requests, organizations } from '@kilocode/db/schema';
import { sql, desc, eq, and, gte, isNotNull } from 'drizzle-orm';

type OverviewStats = {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  successRate: number;
  avgResponseTimeMs: number;
  uniqueTeams: number;
  uniqueUsers: number;
  cloudAgentSessions: number;
  requestsLast24h: number;
  requestsLast7d: number;
  weeklyActiveUsers: number;
};

type DailyStats = {
  date: string;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  avgResponseTimeMs: number;
};

type UsageByOrg = {
  organizationId: string;
  organizationName: string;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  uniqueUsers: number;
  lastRequestAt: string;
};

type UsageByUser = {
  slackUserId: string;
  slackTeamId: string;
  slackTeamName: string | null;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  lastRequestAt: string;
};

type RequestLog = {
  id: string;
  createdAt: string;
  slackTeamId: string;
  slackTeamName: string | null;
  slackChannelId: string;
  slackUserId: string;
  eventType: string;
  userMessageTruncated: string | null;
  status: string;
  errorMessage: string | null;
  responseTimeMs: number | null;
  modelUsed: string | null;
  toolCallsMade: string[] | null;
  cloudAgentSessionId: string | null;
  organizationName: string | null;
};

type ErrorSummary = {
  errorMessage: string;
  count: number;
  lastOccurrence: string;
};

type SlackBotStatsResponse = {
  overview: OverviewStats;
  dailyStats: DailyStats[];
  usageByOrg: UsageByOrg[];
  usageByUser: UsageByUser[];
  recentRequests: RequestLog[];
  errorSummary: ErrorSummary[];
};

export async function GET(
  request: NextRequest
): Promise<NextResponse<{ error: string } | SlackBotStatsResponse>> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) {
    return authFailedResponse;
  }

  const searchParams = request.nextUrl.searchParams;
  const days = parseInt(searchParams.get('days') || '30', 10);
  const limit = parseInt(searchParams.get('limit') || '100', 10);

  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  // Helper function to safely convert BigInt to number
  const bigIntToNumber = (value: unknown): number => {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'bigint') return Number(value);
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
    return Number(value) || 0;
  };

  // Overview stats
  const overviewResult = await db
    .select({
      total_requests: sql<number>`COUNT(*)`,
      successful_requests: sql<number>`COUNT(CASE WHEN ${slack_bot_requests.status} = 'success' THEN 1 END)`,
      failed_requests: sql<number>`COUNT(CASE WHEN ${slack_bot_requests.status} = 'error' THEN 1 END)`,
      avg_response_time_ms: sql<number>`AVG(${slack_bot_requests.response_time_ms})`,
      unique_teams: sql<number>`COUNT(DISTINCT ${slack_bot_requests.slack_team_id})`,
      unique_users: sql<number>`COUNT(DISTINCT ${slack_bot_requests.slack_user_id})`,
      cloud_agent_sessions: sql<number>`COUNT(CASE WHEN ${slack_bot_requests.cloud_agent_session_id} IS NOT NULL THEN 1 END)`,
    })
    .from(slack_bot_requests);

  const overviewStats = overviewResult[0];

  // Requests in last 24h
  const last24hResult = await db
    .select({
      count: sql<number>`COUNT(*)`,
    })
    .from(slack_bot_requests)
    .where(sql`${slack_bot_requests.created_at} >= NOW() - INTERVAL '24 hours'`);

  // Requests in last 7 days
  const last7dResult = await db
    .select({
      count: sql<number>`COUNT(*)`,
    })
    .from(slack_bot_requests)
    .where(sql`${slack_bot_requests.created_at} >= NOW() - INTERVAL '7 days'`);

  // Weekly Active Users (WAU) - rolling 7-day window
  const wauResult = await db
    .select({
      count: sql<number>`COUNT(DISTINCT ${slack_bot_requests.slack_user_id})`,
    })
    .from(slack_bot_requests)
    .where(sql`${slack_bot_requests.created_at} >= NOW() - INTERVAL '7 days'`);

  const totalRequests = bigIntToNumber(overviewStats.total_requests);
  const successfulRequests = bigIntToNumber(overviewStats.successful_requests);

  const overview: OverviewStats = {
    totalRequests,
    successfulRequests,
    failedRequests: bigIntToNumber(overviewStats.failed_requests),
    successRate:
      totalRequests > 0 ? Math.round((successfulRequests / totalRequests) * 10000) / 100 : 0,
    avgResponseTimeMs: Math.round(bigIntToNumber(overviewStats.avg_response_time_ms)),
    uniqueTeams: bigIntToNumber(overviewStats.unique_teams),
    uniqueUsers: bigIntToNumber(overviewStats.unique_users),
    cloudAgentSessions: bigIntToNumber(overviewStats.cloud_agent_sessions),
    requestsLast24h: bigIntToNumber(last24hResult[0]?.count),
    requestsLast7d: bigIntToNumber(last7dResult[0]?.count),
    weeklyActiveUsers: bigIntToNumber(wauResult[0]?.count),
  };

  // Daily stats for the chart
  const dailyStatsResult = await db
    .select({
      date: sql<string>`DATE(${slack_bot_requests.created_at})`,
      total_requests: sql<number>`COUNT(*)`,
      successful_requests: sql<number>`COUNT(CASE WHEN ${slack_bot_requests.status} = 'success' THEN 1 END)`,
      failed_requests: sql<number>`COUNT(CASE WHEN ${slack_bot_requests.status} = 'error' THEN 1 END)`,
      avg_response_time_ms: sql<number>`AVG(${slack_bot_requests.response_time_ms})`,
    })
    .from(slack_bot_requests)
    .where(gte(slack_bot_requests.created_at, startDate.toISOString()))
    .groupBy(sql`DATE(${slack_bot_requests.created_at})`)
    .orderBy(sql`DATE(${slack_bot_requests.created_at})`);

  const dailyStats: DailyStats[] = dailyStatsResult.map(row => ({
    date: String(row.date),
    totalRequests: bigIntToNumber(row.total_requests),
    successfulRequests: bigIntToNumber(row.successful_requests),
    failedRequests: bigIntToNumber(row.failed_requests),
    avgResponseTimeMs: Math.round(bigIntToNumber(row.avg_response_time_ms)),
  }));

  // Usage by organization
  const usageByOrgResult = await db
    .select({
      organization_id: slack_bot_requests.owned_by_organization_id,
      organization_name: organizations.name,
      total_requests: sql<number>`COUNT(*)`,
      successful_requests: sql<number>`COUNT(CASE WHEN ${slack_bot_requests.status} = 'success' THEN 1 END)`,
      failed_requests: sql<number>`COUNT(CASE WHEN ${slack_bot_requests.status} = 'error' THEN 1 END)`,
      unique_users: sql<number>`COUNT(DISTINCT ${slack_bot_requests.slack_user_id})`,
      last_request_at: sql<string>`MAX(${slack_bot_requests.created_at})`,
    })
    .from(slack_bot_requests)
    .leftJoin(organizations, eq(slack_bot_requests.owned_by_organization_id, organizations.id))
    .where(isNotNull(slack_bot_requests.owned_by_organization_id))
    .groupBy(slack_bot_requests.owned_by_organization_id, organizations.name)
    .orderBy(desc(sql`COUNT(*)`))
    .limit(50);

  const usageByOrg: UsageByOrg[] = usageByOrgResult.map(row => ({
    organizationId: row.organization_id || '',
    organizationName: row.organization_name || 'Unknown',
    totalRequests: bigIntToNumber(row.total_requests),
    successfulRequests: bigIntToNumber(row.successful_requests),
    failedRequests: bigIntToNumber(row.failed_requests),
    uniqueUsers: bigIntToNumber(row.unique_users),
    lastRequestAt: row.last_request_at || '',
  }));

  // Usage by Slack user
  const usageByUserResult = await db
    .select({
      slack_user_id: slack_bot_requests.slack_user_id,
      slack_team_id: slack_bot_requests.slack_team_id,
      slack_team_name: slack_bot_requests.slack_team_name,
      total_requests: sql<number>`COUNT(*)`,
      successful_requests: sql<number>`COUNT(CASE WHEN ${slack_bot_requests.status} = 'success' THEN 1 END)`,
      failed_requests: sql<number>`COUNT(CASE WHEN ${slack_bot_requests.status} = 'error' THEN 1 END)`,
      last_request_at: sql<string>`MAX(${slack_bot_requests.created_at})`,
    })
    .from(slack_bot_requests)
    .groupBy(
      slack_bot_requests.slack_user_id,
      slack_bot_requests.slack_team_id,
      slack_bot_requests.slack_team_name
    )
    .orderBy(desc(sql`COUNT(*)`))
    .limit(50);

  const usageByUser: UsageByUser[] = usageByUserResult.map(row => ({
    slackUserId: row.slack_user_id,
    slackTeamId: row.slack_team_id,
    slackTeamName: row.slack_team_name,
    totalRequests: bigIntToNumber(row.total_requests),
    successfulRequests: bigIntToNumber(row.successful_requests),
    failedRequests: bigIntToNumber(row.failed_requests),
    lastRequestAt: row.last_request_at || '',
  }));

  // Recent requests (logs)
  const recentRequestsResult = await db
    .select({
      id: slack_bot_requests.id,
      created_at: slack_bot_requests.created_at,
      slack_team_id: slack_bot_requests.slack_team_id,
      slack_team_name: slack_bot_requests.slack_team_name,
      slack_channel_id: slack_bot_requests.slack_channel_id,
      slack_user_id: slack_bot_requests.slack_user_id,
      event_type: slack_bot_requests.event_type,
      user_message_truncated: slack_bot_requests.user_message_truncated,
      status: slack_bot_requests.status,
      error_message: slack_bot_requests.error_message,
      response_time_ms: slack_bot_requests.response_time_ms,
      model_used: slack_bot_requests.model_used,
      tool_calls_made: slack_bot_requests.tool_calls_made,
      cloud_agent_session_id: slack_bot_requests.cloud_agent_session_id,
      organization_name: organizations.name,
    })
    .from(slack_bot_requests)
    .leftJoin(organizations, eq(slack_bot_requests.owned_by_organization_id, organizations.id))
    .orderBy(desc(slack_bot_requests.created_at))
    .limit(limit);

  const recentRequests: RequestLog[] = recentRequestsResult.map(row => ({
    id: row.id,
    createdAt: row.created_at,
    slackTeamId: row.slack_team_id,
    slackTeamName: row.slack_team_name,
    slackChannelId: row.slack_channel_id,
    slackUserId: row.slack_user_id,
    eventType: row.event_type,
    userMessageTruncated: row.user_message_truncated,
    status: row.status,
    errorMessage: row.error_message,
    responseTimeMs: row.response_time_ms,
    modelUsed: row.model_used,
    toolCallsMade: row.tool_calls_made,
    cloudAgentSessionId: row.cloud_agent_session_id,
    organizationName: row.organization_name,
  }));

  // Error summary
  const errorSummaryResult = await db
    .select({
      error_message: slack_bot_requests.error_message,
      count: sql<number>`COUNT(*)`,
      last_occurrence: sql<string>`MAX(${slack_bot_requests.created_at})`,
    })
    .from(slack_bot_requests)
    .where(and(eq(slack_bot_requests.status, 'error'), isNotNull(slack_bot_requests.error_message)))
    .groupBy(slack_bot_requests.error_message)
    .orderBy(desc(sql`COUNT(*)`))
    .limit(20);

  const errorSummary: ErrorSummary[] = errorSummaryResult.map(row => ({
    errorMessage: row.error_message || 'Unknown error',
    count: bigIntToNumber(row.count),
    lastOccurrence: row.last_occurrence || '',
  }));

  return NextResponse.json({
    overview,
    dailyStats,
    usageByOrg,
    usageByUser,
    recentRequests,
    errorSummary,
  });
}
