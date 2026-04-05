/**
 * Clone Dialog
 *
 * Dialog component that generates a read-only git clone token and displays
 * the git clone command with token expiration time.
 */

'use client';

import { useState, useCallback } from 'react';
import { useMutation } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { Copy, Check, GitBranch, Loader2, Clock } from 'lucide-react';
import { useTRPC } from '@/lib/trpc/utils';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

type CloneDialogProps = {
  projectId: string;
  organizationId?: string;
  disabled?: boolean;
};

type CloneTokenResult = {
  token: string;
  gitUrl: string;
  expiresAt: string;
};

export function CloneDialog({ projectId, organizationId, disabled }: CloneDialogProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [tokenData, setTokenData] = useState<CloneTokenResult | null>(null);

  const trpc = useTRPC();

  const {
    mutate: personalMutate,
    isPending: personalIsPending,
    error: personalError,
  } = useMutation(
    trpc.appBuilder.generateCloneToken.mutationOptions({
      onSuccess: (data: CloneTokenResult) => {
        setTokenData(data);
      },
    })
  );

  const {
    mutate: orgMutate,
    isPending: orgIsPending,
    error: orgError,
  } = useMutation(
    trpc.organizations.appBuilder.generateCloneToken.mutationOptions({
      onSuccess: (data: CloneTokenResult) => {
        setTokenData(data);
      },
    })
  );

  const isPending = organizationId ? orgIsPending : personalIsPending;
  const error = organizationId ? orgError : personalError;

  const handleOpenChange = useCallback(
    (open: boolean) => {
      setIsOpen(open);
      if (open) {
        // Generate token when dialog opens
        setCopied(false);
        setTokenData(null);
        if (organizationId) {
          orgMutate({ projectId, organizationId });
        } else {
          personalMutate({ projectId });
        }
      }
    },
    [orgMutate, personalMutate, projectId, organizationId]
  );

  const getCloneCommand = useCallback(() => {
    if (!tokenData) return '';
    const url = new URL(tokenData.gitUrl);
    url.username = 'x-access-token';
    url.password = tokenData.token;
    return `git clone ${url.toString()}`;
  }, [tokenData]);

  const handleCopy = useCallback(async () => {
    const command = getCloneCommand();
    if (!command) return;

    await navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [getCloneCommand]);

  const getExpirationText = useCallback(() => {
    if (!tokenData) return '';
    const expiresAt = new Date(tokenData.expiresAt);
    return formatDistanceToNow(expiresAt, { addSuffix: true });
  }, [tokenData]);

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled} title="Clone repository">
          <GitBranch className="mr-2 h-4 w-4" />
          Clone
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Clone Repository</DialogTitle>
          <DialogDescription>
            Use this command to clone the repository locally. The token is read-only.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {isPending && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
              <span className="text-muted-foreground ml-2 text-sm">Generating token...</span>
            </div>
          )}

          {error && (
            <div className="rounded-md bg-red-500/10 p-4 text-sm text-red-400">
              Failed to generate clone token. Please try again.
            </div>
          )}

          {tokenData && (
            <>
              <div className="space-y-2">
                <label className="text-sm font-medium">Clone command</label>
                <div className="bg-muted relative rounded-md p-3">
                  <code className="block overflow-x-auto pr-10 text-sm break-all">
                    {getCloneCommand()}
                  </code>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="absolute top-2 right-2"
                    onClick={handleCopy}
                  >
                    {copied ? (
                      <Check className="h-4 w-4 text-green-500" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              </div>

              <div className="text-muted-foreground flex items-center gap-2 text-sm">
                <Clock className="h-4 w-4" />
                <span>Token expires {getExpirationText()}</span>
              </div>

              <div className="text-muted-foreground text-xs">
                <p>
                  This token provides read-only access to the repository. Generate a new token if
                  this one expires.
                </p>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
