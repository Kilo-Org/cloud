'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Download } from 'lucide-react';
import {
  type ModelExperimentRequestFilters,
  useModelExperiment,
  useModelExperimentRequests,
  useModelExperiments,
} from '@/app/admin/api/model-experiments/hooks';
import { UserAvatarLink } from '@/app/admin/components/UserAvatarLink';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  getPaginationHelpers,
  PAGE_SIZE_OPTIONS,
  type PageSize,
  type PaginationMetadata,
} from '@/types/pagination';

const ALL = '__all__';
const DEFAULT_PAGE_SIZE: PageSize = 25;
const MODEL_EXPERIMENTS_TAB = '/admin/gateway?tab=model-experiments';
const INITIAL_FILTERS: ModelExperimentRequestFilters = {
  page: 1,
  limit: DEFAULT_PAGE_SIZE,
  outcome: 'all',
  bodyState: 'all',
};

function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}

function formatNullable(value: string | null): string {
  return value && value.length > 0 ? value : '—';
}

function formatTokens(value: number): string {
  return value.toLocaleString();
}

function formatMicrodollars(value: number | null): string {
  if (value === null) return '—';
  return value.toLocaleString();
}

function isRequestKind(
  value: string
): value is NonNullable<ModelExperimentRequestFilters['requestKind']> {
  return value === 'chat_completions' || value === 'messages' || value === 'responses';
}

function isOutcome(value: string): value is ModelExperimentRequestFilters['outcome'] {
  return value === 'all' || value === 'success' || value === 'error';
}

function isBodyState(value: string): value is ModelExperimentRequestFilters['bodyState'] {
  return (
    value === 'all' ||
    value === 'available' ||
    value === 'truncated' ||
    value === 'failed' ||
    value === 'deleted'
  );
}

function experimentHref(experimentId: string): string {
  return `${MODEL_EXPERIMENTS_TAB}&experimentId=${encodeURIComponent(experimentId)}`;
}

function isAnonymousUserId(userId: string): boolean {
  return userId.startsWith('anon:');
}

function UserLink({
  userId,
  userName,
  userEmail,
  userImageUrl,
}: {
  userId: string;
  userName: string | null;
  userEmail: string | null;
  userImageUrl: string | null;
}) {
  if (isAnonymousUserId(userId)) {
    return <span className="font-mono text-xs">{userId}</span>;
  }

  if (userName && userEmail && userImageUrl) {
    return (
      <UserAvatarLink
        user={{
          id: userId,
          google_user_name: userName,
          google_user_email: userEmail,
          google_user_image_url: userImageUrl,
        }}
        className="flex items-center gap-2"
        avatarClassName="h-6 w-6 shrink-0"
        nameClassName="truncate"
        displayFormat="name"
      />
    );
  }

  const label = userName ?? userEmail ?? userId;
  return (
    <Link
      href={`/admin/users/${encodeURIComponent(userId)}`}
      className="hover:text-foreground font-medium underline-offset-4 hover:underline"
      title={userEmail ?? userId}
    >
      {label}
    </Link>
  );
}

function PromptDownload({
  usageId,
  requestBodySha256,
}: {
  usageId: string;
  requestBodySha256: string;
}) {
  if (requestBodySha256 === '__failed__') {
    return <span className="text-muted-foreground text-xs">Capture failed</span>;
  }
  if (requestBodySha256 === '__deleted__') {
    return <span className="text-muted-foreground text-xs">Deleted</span>;
  }

  return (
    <Button variant="outline" size="sm" asChild>
      <a
        href={`/admin/api/model-experiments/download?usageId=${encodeURIComponent(usageId)}`}
        download
      >
        <Download />
        Download JSON
      </a>
    </Button>
  );
}

function RequestsPagination({
  pagination,
  onPageChange,
  onLimitChange,
}: {
  pagination: PaginationMetadata;
  onPageChange: (page: number) => void;
  onLimitChange: (limit: PageSize) => void;
}) {
  const { hasNext, hasPrev } = getPaginationHelpers(pagination);

  return (
    <div className="flex flex-col gap-3 border-t p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="text-muted-foreground text-sm tabular-nums">
        Showing {Math.min((pagination.page - 1) * pagination.limit + 1, pagination.total)}–
        {Math.min(pagination.page * pagination.limit, pagination.total)} of{' '}
        {pagination.total.toLocaleString()}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-sm">Rows</span>
          <Select
            value={String(pagination.limit)}
            onValueChange={value => {
              const parsed = Number.parseInt(value, 10);
              const limit =
                PAGE_SIZE_OPTIONS.find(option => option === parsed) ?? DEFAULT_PAGE_SIZE;
              onLimitChange(limit);
            }}
          >
            <SelectTrigger size="sm" className="w-20">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZE_OPTIONS.map(size => (
                <SelectItem key={size} value={String(size)}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            disabled={!hasPrev}
            aria-label="First page"
            onClick={() => onPageChange(1)}
          >
            <ChevronsLeft />
          </Button>
          <Button
            variant="outline"
            size="icon"
            disabled={!hasPrev}
            aria-label="Previous page"
            onClick={() => onPageChange(pagination.page - 1)}
          >
            <ChevronLeft />
          </Button>
          <span className="text-muted-foreground px-2 text-sm tabular-nums">
            Page {pagination.page} of {pagination.totalPages}
          </span>
          <Button
            variant="outline"
            size="icon"
            disabled={!hasNext}
            aria-label="Next page"
            onClick={() => onPageChange(pagination.page + 1)}
          >
            <ChevronRight />
          </Button>
          <Button
            variant="outline"
            size="icon"
            disabled={!hasNext}
            aria-label="Last page"
            onClick={() => onPageChange(pagination.totalPages)}
          >
            <ChevronsRight />
          </Button>
        </div>
      </div>
    </div>
  );
}

export function ModelExperimentRequestsContent() {
  const [filters, setFilters] = useState<ModelExperimentRequestFilters>(INITIAL_FILTERS);
  const [clientRequestId, setClientRequestId] = useState('');
  const { data: experiments } = useModelExperiments(true);
  const { data: experimentDetails } = useModelExperiment(filters.experimentId ?? null);
  const { data, isLoading, isFetching, error } = useModelExperimentRequests(filters);
  const rows = data?.items ?? [];
  const pagination = data?.pagination ?? {
    page: filters.page,
    limit: filters.limit,
    total: 0,
    totalPages: 0,
  };

  function setFilter(patch: Partial<ModelExperimentRequestFilters>) {
    setFilters(current => ({ ...current, ...patch, page: 1 }));
  }

  function applyRequestIdFilter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = clientRequestId.trim();
    setFilter({ clientRequestId: value.length > 0 ? value : undefined });
  }

  function resetFilters() {
    setClientRequestId('');
    setFilters(INITIAL_FILTERS);
  }

  return (
    <div className="flex w-full flex-col gap-y-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-2xl font-bold">Experiment Requests</h2>
        <p className="text-muted-foreground text-sm">
          Inspect attributed traffic by experiment and download captured upstream request bodies
          from R2.
        </p>
      </div>

      <form
        onSubmit={applyRequestIdFilter}
        className="border-border bg-card grid gap-3 rounded-xl border p-4 md:grid-cols-2 xl:grid-cols-6"
      >
        <Select
          value={filters.experimentId ?? ALL}
          onValueChange={value =>
            setFilter({ experimentId: value === ALL ? undefined : value, variantId: undefined })
          }
        >
          <SelectTrigger className="w-full" aria-label="Filter by experiment">
            <SelectValue placeholder="All experiments" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All experiments</SelectItem>
            {(experiments?.items ?? []).map(experiment => (
              <SelectItem key={experiment.id} value={experiment.id}>
                {experiment.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          disabled={!filters.experimentId}
          value={filters.variantId ?? ALL}
          onValueChange={value => setFilter({ variantId: value === ALL ? undefined : value })}
        >
          <SelectTrigger className="w-full" aria-label="Filter by variant">
            <SelectValue placeholder="All variants" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All variants</SelectItem>
            {(experimentDetails?.variants ?? []).map(variant => (
              <SelectItem key={variant.id} value={variant.id}>
                {variant.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={filters.requestKind ?? ALL}
          onValueChange={value => {
            if (value === ALL || isRequestKind(value)) {
              setFilter({ requestKind: value === ALL ? undefined : value });
            }
          }}
        >
          <SelectTrigger className="w-full" aria-label="Filter by request type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All request types</SelectItem>
            <SelectItem value="chat_completions">Chat completions</SelectItem>
            <SelectItem value="messages">Messages</SelectItem>
            <SelectItem value="responses">Responses</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={filters.outcome}
          onValueChange={value => {
            if (isOutcome(value)) setFilter({ outcome: value });
          }}
        >
          <SelectTrigger className="w-full" aria-label="Filter by outcome">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All outcomes</SelectItem>
            <SelectItem value="success">Successful</SelectItem>
            <SelectItem value="error">Errors</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={filters.bodyState}
          onValueChange={value => {
            if (isBodyState(value)) setFilter({ bodyState: value });
          }}
        >
          <SelectTrigger className="w-full" aria-label="Filter by body state">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All captures</SelectItem>
            <SelectItem value="available">Downloadable</SelectItem>
            <SelectItem value="truncated">Truncated</SelectItem>
            <SelectItem value="failed">Capture failed</SelectItem>
            <SelectItem value="deleted">Deleted</SelectItem>
          </SelectContent>
        </Select>

        <div className="flex gap-2 md:col-span-2 xl:col-span-6">
          <Input
            className="max-w-md font-mono"
            value={clientRequestId}
            onChange={event => setClientRequestId(event.target.value)}
            placeholder="Exact Kilo request ID"
            aria-label="Filter by Kilo request ID"
          />
          <Button type="submit">Apply</Button>
          <Button type="button" variant="outline" onClick={resetFilters}>
            Reset
          </Button>
          {isFetching && !isLoading ? (
            <span className="text-muted-foreground self-center text-sm">Updating…</span>
          ) : null}
        </div>
      </form>

      {error ? (
        <div className="border-destructive text-destructive rounded-lg border p-4 text-sm">
          Could not load experiment requests: {error.message}
        </div>
      ) : isLoading ? (
        <div className="text-muted-foreground text-sm">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="border-border bg-card text-muted-foreground rounded-lg border p-6 text-sm">
          No experiment requests match these filters.
        </div>
      ) : (
        <div className="border-border overflow-hidden rounded-lg border">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Created</TableHead>
                  <TableHead>Experiment</TableHead>
                  <TableHead>Variant</TableHead>
                  <TableHead>Routing</TableHead>
                  <TableHead>Request</TableHead>
                  <TableHead>Usage</TableHead>
                  <TableHead>Captured body</TableHead>
                  <TableHead>User</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(row => (
                  <TableRow key={row.usageId}>
                    <TableCell className="whitespace-nowrap align-top text-sm">
                      {formatDate(row.createdAt)}
                    </TableCell>
                    <TableCell className="min-w-56 align-top">
                      <Link
                        href={experimentHref(row.experimentId)}
                        className="hover:text-foreground font-medium underline-offset-4 hover:underline"
                      >
                        {row.experimentName}
                      </Link>
                      <div className="text-muted-foreground font-mono text-xs">
                        {row.publicModelId}
                      </div>
                    </TableCell>
                    <TableCell className="min-w-48 align-top">
                      <div className="font-medium">{row.variantLabel}</div>
                    </TableCell>
                    <TableCell className="min-w-56 align-top text-xs">
                      <div>Provider: {formatNullable(row.inferenceProvider ?? row.provider)}</div>
                      <div className="text-muted-foreground font-mono">
                        {formatNullable(row.requestedModel)} → {formatNullable(row.upstreamModel)}
                      </div>
                    </TableCell>
                    <TableCell className="min-w-48 align-top">
                      <div className="flex flex-wrap items-center gap-1">
                        <Badge variant="outline">{row.requestKind}</Badge>
                        <Badge variant="secondary">{row.allocationSubject}</Badge>
                        {row.wasTruncated ? <Badge variant="destructive">truncated</Badge> : null}
                      </div>
                      <div className="text-muted-foreground mt-1 text-xs">
                        Kilo request: {formatNullable(row.clientRequestId)}
                      </div>
                    </TableCell>
                    <TableCell className="min-w-48 align-top text-sm tabular-nums">
                      <div>
                        Tokens: {formatTokens(row.inputTokens)} in /{' '}
                        {formatTokens(row.outputTokens)} out
                      </div>
                      <div className="text-muted-foreground text-xs">
                        Cache: {formatTokens(row.cacheWriteTokens)} write /{' '}
                        {formatTokens(row.cacheHitTokens)} hit
                      </div>
                      <div className="text-muted-foreground text-xs">
                        Cost: {formatMicrodollars(row.costMicrodollars)} µ$ · discount:{' '}
                        {formatMicrodollars(row.cacheDiscountMicrodollars)} µ$
                      </div>
                      {row.hasError ? <Badge variant="destructive">error</Badge> : null}
                    </TableCell>
                    <TableCell className="min-w-48 align-top">
                      <PromptDownload
                        usageId={row.usageId}
                        requestBodySha256={row.requestBodySha256}
                      />
                    </TableCell>
                    <TableCell className="min-w-48 align-top text-sm">
                      <UserLink
                        userId={row.userId}
                        userName={row.userName}
                        userEmail={row.userEmail}
                        userImageUrl={row.userImageUrl}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <RequestsPagination
            pagination={pagination}
            onPageChange={page => setFilters(current => ({ ...current, page }))}
            onLimitChange={limit => setFilters(current => ({ ...current, page: 1, limit }))}
          />
        </div>
      )}
    </div>
  );
}
