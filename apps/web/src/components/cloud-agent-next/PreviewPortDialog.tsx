'use client';

import { useId, useState, type FormEvent } from 'react';
import { LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
  const { openPreview, isOpening } = useOpenPreview(organizationId);

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
        {/* DialogContent unmounts on close, so each open and each session starts with an empty form. */}
        <PreviewPortForm
          isOpening={isOpening}
          onCancel={() => onOpenChange(false)}
          onOpenPort={async port => {
            if (await openPreview(cloudAgentSessionId, port)) onOpenChange(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function PreviewPortForm({
  isOpening,
  onCancel,
  onOpenPort,
}: {
  isOpening: boolean;
  onCancel: () => void;
  onOpenPort: (port: number) => Promise<void>;
}) {
  const [port, setPort] = useState('');
  const [error, setError] = useState<string | null>(null);
  const portId = useId();
  const errorId = useId();

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
    await onOpenPort(parsedPort);
  };

  return (
    <form onSubmit={event => void handleSubmit(event)} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor={portId}>Port</Label>
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
        <Button type="button" variant="outline" disabled={isOpening} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={isOpening}>
          {isOpening && <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />}
          {isOpening ? 'Opening…' : 'Open'}
        </Button>
      </DialogFooter>
    </form>
  );
}
