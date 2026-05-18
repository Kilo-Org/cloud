'use client';

import dynamic from 'next/dynamic';
import { useCallback, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Loader2, Pencil, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useWastelandTRPC } from '@/lib/wasteland/trpc';
import type { WantedItem } from './types';

type WantedPriority = 'low' | 'medium' | 'high' | 'critical';
type WantedType = 'feature' | 'bug' | 'docs' | 'other';

const PRIORITY_OPTIONS: WantedPriority[] = ['low', 'medium', 'high', 'critical'];
const TYPE_OPTIONS: WantedType[] = ['feature', 'bug', 'docs', 'other'];

const MarkdownEditor = dynamic(
  () => import('@/components/gastown/MarkdownEditor').then(m => ({ default: m.MarkdownEditor })),
  { ssr: false }
);

export function PostWantedItemPanel({
  wastelandId,
  onSuccess,
  close,
}: {
  wastelandId: string;
  onSuccess?: () => void;
  close: () => void;
}) {
  const trpc = useWastelandTRPC();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<WantedPriority>('medium');
  const [type, setType] = useState<WantedType>('feature');

  const postMutation = useMutation({
    ...trpc.wasteland.postWantedItem.mutationOptions(),
    onSuccess: () => {
      toast.success('Wanted item posted');
      onSuccess?.();
      close();
    },
    onError: err => toast.error(err.message || 'Failed to post wanted item'),
  });

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmedTitle = title.trim();
      const trimmedDescription = description.trim();
      if (!trimmedTitle || !trimmedDescription) return;
      postMutation.mutate({
        wastelandId,
        title: trimmedTitle,
        description: trimmedDescription,
        priority,
        type,
      });
    },
    [description, postMutation, priority, title, type, wastelandId]
  );

  return (
    <WantedItemForm
      title={title}
      setTitle={setTitle}
      description={description}
      setDescription={setDescription}
      priority={priority}
      setPriority={setPriority}
      type={type}
      setType={setType}
      onSubmit={handleSubmit}
      onCancel={close}
      isPending={postMutation.isPending}
      submitLabel="Post wanted item"
      submitIcon="plus"
      titleInputId="post-title"
      priorityInputId="post-priority"
      typeInputId="post-type"
      descriptionPlaceholder="Describe what needs to be done..."
    />
  );
}

export function EditWantedItemPanel({
  wastelandId,
  item,
  onSuccess,
  close,
}: {
  wastelandId: string;
  item: WantedItem;
  onSuccess?: () => void;
  close: () => void;
}) {
  const trpc = useWastelandTRPC();
  const [title, setTitle] = useState(item.title);
  const [description, setDescription] = useState(item.description ?? '');
  const [priority, setPriority] = useState<WantedPriority>(normalizePriority(item.priority));
  const [type, setType] = useState<WantedType>(normalizeType(item.type));

  const editMutation = useMutation({
    ...trpc.wasteland.editWantedItem.mutationOptions(),
    onSuccess: data => {
      const prUrl = data.pr_url;
      if (prUrl) {
        toast.success('Wanted item updated', {
          description: 'The open pull request was updated.',
          action: {
            label: 'View PR',
            onClick: () => window.open(prUrl, '_blank', 'noopener,noreferrer'),
          },
        });
      } else {
        toast.success('Wanted item updated');
      }
      onSuccess?.();
      close();
    },
    onError: err => toast.error(err.message || 'Failed to edit wanted item'),
  });

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmedTitle = title.trim();
      const trimmedDescription = description.trim();
      if (!trimmedTitle || !trimmedDescription) return;
      editMutation.mutate({
        wastelandId,
        itemId: item.id,
        title: trimmedTitle,
        description: trimmedDescription,
        priority,
        type,
      });
    },
    [description, editMutation, item.id, priority, title, type, wastelandId]
  );

  return (
    <WantedItemForm
      title={title}
      setTitle={setTitle}
      description={description}
      setDescription={setDescription}
      priority={priority}
      setPriority={setPriority}
      type={type}
      setType={setType}
      onSubmit={handleSubmit}
      onCancel={close}
      isPending={editMutation.isPending}
      submitLabel="Save changes"
      submitIcon="pencil"
      titleInputId={`edit-title-${item.id}`}
      priorityInputId={`edit-priority-${item.id}`}
      typeInputId={`edit-type-${item.id}`}
      descriptionPlaceholder="Update the wanted item description..."
    />
  );
}

function WantedItemForm({
  title,
  setTitle,
  description,
  setDescription,
  priority,
  setPriority,
  type,
  setType,
  onSubmit,
  onCancel,
  isPending,
  submitLabel,
  submitIcon,
  titleInputId,
  priorityInputId,
  typeInputId,
  descriptionPlaceholder,
}: {
  title: string;
  setTitle: (value: string) => void;
  description: string;
  setDescription: (value: string) => void;
  priority: WantedPriority;
  setPriority: (value: WantedPriority) => void;
  type: WantedType;
  setType: (value: WantedType) => void;
  onSubmit: (e: React.FormEvent) => void;
  onCancel: () => void;
  isPending: boolean;
  submitLabel: string;
  submitIcon: 'pencil' | 'plus';
  titleInputId: string;
  priorityInputId: string;
  typeInputId: string;
  descriptionPlaceholder: string;
}) {
  const SubmitIcon = submitIcon === 'pencil' ? Pencil : Plus;

  return (
    <form onSubmit={onSubmit} className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
        <div className="space-y-1.5">
          <label htmlFor={titleInputId} className="block text-xs font-medium text-white/50">
            Title
          </label>
          <Input
            id={titleInputId}
            value={title}
            onChange={e => setTitle(e.target.value)}
            maxLength={256}
            placeholder="Brief title for the wanted item"
            autoFocus
            className="border-white/[0.08] bg-black/20 text-white/90 placeholder:text-white/25 focus:border-white/20"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label htmlFor={priorityInputId} className="block text-xs font-medium text-white/50">
              Priority
            </label>
            <select
              id={priorityInputId}
              value={priority}
              onChange={e => setPriority(normalizePriority(e.target.value))}
              className="h-9 w-full rounded-md border border-white/[0.08] bg-black/20 px-3 text-sm text-white/80 outline-none focus:border-white/20"
            >
              {PRIORITY_OPTIONS.map(option => (
                <option key={option} value={option}>
                  {capitalize(option)}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <label htmlFor={typeInputId} className="block text-xs font-medium text-white/50">
              Type
            </label>
            <select
              id={typeInputId}
              value={type}
              onChange={e => setType(normalizeType(e.target.value))}
              className="h-9 w-full rounded-md border border-white/[0.08] bg-black/20 px-3 text-sm text-white/80 outline-none focus:border-white/20"
            >
              {TYPE_OPTIONS.map(option => (
                <option key={option} value={option}>
                  {capitalize(option)}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col space-y-1.5">
          <label className="block text-xs font-medium text-white/50">Description</label>
          <div className="min-h-[360px] flex-1">
            <MarkdownEditor
              value={description}
              onChange={setDescription}
              placeholder={descriptionPlaceholder}
              className="h-full"
            />
          </div>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-white/[0.06] px-5 py-4">
        <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={isPending}>
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={isPending || !title.trim() || !description.trim()}
          className="gap-1.5"
        >
          {isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <SubmitIcon className="size-3.5" />
          )}
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

function normalizePriority(value: unknown): WantedPriority {
  if (value === 'low' || value === 0 || value === '0') return 'low';
  if (value === 'high' || value === 2 || value === '2') return 'high';
  if (value === 'critical' || value === 3 || value === '3') return 'critical';
  return 'medium';
}

function normalizeType(value: unknown): WantedType {
  if (value === 'bug' || value === 'docs' || value === 'other') return value;
  return 'feature';
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
