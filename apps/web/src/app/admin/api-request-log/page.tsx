'use client';

import { useState } from 'react';
import { format, formatDistanceToNow, subDays } from 'date-fns';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import AdminPage from '@/app/admin/components/AdminPage';
import { BreadcrumbItem } from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Download } from 'lucide-react';

export default function ApiRequestLogPage() {
  const today = format(new Date(), 'yyyy-MM-dd');
  const weekAgo = format(subDays(new Date(), 7), 'yyyy-MM-dd');

  const [userId, setUserId] = useState('');
  const [startDate, setStartDate] = useState(weekAgo);
  const [endDate, setEndDate] = useState(today);
  const [model, setModel] = useState('');
  const [error, setError] = useState<string | null>(null);

  const trpc = useTRPC();
  const oldestEntryQuery = useQuery(trpc.admin.apiRequestLog.getOldestEntry.queryOptions());

  function handleDownload() {
    if (!userId.trim()) {
      setError('User ID is required');
      return;
    }
    if (!startDate || !endDate) {
      setError('Both start and end dates are required');
      return;
    }

    setError(null);

    const params = new URLSearchParams({
      userId: userId.trim(),
      startDate,
      endDate,
    });
    if (model.trim()) {
      params.set('model', model.trim());
    }

    // Navigate directly to preserve server-side streaming
    window.location.href = `/admin/api/api-request-log/download?${params}`;
  }

  return (
    <AdminPage
      breadcrumbs={<BreadcrumbItem className="hidden md:block">API Request Log</BreadcrumbItem>}
    >
      <div className="w-full max-w-xl space-y-4">
        {oldestEntryQuery.data && (
          <p className="text-muted-foreground text-sm">
            Oldest entry is{' '}
            <span title={new Date(oldestEntryQuery.data.created_at).toLocaleString()}>
              {formatDistanceToNow(new Date(oldestEntryQuery.data.created_at), {
                addSuffix: true,
              })}
            </span>
            .
          </p>
        )}
        <Card>
          <CardHeader>
            <CardTitle>Download API Request Log</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="userId">User ID</Label>
              <Input
                id="userId"
                placeholder="Enter user ID"
                value={userId}
                onChange={e => setUserId(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="model">Model (optional)</Label>
              <Input
                id="model"
                placeholder="e.g. claude-sonnet-4-20250514"
                value={model}
                onChange={e => setModel(e.target.value)}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="startDate">Start Date</Label>
                <Input
                  id="startDate"
                  type="date"
                  value={startDate}
                  onChange={e => setStartDate(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="endDate">End Date</Label>
                <Input
                  id="endDate"
                  type="date"
                  value={endDate}
                  onChange={e => setEndDate(e.target.value)}
                />
              </div>
            </div>

            {error && <p className="text-sm text-red-500">{error}</p>}

            <Button onClick={handleDownload} className="w-full">
              <Download className="mr-2 h-4 w-4" />
              Download ZIP
            </Button>
          </CardContent>
        </Card>
      </div>
    </AdminPage>
  );
}
