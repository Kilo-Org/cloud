'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import { AlertTriangle, Trash2, Loader2 } from 'lucide-react';

type OrphanedRepository = {
  repoFullName: string;
  findingCount: number;
};

type ClearFindingsCardProps = {
  orphanedRepositories: OrphanedRepository[];
  onDeleteFindings: (repoFullName: string) => void;
  isDeleting: boolean;
};

export function ClearFindingsCard({
  orphanedRepositories,
  onDeleteFindings,
  isDeleting,
}: ClearFindingsCardProps) {
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);

  // Don't render if there are no orphaned repositories
  if (orphanedRepositories.length === 0) {
    return null;
  }

  const selectedRepoData = orphanedRepositories.find(r => r.repoFullName === selectedRepo);

  const handleDeleteClick = () => {
    if (selectedRepo) {
      setConfirmDialogOpen(true);
    }
  };

  const handleConfirmDelete = () => {
    if (selectedRepo) {
      onDeleteFindings(selectedRepo);
      setConfirmDialogOpen(false);
      setSelectedRepo(null);
    }
  };

  return (
    <>
      <Card className="w-full border-yellow-500/50">
        <CardHeader className="pb-3">
          <div className="flex items-center space-x-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-yellow-500/20">
              <AlertTriangle className="h-5 w-5 text-yellow-400" />
            </div>
            <div>
              <CardTitle className="text-lg font-bold">Clear Orphaned Findings</CardTitle>
              <p className="text-muted-foreground text-xs">
                Remove findings from repositories no longer accessible via GitHub
              </p>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3">
            <p className="text-sm text-yellow-200">
              The following repositories have security findings but are no longer accessible via
              your GitHub integration. This can happen when the GitHub App is reinstalled with
              different repository access, or when repositories are removed from the integration.
            </p>
          </div>

          <div className="space-y-3">
            <label className="text-sm font-medium">Select repository to clear</label>
            <Select value={selectedRepo ?? ''} onValueChange={setSelectedRepo}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select a repository..." />
              </SelectTrigger>
              <SelectContent>
                {orphanedRepositories.map(repo => (
                  <SelectItem key={repo.repoFullName} value={repo.repoFullName}>
                    <span className="flex items-center gap-2">
                      <span>{repo.repoFullName}</span>
                      <span className="text-muted-foreground text-xs">
                        ({repo.findingCount} {repo.findingCount === 1 ? 'finding' : 'findings'})
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex justify-end">
            <Button
              variant="destructive"
              onClick={handleDeleteClick}
              disabled={!selectedRepo || isDeleting}
            >
              {isDeleting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="mr-2 h-4 w-4" />
              )}
              {isDeleting ? 'Deleting...' : 'Delete Findings'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Confirmation Dialog */}
      <Dialog open={confirmDialogOpen} onOpenChange={setConfirmDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-red-500" />
              Delete Security Findings?
            </DialogTitle>
            <DialogDescription>
              This action cannot be undone. All security findings for this repository will be
              permanently deleted.
            </DialogDescription>
          </DialogHeader>

          <div className="py-4">
            <div className="bg-muted/50 rounded-lg border p-3">
              <p className="text-sm font-medium">{selectedRepo}</p>
              {selectedRepoData && (
                <p className="text-muted-foreground text-xs">
                  {selectedRepoData.findingCount}{' '}
                  {selectedRepoData.findingCount === 1 ? 'finding' : 'findings'} will be deleted
                </p>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmDialogOpen(false)}
              disabled={isDeleting}
            >
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleConfirmDelete} disabled={isDeleting}>
              {isDeleting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Deleting...
                </>
              ) : (
                'Delete Findings'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
