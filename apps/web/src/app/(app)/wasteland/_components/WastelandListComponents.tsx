import { useState } from 'react';
import type { WastelandOutputs } from '@/lib/wasteland/trpc';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
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
import { ExternalLink, Trash2 } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

export type WastelandItem = WastelandOutputs['wasteland']['listWastelands'][number];

export function WastelandCard({
  wasteland,
  onClick,
  onDelete,
}: {
  wasteland: WastelandItem;
  onClick: () => void;
  /**
   * When provided, a trash-icon button is rendered in the card's top-right
   * corner. The icon click stops propagation so it doesn't fire `onClick`
   * (which navigates to the wasteland). Pages that don't want the
   * affordance simply omit this prop.
   */
  onDelete?: () => void;
}) {
  return (
    <Card
      className="relative cursor-pointer border-white/10 bg-white/[0.03] transition-[border-color,background-color] hover:border-white/20 hover:bg-white/[0.05]"
      onClick={onClick}
    >
      {onDelete && (
        <button
          type="button"
          onClick={e => {
            e.stopPropagation();
            onDelete();
          }}
          aria-label={`Delete wasteland ${wasteland.name}`}
          className="absolute right-2 top-2 rounded p-1.5 text-white/35 transition-colors hover:bg-red-500/10 hover:text-red-300"
        >
          <Trash2 className="size-4" />
        </button>
      )}
      <CardContent className="flex flex-col gap-3 p-4">
        <h3 className="truncate pr-8 text-base font-medium text-white/90">{wasteland.name}</h3>

        <div className="flex flex-wrap items-center gap-2">
          {wasteland.dolthub_upstream && <DoltHubLink upstream={wasteland.dolthub_upstream} />}
        </div>

        <div className="flex items-center justify-between text-xs text-white/40">
          <span>
            Created {formatDistanceToNow(new Date(wasteland.created_at), { addSuffix: true })}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Type-the-name confirmation dialog for deleting a wasteland. Mirrors the
 * one in `/wasteland/[owner]/[repo]/settings/SettingsClient.tsx`'s
 * `DeleteWastelandDialog` so the UX is consistent across surfaces. The
 * caller controls visibility (so it can drive both the trigger and the
 * mutation state); when `wasteland` is `null`, the dialog is closed.
 */
export function DeleteWastelandConfirmDialog({
  wasteland,
  isPending,
  onCancel,
  onConfirm,
}: {
  wasteland: WastelandItem | null;
  isPending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [confirmText, setConfirmText] = useState('');
  const open = wasteland !== null;
  const confirmed = wasteland !== null && confirmText === wasteland.name;

  // Reset the type-to-confirm field whenever the dialog re-targets a
  // different wasteland (or closes), so the user starts from an empty
  // input each time.
  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setConfirmText('');
      onCancel();
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent className="border-red-500/20 bg-[oklch(0.13_0_0)] sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-red-400">Delete this wasteland?</AlertDialogTitle>
          <AlertDialogDescription className="text-white/50">
            This action cannot be undone. Type{' '}
            <span className="font-mono font-semibold text-white/80">{wasteland?.name ?? ''}</span>{' '}
            to confirm.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Input
          value={confirmText}
          onChange={e => setConfirmText(e.target.value)}
          placeholder={wasteland?.name ?? ''}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          className="border-red-500/20 bg-white/[0.03] font-mono text-sm text-white/85 placeholder:text-white/15"
        />
        <AlertDialogFooter>
          <AlertDialogCancel className="border-white/10 text-white/70 hover:bg-white/5 hover:text-white">
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              setConfirmText('');
              onConfirm();
            }}
            disabled={!confirmed || isPending}
            className="bg-red-500/80 text-white hover:bg-red-500 disabled:opacity-40"
          >
            {isPending ? 'Deleting...' : 'Yes, delete wasteland'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function DoltHubLink({ upstream }: { upstream: string }) {
  return (
    <a
      href={`https://www.dolthub.com/repositories/${upstream}`}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 rounded-md bg-white/5 px-2 py-0.5 text-xs text-white/50 hover:text-white/70"
      onClick={e => e.stopPropagation()}
    >
      <ExternalLink className="size-3" />
      {upstream}
    </a>
  );
}

export function WastelandListSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <Card key={i} className="border-white/10 bg-white/[0.03]">
          <CardContent className="flex flex-col gap-3 p-4">
            <div className="flex items-start justify-between">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-5 w-16 rounded-full" />
            </div>
            <div className="flex gap-2">
              <Skeleton className="h-5 w-16" />
              <Skeleton className="h-5 w-24" />
            </div>
            <Skeleton className="h-4 w-28" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
