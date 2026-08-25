'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc/utils';
import { isAllowedSalesDemoEmail } from '@/lib/organizations/sales-demo-email';

const ALREADY_OWNS_DEMO_PREFIX = 'ALREADY_OWNS_DEMO:';

type CreateDemoOrganizationDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type ConflictLinkState = {
  organizationId: string;
  organizationName: string;
} | null;

export function CreateDemoOrganizationDialog({
  open,
  onOpenChange,
}: CreateDemoOrganizationDialogProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const trpc = useTRPC();

  const [email, setEmail] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [conflictLink, setConflictLink] = useState<ConflictLinkState>(null);

  const createDemoOrganizationMutation = useMutation(
    trpc.admin.salesDemo.create.mutationOptions({
      onSuccess: data => {
        toast.success(`Demo organization "${data.organizationName}" created`);
        void queryClient.invalidateQueries({ queryKey: ['admin-organizations'] });
        setEmail('');
        setFieldError(null);
        setConflictLink(null);
        onOpenChange(false);
        router.push(`/admin/organizations/${encodeURIComponent(data.organizationId)}`);
      },
      onError: error => {
        const code = error.data?.code;
        const message = error.message || 'Failed to create demo organization';

        if (code === 'BAD_REQUEST' || code === 'NOT_FOUND') {
          setFieldError(message);
          return;
        }

        if (code === 'CONFLICT' && message.startsWith(ALREADY_OWNS_DEMO_PREFIX)) {
          const rest = message.slice(ALREADY_OWNS_DEMO_PREFIX.length);
          const firstColon = rest.indexOf(':');
          if (firstColon !== -1) {
            setConflictLink({
              organizationId: rest.slice(0, firstColon),
              organizationName: rest.slice(firstColon + 1),
            });
            return;
          }
        }

        toast.error(message);
      },
    })
  );

  const handleBlur = () => {
    const trimmed = email.trim();
    if (!trimmed || isAllowedSalesDemoEmail(trimmed)) {
      setFieldError(null);
    } else {
      setFieldError(
        'Only emails ending in @kilocode.ai or @anaconda.com can own a sales demo organization.'
      );
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const trimmed = email.trim();
    if (!trimmed) {
      // Do not call the mutation on an empty email.
      setConflictLink(null);
      setFieldError('Enter an email.');
      return;
    }

    setFieldError(null);
    setConflictLink(null);
    createDemoOrganizationMutation.mutate({ email: trimmed });
  };

  const handleCancel = () => {
    setEmail('');
    setFieldError(null);
    setConflictLink(null);
    onOpenChange(false);
  };

  const isPending = createDemoOrganizationMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Create Demo Organization</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="sales-demo-email" className="text-right">
                Email
              </Label>
              <Input
                id="sales-demo-email"
                type="email"
                autoComplete="off"
                value={email}
                onChange={e => setEmail(e.target.value)}
                onBlur={handleBlur}
                className="col-span-3"
                placeholder="owner@kilocode.ai"
                aria-invalid={fieldError ? true : undefined}
                aria-describedby={fieldError ? 'sales-demo-email-error' : undefined}
              />
            </div>
            {fieldError && (
              <div id="sales-demo-email-error" className="text-sm text-destructive" role="alert">
                {fieldError}
              </div>
            )}
            {conflictLink && (
              <div className="text-sm text-muted-foreground" role="alert">
                This user already owns a demo organization:{' '}
                <Link
                  href={`/admin/organizations/${encodeURIComponent(conflictLink.organizationId)}`}
                  className="text-primary break-words hover:underline"
                >
                  {conflictLink.organizationName}
                </Link>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={handleCancel} disabled={isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? 'Creating...' : 'Create Demo Organization'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function CreateDemoOrganizationButton() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <Button onClick={() => setIsOpen(true)}>Create Demo Organization</Button>
      <CreateDemoOrganizationDialog open={isOpen} onOpenChange={setIsOpen} />
    </>
  );
}
