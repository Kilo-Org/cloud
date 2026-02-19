'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/Button';
import { toast } from 'sonner';

type CreateTownDialogProps = {
  isOpen: boolean;
  onClose: () => void;
};

export function CreateTownDialog({ isOpen, onClose }: CreateTownDialogProps) {
  const [name, setName] = useState('');
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const createTown = useMutation(
    trpc.gastown.createTown.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.gastown.listTowns.queryKey() });
        toast.success('Town created');
        setName('');
        onClose();
      },
      onError: err => {
        toast.error(err.message);
      },
    })
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    createTown.mutate({ name: name.trim() });
  };

  return (
    <Dialog open={isOpen} onOpenChange={open => !open && onClose()}>
      <DialogContent className="border-white/10 bg-[color:oklch(0.155_0_0)]">
        <DialogHeader>
          <DialogTitle>Create Town</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="py-4">
            <label className="mb-2 block text-sm font-medium text-white/70">Town Name</label>
            <Input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="My Town"
              autoFocus
              className="border-white/10 bg-black/25"
            />
          </div>
          <DialogFooter>
            <Button variant="secondary" size="md" type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="md"
              type="submit"
              disabled={!name.trim() || createTown.isPending}
              className="bg-[color:oklch(95%_0.15_108_/_0.90)] text-black hover:bg-[color:oklch(95%_0.15_108_/_0.95)]"
            >
              {createTown.isPending ? 'Creating...' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
