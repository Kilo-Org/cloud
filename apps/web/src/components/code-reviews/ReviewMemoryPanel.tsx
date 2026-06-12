'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Brain, ExternalLink, GitPullRequest, Loader2, RefreshCw } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useTRPC } from '@/lib/trpc/utils';

type ReviewMemoryPanelProps = {
  organizationId?: string;
  platform: 'github';
};

const ACTIVE_PROPOSAL_STATUSES = [
  'open',
  'edited',
  'opening_change_request',
  'change_request_opened',
  'change_request_failed',
] as const;

const statusLabels: Record<(typeof ACTIVE_PROPOSAL_STATUSES)[number], string> = {
  open: 'Open',
  edited: 'Edited',
  opening_change_request: 'Opening PR',
  change_request_opened: 'PR opened',
  change_request_failed: 'PR failed',
};

export function ReviewMemoryPanel({ organizationId, platform }: ReviewMemoryPanelProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const ownerInput = organizationId ? { organizationId, platform } : { platform };
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editRationale, setEditRationale] = useState('');
  const [editMarkdown, setEditMarkdown] = useState('');

  const summaryQuery = useQuery(trpc.reviewMemory.getDashboardSummary.queryOptions(ownerInput));
  const proposalsQuery = useQuery(
    trpc.reviewMemory.listProposals.queryOptions({
      ...ownerInput,
      statuses: [...ACTIVE_PROPOSAL_STATUSES],
      limit: 50,
    })
  );

  const summary = summaryQuery.data;
  const memoryEnabled = summary?.enabled ?? false;
  const repositories = summary?.repositories ?? [];
  const proposals = proposalsQuery.data ?? [];
  const selectedProposal = proposals.find(proposal => proposal.id === selectedProposalId) ?? null;
  const canEditSelectedProposal = selectedProposal
    ? selectedProposal.status === 'open' ||
      selectedProposal.status === 'edited' ||
      selectedProposal.status === 'change_request_failed'
    : false;
  const canOpenChangeRequest = selectedProposal
    ? selectedProposal.status === 'open' ||
      selectedProposal.status === 'edited' ||
      selectedProposal.status === 'change_request_failed'
    : false;

  useEffect(() => {
    if (!selectedRepo && repositories[0]) {
      setSelectedRepo(repositories[0].repoFullName);
      return;
    }
    if (
      selectedRepo &&
      repositories.length > 0 &&
      !repositories.some(repo => repo.repoFullName === selectedRepo)
    ) {
      setSelectedRepo(repositories[0].repoFullName);
    }
  }, [repositories, selectedRepo]);

  useEffect(() => {
    if (!selectedProposalId && proposals[0]) {
      setSelectedProposalId(proposals[0].id);
      return;
    }
    if (
      selectedProposalId &&
      proposals.length > 0 &&
      !proposals.some(proposal => proposal.id === selectedProposalId)
    ) {
      setSelectedProposalId(proposals[0].id);
    }
  }, [proposals, selectedProposalId]);

  useEffect(() => {
    if (!selectedProposal) {
      setEditTitle('');
      setEditRationale('');
      setEditMarkdown('');
      return;
    }
    setEditTitle(selectedProposal.title);
    setEditRationale(selectedProposal.rationale);
    setEditMarkdown(selectedProposal.proposed_markdown);
  }, [selectedProposal]);

  const invalidateReviewMemory = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: trpc.reviewMemory.getDashboardSummary.queryKey(ownerInput),
      }),
      queryClient.invalidateQueries({
        queryKey: trpc.reviewMemory.listProposals.queryKey({
          ...ownerInput,
          statuses: [...ACTIVE_PROPOSAL_STATUSES],
          limit: 50,
        }),
      }),
      queryClient.invalidateQueries({
        queryKey: organizationId
          ? trpc.organizations.reviewAgent.getReviewConfig.queryKey({ organizationId, platform })
          : trpc.personalReviewAgent.getReviewConfig.queryKey({ platform }),
      }),
    ]);
  };

  const setEnabledMutation = useMutation(
    trpc.reviewMemory.setEnabled.mutationOptions({
      onSuccess: async data => {
        toast.success(data.enabled ? 'Review memory enabled' : 'Review memory disabled');
        await invalidateReviewMemory();
      },
      onError: error => {
        toast.error('Failed to update review memory', { description: error.message });
      },
    })
  );

  const triggerAnalysisMutation = useMutation(
    trpc.reviewMemory.triggerAnalysis.mutationOptions({
      onSuccess: async data => {
        if (data.status === 'proposed') {
          toast.success('Review memory proposal created');
        } else if (data.status === 'no_feedback') {
          toast.info('No recent feedback found for this repository');
        } else {
          toast.info('No clear repeated pattern found');
        }
        if (data.proposalId) setSelectedProposalId(data.proposalId);
        await invalidateReviewMemory();
      },
      onError: error => {
        toast.error('Analysis failed', { description: error.message });
      },
    })
  );

  const updateProposalMutation = useMutation(
    trpc.reviewMemory.updateProposal.mutationOptions({
      onSuccess: async proposal => {
        toast.success('Proposal saved');
        setSelectedProposalId(proposal.id);
        await invalidateReviewMemory();
      },
      onError: error => {
        toast.error('Failed to save proposal', { description: error.message });
      },
    })
  );

  const rejectProposalMutation = useMutation(
    trpc.reviewMemory.rejectProposal.mutationOptions({
      onSuccess: async () => {
        toast.success('Proposal dismissed');
        setSelectedProposalId(null);
        await invalidateReviewMemory();
      },
      onError: error => {
        toast.error('Failed to dismiss proposal', { description: error.message });
      },
    })
  );

  const approveProposalMutation = useMutation(
    trpc.reviewMemory.approveAndOpenChangeRequest.mutationOptions({
      onSuccess: async proposal => {
        if (proposal.status === 'superseded') {
          toast.success('Guidance is already present in REVIEW.md');
        } else {
          toast.success('REVIEW.md PR opened');
        }
        setSelectedProposalId(proposal.id);
        await invalidateReviewMemory();
      },
      onError: error => {
        toast.error('Failed to open REVIEW.md PR', { description: error.message });
      },
    })
  );

  const handleAnalyze = () => {
    if (!selectedRepo) return;
    triggerAnalysisMutation.mutate({ ...ownerInput, repoFullName: selectedRepo });
  };

  const handleSaveEdits = () => {
    if (!selectedProposal) return;
    updateProposalMutation.mutate({
      ...ownerInput,
      proposalId: selectedProposal.id,
      title: editTitle,
      rationale: editRationale,
      proposedMarkdown: editMarkdown,
    });
  };

  const handleDismiss = () => {
    if (!selectedProposal) return;
    rejectProposalMutation.mutate({ ...ownerInput, proposalId: selectedProposal.id });
  };

  const handleOpenChangeRequest = () => {
    if (!selectedProposal) return;
    approveProposalMutation.mutate({ ...ownerInput, proposalId: selectedProposal.id });
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Brain className="h-5 w-5" />
            Review memory
          </CardTitle>
          <CardDescription>
            Learn from maintainer replies to Kilo review comments and propose editable REVIEW.md
            guidance.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <Label htmlFor="review-memory-enabled">Enable review memory</Label>
            <p className="text-muted-foreground text-sm">
              Disabled by default. When enabled, Kilo records the first maintainer reply to each
              Kilo inline review comment.
            </p>
          </div>
          <Switch
            id="review-memory-enabled"
            checked={memoryEnabled}
            disabled={setEnabledMutation.isPending || summaryQuery.isLoading}
            onCheckedChange={enabled => setEnabledMutation.mutate({ ...ownerInput, enabled })}
            aria-label="Enable review memory"
          />
        </CardContent>
      </Card>

      {memoryEnabled && (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <RefreshCw className="h-5 w-5" />
                Analyze feedback
              </CardTitle>
              <CardDescription>
                Pick a repository with recent replies, then ask the model to look for one repeated
                guidance pattern.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 md:flex-row md:items-end">
              <div className="min-w-0 flex-1 space-y-2">
                <Label>Repository</Label>
                <Select
                  value={selectedRepo ?? undefined}
                  onValueChange={setSelectedRepo}
                  disabled={repositories.length === 0}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="No recent feedback" />
                  </SelectTrigger>
                  <SelectContent>
                    {repositories.map(repo => (
                      <SelectItem key={repo.repoFullName} value={repo.repoFullName}>
                        {repo.repoFullName} ({repo.feedbackCount} replies)
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                type="button"
                onClick={handleAnalyze}
                disabled={!selectedRepo || triggerAnalysisMutation.isPending}
              >
                {triggerAnalysisMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                Analyze now
              </Button>
            </CardContent>
          </Card>

          <div className="grid gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
            <Card>
              <CardHeader>
                <CardTitle>Proposals</CardTitle>
                <CardDescription>
                  {summary?.openProposalCount ?? 0} open proposal
                  {(summary?.openProposalCount ?? 0) === 1 ? '' : 's'}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {proposals.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    No proposals yet. Analyze recent feedback to create one.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {proposals.map(proposal => (
                      <button
                        key={proposal.id}
                        type="button"
                        onClick={() => setSelectedProposalId(proposal.id)}
                        className={`hover:bg-muted/50 w-full rounded-lg border p-3 text-left transition-colors ${
                          proposal.id === selectedProposalId ? 'bg-muted/50' : ''
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 space-y-1">
                            <p className="truncate text-sm font-medium">{proposal.title}</p>
                            <p className="text-muted-foreground truncate text-xs">
                              {proposal.repo_full_name}
                            </p>
                          </div>
                          <StatusBadge status={proposal.status} />
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Proposal details</CardTitle>
                <CardDescription>
                  Review evidence, edit the guidance, then open a separate REVIEW.md PR.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {!selectedProposal ? (
                  <p className="text-muted-foreground text-sm">Select a proposal to review it.</p>
                ) : (
                  <div className="space-y-5">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={selectedProposal.status} />
                      <Badge
                        variant="outline"
                        className="bg-red-500/10 text-red-400 ring-1 ring-red-500/20"
                      >
                        {selectedProposal.negative_count} negative
                      </Badge>
                      <Badge
                        variant="outline"
                        className="bg-green-500/10 text-green-400 ring-1 ring-green-500/20"
                      >
                        {selectedProposal.positive_count} positive
                      </Badge>
                      <Badge
                        variant="outline"
                        className="bg-zinc-500/10 text-zinc-400 ring-1 ring-zinc-500/20"
                      >
                        {selectedProposal.neutral_count} neutral
                      </Badge>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="review-memory-title">Title</Label>
                      <Textarea
                        id="review-memory-title"
                        value={editTitle}
                        onChange={event => setEditTitle(event.target.value)}
                        disabled={!canEditSelectedProposal}
                        rows={2}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="review-memory-rationale">Rationale</Label>
                      <Textarea
                        id="review-memory-rationale"
                        value={editRationale}
                        onChange={event => setEditRationale(event.target.value)}
                        disabled={!canEditSelectedProposal}
                        rows={4}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="review-memory-markdown">Proposed REVIEW.md guidance</Label>
                      <Textarea
                        id="review-memory-markdown"
                        value={editMarkdown}
                        onChange={event => setEditMarkdown(event.target.value)}
                        disabled={!canEditSelectedProposal}
                        rows={8}
                        className="font-mono text-xs"
                      />
                    </div>

                    <div className="space-y-2">
                      <h4 className="text-sm font-medium">Evidence excerpts</h4>
                      {selectedProposal.evidence.length === 0 ? (
                        <p className="text-muted-foreground text-sm">No evidence excerpts saved.</p>
                      ) : (
                        <div className="space-y-2">
                          {selectedProposal.evidence.map((item, index) => {
                            const prLabel = item.prNumber ? `PR #${item.prNumber}` : 'PR unknown';
                            const prUrl = item.prNumber
                              ? `https://github.com/${selectedProposal.repo_full_name}/pull/${item.prNumber}`
                              : null;
                            const content = (
                              <>
                                <div className="text-muted-foreground mb-1 flex items-center gap-1 text-xs">
                                  {prLabel}
                                  {prUrl && <ExternalLink className="h-3 w-3" aria-hidden="true" />}
                                </div>
                                <p className="text-sm whitespace-pre-wrap">{item.excerpt}</p>
                              </>
                            );

                            return prUrl ? (
                              <a
                                key={`${item.prNumber}-${index}`}
                                href={prUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="bg-muted/30 hover:bg-muted/50 focus-visible:ring-ring/50 block rounded-lg border p-3 transition-colors focus-visible:ring-[3px] focus-visible:outline-none"
                              >
                                {content}
                              </a>
                            ) : (
                              <div
                                key={`pr-${index}`}
                                className="bg-muted/30 rounded-lg border p-3"
                              >
                                {content}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={handleSaveEdits}
                        disabled={!canEditSelectedProposal || updateProposalMutation.isPending}
                      >
                        {updateProposalMutation.isPending && (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        )}
                        Save edits
                      </Button>
                      {selectedProposal.change_request_url && (
                        <Button asChild variant="outline">
                          <a
                            href={selectedProposal.change_request_url}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            <ExternalLink className="h-4 w-4" />
                            View PR
                          </a>
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={handleOpenChangeRequest}
                        disabled={!canOpenChangeRequest || approveProposalMutation.isPending}
                      >
                        {approveProposalMutation.isPending ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <GitPullRequest className="h-4 w-4" />
                        )}
                        Open REVIEW.md PR
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={handleDismiss}
                        disabled={!canEditSelectedProposal || rejectProposalMutation.isPending}
                      >
                        Dismiss
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const label = status in statusLabels ? statusLabels[status as keyof typeof statusLabels] : status;
  const className =
    status === 'change_request_failed'
      ? 'bg-red-500/10 text-red-400 ring-1 ring-red-500/20'
      : status === 'change_request_opened'
        ? 'bg-green-500/10 text-green-400 ring-1 ring-green-500/20'
        : status === 'opening_change_request'
          ? 'bg-yellow-500/10 text-yellow-400 ring-1 ring-yellow-500/20'
          : 'bg-blue-500/10 text-blue-400 ring-1 ring-blue-500/20';

  return (
    <Badge variant="outline" className={className}>
      {label}
    </Badge>
  );
}
