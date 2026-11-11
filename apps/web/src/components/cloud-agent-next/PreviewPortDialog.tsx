'use client';

import { useId, useState, type FormEvent } from 'react';
import { ChevronRight, ExternalLink, Globe, LoaderCircle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  PREVIEW_PORT_MAX,
  PREVIEW_PORT_MIN,
} from '../../../../../services/cloud-agent-next/src/shared/preview-port';
import type { PreviewTarget } from '../../../../../services/cloud-agent-next/src/shared/preview-target';
import { useOpenPreview, usePreviewServices } from './use-preview';

export function PreviewPortDialog({
  open,
  onOpenChange,
  target,
  organizationId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: PreviewTarget;
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
      <DialogContent className="sm:max-w-lg" showCloseButton={!isOpening}>
        <DialogHeader>
          <DialogTitle>Open preview</DialogTitle>
          <DialogDescription>
            Discover services running in this sandbox. Open a web server in a new tab.
          </DialogDescription>
        </DialogHeader>
        {/* DialogContent unmounts on close, so each open and each target starts fresh. */}
        <PreviewServices
          key={target.worktreeId ?? target.cloudAgentSessionId}
          target={target}
          organizationId={organizationId}
          isOpening={isOpening}
          onOpenPort={async port => {
            if (await openPreview(target, port)) onOpenChange(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function PreviewServices({
  target,
  organizationId,
  isOpening,
  onOpenPort,
}: {
  target: PreviewTarget;
  organizationId?: string;
  isOpening: boolean;
  onOpenPort: (port: number) => Promise<void>;
}) {
  const query = usePreviewServices(target, organizationId);
  const [openingPort, setOpeningPort] = useState<number | null>(null);
  const data = query.data;
  const openPort = async (port: number) => {
    setOpeningPort(port);
    try {
      await onOpenPort(port);
    } finally {
      setOpeningPort(null);
    }
  };
  const unavailable =
    !query.isError && (data?.status === 'not_running' || data?.status === 'unsupported');
  const emptyMessage =
    data?.status === 'not_running'
      ? 'This sandbox is stopped. Send the agent a message to start it again.'
      : data?.status === 'not_ready'
        ? 'The sandbox is not ready yet. Refresh once it is connected.'
        : data?.status === 'unsupported'
          ? 'Service discovery is not available for this sandbox.'
          : 'No listening services found. Ask the agent to start a web server, then refresh.';

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">Listening services</h3>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={query.isFetching || isOpening}
          onClick={() => void query.refetch()}
        >
          <RefreshCw
            className={`size-3.5 ${query.isFetching ? 'animate-spin' : ''}`}
            aria-hidden="true"
          />
          Refresh
        </Button>
      </div>
      <div aria-live="polite" aria-busy={query.isFetching}>
        {query.isPending ? (
          <div role="status" className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            Looking for running services...
          </div>
        ) : query.isError ? (
          <p role="alert" className="text-muted-foreground rounded-md border p-4 text-sm">
            Could not discover services. Try refreshing, or enter a port manually.
          </p>
        ) : !data?.services.length ? (
          <p className="text-muted-foreground rounded-md border p-4 text-sm">{emptyMessage}</p>
        ) : (
          <ul className="max-h-80 space-y-2 overflow-y-auto">
            {data.services.map(service => (
              <li key={service.port}>
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  className="h-auto w-full justify-start gap-3 px-4 py-3 text-left"
                  disabled={isOpening || query.isFetching}
                  onClick={() => void openPort(service.port)}
                  aria-label={`Open ${service.name} on port ${service.port}`}
                >
                  <Globe className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="flex min-w-0 items-center gap-2">
                      <span
                        className={`shrink-0 truncate font-medium ${service.description ? 'max-w-3/5' : 'max-w-full'}`}
                      >
                        {service.name}
                      </span>
                      {service.description && (
                        <span className="text-muted-foreground truncate text-xs font-normal">
                          {service.description}
                        </span>
                      )}
                    </span>
                    <span className="text-muted-foreground block font-mono text-xs font-normal">
                      localhost:{service.port}
                    </span>
                  </span>
                  {isOpening && openingPort === service.port ? (
                    <LoaderCircle className="size-4 shrink-0 animate-spin" aria-hidden="true" />
                  ) : (
                    <ExternalLink
                      className="text-muted-foreground size-4 shrink-0"
                      aria-hidden="true"
                    />
                  )}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <details className="group border-t pt-3">
        <summary className="text-muted-foreground focus-visible:ring-ring flex w-fit cursor-pointer list-none items-center gap-1 text-xs hover:text-foreground focus-visible:ring-2 focus-visible:outline-none">
          <ChevronRight className="size-3.5 group-open:rotate-90" aria-hidden="true" />
          Enter a port manually
        </summary>
        <div className="pt-3">
          <PreviewPortForm
            isOpening={isOpening}
            disabled={isOpening || unavailable}
            onOpenPort={openPort}
          />
        </div>
      </details>
    </div>
  );
}

function PreviewPortForm({
  isOpening,
  disabled,
  onOpenPort,
}: {
  isOpening: boolean;
  disabled: boolean;
  onOpenPort: (port: number) => Promise<void>;
}) {
  const [port, setPort] = useState('');
  const [error, setError] = useState<string | null>(null);
  const portId = useId();
  const errorId = useId();

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (disabled) return;

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
          inputMode="numeric"
          autoComplete="off"
          placeholder="e.g. 5173"
          value={port}
          disabled={disabled}
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
      <div className="flex justify-end">
        <Button type="submit" disabled={disabled}>
          {isOpening && <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />}
          Open port
        </Button>
      </div>
    </form>
  );
}
