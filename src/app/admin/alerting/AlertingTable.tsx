'use client';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { formatPercent } from '@/app/admin/alerting/utils';
import type { AlertingDraft, AlertingBaseline, BaselineState } from '@/app/admin/alerting/types';

type AlertingTableProps = {
  configs: Array<{ model: string }>;
  drafts: Record<string, AlertingDraft>;
  baselineByModel: Record<string, AlertingBaseline | null>;
  baselineStatus: Record<string, BaselineState>;
  updatingModelId: string | null;
  deletingModelId: string | null;
  onToggleEnabled: (modelId: string, enabled: boolean) => void;
  onErrorRateChange: (modelId: string, value: string) => void;
  onMinRequestsChange: (modelId: string, value: string) => void;
  onLoadBaseline: (modelId: string) => void;
  onSave: (modelId: string) => void;
  onDelete: (modelId: string) => void;
};

export function AlertingTable({
  configs,
  drafts,
  baselineByModel,
  baselineStatus,
  updatingModelId,
  deletingModelId,
  onToggleEnabled,
  onErrorRateChange,
  onMinRequestsChange,
  onLoadBaseline,
  onSave,
  onDelete,
}: AlertingTableProps) {
  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Model</TableHead>
            <TableHead>Enabled</TableHead>
            <TableHead>Error Rate (%)</TableHead>
            <TableHead>Min Requests</TableHead>
            <TableHead>Baselines</TableHead>
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {configs.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="text-center">
                No alerting models found
              </TableCell>
            </TableRow>
          ) : (
            configs.map(config => {
              const modelId = config.model;
              const draft = drafts[modelId];
              const baseline = baselineByModel[modelId];
              const status = baselineStatus[modelId]?.status ?? 'idle';
              const isUpdating = updatingModelId === modelId;
              const isDeleting = deletingModelId === modelId;

              return (
                <TableRow key={modelId} className={isUpdating ? 'opacity-60' : ''}>
                  <TableCell className="font-mono text-sm">{modelId}</TableCell>
                  <TableCell>
                    <Switch
                      checked={draft?.enabled ?? false}
                      onCheckedChange={checked => onToggleEnabled(modelId, checked)}
                      disabled={isUpdating}
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      max="99.99"
                      value={draft?.errorRatePercent ?? ''}
                      onChange={e => onErrorRateChange(modelId, e.target.value)}
                      className="w-28"
                      disabled={isUpdating}
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      type="number"
                      step="1"
                      min="1"
                      value={draft?.minRequestsPerWindow ?? ''}
                      onChange={e => onMinRequestsChange(modelId, e.target.value)}
                      className="w-24"
                      disabled={isUpdating}
                    />
                  </TableCell>
                  <TableCell>
                    {status === 'loading' ? (
                      <div className="text-muted-foreground text-sm">Loading…</div>
                    ) : baseline ? (
                      <div className="text-muted-foreground text-xs">
                        <div>
                          1d: {formatPercent(baseline.errorRate1d)} (
                          {baseline.requests1d.toLocaleString()})
                        </div>
                        <div>
                          3d: {formatPercent(baseline.errorRate3d)} (
                          {baseline.requests3d.toLocaleString()})
                        </div>
                        <div>
                          7d: {formatPercent(baseline.errorRate7d)} (
                          {baseline.requests7d.toLocaleString()})
                        </div>
                      </div>
                    ) : baseline === null ? (
                      <div className="text-muted-foreground text-xs">No data</div>
                    ) : status === 'error' ? (
                      <div className="text-destructive text-xs">Failed to load</div>
                    ) : (
                      <div className="text-muted-foreground text-xs">Not loaded</div>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onLoadBaseline(modelId)}
                        disabled={status === 'loading'}
                      >
                        {status === 'loading' ? 'Loading...' : 'Load baseline'}
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => onSave(modelId)}
                        disabled={isUpdating || !draft}
                      >
                        {isUpdating ? 'Saving...' : 'Save'}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onDelete(modelId)}
                        disabled={isDeleting}
                        className="text-destructive hover:text-destructive"
                      >
                        {isDeleting ? 'Deleting...' : 'Delete'}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}
