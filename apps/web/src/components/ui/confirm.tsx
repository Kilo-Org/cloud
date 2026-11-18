'use client';

import * as React from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

export type ConfirmOptions = {
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  /**
   * Wait behind an active prompt instead of cancelling it. Use this for a
   * prompt that must not replace an unrelated confirmation.
   */
  queue?: boolean;
};

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = React.createContext<ConfirmFn | null>(null);

type ConfirmState = ConfirmOptions & { open: boolean };
type QueuedConfirmation = {
  options: ConfirmOptions;
  resolve: (value: boolean) => void;
};

/**
 * Mounts a single AlertDialog and exposes an imperative, promise-based
 * confirm() via context. Resolves true on the confirm action; resolves false
 * on Cancel / Escape / outside-click so every dismissal maps to "keep".
 */
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<ConfirmState | null>(null);
  const resolverRef = React.useRef<((value: boolean) => void) | null>(null);
  const queueRef = React.useRef<QueuedConfirmation[]>([]);

  const settle = React.useCallback((result: boolean) => {
    const resolve = resolverRef.current;
    if (!resolve) return;
    resolverRef.current = null;
    resolve(result);
    setState(prev => (prev ? { ...prev, open: false } : prev));
  }, []);

  React.useEffect(() => {
    if (!state || state.open || queueRef.current.length === 0) return;
    const next = queueRef.current.shift();
    if (!next) return;
    resolverRef.current = next.resolve;
    setState({ ...next.options, open: true });
  }, [state]);

  const confirm = React.useCallback<ConfirmFn>(options => {
    if (resolverRef.current) {
      if (options.queue) {
        return new Promise<boolean>(resolve => {
          queueRef.current.push({ options, resolve });
        });
      }
      // Existing callers replace an in-flight prompt rather than queueing.
      resolverRef.current(false);
      resolverRef.current = null;
    }
    return new Promise<boolean>(resolve => {
      resolverRef.current = resolve;
      setState({ ...options, open: true });
    });
  }, []);

  React.useEffect(
    () => () => {
      resolverRef.current?.(false);
      resolverRef.current = null;
      for (const queued of queueRef.current) queued.resolve(false);
      queueRef.current = [];
    },
    []
  );

  const handleOpenChange = React.useCallback(
    (open: boolean) => {
      if (!open) settle(false);
    },
    [settle]
  );

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog open={state?.open ?? false} onOpenChange={handleOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{state?.title}</AlertDialogTitle>
            {state?.description != null && (
              <AlertDialogDescription>{state.description}</AlertDialogDescription>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{state?.cancelLabel ?? 'Cancel'}</AlertDialogCancel>
            <AlertDialogAction
              variant={state?.destructive ? 'destructive' : 'default'}
              onClick={() => settle(true)}
            >
              {state?.confirmLabel ?? 'Confirm'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmContext.Provider>
  );
}

/**
 * Returns a stable confirm() that resolves true on confirm, false otherwise.
 *
 *   const confirm = useConfirm();
 *   if (await confirm({ title: 'Disconnect Slack?', destructive: true })) { … }
 */
export function useConfirm(): ConfirmFn {
  const confirm = React.useContext(ConfirmContext);
  if (!confirm) {
    throw new Error('useConfirm must be used within a ConfirmProvider');
  }
  return confirm;
}
