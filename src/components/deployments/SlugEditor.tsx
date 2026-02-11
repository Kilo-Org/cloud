'use client';

import { useState, useEffect, useRef } from 'react';
import { Button } from '@/components/Button';
import { Input } from '@/components/ui/input';
import { Pencil, Check, X, Loader2, AlertCircle, CircleCheck } from 'lucide-react';
import { toast } from 'sonner';
import { useDeploymentQueries } from './DeploymentContext';
import { validateSlug } from '@/lib/user-deployments/validation';

type SlugEditorProps = {
  deploymentId: string;
  currentSlug: string;
  deploymentUrl: string;
};

type AvailabilityState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'available' }
  | { status: 'unavailable'; message: string };

export function SlugEditor({ deploymentId, currentSlug, deploymentUrl }: SlugEditorProps) {
  const { queries, mutations } = useDeploymentQueries();
  const renameDeployment = mutations.renameDeployment;

  const [isEditing, setIsEditing] = useState(false);
  const [slug, setSlug] = useState(currentSlug);
  const [localError, setLocalError] = useState<string | undefined>();
  const [availability, setAvailability] = useState<AvailabilityState>({ status: 'idle' });
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);
  // Tracks the most recent slug sent to the availability check so stale responses are discarded.
  const latestCheckSlugRef = useRef<string>(currentSlug);

  // Focus input when entering edit mode
  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
    }
  }, [isEditing]);

  // Reset state when currentSlug changes (e.g. after successful rename)
  useEffect(() => {
    clearTimeout(debounceTimerRef.current);
    setSlug(currentSlug);
    setIsEditing(false);
    setLocalError(undefined);
    setAvailability({ status: 'idle' });
  }, [currentSlug]);

  // Clear pending debounce timer on unmount
  useEffect(() => {
    return () => clearTimeout(debounceTimerRef.current);
  }, []);

  const handleEdit = () => {
    setSlug(currentSlug);
    setLocalError(undefined);
    setAvailability({ status: 'idle' });
    setIsEditing(true);
  };

  const handleCancel = () => {
    setSlug(currentSlug);
    setLocalError(undefined);
    setAvailability({ status: 'idle' });
    setIsEditing(false);
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
  };

  const handleSlugChange = (value: string) => {
    const normalized = value.toLowerCase();
    setSlug(normalized);

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    // Same as current slug — nothing to do
    if (normalized === currentSlug) {
      setLocalError(undefined);
      setAvailability({ status: 'idle' });
      return;
    }

    // Client-side validation
    const validationError = validateSlug(normalized);
    if (validationError) {
      setLocalError(validationError);
      setAvailability({ status: 'idle' });
      return;
    }

    setLocalError(undefined);
    setAvailability({ status: 'checking' });
    latestCheckSlugRef.current = normalized;

    // Debounced server-side availability check
    debounceTimerRef.current = setTimeout(async () => {
      const checkedSlug = normalized;
      try {
        const result = await queries.checkSlugAvailability(checkedSlug);
        if (latestCheckSlugRef.current !== checkedSlug) return;
        if (result.available) {
          setAvailability({ status: 'available' });
        } else {
          setAvailability({ status: 'unavailable', message: result.message });
        }
      } catch {
        if (latestCheckSlugRef.current !== checkedSlug) return;
        setAvailability({ status: 'unavailable', message: 'Failed to check availability' });
      }
    }, 300);
  };

  const handleSave = () => {
    if (slug === currentSlug) {
      setIsEditing(false);
      return;
    }

    renameDeployment.mutate(
      { deploymentId, newSlug: slug },
      {
        onSuccess: result => {
          if (result.success) {
            toast.success('Deployment renamed successfully');
            // State reset happens via the currentSlug useEffect when data refreshes
          } else {
            toast.error(result.message);
          }
        },
        onError: error => {
          toast.error(`Failed to rename: ${error.message}`);
        },
      }
    );
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && canSave) {
      handleSave();
    } else if (e.key === 'Escape') {
      handleCancel();
    }
  };

  const isUnchanged = slug === currentSlug;
  const canSave =
    !isUnchanged &&
    !localError &&
    availability.status === 'available' &&
    !renameDeployment.isPending;

  if (!isEditing) {
    return (
      <div className="flex h-9 min-w-0 items-center gap-2">
        <a
          href={deploymentUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="truncate text-sm text-blue-400 hover:text-blue-300"
        >
          {currentSlug}.d.kiloapps.io
        </a>
        <button
          onClick={handleEdit}
          className="shrink-0 rounded p-1 text-gray-400 hover:bg-gray-700 hover:text-gray-200"
          aria-label="Edit deployment name"
        >
          <Pencil className="size-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-2">
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center">
          <Input
            ref={inputRef}
            value={slug}
            onChange={e => handleSlugChange(e.target.value)}
            onKeyDown={handleKeyDown}
            className="rounded-r-none font-mono text-sm"
            disabled={renameDeployment.isPending}
            aria-invalid={!!localError || availability.status === 'unavailable'}
          />
          <span className="flex h-9 shrink-0 items-center rounded-r-md border border-l-0 border-gray-600 bg-gray-800 px-2 text-sm text-gray-400">
            .d.kiloapps.io
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="primary"
            size="icon"
            onClick={handleSave}
            disabled={!canSave}
            aria-label="Save"
          >
            {renameDeployment.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Check className="size-4" />
            )}
          </Button>
          <Button
            variant="secondary"
            size="icon"
            onClick={handleCancel}
            disabled={renameDeployment.isPending}
            aria-label="Cancel"
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>

      {localError && (
        <p className="flex items-center gap-1 text-xs text-red-400">
          <AlertCircle className="size-3" />
          {localError}
        </p>
      )}

      {!localError && !isUnchanged && availability.status === 'checking' && (
        <p className="flex items-center gap-1 text-xs text-gray-400">
          <Loader2 className="size-3 animate-spin" />
          Checking availability...
        </p>
      )}

      {!localError && availability.status === 'available' && (
        <p className="flex items-center gap-1 text-xs text-green-400">
          <CircleCheck className="size-3" />
          Available
        </p>
      )}

      {!localError && availability.status === 'unavailable' && (
        <p className="flex items-center gap-1 text-xs text-red-400">
          <AlertCircle className="size-3" />
          {availability.message}
        </p>
      )}
    </div>
  );
}
