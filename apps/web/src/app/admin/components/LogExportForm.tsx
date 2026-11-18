'use client';

import { useId, useState, type ReactNode } from 'react';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { MAX_LOG_EXPORT_IDS, splitIdList } from '@/lib/admin/log-export-ids';
import { toast } from 'sonner';

type LogExportFormProps = {
  title: string;
  description?: ReactNode;
  /** Admin route that streams the ZIP for the filters as query parameters. */
  downloadPath: string;
  idLabel: string;
  idPlaceholder: string;
  showGenerationId?: boolean;
  /** Accept several IDs and generation IDs, separated by commas, spaces or newlines. */
  multipleIds?: boolean;
  /** Optional gate that must succeed before the browser navigates. */
  preflight?: () => Promise<void>;
};

export function LogExportForm({
  title,
  description,
  downloadPath,
  idLabel,
  idPlaceholder,
  showGenerationId = false,
  multipleIds = false,
  preflight,
}: LogExportFormProps) {
  const fieldId = useId();
  const [id, setId] = useState('');
  const [userId, setUserId] = useState('');
  const [organizationId, setOrganizationId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endDate, setEndDate] = useState('');
  const [endTime, setEndTime] = useState('');
  const [model, setModel] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [generationId, setGenerationId] = useState('');

  async function handleDownload() {
    const params = new URLSearchParams();
    for (const value of multipleIds ? splitIdList(id) : [id.trim()].filter(Boolean)) {
      params.append('id', value);
    }
    if (userId.trim()) {
      params.set('userId', userId.trim());
    }
    if (organizationId.trim()) {
      params.set('organizationId', organizationId.trim());
    }
    if (startDate) {
      params.set('startDate', startDate);
      if (startTime) {
        params.set('startTime', startTime);
      }
    }
    if (endDate) {
      params.set('endDate', endDate);
      if (endTime) {
        params.set('endTime', endTime);
      }
    }
    if (model.trim()) {
      params.set('model', model.trim());
    }
    if (sessionId.trim()) {
      params.set('sessionId', sessionId.trim());
    }
    if (showGenerationId) {
      for (const value of multipleIds
        ? splitIdList(generationId)
        : [generationId.trim()].filter(Boolean)) {
        params.append('generationId', value);
      }
    }

    if (preflight) {
      try {
        await preflight();
      } catch {
        toast.error('Could not verify access before download. Try again.');
        return;
      }
    }

    // Navigate directly to preserve server-side streaming
    window.location.href = `${downloadPath}?${params}`;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor={`${fieldId}-id`}>{idLabel}</Label>
            {multipleIds ? (
              <Textarea
                id={`${fieldId}-id`}
                aria-describedby={`${fieldId}-id-list-help`}
                placeholder={idPlaceholder}
                rows={3}
                value={id}
                onChange={e => setId(e.target.value)}
              />
            ) : (
              <Input
                id={`${fieldId}-id`}
                placeholder={idPlaceholder}
                value={id}
                onChange={e => setId(e.target.value)}
              />
            )}
          </div>

          {showGenerationId && (
            <div className="space-y-2">
              <Label htmlFor={`${fieldId}-generationId`}>
                {multipleIds ? 'Generation IDs' : 'Generation ID'}
              </Label>
              {multipleIds ? (
                <Textarea
                  id={`${fieldId}-generationId`}
                  aria-describedby={`${fieldId}-id-list-help`}
                  placeholder="Enter upstream generation IDs"
                  rows={3}
                  value={generationId}
                  onChange={e => setGenerationId(e.target.value)}
                />
              ) : (
                <Input
                  id={`${fieldId}-generationId`}
                  placeholder="Enter upstream generation ID"
                  value={generationId}
                  onChange={e => setGenerationId(e.target.value)}
                />
              )}
            </div>
          )}

          {multipleIds && (
            <p
              id={`${fieldId}-id-list-help`}
              className="text-muted-foreground text-xs sm:col-span-2"
            >
              Separate IDs with commas, spaces or new lines. Up to {MAX_LOG_EXPORT_IDS} of each. A
              record matches if it has any of the listed IDs.
            </p>
          )}

          <div className="space-y-2">
            <Label htmlFor={`${fieldId}-userId`}>User ID or email</Label>
            <Input
              id={`${fieldId}-userId`}
              placeholder="Enter user ID or email"
              value={userId}
              onChange={e => setUserId(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor={`${fieldId}-organizationId`}>Organization ID</Label>
            <Input
              id={`${fieldId}-organizationId`}
              placeholder="Enter organization ID"
              value={organizationId}
              onChange={e => setOrganizationId(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor={`${fieldId}-model`}>Model prefix</Label>
            <Input
              id={`${fieldId}-model`}
              placeholder="e.g. anthropic/"
              value={model}
              onChange={e => setModel(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor={`${fieldId}-sessionId`}>Session ID</Label>
            <Input
              id={`${fieldId}-sessionId`}
              placeholder="Enter session ID"
              value={sessionId}
              onChange={e => setSessionId(e.target.value)}
            />
          </div>
        </div>

        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div className="space-y-2">
              <Label htmlFor={`${fieldId}-startDate`}>Start date</Label>
              <Input
                id={`${fieldId}-startDate`}
                type="date"
                value={startDate}
                onChange={e => setStartDate(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${fieldId}-startTime`}>Start time</Label>
              <Input
                id={`${fieldId}-startTime`}
                type="time"
                value={startTime}
                disabled={!startDate}
                onChange={e => setStartTime(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${fieldId}-endDate`}>End date</Label>
              <Input
                id={`${fieldId}-endDate`}
                type="date"
                value={endDate}
                onChange={e => setEndDate(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${fieldId}-endTime`}>End time</Label>
              <Input
                id={`${fieldId}-endTime`}
                type="time"
                value={endTime}
                disabled={!endDate}
                onChange={e => setEndTime(e.target.value)}
              />
            </div>
          </div>
          <p className="text-muted-foreground text-xs">
            All filters are optional. Dates and times are UTC; without a time, the range covers the
            whole day, and the end time includes the full minute.
          </p>
        </div>

        <Button onClick={() => void handleDownload()}>
          <Download />
          Download ZIP
        </Button>
      </CardContent>
    </Card>
  );
}
