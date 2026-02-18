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

type CreateRigDialogProps = {
  townId: string;
  isOpen: boolean;
  onClose: () => void;
};

export function CreateRigDialog({ townId, isOpen, onClose }: CreateRigDialogProps) {
  const [name, setName] = useState('');
  const [gitUrl, setGitUrl] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('main');
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const createRig = useMutation(
    trpc.gastown.createRig.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: trpc.gastown.listRigs.queryKey() });
        toast.success('Rig created');
        setName('');
        setGitUrl('');
        setDefaultBranch('main');
        onClose();
      },
      onError: err => {
        toast.error(err.message);
      },
    })
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !gitUrl.trim()) return;
    createRig.mutate({
      townId,
      name: name.trim(),
      gitUrl: gitUrl.trim(),
      defaultBranch: defaultBranch.trim() || 'main',
    });
  };

  return (
    <Dialog open={isOpen} onOpenChange={open => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Rig</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="space-y-4 py-4">
            <div>
              <label className="mb-2 block text-sm font-medium text-gray-300">Rig Name</label>
              <Input
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="my-project"
                autoFocus
              />
            </div>
            <div>
              <label className="mb-2 block text-sm font-medium text-gray-300">Git URL</label>
              <Input
                value={gitUrl}
                onChange={e => setGitUrl(e.target.value)}
                placeholder="https://github.com/org/repo.git"
              />
            </div>
            <div>
              <label className="mb-2 block text-sm font-medium text-gray-300">Default Branch</label>
              <Input
                value={defaultBranch}
                onChange={e => setDefaultBranch(e.target.value)}
                placeholder="main"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="secondary" size="md" type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="md"
              type="submit"
              disabled={!name.trim() || !gitUrl.trim() || createRig.isPending}
            >
              {createRig.isPending ? 'Creating...' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
