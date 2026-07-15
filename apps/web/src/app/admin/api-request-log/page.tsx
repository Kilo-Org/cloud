'use client';

import { useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
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
  const [userId, setUserId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [model, setModel] = useState('');
  const [sessionId, setSessionId] = useState('');

  const trpc = useTRPC();
  const oldestEntryQuery = useQuery(trpc.admin.apiRequestLog.getOldestEntry.queryOptions());

  function handleDownload() {
    const params = new URLSearchParams();
    if (userId.trim()) {
      params.set('userId', userId.trim());
    }
    if (startDate) {
      params.set('startDate', startDate);
    }
    if (endDate) {
      params.set('endDate', endDate);
    }
    if (model.trim()) {
      params.set('model', model.trim());
    }
    if (sessionId.trim()) {
      params.set('sessionId', sessionId.trim());
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
              <Label htmlFor="userId">User ID (optional)</Label>
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

            <div className="space-y-2">
              <Label htmlFor="sessionId">Session ID (optional)</Label>
              <Input
                id="sessionId"
                placeholder="Enter session ID"
                value={sessionId}
                onChange={e => setSessionId(e.target.value)}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="startDate">Start Date (optional)</Label>
                <Input
                  id="startDate"
                  type="date"
                  value={startDate}
                  onChange={e => setStartDate(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="endDate">End Date (optional)</Label>
                <Input
                  id="endDate"
                  type="date"
                  value={endDate}
                  onChange={e => setEndDate(e.target.value)}
                />
              </div>
            </div>

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
