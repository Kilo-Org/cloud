'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

type SegmentationData = {
  ownershipBreakdown: {
    type: string;
    count: number;
    completed: number;
    failed: number;
  }[];
  topUsers: {
    userId: string | null;
    email: string | null;
    name: string | null;
    reviewCount: number;
    completedCount: number;
  }[];
  topOrgs: {
    orgId: string | null;
    name: string | null;
    plan: string | null;
    reviewCount: number;
    completedCount: number;
  }[];
};

type Props = {
  data: SegmentationData;
  onUserClick?: (userId: string, email: string | null, name: string | null) => void;
  onOrgClick?: (orgId: string, name: string | null, plan: string | null) => void;
};

export function CodeReviewUserSegmentation({ data, onUserClick, onOrgClick }: Props) {
  const personal = data.ownershipBreakdown.find(o => o.type === 'personal');
  const org = data.ownershipBreakdown.find(o => o.type === 'organization');

  const totalCount = (personal?.count || 0) + (org?.count || 0);
  const personalPercentage = totalCount > 0 ? ((personal?.count || 0) / totalCount) * 100 : 0;
  const orgPercentage = totalCount > 0 ? ((org?.count || 0) / totalCount) * 100 : 0;

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {/* Ownership Breakdown */}
      <Card>
        <CardHeader>
          <CardTitle>Ownership Breakdown</CardTitle>
          <CardDescription>Personal vs Organization usage</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Personal Users</span>
                <span className="text-2xl font-bold">
                  {(personal?.count || 0).toLocaleString()}
                </span>
              </div>
              <div className="text-muted-foreground flex items-center justify-between text-xs">
                <span>{personalPercentage.toFixed(1)}% of total</span>
                <span>
                  {personal?.completed || 0} completed / {personal?.failed || 0} failed
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200">
                <div
                  className="h-full bg-blue-500 transition-all"
                  style={{ width: `${personalPercentage}%` }}
                />
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Organizations</span>
                <span className="text-2xl font-bold">{(org?.count || 0).toLocaleString()}</span>
              </div>
              <div className="text-muted-foreground flex items-center justify-between text-xs">
                <span>{orgPercentage.toFixed(1)}% of total</span>
                <span>
                  {org?.completed || 0} completed / {org?.failed || 0} failed
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200">
                <div
                  className="h-full bg-green-500 transition-all"
                  style={{ width: `${orgPercentage}%` }}
                />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Top Users */}
      <Card>
        <CardHeader>
          <CardTitle>Top Personal Users</CardTitle>
          <CardDescription>
            {onUserClick ? 'Click to filter by user' : 'Most active personal users'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.topUsers.length === 0 ? (
            <p className="text-muted-foreground text-sm">No personal user reviews in this period</p>
          ) : (
            <div className="max-h-[250px] overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>User</TableHead>
                    <TableHead className="text-right">Reviews</TableHead>
                    <TableHead className="text-right">Done</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.topUsers.map(user => (
                    <TableRow
                      key={user.userId || 'unknown'}
                      className={
                        onUserClick && user.userId ? 'hover:bg-muted/50 cursor-pointer' : ''
                      }
                      onClick={() => {
                        if (onUserClick && user.userId) {
                          onUserClick(user.userId, user.email, user.name);
                        }
                      }}
                    >
                      <TableCell
                        className="max-w-[120px] truncate text-xs"
                        title={user.email || undefined}
                      >
                        {user.name || user.email || user.userId || 'Unknown'}
                      </TableCell>
                      <TableCell className="text-right font-medium">{user.reviewCount}</TableCell>
                      <TableCell className="text-right text-green-600">
                        {user.completedCount}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Top Organizations */}
      <Card>
        <CardHeader>
          <CardTitle>Top Organizations</CardTitle>
          <CardDescription>
            {onOrgClick ? 'Click to filter by organization' : 'Most active organizations'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.topOrgs.length === 0 ? (
            <p className="text-muted-foreground text-sm">No organization reviews in this period</p>
          ) : (
            <div className="max-h-[250px] overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Organization</TableHead>
                    <TableHead>Plan</TableHead>
                    <TableHead className="text-right">Reviews</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.topOrgs.map(org => (
                    <TableRow
                      key={org.orgId || 'unknown'}
                      className={onOrgClick && org.orgId ? 'hover:bg-muted/50 cursor-pointer' : ''}
                      onClick={() => {
                        if (onOrgClick && org.orgId) {
                          onOrgClick(org.orgId, org.name, org.plan);
                        }
                      }}
                    >
                      <TableCell
                        className="max-w-[100px] truncate text-xs"
                        title={org.name || undefined}
                      >
                        {org.name || org.orgId || 'Unknown'}
                      </TableCell>
                      <TableCell className="text-xs capitalize">{org.plan || '-'}</TableCell>
                      <TableCell className="text-right font-medium">{org.reviewCount}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
