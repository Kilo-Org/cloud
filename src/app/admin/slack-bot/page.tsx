'use client';

import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { format, parseISO } from 'date-fns';
import AdminPage from '../components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';
import { Badge } from '@/components/ui/badge';

const breadcrumbs = (
  <>
    <BreadcrumbItem>
      <BreadcrumbPage>Slack Bot</BreadcrumbPage>
    </BreadcrumbItem>
  </>
);

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

function OverviewStatsCards({ data }: { data: OverviewStats }) {
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Total Requests</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{data.totalRequests.toLocaleString()}</div>
          <p className="text-muted-foreground text-xs">
            {data.requestsLast24h} last 24h • {data.requestsLast7d} last 7d
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Success Rate</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{data.successRate}%</div>
          <p className="text-muted-foreground text-xs">
            {data.successfulRequests} success • {data.failedRequests} failed
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Avg Response Time</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{data.avgResponseTimeMs.toLocaleString()}ms</div>
          <p className="text-muted-foreground text-xs">Average across all requests</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Weekly Active Users</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{data.weeklyActiveUsers.toLocaleString()}</div>
          <p className="text-muted-foreground text-xs">Rolling 7-day window</p>
        </CardContent>
      </Card>
    </div>
  );
}

function DailyChart({ data }: { data: DailyStats[] }) {
  type ChartDataPoint = {
    date: string;
    totalRequests: number;
    successfulRequests: number;
    failedRequests: number;
    avgResponseTimeMs: number;
  };

  const chartData: ChartDataPoint[] = data.map(item => ({
    date: format(parseISO(item.date), 'MM/dd'),
    totalRequests: item.totalRequests,
    successfulRequests: item.successfulRequests,
    failedRequests: item.failedRequests,
    avgResponseTimeMs: item.avgResponseTimeMs,
  }));

  type TooltipPayload = {
    dataKey: string;
    value: number;
  };

  type CustomTooltipProps = {
    active?: boolean;
    payload?: TooltipPayload[];
    label?: string;
  };

  const CustomTooltip = ({ active, payload, label }: CustomTooltipProps) => {
    if (active && payload && payload.length) {
      const total = payload.find(p => p.dataKey === 'successfulRequests')?.value || 0;
      const failed = payload.find(p => p.dataKey === 'failedRequests')?.value || 0;
      const avgTime = payload.find(p => p.dataKey === 'avgResponseTimeMs')?.value || 0;

      return (
        <div className="bg-background rounded-lg border p-3 shadow-sm">
          <p className="text-sm font-medium">{label}</p>
          <div className="mt-2 space-y-1">
            <p className="text-sm">
              <span className="text-muted-foreground">Successful:</span>{' '}
              <span className="font-medium">{total}</span>
            </p>
            <p className="text-sm">
              <span className="text-muted-foreground">Failed:</span>{' '}
              <span className="font-medium">{failed}</span>
            </p>
            <p className="text-sm">
              <span className="text-muted-foreground">Avg Response:</span>{' '}
              <span className="font-medium">{avgTime}ms</span>
            </p>
          </div>
        </div>
      );
    }
    return null;
  };

  const maxRequests = Math.max(...chartData.map(d => d.successfulRequests + d.failedRequests));
  const maxResponseTime = Math.max(...chartData.map(d => d.avgResponseTimeMs));
  const yAxisMaxRequests = Math.ceil(maxRequests * 1.1) || 10;
  const yAxisMaxResponseTime = Math.ceil(maxResponseTime * 1.2) || 1000;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Daily Requests</CardTitle>
        <CardDescription>Request volume and response times over the last 30 days</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-[300px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 60 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis
                dataKey="date"
                angle={-45}
                textAnchor="end"
                height={60}
                className="text-xs"
                tick={{ fontSize: 10 }}
              />
              <YAxis
                yAxisId="left"
                orientation="left"
                className="text-xs"
                tick={{ fontSize: 10 }}
                label={{
                  value: 'Requests',
                  angle: -90,
                  position: 'insideLeft',
                  style: { fontSize: 12 },
                }}
                domain={[0, yAxisMaxRequests]}
              />
              <YAxis
                yAxisId="right"
                orientation="right"
                className="text-xs"
                tick={{ fontSize: 10 }}
                label={{
                  value: 'Response Time (ms)',
                  angle: 90,
                  position: 'insideRight',
                  style: { fontSize: 12 },
                }}
                domain={[0, yAxisMaxResponseTime]}
              />
              <Tooltip content={<CustomTooltip />} />
              <Bar
                yAxisId="left"
                dataKey="successfulRequests"
                stackId="requests"
                fill="#16a34a"
                name="Successful"
              />
              <Bar
                yAxisId="left"
                dataKey="failedRequests"
                stackId="requests"
                fill="#dc2626"
                name="Failed"
              />
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="avgResponseTimeMs"
                stroke="#2563eb"
                strokeWidth={2}
                dot={{ r: 2 }}
                name="Avg Response Time"
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-6 text-sm">
          <div className="flex items-center gap-2">
            <div className="h-3 w-3 bg-green-600" />
            <span className="text-muted-foreground">Successful Requests</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="h-3 w-3 bg-red-600" />
            <span className="text-muted-foreground">Failed Requests</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="h-3 w-3 bg-blue-600" />
            <span className="text-muted-foreground">Avg Response Time</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function UsageByOrgTable({ data }: { data: UsageByOrg[] }) {
  if (data.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Usage by Organization</CardTitle>
          <CardDescription>No organization usage data available</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Usage by Organization</CardTitle>
        <CardDescription>Top organizations by request volume</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Organization</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead className="text-right">Success</TableHead>
              <TableHead className="text-right">Failed</TableHead>
              <TableHead className="text-right">Users</TableHead>
              <TableHead>Last Request</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map(org => (
              <TableRow key={org.organizationId}>
                <TableCell className="font-medium">{org.organizationName}</TableCell>
                <TableCell className="text-right">{org.totalRequests}</TableCell>
                <TableCell className="text-right">{org.successfulRequests}</TableCell>
                <TableCell className="text-right">{org.failedRequests}</TableCell>
                <TableCell className="text-right">{org.uniqueUsers}</TableCell>
                <TableCell>
                  {org.lastRequestAt ? format(parseISO(org.lastRequestAt), 'MMM d, HH:mm') : '-'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function UsageByUserTable({ data }: { data: UsageByUser[] }) {
  if (data.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Usage by Slack User</CardTitle>
          <CardDescription>No user usage data available</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Usage by Slack User</CardTitle>
        <CardDescription>Top Slack users by request volume</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Slack User ID</TableHead>
              <TableHead>Team</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead className="text-right">Success</TableHead>
              <TableHead className="text-right">Failed</TableHead>
              <TableHead>Last Request</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map(user => (
              <TableRow key={`${user.slackTeamId}-${user.slackUserId}`}>
                <TableCell className="font-mono text-sm">{user.slackUserId}</TableCell>
                <TableCell>{user.slackTeamName || user.slackTeamId}</TableCell>
                <TableCell className="text-right">{user.totalRequests}</TableCell>
                <TableCell className="text-right">{user.successfulRequests}</TableCell>
                <TableCell className="text-right">{user.failedRequests}</TableCell>
                <TableCell>
                  {user.lastRequestAt ? format(parseISO(user.lastRequestAt), 'MMM d, HH:mm') : '-'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function RequestLogsTable({ data }: { data: RequestLog[] }) {
  if (data.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Recent Requests</CardTitle>
          <CardDescription>No request logs available</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent Requests</CardTitle>
        <CardDescription>Latest Slack bot requests (most recent first)</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Team</TableHead>
                <TableHead>User</TableHead>
                <TableHead>Event</TableHead>
                <TableHead>Message</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Response</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Tools</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map(log => (
                <TableRow key={log.id}>
                  <TableCell className="whitespace-nowrap">
                    {format(parseISO(log.createdAt), 'MMM d, HH:mm:ss')}
                  </TableCell>
                  <TableCell className="max-w-[100px] truncate">
                    {log.slackTeamName || log.slackTeamId}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{log.slackUserId}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{log.eventType}</Badge>
                  </TableCell>
                  <TableCell
                    className="max-w-[200px] truncate"
                    title={log.userMessageTruncated || ''}
                  >
                    {log.userMessageTruncated || '-'}
                  </TableCell>
                  <TableCell>
                    <Badge variant={log.status === 'success' ? 'default' : 'destructive'}>
                      {log.status}
                    </Badge>
                  </TableCell>
                  <TableCell>{log.responseTimeMs ? `${log.responseTimeMs}ms` : '-'}</TableCell>
                  <TableCell className="max-w-[100px] truncate text-xs">
                    {log.modelUsed || '-'}
                  </TableCell>
                  <TableCell className="text-xs">
                    {log.toolCallsMade && log.toolCallsMade.length > 0
                      ? log.toolCallsMade.join(', ')
                      : '-'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function ErrorSummaryTable({ data }: { data: ErrorSummary[] }) {
  if (data.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Error Summary</CardTitle>
          <CardDescription>No errors recorded</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Error Summary</CardTitle>
        <CardDescription>Most common errors by frequency</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Error Message</TableHead>
              <TableHead className="text-right">Count</TableHead>
              <TableHead>Last Occurrence</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((error, index) => (
              <TableRow key={index}>
                <TableCell
                  className="max-w-[400px] truncate font-mono text-sm"
                  title={error.errorMessage}
                >
                  {error.errorMessage}
                </TableCell>
                <TableCell className="text-right">{error.count}</TableCell>
                <TableCell>
                  {error.lastOccurrence
                    ? format(parseISO(error.lastOccurrence), 'MMM d, HH:mm')
                    : '-'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export default function SlackBotAdminPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-slack-bot-stats'],
    queryFn: async () => {
      const response = await fetch('/admin/api/slack-bot/stats');

      if (!response.ok) {
        throw new Error('Failed to fetch Slack bot statistics');
      }

      return (await response.json()) as SlackBotStatsResponse;
    },
    refetchInterval: 60000, // Refresh every minute
  });

  if (error) {
    return (
      <AdminPage breadcrumbs={breadcrumbs}>
        <Card>
          <CardHeader>
            <CardTitle>Error</CardTitle>
            <CardDescription>Failed to load Slack bot statistics</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground text-sm">
              {error instanceof Error ? error.message : 'An error occurred'}
            </p>
          </CardContent>
        </Card>
      </AdminPage>
    );
  }

  if (isLoading || !data) {
    return (
      <AdminPage breadcrumbs={breadcrumbs}>
        <div className="flex w-full flex-col gap-y-4">
          <h2 className="text-2xl font-bold">Slack Bot Admin</h2>
          <Card>
            <CardHeader>
              <CardTitle>Loading...</CardTitle>
              <CardDescription>Fetching Slack bot statistics</CardDescription>
            </CardHeader>
          </Card>
        </div>
      </AdminPage>
    );
  }

  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <div className="flex w-full flex-col gap-y-6">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold">Slack Bot Admin</h2>
        </div>

        <OverviewStatsCards data={data.overview} />

        <DailyChart data={data.dailyStats} />

        <div className="grid gap-6 lg:grid-cols-2">
          <UsageByOrgTable data={data.usageByOrg} />
          <UsageByUserTable data={data.usageByUser} />
        </div>

        <ErrorSummaryTable data={data.errorSummary} />

        <RequestLogsTable data={data.recentRequests} />
      </div>
    </AdminPage>
  );
}
