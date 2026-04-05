'use client';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { formatDistanceToNow } from 'date-fns';
import { Activity, Plus } from 'lucide-react';
import { useState } from 'react';
import { AuditLogDetailModal } from './AuditLogDetailModal';
import { AuditLogsFilters } from './AuditLogsFilters';
import type { AuditLogAction } from '@/lib/organizations/organization-audit-logs';
import type { AuditLogsFilters as AuditLogsFiltersType } from './useAuditLogsFilters';

type AuditLogEntry = {
  id: string;
  action: string;
  actor_id: string | null;
  actor_email: string | null;
  actor_name: string | null;
  message: string;
  created_at: string;
};

type AuditLogsTableProps = {
  logs: AuditLogEntry[];
  isLoading?: boolean;
  filters?: AuditLogsFiltersType;
  onFilterChange?: <K extends keyof AuditLogsFiltersType>(
    key: K,
    value: AuditLogsFiltersType[K]
  ) => void;
  onClearFilters?: () => void;
  availableActions?: AuditLogAction[];
};

function formatActionForDisplay(action: string): string {
  // Remove "organization." prefix and return the rest
  return action.replace(/^organization\./, '');
}

function getActorDisplay(log: AuditLogEntry): {
  name: string;
  email: string | null;
  isSystem: boolean;
} {
  if (!log.actor_id && !log.actor_email && !log.actor_name) {
    return {
      name: 'System',
      email: null,
      isSystem: true,
    };
  }

  return {
    name: log.actor_name || log.actor_email || 'Unknown User',
    email: log.actor_email,
    isSystem: false,
  };
}

export function AuditLogsTable({
  logs,
  isLoading = false,
  filters,
  onFilterChange,
  onClearFilters,
  availableActions,
}: AuditLogsTableProps) {
  const [selectedLog, setSelectedLog] = useState<AuditLogEntry | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const handleRowClick = (log: AuditLogEntry) => {
    setSelectedLog(log);
    setIsModalOpen(true);
  };

  const handleCloseModal = () => {
    setIsModalOpen(false);
    setSelectedLog(null);
  };

  const handleAddActionFilter = (action: string, event: React.MouseEvent) => {
    event.stopPropagation(); // Prevent row click
    const currentActions = filters?.action || [];
    // Type assertion since we know the action comes from the audit log
    const typedAction = action as AuditLogAction;
    if (!currentActions.includes(typedAction)) {
      const newActions = [...currentActions, typedAction];
      onFilterChange?.('action', newActions);
    }
  };

  const handleAddActorEmailFilter = (email: string, event: React.MouseEvent) => {
    event.stopPropagation(); // Prevent row click
    onFilterChange?.('actorEmail', email);
  };

  const renderHeader = () => (
    <CardHeader className="space-y-4">
      <AuditLogsFilters
        filters={filters}
        onFilterChange={onFilterChange}
        onClearFilters={onClearFilters}
        availableActions={availableActions}
      />
    </CardHeader>
  );

  if (isLoading) {
    return (
      <Card>
        {renderHeader()}
        <CardContent>
          <div className="flex items-center justify-center py-8">
            <div className="text-muted-foreground">Loading audit logs...</div>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (logs.length === 0) {
    return (
      <Card>
        {renderHeader()}
        <CardContent>
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <Activity className="text-muted-foreground mb-4 h-8 w-8" />
            <p className="text-muted-foreground mb-2">No audit logs found</p>
            <p className="text-muted-foreground text-sm">
              Organization activity will appear here when actions are performed.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      {renderHeader()}
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[180px]">Time</TableHead>
              <TableHead className="w-[160px]">Action</TableHead>
              <TableHead className="w-[200px]">Actor</TableHead>
              <TableHead>Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {logs.map(log => {
              const actor = getActorDisplay(log);
              const actionDisplay = formatActionForDisplay(log.action);

              return (
                <TableRow
                  key={log.id}
                  className="group cursor-pointer"
                  onClick={() => handleRowClick(log)}
                >
                  <TableCell className="font-mono text-xs">
                    <div title={new Date(log.created_at).toLocaleString()}>
                      {formatDistanceToNow(new Date(log.created_at), { addSuffix: true })}
                    </div>
                  </TableCell>

                  <TableCell>
                    <div className="flex items-center gap-2">
                      <code className="text-xs">{actionDisplay}</code>
                      {onFilterChange && (
                        <button
                          onClick={e => handleAddActionFilter(log.action, e)}
                          className="text-muted-foreground hover:text-foreground hover:bg-muted rounded p-1 opacity-0 transition-opacity group-hover:opacity-100"
                          title={`Filter by action: ${actionDisplay}`}
                        >
                          <Plus className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  </TableCell>

                  <TableCell>
                    <div className="flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <div
                          className="truncate font-medium"
                          title={actor.email && !actor.isSystem ? actor.email : undefined}
                        >
                          {actor.name}
                        </div>
                      </div>
                      {onFilterChange && actor.email && !actor.isSystem && (
                        <button
                          onClick={e => handleAddActorEmailFilter(actor.email as string, e)}
                          className="text-muted-foreground hover:text-foreground hover:bg-muted rounded p-1 opacity-0 transition-opacity group-hover:opacity-100"
                          title={`Filter by actor: ${actor.email}`}
                        >
                          <Plus className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  </TableCell>

                  <TableCell>
                    <div className="line-clamp-1 text-sm">{log.message}</div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>

      <AuditLogDetailModal isOpen={isModalOpen} onClose={handleCloseModal} log={selectedLog} />
    </Card>
  );
}
