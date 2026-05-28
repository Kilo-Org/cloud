'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Brain, ExternalLink, RefreshCw, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import {
  REVIEW_MEMORY_RETENTION_COPY,
  REVIEW_MEMORY_RETENTION_DAYS,
  REVIEW_MEMORY_RETENTION_LABEL,
} from '@/lib/code-reviews/review-memory/retention';
import { useTRPC } from '@/lib/trpc/utils';
import { cn } from '@/lib/utils';
import type { ReviewMemoryProposalStatus } from '@kilocode/db/schema-types';

type Platform = 'github' | 'gitlab';

type ReviewMemoryPanelProps = {
  organizationId?: string;
  platform: Platform;
};

const ACTIVE_PROPOSAL_STATUSES: ReviewMemoryProposalStatus[] = [
  'open',
  'edited',
  'approved',
  'opening_change_request',
  'change_request_opened',
  'change_request_failed',
];

function readable(value: string) {
  return value.replace(/_/g, ' ');
}

export function ReviewMemoryPanel({ organizationId, platform }: ReviewMemoryPanelProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [rationale, setRationale] = useState('');
  const [proposedMarkdown, setProposedMarkdown] = useState('');

  const ownerInput = organizationId ? { organizationId, platform } : { platform };
  const proposalInput = { ...ownerInput, statuses: ACTIVE_PROPOSAL_STATUSES, limit: 50 };
  const summaryQuery = useQuery(trpc.reviewMemory.getDashboardSummary.queryOptions(ownerInput));
  const proposalsQuery = useQuery(trpc.reviewMemory.listProposals.queryOptions(proposalInput));
  const proposals = proposalsQuery.data ?? [];
  const selectedProposal =
    proposals.find(proposal => proposal.id === selectedProposalId) ?? proposals[0];
  const analysisRepo =
    summaryQuery.data?.repositories[0]?.repoFullName ?? selectedProposal?.repo_full_name;

  useEffect(() => {
    if (!selectedProposal) return;
    setSelectedProposalId(selectedProposal.id);
    setTitle(selectedProposal.title);
    setRationale(selectedProposal.rationale);
    setProposedMarkdown(selectedProposal.proposed_markdown);
    setIsEditing(false);
  }, [selectedProposal?.id]);

  const invalidateReviewMemory = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: trpc.reviewMemory.getDashboardSummary.queryKey(ownerInput),
      }),
      queryClient.invalidateQueries({
        queryKey: trpc.reviewMemory.listProposals.queryKey(proposalInput),
      }),
    ]);
  };

  const triggerAnalysis = useMutation(
    trpc.reviewMemory.triggerAnalysis.mutationOptions({
      onSuccess: async () => {
        toast.success('Review memory analysis queued');
        await invalidateReviewMemory();
      },
      onError: error => toast.error('Could not analyze feedback', { description: error.message }),
    })
  );
  const updateProposal = useMutation(
    trpc.reviewMemory.updateProposal.mutationOptions({
      onSuccess: async () => {
        toast.success('Memory proposal updated');
        setIsEditing(false);
        await invalidateReviewMemory();
      },
      onError: error => toast.error('Could not update proposal', { description: error.message }),
    })
  );
  const rejectProposal = useMutation(
    trpc.reviewMemory.rejectProposal.mutationOptions({
      onSuccess: async () => {
        toast.success('Memory proposal dismissed');
        await invalidateReviewMemory();
      },
      onError: error => toast.error('Could not dismiss proposal', { description: error.message }),
    })
  );
  const approveAndOpenChangeRequest = useMutation(
    trpc.reviewMemory.approveAndOpenChangeRequest.mutationOptions({
      onSuccess: async proposal => {
        toast.success(platform === 'github' ? 'Pull request opened' : 'Merge request opened', {
          description: proposal.change_request_url ?? undefined,
        });
        await invalidateReviewMemory();
      },
      onError: error =>
        toast.error('Could not open REVIEW.md change request', { description: error.message }),
    })
  );

  const isLoading = summaryQuery.isLoading || proposalsQuery.isLoading;
  const changeRequestLabel = platform === 'github' ? 'PR' : 'MR';

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1.5">
            <CardTitle className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-2">
                <Brain className="size-4" />
                Review memory
              </span>
              <Badge variant="outline" className="text-muted-foreground">
                {REVIEW_MEMORY_RETENTION_LABEL}
              </Badge>
            </CardTitle>
            <CardDescription className="max-w-2xl">
              Turn recurring reviewer feedback into proposed REVIEW.md guidance.
              {` ${REVIEW_MEMORY_RETENTION_COPY}`}
            </CardDescription>
          </div>
          <Button
            size="sm"
            variant="secondary"
            disabled={!analysisRepo || triggerAnalysis.isPending}
            onClick={() => {
              if (analysisRepo)
                triggerAnalysis.mutate({ ...ownerInput, repoFullName: analysisRepo });
            }}
          >
            {triggerAnalysis.isPending ? <RefreshCw className="animate-spin" /> : <Sparkles />}
            Analyze feedback
          </Button>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3">
          <Metric label="Open proposals" value={summaryQuery.data?.actionableProposalCount ?? 0} />
          <Metric
            label="Tracked repositories"
            value={summaryQuery.data?.repositories.length ?? 0}
          />
          <Metric
            label={`Fresh signals from the last ${REVIEW_MEMORY_RETENTION_DAYS} days`}
            value={
              summaryQuery.data?.states.reduce((sum, state) => sum + state.fresh_event_count, 0) ??
              0
            }
          />
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Proposals</CardTitle>
            <CardDescription>
              Review, edit, or dismiss learned guidance before applying it.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {isLoading ? (
              <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
                Loading memory...
              </div>
            ) : proposals.length === 0 ? (
              <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
                No proposals from retained feedback yet. Kilo waits for repeated, high-signal
                feedback before suggesting memory changes.
              </div>
            ) : (
              proposals.map(proposal => (
                <button
                  key={proposal.id}
                  type="button"
                  onClick={() => setSelectedProposalId(proposal.id)}
                  className={cn(
                    'w-full rounded-lg border p-4 text-left transition-colors hover:bg-accent/60 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none',
                    selectedProposal?.id === proposal.id
                      ? 'border-primary/60 bg-primary/5'
                      : 'border-border bg-background/40'
                  )}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{readable(proposal.proposal_type)}</Badge>
                    <Badge variant="outline" className="text-muted-foreground">
                      {readable(proposal.status)}
                    </Badge>
                  </div>
                  <div className="mt-3 font-medium">{proposal.title}</div>
                  <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                    {proposal.rationale}
                  </p>
                </button>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{selectedProposal ? selectedProposal.title : 'Proposal details'}</CardTitle>
            <CardDescription>
              {selectedProposal
                ? `${selectedProposal.negative_count} negative, ${selectedProposal.positive_count} positive, ${selectedProposal.neutral_count} neutral signals`
                : 'Select a proposal to review its guidance.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {selectedProposal ? (
              <>
                {isEditing ? (
                  <div className="space-y-3">
                    <Textarea
                      value={title}
                      onChange={event => setTitle(event.target.value)}
                      className="min-h-10"
                    />
                    <Textarea
                      value={rationale}
                      onChange={event => setRationale(event.target.value)}
                      className="min-h-24"
                    />
                    <Textarea
                      value={proposedMarkdown}
                      onChange={event => setProposedMarkdown(event.target.value)}
                      className="min-h-56 font-mono text-xs"
                    />
                  </div>
                ) : (
                  <div className="space-y-4">
                    <p className="text-sm text-muted-foreground">{selectedProposal.rationale}</p>
                    <pre className="max-h-80 overflow-auto rounded-lg border bg-background/60 p-4 text-xs whitespace-pre-wrap text-muted-foreground">
                      {selectedProposal.proposed_markdown}
                    </pre>
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  {isEditing ? (
                    <>
                      <Button size="sm" variant="secondary" onClick={() => setIsEditing(false)}>
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={updateProposal.isPending}
                        onClick={() => {
                          updateProposal.mutate({
                            ...ownerInput,
                            proposalId: selectedProposal.id,
                            title,
                            rationale,
                            proposedMarkdown,
                            scopeKind: selectedProposal.scope_kind,
                            scopeValue: selectedProposal.scope_value,
                          });
                        }}
                      >
                        Save edits
                      </Button>
                    </>
                  ) : (
                    <>
                      {selectedProposal.change_request_url ? (
                        <Button size="sm" variant="secondary" asChild>
                          <a
                            href={selectedProposal.change_request_url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            View {changeRequestLabel}
                            <ExternalLink className="size-4" />
                          </a>
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          disabled={
                            approveAndOpenChangeRequest.isPending ||
                            selectedProposal.status === 'opening_change_request'
                          }
                          onClick={() =>
                            approveAndOpenChangeRequest.mutate({
                              ...ownerInput,
                              proposalId: selectedProposal.id,
                            })
                          }
                        >
                          {selectedProposal.status === 'opening_change_request'
                            ? `Opening ${changeRequestLabel}...`
                            : selectedProposal.status === 'change_request_failed'
                              ? `Retry REVIEW.md ${changeRequestLabel}`
                              : `Open REVIEW.md ${changeRequestLabel}`}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={
                          selectedProposal.status === 'opening_change_request' ||
                          selectedProposal.status === 'change_request_opened'
                        }
                        onClick={() => setIsEditing(true)}
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={
                          rejectProposal.isPending ||
                          selectedProposal.status === 'opening_change_request' ||
                          selectedProposal.status === 'change_request_opened'
                        }
                        onClick={() =>
                          rejectProposal.mutate({ ...ownerInput, proposalId: selectedProposal.id })
                        }
                      >
                        Dismiss
                      </Button>
                    </>
                  )}
                </div>
              </>
            ) : (
              <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
                No memory proposal is selected.
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border bg-background/40 p-4">
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="text-sm text-muted-foreground">{label}</div>
    </div>
  );
}
