'use client';

import { useMemo, useState } from 'react';
import { ExternalLink, Check } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export type ConvertibleRepository = {
  id: number | string;
  full_name: string;
};

type ReviewMdConversionDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId?: string;
  platform: 'github' | 'gitlab';
  repositories: ConvertibleRepository[];
};

function buildConversionHref(input: {
  organizationId?: string;
  platform: 'github' | 'gitlab';
  repoFullName: string;
}): string {
  const params = new URLSearchParams({
    platform: input.platform,
    repo: input.repoFullName,
  });
  if (input.organizationId) {
    params.set('organizationId', input.organizationId);
  }
  return `/cloud-agent-fork/review-md?${params.toString()}`;
}

/**
 * Repository picker for the Custom Instructions -> REVIEW.md conversion (PoC).
 *
 * Each repository is started by its own link click rather than by one "go"
 * button that opens N tabs: `window.open` only survives popup blocking inside a
 * live user gesture, and awaiting N session creations spends that gesture, so a
 * loop would open the first tab and silently lose the rest. One link per
 * repository also means a sandbox is only spent on repositories the user
 * actually pursues.
 */
export function ReviewMdConversionDialog({
  open,
  onOpenChange,
  organizationId,
  platform,
  repositories,
}: ReviewMdConversionDialogProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [startedIds, setStartedIds] = useState<Set<string>>(new Set());

  const sortedRepositories = useMemo(
    () => [...repositories].sort((a, b) => a.full_name.localeCompare(b.full_name)),
    [repositories]
  );

  const selectedRepositories = sortedRepositories.filter(repo => selectedIds.has(String(repo.id)));

  function toggleRepository(repositoryId: string, checked: boolean) {
    setSelectedIds(previous => {
      const next = new Set(previous);
      if (checked) next.add(repositoryId);
      else next.delete(repositoryId);
      return next;
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Convert Custom Instructions to REVIEW.md</DialogTitle>
          <DialogDescription>
            Kilo starts a cloud agent session for each repository you pick. The agent writes your
            Custom Instructions into REVIEW.md, merging with the file if one already exists, and
            opens a {platform === 'gitlab' ? 'merge request' : 'pull request'} for you to review.
          </DialogDescription>
        </DialogHeader>

        {sortedRepositories.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No repositories available. Select repositories under Advanced Settings first.
          </p>
        ) : (
          <div className="space-y-4">
            <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border p-2">
              {sortedRepositories.map(repo => {
                const repositoryId = String(repo.id);
                const isSelected = selectedIds.has(repositoryId);
                const isStarted = startedIds.has(repositoryId);

                return (
                  <div
                    key={repositoryId}
                    className="hover:bg-muted/50 flex items-center justify-between gap-3 rounded-sm px-2 py-1.5"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <Checkbox
                        id={`convert-${repositoryId}`}
                        checked={isSelected}
                        onCheckedChange={checked =>
                          toggleRepository(repositoryId, checked === true)
                        }
                      />
                      <label
                        htmlFor={`convert-${repositoryId}`}
                        className="cursor-pointer truncate text-sm"
                      >
                        {repo.full_name}
                      </label>
                    </div>

                    {isSelected && (
                      <a
                        href={buildConversionHref({
                          organizationId,
                          platform,
                          repoFullName: repo.full_name,
                        })}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={() =>
                          setStartedIds(previous => new Set(previous).add(repositoryId))
                        }
                        className="text-primary inline-flex shrink-0 items-center gap-1.5 text-sm underline-offset-2 hover:underline"
                      >
                        {isStarted ? (
                          <>
                            <Check className="size-3.5" aria-hidden="true" />
                            Started — open again
                          </>
                        ) : (
                          <>
                            <ExternalLink className="size-3.5" aria-hidden="true" />
                            Start conversion
                          </>
                        )}
                      </a>
                    )}
                  </div>
                );
              })}
            </div>

            <p className="text-muted-foreground text-sm">
              {selectedRepositories.length === 0
                ? 'Select one or more repositories to get a start link for each.'
                : `Start each repository from its own link — every one opens its own agent session in a new tab. ${startedIds.size} of ${selectedRepositories.length} started.`}
            </p>

            <p className="text-muted-foreground text-sm">
              Your Custom Instructions stay in this config until you clear them yourself. Once a
              pull request is merged, delete the text above and save so reviews stop applying it
              twice.
            </p>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
