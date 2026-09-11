'use client';

import { useId, useState, type FormEvent } from 'react';
import { Check, LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  workspaceFolderNameSchema,
  type WorkspaceFolder,
  type WorkspaceFolderColor,
} from '@/lib/cloud-agent/workspace-folders';
import { workspaceFolderColors } from './workspace-folders';

export function WorkspaceFolderDialog({
  folder,
  isSaving,
  onSave,
  onClose,
}: {
  folder: WorkspaceFolder | null;
  isSaving: boolean;
  onSave: (values: { name: string; color: WorkspaceFolderColor }) => Promise<boolean>;
  onClose: () => void;
}) {
  const [name, setName] = useState(folder?.name ?? '');
  const [color, setColor] = useState<WorkspaceFolderColor>(folder?.color ?? 'default');
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  const errorId = useId();
  const colorId = useId();

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (isSaving) return;
    const parsed = workspaceFolderNameSchema.safeParse(name);
    if (!parsed.success) {
      setError('Enter a folder name between 1 and 200 characters.');
      return;
    }
    setError(null);
    if (await onSave({ name: parsed.data, color })) {
      onClose();
    } else {
      setError('Could not save this folder. Please try again.');
    }
  };

  return (
    <Dialog
      open
      onOpenChange={open => {
        if (!open && !isSaving) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md" showCloseButton={!isSaving}>
        <DialogHeader>
          <DialogTitle>{folder ? 'Edit folder' : 'New folder'}</DialogTitle>
          <DialogDescription>
            Organize your workspaces. Folders are private to you.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={event => void handleSubmit(event)} className="space-y-4">
          <div className="space-y-2">
            <label htmlFor={nameId} className="text-sm font-medium">
              Folder name
            </label>
            <Input
              id={nameId}
              autoFocus
              autoComplete="off"
              maxLength={200}
              value={name}
              disabled={isSaving}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? errorId : undefined}
              onChange={event => {
                setName(event.target.value);
                setError(null);
              }}
            />
            {error && (
              <p id={errorId} role="alert" className="text-destructive text-sm">
                {error}
              </p>
            )}
          </div>
          <fieldset disabled={isSaving} className="space-y-2">
            <legend className="text-sm font-medium">Folder color</legend>
            <div className="flex flex-wrap gap-1">
              {workspaceFolderColors.map(option => (
                <label key={option.value} title={option.label} className="cursor-pointer">
                  <input
                    type="radio"
                    name={colorId}
                    value={option.value}
                    aria-label={option.label}
                    checked={color === option.value}
                    onChange={() => setColor(option.value)}
                    className="peer sr-only"
                  />
                  <span className="hover:bg-accent peer-checked:bg-accent peer-focus-visible:ring-ring flex size-11 items-center justify-center rounded-md peer-focus-visible:ring-2 peer-disabled:opacity-50">
                    <span
                      className="flex size-6 items-center justify-center rounded-full"
                      style={{ backgroundColor: option.css }}
                    >
                      {color === option.value && (
                        <Check aria-hidden="true" className="text-background size-4" />
                      )}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={isSaving} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSaving}>
              {isSaving && <LoaderCircle className="size-4 animate-spin" />}
              {isSaving ? 'Saving...' : folder ? 'Save changes' : 'Create folder'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
