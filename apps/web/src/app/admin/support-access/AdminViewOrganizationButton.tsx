'use client';

import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SupportAccessRequestDialog } from '@/components/organizations/SupportAccessRequestDialog';
import { useTRPC } from '@/lib/trpc/utils';

function openOrganization(href: string): boolean {
  const opened = window.open(href, '_blank');
  if (!opened) return false;
  opened.opener = null;
  return true;
}

export function AdminViewOrganizationButton({
  organizationId,
  organizationName,
  className,
  children,
}: {
  organizationId: string;
  organizationName: string;
  className?: string;
  children: ReactNode;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const href = `/organizations/${organizationId}`;
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [readyToOpen, setReadyToOpen] = useState(false);

  const viewAccessOptions = trpc.admin.supportAccess.viewAccess.queryOptions({ organizationId });

  const handleClick = async (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setChecking(true);
    try {
      const access = await queryClient.fetchQuery({ ...viewAccessOptions, staleTime: 0 });
      if (!access.grantRequired) {
        if (!openOrganization(href)) setReadyToOpen(true);
        return;
      }
      setOpen(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not check organization access');
    } finally {
      setChecking(false);
    }
  };

  const handleGranted = () => {
    if (!openOrganization(href)) setReadyToOpen(true);
  };

  return (
    <>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={className}
        aria-busy={checking}
        onClick={handleClick}
      >
        {children}
      </a>
      <SupportAccessRequestDialog
        open={open}
        onOpenChange={setOpen}
        organizationId={organizationId}
        organizationName={organizationName}
        onGranted={handleGranted}
      />
      <Dialog open={readyToOpen} onOpenChange={setReadyToOpen}>
        <DialogContent onClick={event => event.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>Open {organizationName}</DialogTitle>
            <DialogDescription>
              Your browser blocked the new tab. Open the organization from here.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button asChild>
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setReadyToOpen(false)}
              >
                Open organization
              </a>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
