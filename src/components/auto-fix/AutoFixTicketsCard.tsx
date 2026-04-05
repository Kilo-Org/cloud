'use client';

import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  ExternalLink,
  Wrench,
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  GitPullRequest,
  Ban,
  RotateCw,
  HelpCircle,
} from 'lucide-react';
import { useTRPC } from '@/lib/trpc/utils';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';

type AutoFixTicketsCardProps = {
  organizationId?: string;
};

type FixStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
type FixClassification = 'bug' | 'feature' | 'question' | 'unclear';

const statusConfig: Record<
  FixStatus,
  {
    icon: React.ComponentType<{ className?: string }>;
    variant: 'default' | 'secondary' | 'destructive' | 'outline';
    label: string;
  }
> = {
  pending: { icon: Clock, variant: 'secondary', label: 'Pending' },
  running: { icon: Loader2, variant: 'default', label: 'Running' },
  completed: { icon: CheckCircle2, variant: 'default', label: 'Completed' },
  failed: { icon: XCircle, variant: 'destructive', label: 'Failed' },
  cancelled: { icon: Ban, variant: 'outline', label: 'Cancelled' },
};

const classificationConfig: Record<
  FixClassification,
  {
    icon: React.ComponentType<{ className?: string }>;
    label: string;
    color: string;
  }
> = {
  bug: { icon: AlertCircle, label: 'Bug', color: 'text-red-500' },
  feature: { icon: GitPullRequest, label: 'Feature', color: 'text-blue-500' },
  question: { icon: HelpCircle, label: 'Question', color: 'text-yellow-500' },
  unclear: { icon: HelpCircle, label: 'Unclear', color: 'text-gray-500' },
};

const PAGE_SIZE = 10;

export function AutoFixTicketsCard({ organizationId }: AutoFixTicketsCardProps) {
  const [currentPage, setCurrentPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<FixStatus | undefined>(undefined);
  const [classificationFilter, setClassificationFilter] = useState<FixClassification | undefined>(
    undefined
  );

  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const offset = (currentPage - 1) * PAGE_SIZE;

  // Fetch fix tickets with auto-refresh every 5 seconds if there are active jobs
  const { data, isLoading, isFetching } = useQuery({
    ...(organizationId
      ? trpc.organizations.autoFix.listTickets.queryOptions({
          organizationId,
          limit: PAGE_SIZE,
          offset,
          status: statusFilter,
          classification: classificationFilter,
        })
      : trpc.personalAutoFix.listTickets.queryOptions({
          limit: PAGE_SIZE,
          offset,
          status: statusFilter,
          classification: classificationFilter,
        })),
    refetchInterval: query => {
      const result = query.state.data;
      if (!result || !result.success) return false;
      const tickets = result.tickets || [];
      const hasActiveJobs = tickets.some(t => ['pending', 'running'].includes(t.status));
      return hasActiveJobs ? 5000 : false; // Poll every 5s if active jobs
    },
  });

  // Retry mutation for failed tickets (organization)
  const retryOrgMutation = useMutation(
    trpc.organizations.autoFix.retriggerFix.mutationOptions({
      onSuccess: async () => {
        toast.success('Fix retry initiated', {
          description: 'The fix has been reset to pending and will be processed soon.',
        });
        // Invalidate the query to refetch the list
        if (organizationId) {
          await queryClient.invalidateQueries({
            queryKey: trpc.organizations.autoFix.listTickets.queryKey({
              organizationId,
              limit: PAGE_SIZE,
              offset,
              status: statusFilter,
              classification: classificationFilter,
            }),
          });
        }
      },
      onError: error => {
        toast.error('Failed to retry fix', {
          description: error.message,
        });
      },
    })
  );

  // Retry mutation for failed tickets (personal)
  const retryPersonalMutation = useMutation(
    trpc.personalAutoFix.retriggerFix.mutationOptions({
      onSuccess: async () => {
        toast.success('Fix retry initiated', {
          description: 'The fix has been reset to pending and will be processed soon.',
        });
        // Invalidate the query to refetch the list
        await queryClient.invalidateQueries({
          queryKey: trpc.personalAutoFix.listTickets.queryKey({
            limit: PAGE_SIZE,
            offset,
            status: statusFilter,
            classification: classificationFilter,
          }),
        });
      },
      onError: error => {
        toast.error('Failed to retry fix', {
          description: error.message,
        });
      },
    })
  );

  // Cancel mutation for running tickets (organization)
  const cancelOrgMutation = useMutation(
    trpc.organizations.autoFix.cancelFix.mutationOptions({
      onSuccess: async () => {
        toast.success('Fix cancelled', {
          description: 'The fix has been cancelled.',
        });
        // Invalidate the query to refetch the list
        if (organizationId) {
          await queryClient.invalidateQueries({
            queryKey: trpc.organizations.autoFix.listTickets.queryKey({
              organizationId,
              limit: PAGE_SIZE,
              offset,
              status: statusFilter,
              classification: classificationFilter,
            }),
          });
        }
      },
      onError: error => {
        toast.error('Failed to cancel fix', {
          description: error.message,
        });
      },
    })
  );

  // Cancel mutation for running tickets (personal)
  const cancelPersonalMutation = useMutation(
    trpc.personalAutoFix.cancelFix.mutationOptions({
      onSuccess: async () => {
        toast.success('Fix cancelled', {
          description: 'The fix has been cancelled.',
        });
        // Invalidate the query to refetch the list
        await queryClient.invalidateQueries({
          queryKey: trpc.personalAutoFix.listTickets.queryKey({
            limit: PAGE_SIZE,
            offset,
            status: statusFilter,
            classification: classificationFilter,
          }),
        });
      },
      onError: error => {
        toast.error('Failed to cancel fix', {
          description: error.message,
        });
      },
    })
  );

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Fix Tickets</CardTitle>
          <CardDescription>Loading...</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const tickets = data?.success ? data.tickets : [];
  const total = data?.success ? data.total : 0;
  const hasMore = data?.success ? data.hasMore : false;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const hasPrevious = currentPage > 1;
  const hasNext = hasMore;

  // Show empty state only on first page with no tickets
  if (tickets.length === 0 && currentPage === 1 && !statusFilter && !classificationFilter) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wrench className="h-5 w-5" />
            Fix Tickets
          </CardTitle>
          <CardDescription>No fix tickets yet</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            Fix tickets will appear here when issues labeled with kilo-auto-fix are processed.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wrench className="h-5 w-5" />
          Fix Tickets
        </CardTitle>
        <CardDescription>
          {total > 0 ? (
            <>
              Showing {offset + 1}-{Math.min(offset + tickets.length, total)} of {total} tickets
            </>
          ) : (
            'No tickets match the current filters'
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {/* Filters */}
        <div className="mb-4 flex flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-sm">Status:</span>
            <Button
              variant={statusFilter === undefined ? 'default' : 'outline'}
              size="sm"
              onClick={() => {
                setStatusFilter(undefined);
                setCurrentPage(1);
              }}
            >
              All
            </Button>
            {Object.entries(statusConfig).map(([status, config]) => (
              <Button
                key={status}
                variant={statusFilter === status ? 'default' : 'outline'}
                size="sm"
                onClick={() => {
                  setStatusFilter(status as FixStatus);
                  setCurrentPage(1);
                }}
              >
                {config.label}
              </Button>
            ))}
          </div>
        </div>

        <div className="mb-4 flex flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-sm">Classification:</span>
            <Button
              variant={classificationFilter === undefined ? 'default' : 'outline'}
              size="sm"
              onClick={() => {
                setClassificationFilter(undefined);
                setCurrentPage(1);
              }}
            >
              All
            </Button>
            {Object.entries(classificationConfig).map(([classification, config]) => (
              <Button
                key={classification}
                variant={classificationFilter === classification ? 'default' : 'outline'}
                size="sm"
                onClick={() => {
                  setClassificationFilter(classification as FixClassification);
                  setCurrentPage(1);
                }}
              >
                {config.label}
              </Button>
            ))}
          </div>
        </div>

        {/* Tickets List */}
        <div className="space-y-3">
          {tickets.map(ticket => {
            const statusInfo = statusConfig[ticket.status as FixStatus] ?? {
              icon: AlertCircle,
              variant: 'outline' as const,
              label: ticket.status,
            };
            const StatusIcon = statusInfo.icon;

            const classificationInfo = ticket.classification
              ? classificationConfig[ticket.classification as FixClassification]
              : null;
            const ClassificationIcon = classificationInfo?.icon;

            return (
              <div key={ticket.id} className="space-y-2">
                <div className="hover:bg-muted/50 flex items-start gap-3 rounded-lg border p-3 transition-colors">
                  {/* Status Icon */}
                  <div className="mt-1">
                    <StatusIcon
                      className={`h-5 w-5 ${ticket.status === 'running' ? 'animate-spin' : ''} ${
                        ticket.status === 'completed'
                          ? 'text-green-500'
                          : ticket.status === 'failed'
                            ? 'text-red-500'
                            : 'text-muted-foreground'
                      }`}
                    />
                  </div>

                  {/* Ticket Info */}
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <a
                          href={ticket.issue_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-foreground hover:text-primary inline-flex items-center gap-1 text-sm font-medium transition-colors hover:underline"
                        >
                          {ticket.issue_title}
                          <ExternalLink className="h-3 w-3" />
                        </a>
                        <div className="text-muted-foreground mt-0.5 flex items-center gap-2 text-xs">
                          <span>{ticket.repo_full_name}</span>
                          <span>•</span>
                          <span>#{ticket.issue_number}</span>
                          <span>•</span>
                          <span>by @{ticket.issue_author}</span>
                        </div>
                      </div>

                      {/* Status Badge */}
                      <Badge variant={statusInfo.variant} className="gap-1 whitespace-nowrap">
                        <StatusIcon
                          className={`h-3 w-3 ${ticket.status === 'running' ? 'animate-spin' : ''}`}
                        />
                        {statusInfo.label}
                      </Badge>
                    </div>

                    {/* Classification & Confidence */}
                    {classificationInfo && (
                      <div className="flex items-center gap-2">
                        <div className="flex items-center gap-1">
                          {ClassificationIcon && (
                            <ClassificationIcon
                              className={`h-3.5 w-3.5 ${classificationInfo.color}`}
                            />
                          )}
                          <span className="text-xs font-medium">{classificationInfo.label}</span>
                        </div>
                        {ticket.confidence && (
                          <Badge variant="outline" className="text-xs">
                            {Math.round(parseFloat(ticket.confidence) * 100)}% confidence
                          </Badge>
                        )}
                      </div>
                    )}

                    {/* Intent Summary */}
                    {ticket.intent_summary && (
                      <p className="text-muted-foreground text-xs">{ticket.intent_summary}</p>
                    )}

                    {/* PR Information */}
                    {ticket.pr_url && (
                      <div className="flex items-center gap-1">
                        <GitPullRequest className="h-3.5 w-3.5 text-green-500" />
                        <span className="text-xs font-medium text-green-600">PR Created</span>
                        <a
                          href={ticket.pr_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary ml-1 inline-flex items-center gap-0.5 text-xs hover:underline"
                        >
                          #{ticket.pr_number}
                          <ExternalLink className="h-2.5 w-2.5" />
                        </a>
                      </div>
                    )}

                    {/* Cloud Agent Session */}
                    {ticket.session_id && (
                      <div className="flex items-center gap-1">
                        <span className="text-muted-foreground text-xs">Session:</span>
                        <code className="text-xs">{ticket.session_id}</code>
                      </div>
                    )}

                    {/* Timestamps */}
                    <div className="text-muted-foreground flex items-center gap-3 text-xs">
                      {ticket.started_at && (
                        <span>
                          Started{' '}
                          {formatDistanceToNow(new Date(ticket.started_at), { addSuffix: true })}
                        </span>
                      )}
                      {ticket.completed_at && (
                        <span>
                          Completed{' '}
                          {formatDistanceToNow(new Date(ticket.completed_at), { addSuffix: true })}
                        </span>
                      )}
                      {!ticket.started_at && (
                        <span>
                          Created{' '}
                          {formatDistanceToNow(new Date(ticket.created_at), { addSuffix: true })}
                        </span>
                      )}
                    </div>

                    {/* Error Message */}
                    {ticket.error_message && (
                      <div className="text-destructive mt-1 text-xs">
                        Error: {ticket.error_message}
                      </div>
                    )}

                    {/* Action Buttons */}
                    <div className="mt-2 flex gap-2">
                      {/* Retry Button for Failed, Pending, and Cancelled Tickets */}
                      {(ticket.status === 'failed' ||
                        ticket.status === 'pending' ||
                        ticket.status === 'cancelled') && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            if (organizationId) {
                              retryOrgMutation.mutate({ organizationId, ticketId: ticket.id });
                            } else {
                              retryPersonalMutation.mutate({ ticketId: ticket.id });
                            }
                          }}
                          disabled={retryOrgMutation.isPending || retryPersonalMutation.isPending}
                          className="gap-2"
                        >
                          <RotateCw
                            className={`h-3 w-3 ${retryOrgMutation.isPending || retryPersonalMutation.isPending ? 'animate-spin' : ''}`}
                          />
                          {retryOrgMutation.isPending || retryPersonalMutation.isPending
                            ? ticket.status === 'pending'
                              ? 'Dispatching...'
                              : 'Retrying...'
                            : ticket.status === 'pending'
                              ? 'Dispatch'
                              : 'Retry'}
                        </Button>
                      )}

                      {/* Cancel Button for Running Tickets */}
                      {ticket.status === 'running' && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            if (organizationId) {
                              cancelOrgMutation.mutate({ organizationId, ticketId: ticket.id });
                            } else {
                              cancelPersonalMutation.mutate({ ticketId: ticket.id });
                            }
                          }}
                          disabled={cancelOrgMutation.isPending || cancelPersonalMutation.isPending}
                          className="gap-2"
                        >
                          <Ban
                            className={`h-3 w-3 ${cancelOrgMutation.isPending || cancelPersonalMutation.isPending ? 'animate-spin' : ''}`}
                          />
                          {cancelOrgMutation.isPending || cancelPersonalMutation.isPending
                            ? 'Cancelling...'
                            : 'Cancel'}
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Pagination Controls */}
        {total > PAGE_SIZE && (
          <div className="mt-4 flex items-center justify-between border-t pt-4">
            <div className="text-muted-foreground text-sm">
              Page {currentPage} of {totalPages}
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                disabled={!hasPrevious || isFetching}
                className="flex items-center gap-1"
              >
                <ChevronLeft className="h-4 w-4" />
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCurrentPage(p => p + 1)}
                disabled={!hasNext || isFetching}
                className="flex items-center gap-1"
              >
                Next
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
