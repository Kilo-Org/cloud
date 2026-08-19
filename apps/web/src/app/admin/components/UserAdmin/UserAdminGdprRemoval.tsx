'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { AlertTriangle, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import {
  isDeletionInProgressBlockedReason,
  isGoneOrDeletingBlockedReason,
} from '@kilocode/db/user-soft-delete-reasons';
import type { UserDetailProps } from '@/types/admin';

type DeletionRequestStatus = 'pending' | 'in_progress' | 'finalizing' | 'completed' | 'cancelled';

type DeletionStepStatus =
  | 'pending'
  | 'running'
  | 'retry_wait'
  | 'needs_attention'
  | 'manual_action_required'
  | 'succeeded'
  | 'not_applicable'
  | 'manually_verified';

type DeletionRequest = {
  id: string;
  status: DeletionRequestStatus;
  target_email: string | null;
};

type DeletionStep = {
  id: string;
  step_key: string;
  status: DeletionStepStatus;
  last_error_code: string | null;
};

type Busy = { kind: 'load' } | { kind: 'start' } | { kind: 'refresh' };

const TERMINAL_STATUSES: ReadonlySet<DeletionRequestStatus> = new Set(['completed', 'cancelled']);

export function UserAdminGdprRemoval(user: UserDetailProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<Busy | null>({ kind: 'load' });
  const [showGdprConfirmDialog, setShowGdprConfirmDialog] = useState(false);
  const [hasReadHandbook, setHasReadHandbook] = useState(false);
  const requestIdRef = useRef<string | null>(null);
  const [request, setRequest] = useState<DeletionRequest | null>(null);
  const [steps, setSteps] = useState<DeletionStep[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);

  const applyGetResult = useCallback(
    (result: { request: DeletionRequest | null; steps: DeletionStep[] }) => {
      setRequest(result.request);
      setSteps(result.steps);
      if (result.request) {
        requestIdRef.current = result.request.id;
      }
      setLoadFailed(false);
    },
    []
  );

  const fetchStatus = useCallback(
    async (overrideRequestId?: string) => {
      const id = overrideRequestId ?? requestIdRef.current;
      const query = id
        ? `requestId=${encodeURIComponent(id)}`
        : `userId=${encodeURIComponent(user.id)}`;
      const response = await fetch(`/admin/api/users/gdpr-removal?${query}`);
      const body: unknown = await readJson(response);
      if (!response.ok) {
        throw new Error(readApiError(body, `Server responded with ${response.status}`));
      }
      const parsed = parseGetResponse(body);
      if (!parsed) {
        throw new Error('Deletion status response was not valid');
      }
      return parsed;
    },
    [user.id]
  );

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setBusy({ kind: 'load' });
      try {
        const result = await fetchStatus();
        if (cancelled) {
          return;
        }
        applyGetResult(result);
      } catch (error) {
        if (cancelled) {
          return;
        }
        setLoadFailed(true);
        toast.error('Could not load deletion status', {
          description: error instanceof Error ? error.message : 'Network error',
          duration: 15_000,
        });
      } finally {
        if (!cancelled) {
          setBusy(null);
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [applyGetResult, fetchStatus]);

  useEffect(() => {
    if (!request || TERMINAL_STATUSES.has(request.status)) {
      return;
    }
    const timer = window.setInterval(() => {
      void fetchStatus()
        .then(applyGetResult)
        .catch(() => undefined);
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [applyGetResult, fetchStatus, request]);

  const handleRefreshStatus = async () => {
    setBusy({ kind: 'refresh' });
    try {
      applyGetResult(await fetchStatus());
    } catch (error) {
      toast.error('Could not refresh deletion status', {
        description: error instanceof Error ? error.message : 'Network error',
        duration: 15_000,
      });
    } finally {
      setBusy(null);
    }
  };

  const handleGdprDataRemoval = async () => {
    setShowGdprConfirmDialog(false);
    setBusy({ kind: 'start' });

    try {
      const response = await fetch('/admin/api/users/gdpr-removal', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ userId: user.id }),
      });

      const body: unknown = await readJson(response);
      if (response.status === 202) {
        const parsed = parseStartResponse(body);
        if (!parsed) {
          toast.error('User deletion failed', {
            description: 'Start response was not valid',
            duration: 15_000,
          });
          return;
        }
        requestIdRef.current = parsed.requestId;
        applyGetResult(await fetchStatus(parsed.requestId));
        toast.message('User deletion queued. Recovery continues on the deletion queue.');
        return;
      }

      toast.error('User deletion failed', {
        description: readApiError(body, `Server responded with ${response.status}`),
        duration: 15_000,
      });
    } catch (error) {
      toast.error('User deletion failed', {
        description: error instanceof Error ? error.message : 'Network error',
        duration: 15_000,
      });
    } finally {
      setBusy(null);
    }
  };

  const isBusy = busy !== null;
  const isGoneOrDeleting = isGoneOrDeletingBlockedReason(user.blocked_reason);
  const showChecklist = request !== null;
  const showStartForm = !showChecklist && !isGoneOrDeleting && busy?.kind !== 'load';
  const showGoneWithoutRequest =
    !showChecklist && isGoneOrDeleting && busy?.kind !== 'load' && !loadFailed;
  const showLoadError = !showChecklist && isGoneOrDeleting && loadFailed && busy?.kind !== 'load';

  return (
    <>
      <Card className="max-h-max border-red-800 bg-red-950/50 lg:col-span-2">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-red-200">
            <AlertTriangle />
            GDPR Data Removal
          </CardTitle>
          <CardDescription className="text-red-300">
            {cardDescription(request, busy)}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {busy?.kind === 'load' && request === null ? (
            <p className="text-sm text-red-200">Refreshing status...</p>
          ) : null}

          {showStartForm ? (
            <StartDeletionForm
              hasReadHandbook={hasReadHandbook}
              isBusy={isBusy}
              onHandbookChange={setHasReadHandbook}
              onRequestRemoval={() => setShowGdprConfirmDialog(true)}
              starting={busy?.kind === 'start'}
            />
          ) : null}

          {showGoneWithoutRequest ? (
            <div className="space-y-4">
              <p className="text-sm text-red-200">
                {isDeletionInProgressBlockedReason(user.blocked_reason)
                  ? 'This user is marked deletion-in-progress, but no active deletion request was found.'
                  : 'This account is already deleted.'}
              </p>
              <ViewGdprHandbookLink />
              <ChecklistActions
                busy={busy}
                isBusy={isBusy}
                onBackToUsers={() => router.push('/admin/users')}
                onRefresh={handleRefreshStatus}
                showRefresh
              />
            </div>
          ) : null}

          {showLoadError ? (
            <div className="space-y-4">
              <p className="text-sm text-red-200">Deletion status could not be loaded.</p>
              <ChecklistActions
                busy={busy}
                isBusy={isBusy}
                onBackToUsers={() => router.push('/admin/users')}
                onRefresh={handleRefreshStatus}
                showRefresh
              />
            </div>
          ) : null}

          {showChecklist && request ? (
            <QueuedDeletionStatus
              busy={busy}
              isBusy={isBusy}
              onBackToUsers={() => router.push('/admin/users')}
              onRefresh={handleRefreshStatus}
              request={request}
              steps={steps}
            />
          ) : null}
        </CardContent>
      </Card>

      <Dialog open={showGdprConfirmDialog} onOpenChange={setShowGdprConfirmDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-200">
              <AlertTriangle />
              Confirm GDPR Data Removal
            </DialogTitle>
            <DialogDescription asChild>
              <div>
                <p className="mb-4">
                  Are you absolutely sure you want to permanently delete all data for{' '}
                  <strong>{user.google_user_email}</strong>? This includes their account, usage
                  data, and any other associated information. This action cannot be undone.
                </p>
                <p>
                  Be sure to follow the handbook for other data: <ViewGdprHandbookLink />
                </p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowGdprConfirmDialog(false)}
              disabled={isBusy}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void handleGdprDataRemoval()}
              disabled={isBusy}
            >
              {busy?.kind === 'start'
                ? 'Queuing deletion...'
                : 'Yes, I understand. Delete most data.'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function StartDeletionForm({
  hasReadHandbook,
  isBusy,
  onHandbookChange,
  onRequestRemoval,
  starting,
}: {
  hasReadHandbook: boolean;
  isBusy: boolean;
  onHandbookChange: (checked: boolean) => void;
  onRequestRemoval: () => void;
  starting: boolean;
}) {
  return (
    <div className="space-y-4">
      <div className="rounded-md border border-blue-800 bg-blue-950/50 p-3">
        <p className="mb-2 text-sm text-blue-200">
          <strong>Important:</strong> Before proceeding, you must read the GDPR removal process in
          our handbook.
        </p>
        <ViewGdprHandbookLink />
      </div>

      <div className="flex items-center space-x-2">
        <input
          type="checkbox"
          id="handbook-confirmation"
          checked={hasReadHandbook}
          onChange={e => onHandbookChange(e.target.checked)}
          disabled={isBusy}
          className="h-4 w-4 rounded border-gray-600 bg-gray-800 text-red-400 focus:ring-red-400"
        />
        <Label htmlFor="handbook-confirmation" className="text-sm">
          I have read and understand the GDPR removal process in the handbook
        </Label>
      </div>

      <Button
        variant="destructive"
        size="sm"
        onClick={onRequestRemoval}
        disabled={isBusy || !hasReadHandbook}
      >
        {starting ? 'Queuing deletion...' : 'Request Data Removal'}
      </Button>
    </div>
  );
}

function QueuedDeletionStatus({
  busy,
  isBusy,
  onBackToUsers,
  onRefresh,
  request,
  steps,
}: {
  busy: Busy | null;
  isBusy: boolean;
  onBackToUsers: () => void;
  onRefresh: () => void;
  request: DeletionRequest;
  steps: DeletionStep[];
}) {
  const completed = request.status === 'completed';
  const attentionCount = steps.filter(
    step => step.status === 'needs_attention' || step.status === 'manual_action_required'
  ).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <RequestStatusBadge status={request.status} />
        {request.target_email ? (
          <span className="text-sm text-red-200">
            Target email <span className="font-mono text-xs">{request.target_email}</span>
          </span>
        ) : null}
      </div>

      {attentionCount > 0 ? (
        <p className="text-sm text-orange-300">
          {attentionCount} step{attentionCount === 1 ? '' : 's'} need recovery on the deletion
          queue.
        </p>
      ) : null}

      <Link
        href={`/admin/deletion-queue/${request.id}`}
        className="inline-flex items-center gap-1 text-sm text-blue-600 underline hover:text-blue-300"
      >
        Open deletion queue
        <ExternalLink size={14} />
      </Link>

      <ViewGdprHandbookLink />

      <ChecklistActions
        busy={busy}
        isBusy={isBusy}
        onBackToUsers={onBackToUsers}
        onRefresh={onRefresh}
        showRefresh={!completed}
      />
    </div>
  );
}

function ChecklistActions({
  busy,
  isBusy,
  onBackToUsers,
  onRefresh,
  showRefresh,
}: {
  busy: Busy | null;
  isBusy: boolean;
  onBackToUsers: () => void;
  onRefresh: () => void;
  showRefresh: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {showRefresh ? (
        <Button variant="outline" size="sm" disabled={isBusy} onClick={() => void onRefresh()}>
          {busy?.kind === 'refresh' ? 'Refreshing status...' : 'Refresh status'}
        </Button>
      ) : null}
      <Button variant="outline" size="sm" disabled={isBusy} onClick={onBackToUsers}>
        Back to users
      </Button>
    </div>
  );
}

function RequestStatusBadge({ status }: { status: DeletionRequestStatus }) {
  if (status === 'completed') {
    return <Badge variant="new">{status}</Badge>;
  }
  if (status === 'in_progress' || status === 'finalizing') {
    return (
      <Badge variant="outline" className="border-yellow-500/20 bg-yellow-500/10 text-yellow-400">
        {status}
      </Badge>
    );
  }
  if (status === 'cancelled') {
    return <Badge variant="destructive">{status}</Badge>;
  }
  return <Badge variant="outline">{status}</Badge>;
}

function cardDescription(request: DeletionRequest | null, busy: Busy | null): string {
  if (busy?.kind === 'load' && request === null) {
    return 'Checking whether a deletion request already exists.';
  }
  if (request?.status === 'completed') {
    return 'Deletion finished for the Cloud account and CSA-scoped providers.';
  }
  if (request) {
    return 'Deletion is queued. Remaining work continues on cron. Use the deletion queue for recovery.';
  }
  return 'This action is irreversible and will permanently delete all data associated with this user. Note: This will NOT delete all data - additional manual steps are required as outlined in our handbook.';
}

function ViewGdprHandbookLink() {
  return (
    <a
      href="https://handbook.kilo.ai/cx/support/procedures#gdpr-compliant-account-removal"
      target="_blank"
      className="inline-flex items-center gap-1 text-sm text-blue-600 underline hover:text-blue-300"
    >
      View GDPR Removal Handbook
      <ExternalLink size={14} />
    </a>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDeletionRequestStatus(value: unknown): value is DeletionRequestStatus {
  return (
    value === 'pending' ||
    value === 'in_progress' ||
    value === 'finalizing' ||
    value === 'completed' ||
    value === 'cancelled'
  );
}

function isDeletionStepStatus(value: unknown): value is DeletionStepStatus {
  return (
    value === 'pending' ||
    value === 'running' ||
    value === 'retry_wait' ||
    value === 'needs_attention' ||
    value === 'manual_action_required' ||
    value === 'succeeded' ||
    value === 'not_applicable' ||
    value === 'manually_verified'
  );
}

function parseDeletionRequest(value: unknown): DeletionRequest | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.id !== 'string' || !isDeletionRequestStatus(value.status)) {
    return null;
  }
  return {
    id: value.id,
    status: value.status,
    target_email: typeof value.target_email === 'string' ? value.target_email : null,
  };
}

function parseDeletionStep(value: unknown): DeletionStep | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.id !== 'string' || typeof value.step_key !== 'string') {
    return null;
  }
  if (!isDeletionStepStatus(value.status)) {
    return null;
  }
  return {
    id: value.id,
    step_key: value.step_key,
    status: value.status,
    last_error_code: typeof value.last_error_code === 'string' ? value.last_error_code : null,
  };
}

function parseSteps(value: unknown): DeletionStep[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const steps: DeletionStep[] = [];
  for (const item of value) {
    const step = parseDeletionStep(item);
    if (!step) {
      return null;
    }
    steps.push(step);
  }
  return steps;
}

function parseGetResponse(
  value: unknown
): { request: DeletionRequest | null; steps: DeletionStep[] } | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.request === null) {
    if (value.steps === undefined) {
      return { request: null, steps: [] };
    }
    const steps = parseSteps(value.steps);
    if (!steps) {
      return null;
    }
    return { request: null, steps };
  }
  const request = parseDeletionRequest(value.request);
  const steps = parseSteps(value.steps);
  if (!request || !steps) {
    return null;
  }
  return { request, steps };
}

function parseStartResponse(value: unknown): { requestId: string; status: string } | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.requestId !== 'string' || typeof value.status !== 'string') {
    return null;
  }
  return { requestId: value.requestId, status: value.status };
}

function readApiError(value: unknown, fallback: string): string {
  if (isRecord(value) && typeof value.error === 'string' && value.error.length > 0) {
    return value.error;
  }
  return fallback;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
