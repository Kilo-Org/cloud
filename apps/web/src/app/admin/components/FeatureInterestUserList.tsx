'use client';

import { useState, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { FeatureSignupUser } from '@/routers/admin-feature-interest-router';
import { format, parseISO } from 'date-fns';
import { HelpCircle, Download } from 'lucide-react';

type FeatureInterestUserListProps = {
  feature: string;
  users: FeatureSignupUser[];
  totalCount: number;
  usersQuery?: string;
  countQuery?: string;
};

export function FeatureInterestUserList({
  feature,
  users,
  totalCount,
  usersQuery,
  countQuery,
}: FeatureInterestUserListProps) {
  const [showQueries, setShowQueries] = useState(false);

  const downloadCSV = useCallback(() => {
    // CSV header
    const header = ['Email', 'Name', 'Company', 'Role', 'Signed Up'];

    // CSV rows
    const rows = users.map(user => [
      user.email,
      user.name || '',
      user.company || '',
      user.role || '',
      user.signed_up_at ? format(parseISO(user.signed_up_at), 'yyyy-MM-dd HH:mm:ss') : '',
    ]);

    // Combine header and rows
    const csvContent = [header, ...rows]
      .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');

    // Create blob and download
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `${feature.toLowerCase().replace(/\s+/g, '-')}-signups.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, [users, feature]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg">Users Interested in {feature}</CardTitle>
            <p className="text-muted-foreground text-sm">
              {totalCount} unique {totalCount === 1 ? 'signup' : 'signups'} in the last 90 days
            </p>
          </div>
          <div className="flex items-center gap-2">
            {users.length > 0 && (
              <button
                onClick={downloadCSV}
                className="hover:bg-muted flex items-center gap-1 rounded-md px-3 py-1.5 text-sm transition-colors"
                title="Download as CSV"
              >
                <Download className="h-4 w-4" />
                <span>CSV</span>
              </button>
            )}
            {(usersQuery || countQuery) && (
              <button
                onClick={() => setShowQueries(!showQueries)}
                className="text-muted-foreground hover:text-foreground transition-colors"
                title="Show PostHog queries"
              >
                <HelpCircle className="h-5 w-5" />
              </button>
            )}
          </div>
        </div>
        {showQueries && (usersQuery || countQuery) && (
          <div className="mt-3 space-y-3">
            {usersQuery && (
              <div>
                <p className="text-muted-foreground mb-1 text-xs font-medium">Users Query:</p>
                <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs">
                  <code>{usersQuery.trim()}</code>
                </pre>
              </div>
            )}
            {countQuery && (
              <div>
                <p className="text-muted-foreground mb-1 text-xs font-medium">Count Query:</p>
                <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs">
                  <code>{countQuery.trim()}</code>
                </pre>
              </div>
            )}
          </div>
        )}
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b">
                <th className="text-muted-foreground py-2 pr-3 text-left font-medium">Email</th>
                <th className="text-muted-foreground px-3 py-2 text-left font-medium">Name</th>
                <th className="text-muted-foreground px-3 py-2 text-left font-medium">Company</th>
                <th className="text-muted-foreground px-3 py-2 text-left font-medium">Role</th>
                <th className="text-muted-foreground py-2 pl-3 text-left font-medium">Signed Up</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user, index) => (
                <tr key={`${user.email}-${index}`} className="hover:bg-muted/50 border-b">
                  <td className="py-2 pr-3">
                    <a href={`mailto:${user.email}`} className="text-blue-600 hover:underline">
                      {user.email}
                    </a>
                  </td>
                  <td className="px-3 py-2">{user.name || '-'}</td>
                  <td className="px-3 py-2">{user.company || '-'}</td>
                  <td className="px-3 py-2">{user.role || '-'}</td>
                  <td className="py-2 pl-3 whitespace-nowrap">
                    {user.signed_up_at
                      ? format(parseISO(user.signed_up_at), 'MMM d, yyyy HH:mm')
                      : '-'}
                  </td>
                </tr>
              ))}
              {users.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-muted-foreground py-4 text-center">
                    No users found for this feature
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
