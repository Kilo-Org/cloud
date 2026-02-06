'use client';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Rocket, Loader2, ExternalLink } from 'lucide-react';
import { DEMO_SOURCE_REPO, type DemoConfig } from './demo-config';

type DemoSessionModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete: () => void;
  isLoading: boolean;
  demo: DemoConfig | null;
};

export function DemoSessionModal({
  open,
  onOpenChange,
  onComplete,
  isLoading,
  demo,
}: DemoSessionModalProps) {
  if (!demo) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Fork {DEMO_SOURCE_REPO}</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-3">
              <p>
                To try this demo, you&apos;ll need to fork the repository to your GitHub account.
              </p>
              <div className="bg-muted rounded-lg p-4">
                <ol className="list-inside list-decimal space-y-2 text-sm">
                  <li>Click the link below to open the GitHub fork page</li>
                  <li>Click the &quot;Create fork&quot; button on GitHub</li>
                  <li>Come back here and click &quot;Done. Let&apos;s Go!&quot; when finished</li>
                </ol>
              </div>
              <a
                href={`https://github.com/${DEMO_SOURCE_REPO}/fork`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm text-blue-400 underline hover:text-blue-300"
              >
                Open fork page on GitHub
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isLoading}>
            Cancel
          </Button>
          <Button onClick={onComplete} disabled={isLoading}>
            {isLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Checking for fork...
              </>
            ) : (
              <>
                <Rocket className="mr-2 h-4 w-4" />
                Done. Let&apos;s Go!
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
