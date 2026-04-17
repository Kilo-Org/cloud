'use client';

import { useEffect, useRef } from 'react';
import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { useKiloClawMutations } from '@/hooks/useKiloClaw';
import { stripAnsi } from '@/lib/stripAnsi';

type DoctorMutation = ReturnType<typeof useKiloClawMutations>['runDoctor'];

export function RunDoctorDialog({
  open,
  onOpenChange,
  mutation,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mutation: DoctorMutation;
}) {
  const hasFired = useRef(false);
  const mutationRef = useRef(mutation);
  mutationRef.current = mutation;

  useEffect(() => {
    if (open && !hasFired.current) {
      hasFired.current = true;
      mutationRef.current.mutate(undefined);
    }
    if (!open) {
      hasFired.current = false;
      mutationRef.current.reset();
    }
  }, [open]);

  const rawResult = mutation.data;
  const result = rawResult
    ? {
        ...rawResult,
        output: stripAnsi(rawResult.output),
      }
    : rawResult;
  const isPending = mutation.isPending;
  const isError = mutation.isError;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[750px]">
        <DialogHeader>
          <DialogTitle>OpenClaw Doctor</DialogTitle>
          <DialogDescription>
            Running diagnostics and applying fixes on your instance.
          </DialogDescription>
        </DialogHeader>

        {isPending && (
          <div className="flex flex-col items-center justify-center gap-3 py-12">
            <Loader2 className="text-muted-foreground h-8 w-8 animate-spin" />
            <p className="text-muted-foreground text-sm">Running diagnostics...</p>
          </div>
        )}

        {isError && (
          <div className="flex flex-col items-center justify-center gap-3 py-12">
            <XCircle className="h-8 w-8 text-red-400" />
            <p className="text-sm text-red-400">
              {mutation.error?.message || 'Failed to run doctor'}
            </p>
          </div>
        )}

        {result && !isPending && (
          <div className="min-w-0 space-y-3">
            <div className="flex items-center gap-2">
              {result.success ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              ) : (
                <XCircle className="h-4 w-4 text-red-400" />
              )}
              <span className="text-sm font-medium">
                {result.success ? 'Executed successfully' : 'Issues detected'}
              </span>
            </div>
            <div className="border-border bg-background max-h-[400px] min-w-0 overflow-auto rounded-md border">
              {/* prettier-ignore */}
              <pre
                className="p-3 text-xs leading-relaxed whitespace-pre"
                style={{ fontFamily: "'Courier New', Courier, monospace", tabSize: 8 }}
              >{result.output}</pre>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
