'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useTRPC } from '@/lib/trpc/utils';
import type {
  RepositoryAccessChange,
  RepositoryAccessMode,
} from '@kilocode/worker-utils/workspace-repository-access';
import { RepositoryPicker, type RepositoryOption } from './settings/RepositoryPicker';
import {
  repositoryAccessErrorMessage,
  repositoryAccessResultMessage,
  repositoryAccessTransition,
} from './repository-access-state';

export function RepositoryAccessDialog({
  open,
  onOpenChange,
  sessionId,
  organizationId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  organizationId?: string;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const accessOptions = organizationId
    ? trpc.organizations.cloudAgentNext.getRepositoryAccess.queryOptions(
        { sessionId, organizationId },
        { enabled: open }
      )
    : trpc.cloudAgentNext.getRepositoryAccess.queryOptions({ sessionId }, { enabled: open });
  const access = useQuery(accessOptions);
  const personal = useMutation(trpc.cloudAgentNext.changeRepositoryAccess.mutationOptions());
  const organization = useMutation(
    trpc.organizations.cloudAgentNext.changeRepositoryAccess.mutationOptions()
  );
  const [draft, setDraft] = useState<RepositoryOption | null>(null);
  const [mode, setMode] = useState<RepositoryAccessMode>('read');
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const busy = personal.isPending || organization.isPending;
  const save = async (repositoryId: number, next: RepositoryAccessMode | 'remove') => {
    if (!access.data) return;
    const current = access.data.repositories.find(repo => repo.repositoryId === repositoryId);
    if (repositoryAccessTransition(current?.mode, next) === 'unchanged') return;
    const input: RepositoryAccessChange = {
      sessionId,
      repositoryId,
      mode: next,
      expectedRevision: access.data.revision,
    };
    setMessage('');
    try {
      const result = organizationId
        ? await organization.mutateAsync({ ...input, organizationId })
        : await personal.mutateAsync(input);
      queryClient.setQueryData(accessOptions.queryKey, result.current);
      setFailed(!result.changed);
      setMessage(repositoryAccessResultMessage(result.changed));
      if (result.changed) setDraft(null);
      await access.refetch();
    } catch (error) {
      setFailed(true);
      setMessage(repositoryAccessErrorMessage(error));
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Repository access</DialogTitle>
          <DialogDescription>
            All chats and processes in this workspace share this access.
          </DialogDescription>
        </DialogHeader>
        <p className="text-muted-foreground text-sm">
          Contribute permits pushes across the repository, subject to GitHub rules. Removing access
          leaves downloaded files in this workspace.
        </p>
        {access.isPending && (
          <p role="status" className="text-sm">
            Loading repository access...
          </p>
        )}
        {access.isError && (
          <div role="alert" className="text-destructive text-sm">
            Repository access is unavailable.{' '}
            <Button variant="link" onClick={() => void access.refetch()}>
              Retry
            </Button>
          </div>
        )}
        <div className="max-h-72 space-y-3 overflow-y-auto">
          {access.data?.repositories.map(repo => (
            <div key={repo.repositoryId} className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 break-all text-sm">
                {repo.owner}/{repo.name}
              </span>
              <Select
                value={repo.mode}
                disabled={busy}
                onValueChange={value => {
                  if (value === 'read' || value === 'contribute')
                    void save(repo.repositoryId, value);
                }}
              >
                <SelectTrigger
                  className="h-9 w-32"
                  aria-label={`Access for ${repo.owner}/${repo.name}`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="read">Read</SelectItem>
                  <SelectItem value="contribute">Contribute</SelectItem>
                </SelectContent>
              </Select>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void save(repo.repositoryId, 'remove')}
                aria-label={`Remove access to ${repo.owner}/${repo.name}`}
              >
                Remove
              </Button>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <RepositoryPicker
            organizationId={organizationId}
            githubOnly
            listed={(access.data?.repositories ?? []).map(repo => ({
              repositoryFullName: `${repo.owner}/${repo.name}`,
              repositoryPlatform: 'github',
            }))}
            disabled={busy || !access.data}
            onSelect={repository => {
              setDraft(repository);
              setMode('read');
              setMessage('');
            }}
          />
          {draft && (
            <>
              <span className="min-w-0 break-all text-sm">{draft.fullName}</span>
              <Select
                value={mode}
                onValueChange={value => {
                  if (value === 'read' || value === 'contribute') setMode(value);
                }}
                disabled={busy}
              >
                <SelectTrigger className="h-9 w-32" aria-label="New repository access">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="read">Read</SelectItem>
                  <SelectItem value="contribute">Contribute</SelectItem>
                </SelectContent>
              </Select>
              <Button
                disabled={busy || !draft.repositoryId}
                onClick={() => {
                  if (draft.repositoryId) void save(draft.repositoryId, mode);
                }}
              >
                {busy ? 'Saving...' : 'Add access'}
              </Button>
            </>
          )}
        </div>
        {message && (
          <p
            role={failed ? 'alert' : 'status'}
            className={failed ? 'text-destructive text-sm' : 'text-sm'}
          >
            {message}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
