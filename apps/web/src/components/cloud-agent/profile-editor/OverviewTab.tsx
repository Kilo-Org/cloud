'use client';

import { useState, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { Star, Trash2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { InlineDeleteConfirmation } from '@/components/ui/inline-delete-confirmation';
import { cn } from '@/lib/utils';
import type {
  useProfile,
  useProfileMutations,
  useCombinedProfileMutations,
} from '@/hooks/useCloudAgentProfiles';
import type { ProfileOwnerType } from '@kilocode/cloud-agent-profile';

type AutoSaveFieldProps = {
  kind: 'input' | 'textarea';
  id: string;
  label: string;
  placeholder?: string;
  initialValue: string;
  /** Returns the canonical value that was actually persisted (e.g. trimmed). */
  onSave: (value: string) => Promise<string>;
  disabled?: boolean;
};

function AutoSaveField({
  kind,
  id,
  label,
  placeholder,
  initialValue,
  onSave,
  disabled = false,
}: AutoSaveFieldProps) {
  const [value, setValue] = useState(initialValue);
  const [savedValue, setSavedValue] = useState(initialValue);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);

  const commit = async () => {
    if (value === savedValue) return;
    setStatus('saving');
    try {
      const persisted = await onSave(value);
      setSavedValue(persisted);
      setValue(persisted);
      setStatus('saved');
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setStatus('idle'), 1500);
    } catch {
      // Revert on failure so the rendered value matches what's on the server.
      // Error toast is surfaced by `onSave`.
      setValue(savedValue);
      setStatus('idle');
    }
  };

  const commonProps = {
    id,
    value,
    placeholder,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setValue(e.target.value),
    onBlur: () => {
      if (!disabled) void commit();
    },
    disabled: disabled || status === 'saving',
  };

  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between">
        <Label htmlFor={id} className="text-xs">
          {label}
        </Label>
        {status === 'saving' && <span className="text-muted-foreground text-[10px]">Saving…</span>}
        {status === 'saved' && <span className="text-muted-foreground text-[10px]">Saved</span>}
      </div>
      {kind === 'input' ? (
        <Input
          {...commonProps}
          className="h-8 text-sm"
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
        />
      ) : (
        <Textarea {...commonProps} rows={2} className="text-sm" />
      )}
    </div>
  );
}

// -------------------------------------------------------------------
// OverviewTab
// -------------------------------------------------------------------

type OverviewTabProps = {
  profile: NonNullable<ReturnType<typeof useProfile>['data']>;
  ownerType: ProfileOwnerType;
  organizationId?: string;
  isEffectiveDefault: boolean;
  mutations:
    | ReturnType<typeof useProfileMutations>
    | ReturnType<typeof useCombinedProfileMutations>;
  onDelete: () => void;
  isDeleting: boolean;
  readOnly?: boolean;
};

export function OverviewTab({
  profile,
  ownerType,
  organizationId,
  isEffectiveDefault,
  mutations,
  onDelete,
  isDeleting,
  readOnly = false,
}: OverviewTabProps) {
  const [togglingDefault, setTogglingDefault] = useState(false);

  const handleToggleDefault = async () => {
    setTogglingDefault(true);
    try {
      if (profile.isDefault) {
        await mutations.clearDefault.mutateAsync({ profileId: profile.id, organizationId });
        toast.success(`"${profile.name}" is no longer the default`);
      } else {
        await mutations.setAsDefault.mutateAsync({ profileId: profile.id, organizationId });
        toast.success(`"${profile.name}" is now the default`);
      }
    } catch {
      toast.error('Failed to update default');
    } finally {
      setTogglingDefault(false);
    }
  };

  return (
    <div className="space-y-4 p-4">
      {/* Name */}
      <AutoSaveField
        key={`name-${profile.id}`}
        kind="input"
        id={`name-${profile.id}`}
        label="Name"
        placeholder="Profile name"
        initialValue={profile.name}
        disabled={readOnly}
        onSave={async value => {
          const trimmed = value.trim();
          if (!trimmed) {
            toast.error('Name is required');
            throw new Error('Name is required');
          }
          // Only send the changed field — sending stale `description`
          // here can clobber a concurrent description autosave.
          await mutations.updateProfile.mutateAsync({
            profileId: profile.id,
            name: trimmed,
            organizationId,
          });
          return trimmed;
        }}
      />

      {/* Description */}
      <AutoSaveField
        key={`desc-${profile.id}`}
        kind="textarea"
        id={`desc-${profile.id}`}
        label="Description"
        placeholder="Optional description"
        initialValue={profile.description ?? ''}
        disabled={readOnly}
        onSave={async value => {
          const trimmed = value.trim();
          // Only send the changed field — sending stale `name` here
          // can clobber a concurrent name autosave.
          await mutations.updateProfile.mutateAsync({
            profileId: profile.id,
            description: trimmed || undefined,
            organizationId,
          });
          return trimmed;
        }}
      />

      {/* Default toggle */}
      <div className="flex items-center justify-between rounded-lg border p-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium">
            <Star className={cn('h-4 w-4', isEffectiveDefault && 'text-primary fill-current')} />
            {ownerType === 'organization' ? 'Organization default' : 'Personal default'}
          </div>
          <p className="text-muted-foreground mt-0.5 text-xs">
            {ownerType === 'organization'
              ? 'Auto-loaded for org members who have no personal default and no repo profile'
              : 'Auto-loaded when no repo profile is set (overrides any org default)'}
          </p>
        </div>
        <Switch
          aria-label={
            ownerType === 'organization'
              ? 'Organization default profile'
              : 'Personal default profile'
          }
          checked={profile.isDefault}
          onCheckedChange={handleToggleDefault}
          disabled={readOnly || togglingDefault}
        />
      </div>

      {/* Delete profile */}
      {!readOnly && (
        <div className="flex items-center justify-between rounded-lg border p-3">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium">
              <Trash2 className="text-destructive h-4 w-4" />
              Delete profile
            </div>
            <p className="text-muted-foreground mt-0.5 text-xs">
              Permanently removes this profile and its settings. This cannot be undone.
            </p>
          </div>
          <InlineDeleteConfirmation
            onDelete={onDelete}
            isLoading={isDeleting}
            showAsButton
            buttonText="Delete"
          />
        </div>
      )}
    </div>
  );
}
