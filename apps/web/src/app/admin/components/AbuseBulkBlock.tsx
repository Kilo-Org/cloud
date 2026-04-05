'use client';

import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';
import type { BulkBlockResponse } from '@/lib/abuse/bulkBlock';

export function AbuseBulkBlock() {
  const [rawIds, setRawIds] = useState('');
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<BulkBlockResponse | null>(null);

  const ids = useMemo(() => [...new Set(rawIds.split(/\s+/).filter(Boolean))], [rawIds]);

  const mutation = useMutation<BulkBlockResponse>({
    mutationFn: async () => {
      const res = await fetch('/admin/api/abuse/bulk-block', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kilo_user_emails_or_ids: ids.slice(0, 2000), block_reason: reason }),
      });
      return res.json() as Promise<BulkBlockResponse>;
    },
    onSuccess: setResult,
    onError: err => setResult({ success: false, error: err.message, foundIds: [] }),
  });

  return (
    <div className="bg-background rounded-lg border p-6">
      <h3 className="mb-4 text-lg font-semibold">Bulk Block Users</h3>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="ids">kilo_user_emails_or_ids (space/newline separated)</Label>
          <Textarea
            id="ids"
            placeholder="e.g.&#10;usr_123 usr_456&#10;usr_789"
            value={rawIds}
            onChange={e => setRawIds(e.target.value)}
            rows={8}
          />
          <div className="text-muted-foreground text-xs">
            Parsed {ids.length.toLocaleString()} unique ids / emails (no more than 10 000).
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="reason">Block reason</Label>
          <Input
            id="reason"
            placeholder="e.g. abuse/spam/chargeback"
            value={reason}
            onChange={e => setReason(e.target.value)}
          />

          <div className="flex items-center gap-2 pt-2">
            <Button
              onClick={() => {
                setResult(null);
                mutation.mutate();
              }}
              disabled={!ids.length || !reason.trim() || mutation.isPending}
              variant="destructive"
            >
              {mutation.isPending ? 'Blocking…' : 'Bulk Block'}
            </Button>

            {result && !result.success && result.foundIds.length > 0 && (
              <Button
                variant="outline"
                onClick={() => {
                  setRawIds(result.foundIds.join('\n'));
                  setResult(null);
                }}
              >
                Keep only valid ids
              </Button>
            )}
          </div>

          {result && !result.success && (
            <Alert variant="destructive" className="mt-2">
              <AlertDescription>{result.error}</AlertDescription>
            </Alert>
          )}

          {result?.success && (
            <Alert className="mt-2">
              <AlertDescription>
                Updated {result.updatedCount.toLocaleString()} users with reason &ldquo;
                {reason.trim()}&rdquo;.
              </AlertDescription>
            </Alert>
          )}
        </div>
      </div>
    </div>
  );
}
