'use client';

import { useId, useState, type FormEvent } from 'react';
import { LoaderCircle } from 'lucide-react';
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
  PREVIEW_PORT_MAX,
  PREVIEW_PORT_MIN,
} from '../../../../../services/cloud-agent-next/src/shared/preview-port';
import { useOpenPreview } from './use-preview';

export function PreviewPortDialog({
  open,
  onOpenChange,
  cloudAgentSessionId,
  organizationId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cloudAgentSessionId: `workspace_${string}`;
  organizationId?: string;
}) {
  const [port, setPort] = useState('');
  const [error, setError] = useState<string | null>(null);
  const portId = useId();
  const errorId = useId();

  const { openPreview, isOpening } = useOpenPreview(organizationId);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (isOpening) return;

    const parsedPort = Number(port);
    if (
      !Number.isInteger(parsedPort) ||
      parsedPort < PREVIEW_PORT_MIN ||
      parsedPort > PREVIEW_PORT_MAX
    ) {
      setError(`Enter a port between ${PREVIEW_PORT_MIN} and ${PREVIEW_PORT_MAX}.`);
      return;
    }
    setError(null);

    if (await openPreview(cloudAgentSessionId, parsedPort)) onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!isOpening) onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md" showCloseButton={!isOpening}>
        <DialogHeader>
          <DialogTitle>Open preview</DialogTitle>
          <DialogDescription>
            Open a server running inside this sandbox in a new browser tab.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={event => void handleSubmit(event)} className="space-y-4">
          <div className="space-y-2">
            <label htmlFor={portId} className="text-sm font-medium">
              Port
            </label>
            <Input
              id={portId}
              autoFocus
              inputMode="numeric"
              autoComplete="off"
              placeholder="e.g. 5173"
              value={port}
              disabled={isOpening}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? errorId : undefined}
              onChange={event => {
                setPort(event.target.value);
                setError(null);
              }}
            />
            {error && (
              <p id={errorId} role="alert" className="text-destructive text-sm">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={isOpening}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isOpening}>
              {isOpening && <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />}
              {isOpening ? 'Opening…' : 'Open'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
