'use client';

import React, { use, useState, useCallback } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import Link from 'next/link';
import { format, formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import { getWebhookRoutes } from '@/lib/webhook-routes';

import { Button } from '@/components/ui/button';
import { CopyTextButton } from '@/components/admin/CopyEmailButton';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  ArrowLeft,
  Shell,
  Clock,
  Check,
  X,
  ChevronDown,
  ChevronRight,
  Copy,
  Loader2,
  AlertCircle,
  RefreshCw,
  ExternalLink,
  Inbox,
  Share2,
} from 'lucide-react';

type WebhookRequestsContentProps = {
  params: Promise<{ triggerId: string }>;
  organizationId?: string;
  adminPathBase?: string;
  adminUserId?: string;
};

type RequestStatus = 'captured' | 'inprogress' | 'success' | 'failed';

/** Status badge configuration */
const STATUS_CONFIG: Record<
  RequestStatus,
  { icon: React.ComponentType<{ className?: string }>; label: string; className: string }
> = {
  captured: {
    icon: Clock,
    label: 'Captured',
    className: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  },
  inprogress: {
    icon: Loader2,
    label: 'In Progress',
    className: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  },
  success: {
    icon: Check,
    label: 'Success',
    className: 'bg-green-500/20 text-green-400 border-green-500/30',
  },
  failed: { icon: X, label: 'Failed', className: 'bg-red-500/20 text-red-400 border-red-500/30' },
};

/** Map status to badge styling */
function getStatusBadge(status: RequestStatus) {
  const config = STATUS_CONFIG[status];
  if (!config) {
    return <Badge variant="secondary">{status}</Badge>;
  }
  const Icon = config.icon;
  const iconClass = status === 'inprogress' ? 'h-3 w-3 animate-spin' : 'h-3 w-3';
  return (
    <Badge className={config.className}>
      <Icon className={iconClass} />
      {config.label}
    </Badge>
  );
}

/** Format request ID to short display (first 8 chars) */
function shortId(id: string): string {
  return id.slice(0, 8);
}

/** Format timestamp for display */
function formatTimestamp(isoString: string): { absolute: string; relative: string } {
  const date = new Date(isoString);
  return {
    absolute: format(date, 'MMM d, yyyy h:mm a'),
    relative: formatDistanceToNow(date, { addSuffix: true }),
  };
}

function maskHeaderValue(value: string): string {
  if (!value) return '';
  if (value.length <= 4) return '****';
  return `${'*'.repeat(Math.min(value.length, 8))}`;
}

function maskHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, maskHeaderValue(value)])
  );
}

export function WebhookRequestsContent({
  params,
  organizationId,
  adminPathBase,
  adminUserId,
}: WebhookRequestsContentProps) {
  const { triggerId } = use(params);
  const trpc = useTRPC();

  // State for expanded rows
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [copiedUrl, setCopiedUrl] = useState(false);

  // Build URLs based on context
  const routes = getWebhookRoutes(organizationId);
  const isAdminView = !!adminPathBase;
  const adminRoutes = adminPathBase
    ? {
        list: adminPathBase,
        edit: `${adminPathBase}/${triggerId}`,
      }
    : null;
  const listHref = adminRoutes?.list ?? routes.list;
  const editHref = adminRoutes?.edit ?? routes.edit(triggerId);

  // Resolve admin scope — org or user, null when not in admin view.
  // If admin view is active but neither ID is provided (should be impossible given
  // caller constraints), adminScope stays null and the non-admin query paths run
  // instead, which will surface a proper tRPC error in the existing error UI.
  const adminScope = !isAdminView
    ? null
    : organizationId
      ? ({ scope: 'organization', organizationId } as const)
      : adminUserId
        ? ({ scope: 'user', userId: adminUserId } as const)
        : null;

  if (isAdminView && !adminScope) {
    return (
      <div className="rounded-lg border p-6">
        <h2 className="text-lg font-semibold">Admin context missing</h2>
        <p className="text-muted-foreground mt-2">
          This page requires either an organization or user scope.
        </p>
        {adminPathBase && (
          <Button asChild className="mt-4" variant="outline" size="sm">
            <Link href={adminPathBase}>Back to admin list</Link>
          </Button>
        )}
      </div>
    );
  }

  // Fetch trigger data to get the inbound URL
  const {
    data: triggerData,
    isLoading: isLoadingTrigger,
    error: triggerError,
  } = useQuery(
    adminScope
      ? trpc.admin.webhookTriggers.get.queryOptions({ ...adminScope, triggerId })
      : trpc.webhookTriggers.get.queryOptions({
          triggerId,
          organizationId: organizationId ?? undefined,
        })
  );

  // Fetch requests with auto-refresh every 10 seconds
  const {
    data: requests,
    isLoading: isLoadingRequests,
    isError: isRequestsError,
    error: requestsError,
    refetch: refetchRequests,
  } = useQuery({
    ...(adminScope
      ? trpc.admin.webhookTriggers.listRequests.queryOptions({
          ...adminScope,
          triggerId,
          limit: 50,
        })
      : trpc.webhookTriggers.listRequests.queryOptions({
          triggerId,
          organizationId: organizationId ?? undefined,
          limit: 50,
        })),
    refetchOnMount: 'always', // Always fetch fresh data on navigation
    refetchInterval: 10000, // Auto-refresh every 10 seconds
  });

  // Toggle row expansion
  const toggleRow = useCallback((requestId: string) => {
    setExpandedRows(prev => {
      const next = new Set(prev);
      if (next.has(requestId)) {
        next.delete(requestId);
      } else {
        next.add(requestId);
      }
      return next;
    });
  }, []);

  // Copy webhook URL to clipboard
  const handleCopyUrl = useCallback(async () => {
    if (!triggerData?.inboundUrl) return;

    try {
      await navigator.clipboard.writeText(triggerData.inboundUrl);
      setCopiedUrl(true);
      toast.success('Webhook URL copied to clipboard');
      setTimeout(() => setCopiedUrl(false), 2000);
    } catch {
      toast.error('Failed to copy URL');
    }
  }, [triggerData?.inboundUrl]);

  // Build session URL based on context (using kiloSessionId for /cloud/chat?sessionId=)
  const getSessionUrl = useCallback(
    (kiloSessionId: string) => {
      return organizationId
        ? `/organizations/${organizationId}/cloud/chat?sessionId=${kiloSessionId}`
        : `/cloud/chat?sessionId=${kiloSessionId}`;
    },
    [organizationId]
  );

  // State and mutation for sharing sessions (org context only)
  const [sharingSessionId, setSharingSessionId] = useState<string | null>(null);

  const { mutate: shareSession } = useMutation(
    trpc.cliSessions.shareForWebhookTrigger.mutationOptions({
      onSuccess: data => {
        const shareUrl = `${window.location.origin}/share/${data.share_id}`;
        window.open(shareUrl, '_blank');
        toast.success('Session shared successfully');
        setSharingSessionId(null);
      },
      onError: err => {
        toast.error(`Failed to share session: ${err.message}`);
        setSharingSessionId(null);
      },
    })
  );

  const handleShareSession = useCallback(
    (kiloSessionId: string) => {
      setSharingSessionId(kiloSessionId);
      shareSession({
        kilo_session_id: kiloSessionId,
        trigger_id: triggerId,
        organization_id: organizationId,
      });
    },
    [shareSession, triggerId, organizationId]
  );

  // Loading state
  const isLoading = isLoadingTrigger || isLoadingRequests;

  // Error state for trigger
  if (triggerError) {
    const isNotFound = triggerError.message.includes('not found');
    return (
      <>
        <div className="mb-6">
          <div className="mb-4">
            <Button variant="ghost" size="sm" asChild>
              <Link href={listHref}>
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to Webhook Triggers
              </Link>
            </Button>
          </div>
        </div>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shell className="h-5 w-5" />
              {isNotFound ? 'Trigger Not Found' : 'Error Loading Trigger'}
            </CardTitle>
            <CardDescription>
              {isNotFound
                ? `The webhook trigger "${triggerId}" does not exist or you don't have access to it.`
                : `An error occurred while loading the trigger: ${triggerError.message}`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" asChild>
              <Link href={listHref}>
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to List
              </Link>
            </Button>
          </CardContent>
        </Card>
      </>
    );
  }

  return (
    <>
      {/* Header */}
      <div className="mb-6">
        <div className="mb-4">
          <Button variant="ghost" size="sm" asChild>
            <Link href={editHref}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Trigger
            </Link>
          </Button>
        </div>
        <div className="flex items-center gap-3">
          <Shell className="h-8 w-8" />
          <h1 className="text-3xl font-bold">Requests for {triggerId}</h1>
        </div>
        <p className="text-muted-foreground mt-2">
          View captured webhook requests and their processing status.
        </p>

        {/* Webhook URL with copy button */}
        {triggerData?.inboundUrl && (
          <div className="bg-muted/50 mt-4 flex items-center gap-2 rounded-md border p-3">
            <code className="flex-1 truncate font-mono text-sm">{triggerData.inboundUrl}</code>
            <Button variant="ghost" size="sm" onClick={handleCopyUrl}>
              {copiedUrl ? (
                <Check className="h-4 w-4 text-green-500" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </Button>
          </div>
        )}
      </div>

      {/* Loading State */}
      {isLoading && (
        <div className="space-y-4">
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8"></TableHead>
                  <TableHead>Request ID</TableHead>
                  <TableHead>Timestamp</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Session</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...Array(5)].map((_, i) => (
                  <TableRow key={i}>
                    <TableCell>
                      <Skeleton className="h-4 w-4" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-24" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-40" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-12" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-6 w-20" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-16" />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {/* Error State */}
      {isRequestsError && (
        <div className="flex flex-col items-center justify-center py-12">
          <AlertCircle className="text-destructive h-8 w-8" />
          <p className="text-muted-foreground mt-2">
            Failed to load requests: {requestsError?.message || 'Unknown error'}
          </p>
          <Button variant="outline" onClick={() => refetchRequests()} className="mt-4">
            <RefreshCw className="mr-2 h-4 w-4" />
            Retry
          </Button>
        </div>
      )}

      {/* Empty State */}
      {!isLoading && !isRequestsError && requests && requests.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-12">
          <Inbox className="text-muted-foreground h-12 w-12" />
          <h3 className="mt-4 text-lg font-semibold">No requests captured yet</h3>
          <p className="text-muted-foreground mt-1 max-w-md text-center">
            When webhook requests are sent to this trigger's URL, they will appear here. Use the
            webhook URL above to start receiving requests.
          </p>
        </div>
      )}

      {/* Requests Table */}
      {!isLoading && !isRequestsError && requests && requests.length > 0 && (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8"></TableHead>
                <TableHead>Request ID</TableHead>
                <TableHead>Timestamp</TableHead>
                <TableHead>Method</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Session</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {requests.map(request => {
                const isExpanded = expandedRows.has(request.id);
                const timestamp = formatTimestamp(request.timestamp);

                return (
                  <React.Fragment key={request.id}>
                    <TableRow
                      className="hover:bg-muted/50 cursor-pointer"
                      onClick={() => toggleRow(request.id)}
                    >
                      <TableCell>
                        {isExpanded ? (
                          <ChevronDown className="h-4 w-4" />
                        ) : (
                          <ChevronRight className="h-4 w-4" />
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-sm">{shortId(request.id)}</TableCell>
                      <TableCell>
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="text-sm">
                                {timestamp.absolute}
                                <span className="text-muted-foreground">
                                  {' '}
                                  • {timestamp.relative}
                                </span>
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>{timestamp.relative}</p>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="font-mono">
                          {request.method}
                        </Badge>
                      </TableCell>
                      <TableCell>{getStatusBadge(request.processStatus)}</TableCell>
                      <TableCell>
                        {request.kiloSessionId ? (
                          (() => {
                            const sessionId = request.kiloSessionId;
                            if (isAdminView) {
                              return (
                                <div className="flex items-center gap-2">
                                  <Button
                                    variant="link"
                                    size="sm"
                                    className="h-auto p-0"
                                    asChild
                                    onClick={e => e.stopPropagation()}
                                  >
                                    <Link href={`/admin/session-traces?sessionId=${sessionId}`}>
                                      <ExternalLink className="mr-1 h-3 w-3" />
                                      {shortId(sessionId)}
                                    </Link>
                                  </Button>
                                  <span onClick={e => e.stopPropagation()}>
                                    <CopyTextButton text={sessionId} />
                                  </span>
                                </div>
                              );
                            }

                            return organizationId ? (
                              // Org context: show share button (bot sessions aren't directly accessible)
                              <Button
                                variant="link"
                                size="sm"
                                className="h-auto p-0"
                                onClick={e => {
                                  e.stopPropagation();
                                  handleShareSession(sessionId);
                                }}
                                disabled={sharingSessionId === sessionId}
                              >
                                {sharingSessionId === sessionId ? (
                                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                                ) : (
                                  <Share2 className="mr-1 h-3 w-3" />
                                )}
                                {shortId(sessionId)}
                              </Button>
                            ) : (
                              // Personal context: direct link to session
                              <Button
                                variant="link"
                                size="sm"
                                className="h-auto p-0"
                                asChild
                                onClick={e => e.stopPropagation()}
                              >
                                <Link href={getSessionUrl(sessionId)}>
                                  <ExternalLink className="mr-1 h-3 w-3" />
                                  {shortId(sessionId)}
                                </Link>
                              </Button>
                            );
                          })()
                        ) : (
                          <span className="text-muted-foreground text-sm">—</span>
                        )}
                      </TableCell>
                    </TableRow>

                    {/* Expanded Details */}
                    {isExpanded && (
                      <TableRow key={`${request.id}-expanded`}>
                        <TableCell colSpan={6} className="bg-muted/30 p-0">
                          <div className="space-y-4 p-4">
                            {/* Error Message (if failed) */}
                            {request.errorMessage && (
                              <div className="rounded-md border border-red-500/30 bg-red-500/10 p-3">
                                <p className="text-sm font-medium text-red-400">Error</p>
                                <p className="mt-1 text-sm">{request.errorMessage}</p>
                              </div>
                            )}

                            {/* Headers */}
                            <div>
                              <p className="mb-2 text-sm font-medium">Headers</p>
                              <pre className="bg-muted max-h-48 overflow-auto rounded-md p-3 text-xs">
                                <code>
                                  {JSON.stringify(
                                    isAdminView ? maskHeaders(request.headers) : request.headers,
                                    null,
                                    2
                                  )}
                                </code>
                              </pre>
                            </div>

                            {/* Body */}
                            <div>
                              <p className="mb-2 text-sm font-medium">Body</p>
                              {isAdminView ? (
                                <p className="text-muted-foreground text-xs">
                                  Payload body length:{' '}
                                  {new TextEncoder().encode(request.body).byteLength} bytes
                                </p>
                              ) : (
                                <pre className="bg-muted max-h-64 overflow-auto rounded-md p-3 text-xs">
                                  <code>
                                    {(() => {
                                      try {
                                        // Try to parse and format JSON
                                        const parsed = JSON.parse(request.body);
                                        return JSON.stringify(parsed, null, 2);
                                      } catch {
                                        // Show raw text if not JSON
                                        return request.body || '(empty)';
                                      }
                                    })()}
                                  </code>
                                </pre>
                              )}
                            </div>
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </React.Fragment>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}
