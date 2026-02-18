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
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/Button';
import { toast } from 'sonner';

type SlingDialogProps = {
  rigId: string;
  isOpen: boolean;
  onClose: () => void;
};

const MODEL_OPTIONS = [
  { value: 'kilo/auto', label: 'Auto' },
  { value: 'kilo/claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
  { value: 'kilo/claude-opus-4-20250514', label: 'Claude Opus 4' },
  { value: 'kilo/gpt-4.1', label: 'GPT 4.1' },
  { value: 'kilo/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
];

export function SlingDialog({ rigId, isOpen, onClose }: SlingDialogProps) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [model, setModel] = useState('kilo/auto');
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const sling = useMutation(
    trpc.gastown.sling.mutationOptions({
      onSuccess: result => {
        queryClient.invalidateQueries({ queryKey: trpc.gastown.listBeads.queryKey() });
        queryClient.invalidateQueries({ queryKey: trpc.gastown.listAgents.queryKey() });
        queryClient.invalidateQueries({ queryKey: trpc.gastown.getRig.queryKey() });
        toast.success(`Work slung to ${result.agent.name}`);
        setTitle('');
        setBody('');
        setModel('kilo/auto');
        onClose();
      },
      onError: err => {
        toast.error(err.message);
      },
    })
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    sling.mutate({
      rigId,
      title: title.trim(),
      body: body.trim() || undefined,
      model,
    });
  };

  return (
    <Dialog open={isOpen} onOpenChange={open => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Sling Work</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="space-y-4 py-4">
            <div>
              <label className="mb-2 block text-sm font-medium text-gray-300">Title</label>
              <Input
                value={title}
                onChange={e => setTitle(e.target.value)}
                placeholder="What needs to be done?"
                autoFocus
              />
            </div>
            <div>
              <label className="mb-2 block text-sm font-medium text-gray-300">
                Description (optional)
              </label>
              <Textarea
                value={body}
                onChange={e => setBody(e.target.value)}
                placeholder="Additional context or requirements..."
                rows={4}
              />
            </div>
            <div>
              <label className="mb-2 block text-sm font-medium text-gray-300">Model</label>
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MODEL_OPTIONS.map(opt => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
              disabled={!title.trim() || sling.isPending}
            >
              {sling.isPending ? 'Slinging...' : 'Sling'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
