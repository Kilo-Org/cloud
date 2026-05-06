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
import { UserAvatarLink } from './UserAvatarLink';
import type { FreeModelUsageStatsResponse } from '../api/free-model-usage/stats/route';

export function UserRateLimitStats() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-free-model-usage-stats'],
    queryFn: async () => {
      const response = await fetch('/admin/api/free-model-usage/stats');
      if (!response.ok) {
        throw new Error('Failed to fetch free model usage statistics');
      }
      return (await response.json()) as FreeModelUsageStatsResponse;
    },
    refetchInterval: 60000,
  });

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Error</CardTitle>
          <CardDescription>Failed to load user rate limit statistics</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            {error instanceof Error ? error.message : 'An error occurred'}
          </p>
        </CardContent>
      </Card>
    );
  }

  if (isLoading || !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Loading...</CardTitle>
          <CardDescription>Fetching user rate limit statistics</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const usersAtLimit = data.windowUsersAtLimitList;
  const isHot = data.windowUsersAtRequestLimit > 0;
  const formatNumber = (num: number) => num.toLocaleString();

  return (
    <div className="space-y-4">
      <Card className={isHot ? 'border-destructive bg-destructive/5' : 'border-primary/40'}>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Users at Limit</CardTitle>
          <CardDescription>
            Authenticated users that have reached {formatNumber(data.maxRequestsPerWindow)} requests
            in the last {data.rateLimitWindowHours}h
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className={isHot ? 'text-destructive text-3xl font-bold' : 'text-3xl font-bold'}>
            {formatNumber(data.windowUsersAtRequestLimit)}
          </div>
        </CardContent>
      </Card>

      {usersAtLimit.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">User IDs at Limit</CardTitle>
            <CardDescription>
              The authenticated users currently being rate-limited, ordered by request count.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Kilo user id</TableHead>
                  <TableHead className="text-right">Requests in window</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {usersAtLimit.map(user => (
                  <TableRow key={user.kiloUserId}>
                    <TableCell>
                      {user.googleUserName ? (
                        <UserAvatarLink
                          user={{
                            id: user.kiloUserId,
                            google_user_name: user.googleUserName,
                            google_user_email: user.googleUserEmail ?? '',
                            google_user_image_url: user.googleUserImageUrl ?? '',
                          }}
                          className="flex items-center space-x-3"
                          displayFormat="email-name"
                        />
                      ) : (
                        <span className="text-muted-foreground text-sm">(unknown user)</span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{user.kiloUserId}</TableCell>
                    <TableCell className="text-right font-medium">
                      {formatNumber(user.requestCount)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
