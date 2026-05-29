'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useGastownTRPC } from '@/lib/gastown/trpc';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/Button';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { ExternalLink, GitBranch, GitPullRequest, Loader2, AlertTriangle } from 'lucide-react';

type BabysitPrPanelProps = {
  rigId: string;
  onClose: () => void;
};

const HTTPS_URL_RE = /^https:\/\/.+/;

export type PreviewPrResult = {
  state: string;
  head_branch?: string;
  base_branch?: string;
  head_sha?: string;
  title?: string;
  repo_matches: boolean;
};

export function BabysitPrPanel({ rigId, onClose }: BabysitPrPanelProps) {
  const trpc = useGastownTRPC();
  const queryClient = useQueryClient();

  const [prUrl, setPrUrl] = useState('');
  const [debouncedUrl, setDebouncedUrl] = useState('');
  const [titleOverride, setTitleOverride] = useState('');
  const [bodyOverride, setBodyOverride] = useState('');
  const [forcePushAllowed, setForcePushAllowed] = useState(false);
  const [userEditedTitle, setUserEditedTitle] = useState(false);
  const [userEditedBody, setUserEditedBody] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    if (!prUrl.trim() || !HTTPS_URL_RE.test(prUrl.trim())) {
      setDebouncedUrl('');
      return;
    }
    debounceRef.current = setTimeout(() => {
      setDebouncedUrl(prUrl.trim());
    }, 500);
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [prUrl]);

  const previewQuery = useQuery(
    trpc.gastown.previewPr.queryOptions(
      { rigId, prUrl: debouncedUrl },
      {
        enabled: debouncedUrl.length > 0,
        retry: false,
      }
    )
  );

  const preview = previewQuery.data as PreviewPrResult | undefined;
  const previewError = previewQuery.error;
  const defaultTitle = preview?.title ? `Babysit: ${preview.title}` : '';
  const defaultBody = preview ? `Monitoring PR: ${prUrl.trim()}` : '';

  useEffect(() => {
    if (!userEditedTitle) setTitleOverride(defaultTitle);
  }, [defaultTitle, userEditedTitle]);

  useEffect(() => {
    if (!userEditedBody) setBodyOverride(defaultBody);
  }, [defaultBody, userEditedBody]);

  const isValidUrl = HTTPS_URL_RE.test(prUrl.trim());
  const isPreviewReady = !!preview && preview.repo_matches && preview.state === 'open';
  const isRepoMismatch = !!preview && !preview.repo_matches;
  const isPrClosed =
    !!preview && preview.repo_matches && preview.state !== 'open' && preview.state !== 'unknown';

  const babysitPr = useMutation(
    trpc.gastown.babysitPr.mutationOptions({
      onSuccess: result => {
        void queryClient.invalidateQueries({ queryKey: trpc.gastown.listBeads.queryKey() });
        void queryClient.invalidateQueries({ queryKey: trpc.gastown.listAgents.queryKey() });
        void queryClient.invalidateQueries({ queryKey: trpc.gastown.getRig.queryKey() });
        const msg = result.warning
          ? `Babysit started — ${result.warning}`
          : 'Babysit started — PR will be polled automatically';
        toast.success(msg);
        onClose();
      },
      onError: err => {
        toast.error(err.message);
      },
    })
  );

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!isPreviewReady) return;
      babysitPr.mutate({
        rigId,
        prUrl: prUrl.trim(),
        title: titleOverride.trim() || undefined,
        body: bodyOverride.trim() || undefined,
        forcePushAllowed,
      });
    },
    [isPreviewReady, babysitPr, rigId, prUrl, titleOverride, bodyOverride, forcePushAllowed]
  );

  return (
    <form onSubmit={handleSubmit}>
      <div className="space-y-4 py-4">
        <div>
          <label className="mb-2 block text-sm font-medium text-white/70">PR URL</label>
          <Input
            value={prUrl}
            onChange={e => setPrUrl(e.target.value)}
            placeholder="https://github.com/owner/repo/pull/123"
            autoFocus
            className="border-white/10 bg-black/25"
          />
          {prUrl && !isValidUrl && (
            <p className="mt-1 text-xs text-red-400">Enter a valid https:// URL</p>
          )}
        </div>

        {previewQuery.isLoading && debouncedUrl && (
          <div className="flex items-center gap-2 text-xs text-white/40">
            <Loader2 className="size-3 animate-spin" />
            Loading PR preview...
          </div>
        )}

        {previewError && debouncedUrl && !previewQuery.isLoading && (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
            Failed to load PR preview: {previewError.message}
          </div>
        )}

        {isRepoMismatch && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            <div className="flex items-center gap-1.5">
              <AlertTriangle className="size-3.5 shrink-0" />
              This PR belongs to a different repository than the rig. Cannot babysit.
            </div>
          </div>
        )}

        {isPrClosed && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            <div className="flex items-center gap-1.5">
              <AlertTriangle className="size-3.5 shrink-0" />
              This PR is {preview.state}. Only open PRs can be babysat.
            </div>
          </div>
        )}

        {preview && preview.repo_matches && preview.state !== 'unknown' && !isRepoMismatch && (
          <div className="rounded-md border border-white/[0.08] bg-white/[0.03] px-3 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <GitPullRequest className="size-3.5 shrink-0 text-[color:oklch(95%_0.15_108)]" />
                  <span className="truncate text-sm font-medium text-white/90">
                    {preview.title ?? 'Untitled PR'}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2 text-[11px] text-white/40">
                  {preview.head_branch && (
                    <span className="inline-flex items-center gap-0.5">
                      <GitBranch className="size-3" />
                      {preview.head_branch}
                    </span>
                  )}
                  {preview.head_branch && preview.base_branch && <span>&rarr;</span>}
                  {preview.base_branch && <span>{preview.base_branch}</span>}
                </div>
              </div>
              <Badge
                variant="outline"
                className={`shrink-0 text-[10px] ${
                  preview.state === 'open'
                    ? 'border-emerald-500/30 text-emerald-400'
                    : 'border-white/10 text-white/50'
                }`}
              >
                {preview.state}
              </Badge>
            </div>
            <a
              href={prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-[color:oklch(95%_0.15_108)] hover:underline"
            >
              <ExternalLink className="size-3" />
              View Pull Request
            </a>
          </div>
        )}

        <div>
          <label className="mb-2 block text-sm font-medium text-white/70">
            Title override (optional)
          </label>
          <Input
            value={titleOverride}
            onChange={e => {
              setTitleOverride(e.target.value);
              setUserEditedTitle(true);
            }}
            placeholder={defaultTitle || 'Babysit: <PR title>'}
            className="border-white/10 bg-black/25"
          />
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium text-white/70">
            Body override (optional)
          </label>
          <Textarea
            value={bodyOverride}
            onChange={e => {
              setBodyOverride(e.target.value);
              setUserEditedBody(true);
            }}
            placeholder={defaultBody || 'Monitoring PR: <url>'}
            rows={3}
            className="border-white/10 bg-black/25"
          />
        </div>

        <div>
          <label className="flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              checked={forcePushAllowed}
              onChange={e => setForcePushAllowed(e.target.checked)}
              className="mt-0.5 size-4 cursor-pointer rounded border-white/20 bg-white/5 accent-[color:oklch(0.95_0.15_108)]"
            />
            <div>
              <span className="text-sm text-white/75">Allow force-push</span>
              <p className="mt-0.5 text-xs text-white/35">
                Allow polecats to force-push to the PR branch when fixing conflicts or addressing
                review comments. Only check this if you own the branch or the PR author has
                explicitly consented. When unchecked, polecats will use merge commits and regular
                pushes only.
              </p>
            </div>
          </label>
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="secondary" size="md" type="button" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="md"
          type="submit"
          disabled={!isValidUrl || !isPreviewReady || babysitPr.isPending}
          className="bg-[color:oklch(95%_0.15_108_/_0.90)] text-black hover:bg-[color:oklch(95%_0.15_108_/_0.95)]"
        >
          {babysitPr.isPending ? (
            <>
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
              Starting...
            </>
          ) : (
            'Babysit PR'
          )}
        </Button>
      </div>
    </form>
  );
}
