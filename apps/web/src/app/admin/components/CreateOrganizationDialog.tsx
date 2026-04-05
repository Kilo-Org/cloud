'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
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

type CreateOrganizationDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function CreateOrganizationDialog({ open, onOpenChange }: CreateOrganizationDialogProps) {
  const [name, setName] = useState('');
  const queryClient = useQueryClient();
  const trpc = useTRPC();

  const createOrganizationMutation = useMutation(
    trpc.organizations.admin.create.mutationOptions({
      onSuccess: data => {
        toast.success(`Organization "${data.organization.name}" created successfully`);
        void queryClient.invalidateQueries({ queryKey: ['admin-organizations'] });
        setName('');
        onOpenChange(false);
      },
      onError: error => {
        toast.error(error.message || 'Failed to create organization');
      },
    })
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!name.trim()) {
      toast.error('Organization name is required');
      return;
    }

    createOrganizationMutation.mutate({ name: name.trim() });
  };

  const handleCancel = () => {
    setName('');
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Create New Organization</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="name" className="text-right">
                Name *
              </Label>
              <Input
                id="name"
                autoComplete="off"
                value={name}
                onChange={e => setName(e.target.value)}
                className="col-span-3"
                placeholder="Enter organization name"
                required
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={handleCancel}
              disabled={createOrganizationMutation.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={createOrganizationMutation.isPending}>
              {createOrganizationMutation.isPending ? 'Creating...' : 'Create Organization'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
