'use client';

import { useState, useMemo, useEffect } from 'react';
import { Layers, ChevronDown, Check, Plus, FolderCog, X, ArrowLeft, Zap } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import {
  useProfiles,
  useCombinedProfiles,
  useRepoBindings,
  type ProfileSummaryWithOwner,
} from '@/hooks/useCloudAgentProfiles';
import { resolveProfileLayers } from '@kilocode/cloud-agent-profile';
import { ProfilesListDialog } from './ProfilesListDialog';

type ProfilePickerPopoverProps = {
  organizationId?: string;
  selectedOverrideProfileId: string | null;
  onOverrideProfileSelect: (id: string | null) => void;
  repoFullName?: string;
  platform?: 'github' | 'gitlab';
};

export function ProfilePickerPopover({
  organizationId,
  selectedOverrideProfileId,
  onOverrideProfileSelect,
  repoFullName,
  platform,
}: ProfilePickerPopoverProps) {
  const [open, setOpen] = useState(false);
  const [pickingOverride, setPickingOverride] = useState(false);
  const [showManageProfiles, setShowManageProfiles] = useState(false);
  const [openToNewProfile, setOpenToNewProfile] = useState(false);
  const [editProfileId, setEditProfileId] = useState<string | null>(null);

  // Reset override-picker mode whenever the popover closes.
  useEffect(() => {
    if (!open) setPickingOverride(false);
  }, [open]);

  const openEditDialog = (profileId: string) => {
    setOpen(false);
    setOpenToNewProfile(false);
    setEditProfileId(profileId);
    setShowManageProfiles(true);
  };

  const { data: combinedData } = useCombinedProfiles({
    organizationId: organizationId ?? '',
    enabled: !!organizationId,
  });
  const { data: personalProfilesData } = useProfiles({
    organizationId: undefined,
    enabled: !organizationId,
  });

  const allProfiles: ProfileSummaryWithOwner[] = useMemo(
    () =>
      organizationId
        ? (combinedData?.allProfiles ?? [])
        : (personalProfilesData ?? []).map(p => ({ ...p, ownerType: 'user' as const })),
    [organizationId, combinedData, personalProfilesData]
  );

  const effectiveDefaultProfileId = organizationId
    ? (combinedData?.effectiveDefaultId ?? null)
    : (personalProfilesData?.find(p => p.isDefault)?.id ?? null);

  const { data: repoBindings } = useRepoBindings({ organizationId });

  const repoBindingProfileId = useMemo(() => {
    if (!repoFullName || !repoBindings) return null;
    const binding = repoBindings.find(
      b =>
        b.repoFullName.toLowerCase() === repoFullName.toLowerCase() &&
        (!platform || b.platform === platform)
    );
    return binding?.profileId ?? null;
  }, [repoFullName, repoBindings, platform]);

  // Shared resolution logic — same rules as the server-side merge.
  const layers = useMemo(
    () =>
      resolveProfileLayers({
        repoBindingProfileId,
        effectiveDefaultProfileId,
        explicitOverrideProfileId: selectedOverrideProfileId,
      }),
    [repoBindingProfileId, effectiveDefaultProfileId, selectedOverrideProfileId]
  );

  const baseProfile = useMemo(
    () => (layers.base ? (allProfiles.find(p => p.id === layers.base?.profileId) ?? null) : null),
    [allProfiles, layers.base]
  );

  const topProfile = useMemo(
    () => (layers.top ? (allProfiles.find(p => p.id === layers.top?.profileId) ?? null) : null),
    [allProfiles, layers.top]
  );
  const topSource = layers.top?.source ?? null;

  // Profiles offered as override candidates. The base profile is omitted
  // because picking it would dedupe to a no-op in `resolveProfileLayers`.
  const overrideCandidates = useMemo(
    () => allProfiles.filter(p => p.id !== layers.base?.profileId),
    [allProfiles, layers.base]
  );

  const chipName = topProfile?.name ?? baseProfile?.name ?? null;

  const chipCounts = useMemo(() => {
    const vars = Math.max(baseProfile?.varCount ?? 0, topProfile?.varCount ?? 0);
    const mcps = (baseProfile?.mcpServerCount ?? 0) + (topProfile?.mcpServerCount ?? 0);
    const skills = (baseProfile?.skillCount ?? 0) + (topProfile?.skillCount ?? 0);
    const cmds = (baseProfile?.kiloCommandCount ?? 0) + (topProfile?.kiloCommandCount ?? 0);
    return [
      vars > 0 && `${vars} vars`,
      mcps > 0 && `${mcps} MCP`,
      skills > 0 && `${skills} skills`,
      cmds > 0 && `${cmds} cmds`,
    ]
      .filter(Boolean)
      .join(' · ');
  }, [baseProfile, topProfile]);

  function formatCounts(profile: ProfileSummaryWithOwner) {
    return [
      profile.varCount > 0 && `${profile.varCount} vars`,
      profile.mcpServerCount > 0 && `${profile.mcpServerCount} MCP`,
      profile.skillCount > 0 && `${profile.skillCount} skills`,
      profile.kiloCommandCount > 0 && `${profile.kiloCommandCount} cmds`,
    ]
      .filter(Boolean)
      .join(' · ');
  }

  // Two layers are present (repo + something on top). Used for the "+1" hint
  // and the "on top of …" affordance regardless of whether the top is an
  // explicit pick or just the default.
  const hasTwoLayers = !!topProfile && !!baseProfile;

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            className={cn(
              'inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors',
              'border border-border/50 bg-muted/30 hover:bg-muted/60 hover:border-border',
              'text-muted-foreground hover:text-foreground',
              open && 'border-border bg-muted/60 text-foreground'
            )}
          >
            <Layers className="h-3 w-3 shrink-0" />
            {chipName ? (
              <>
                <span className="font-medium">{chipName}</span>
                {chipCounts && <span className="opacity-60">· {chipCounts}</span>}
                {hasTwoLayers && <span className="text-primary/80 ml-0.5">+1</span>}
              </>
            ) : (
              <span>No profile</span>
            )}
            <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
          </button>
        </PopoverTrigger>

        <PopoverContent className="w-80 p-3" align="end" sideOffset={6}>
          {pickingOverride ? (
            <OverridePickerView
              candidates={overrideCandidates}
              selectedOverrideProfileId={selectedOverrideProfileId}
              formatCounts={formatCounts}
              onSelect={id => {
                onOverrideProfileSelect(id);
                setPickingOverride(false);
              }}
              onBack={() => setPickingOverride(false)}
            />
          ) : (
            <ActiveProfileView
              baseProfile={baseProfile}
              topProfile={topProfile}
              topSource={topSource}
              allProfiles={allProfiles}
              overrideCandidatesCount={overrideCandidates.length}
              formatCounts={formatCounts}
              onEditProfile={openEditDialog}
              onStartPickOverride={() => setPickingOverride(true)}
              onRemoveOverride={() => onOverrideProfileSelect(null)}
              onSelectProfile={id => {
                onOverrideProfileSelect(id);
                setOpen(false);
              }}
            />
          )}

          <div className="my-3 border-t" />

          <div className="flex gap-2">
            <button
              className="flex flex-1 cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1.5 text-xs transition-colors hover:bg-accent"
              onClick={() => {
                setOpen(false);
                setOpenToNewProfile(true);
                setShowManageProfiles(true);
              }}
            >
              <Plus className="h-3 w-3 shrink-0" />
              New profile
            </button>
            <button
              className="flex flex-1 cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1.5 text-xs transition-colors hover:bg-accent"
              onClick={() => {
                setOpen(false);
                setOpenToNewProfile(false);
                setShowManageProfiles(true);
              }}
            >
              <FolderCog className="h-3 w-3 shrink-0" />
              Manage profiles...
            </button>
          </div>
        </PopoverContent>
      </Popover>

      <ProfilesListDialog
        organizationId={organizationId}
        open={showManageProfiles}
        onOpenChange={open => {
          setShowManageProfiles(open);
          if (!open) {
            setOpenToNewProfile(false);
            setEditProfileId(null);
          }
        }}
        onProfileSelect={id => {
          onOverrideProfileSelect(id);
          setShowManageProfiles(false);
        }}
        openToNewProfile={openToNewProfile}
        initialSelectedProfileId={editProfileId}
      />
    </>
  );
}

type PickerRowProps = {
  label: string;
  meta?: string;
  isSelected: boolean;
  onClick: () => void;
};

function PickerRow({ label, meta, isSelected, onClick }: PickerRowProps) {
  return (
    <button
      className={cn(
        'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
        'hover:bg-accent text-left',
        isSelected && 'text-foreground'
      )}
      onClick={onClick}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        {isSelected && <Check className="text-primary h-3 w-3" />}
      </span>
      <span className={cn('flex-1', isSelected ? 'font-medium' : 'text-muted-foreground')}>
        {label}
      </span>
      {meta && <span className="text-muted-foreground shrink-0 text-xs">{meta}</span>}
    </button>
  );
}

type ActiveProfileViewProps = {
  baseProfile: ProfileSummaryWithOwner | null;
  topProfile: ProfileSummaryWithOwner | null;
  topSource: 'repo-binding' | 'default' | 'explicit' | null;
  allProfiles: ProfileSummaryWithOwner[];
  overrideCandidatesCount: number;
  formatCounts: (p: ProfileSummaryWithOwner) => string;
  onEditProfile: (id: string) => void;
  onStartPickOverride: () => void;
  onRemoveOverride: () => void;
  onSelectProfile: (id: string) => void;
};

function ActiveProfileView({
  baseProfile,
  topProfile,
  topSource,
  allProfiles,
  overrideCandidatesCount,
  formatCounts,
  onEditProfile,
  onStartPickOverride,
  onRemoveOverride,
  onSelectProfile,
}: ActiveProfileViewProps) {
  // Nothing selected at all and no profiles exist.
  if (!baseProfile && !topProfile && allProfiles.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">
        No profiles yet. Create one to add environment variables, MCP servers, and skills.
      </p>
    );
  }

  // No base and no top, but profiles exist — show the picker list directly so
  // the user can select one with a single click.
  if (!baseProfile && !topProfile) {
    return (
      <>
        <p className="text-muted-foreground mb-2 text-[10px] font-semibold uppercase tracking-wider">
          Pick a profile
        </p>
        <div className="max-h-48 space-y-0.5 overflow-y-auto">
          {allProfiles.map(profile => (
            <PickerRow
              key={profile.id}
              label={profile.name}
              meta={formatCounts(profile)}
              isSelected={false}
              onClick={() => onSelectProfile(profile.id)}
            />
          ))}
        </div>
      </>
    );
  }

  // The profile the user sees as "active" — top takes precedence over base.
  const active = topProfile ?? baseProfile;
  if (!active) return null;

  // An explicit pick is what the user can change/remove for this task.
  const isExplicit = topSource === 'explicit';
  // Show "override" badge only when the explicit pick is layered on a base.
  const isOverridingBase = isExplicit && !!baseProfile;
  // When only the base is showing (no top), badge it as "repo" — distinct from
  // the default case which is the expected baseline and unbadged.
  const badgeLabel = isOverridingBase ? 'override' : !topProfile && baseProfile ? 'repo' : null;

  return (
    <>
      <p className="text-muted-foreground mb-2 text-[10px] font-semibold uppercase tracking-wider">
        Active profile
      </p>

      <div className="overflow-hidden rounded-lg border">
        <div className="bg-accent/10 hover:bg-accent/30 flex items-center gap-2 p-3 transition-colors">
          <Layers className="text-primary h-3.5 w-3.5 shrink-0" />
          <button
            type="button"
            onClick={() => onEditProfile(active.id)}
            className="min-w-0 flex-1 cursor-pointer text-left"
            title="Edit profile"
          >
            <div className="truncate text-sm font-medium">{active.name}</div>
            {formatCounts(active) && (
              <div className="text-muted-foreground text-xs">{formatCounts(active)}</div>
            )}
          </button>
          {badgeLabel && (
            <span className="text-muted-foreground border-muted-foreground/30 shrink-0 rounded border px-1.5 py-0.5 text-[10px]">
              {badgeLabel}
            </span>
          )}
          {isExplicit && (
            <button
              type="button"
              onClick={onRemoveOverride}
              className="text-muted-foreground hover:bg-accent hover:text-foreground shrink-0 cursor-pointer rounded p-0.5 transition-colors"
              title={isOverridingBase ? 'Remove override' : 'Clear profile'}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* When two layers are active, show the base underneath so the user
            knows what the top is layered on top of. The base is always the
            repo binding in the new model. */}
        {topProfile && baseProfile && (
          <button
            type="button"
            onClick={() => onEditProfile(baseProfile.id)}
            className="hover:bg-accent/30 block w-full cursor-pointer border-t border-dashed px-3 py-2 text-left transition-colors"
            title="Edit base profile"
          >
            <div className="text-muted-foreground flex items-center gap-2 text-xs">
              <span className="opacity-60">on top of</span>
              <span className="truncate font-medium">{baseProfile.name}</span>
              <span className="ml-auto shrink-0 text-[10px] opacity-60">repo</span>
            </div>
          </button>
        )}
      </div>

      {!isExplicit && overrideCandidatesCount > 0 && (
        <div className="mt-3">
          <button
            type="button"
            onClick={onStartPickOverride}
            className="hover:bg-accent flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-xs transition-colors"
          >
            <Zap className="h-3 w-3 shrink-0" />
            Override for this task…
          </button>
        </div>
      )}
    </>
  );
}

type OverridePickerViewProps = {
  candidates: ProfileSummaryWithOwner[];
  selectedOverrideProfileId: string | null;
  formatCounts: (p: ProfileSummaryWithOwner) => string;
  onSelect: (id: string | null) => void;
  onBack: () => void;
};

function OverridePickerView({
  candidates,
  selectedOverrideProfileId,
  formatCounts,
  onSelect,
  onBack,
}: OverridePickerViewProps) {
  return (
    <>
      <div className="mb-2 flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="text-muted-foreground hover:text-foreground -ml-1 cursor-pointer rounded p-0.5 transition-colors"
          title="Back"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        <p className="text-muted-foreground text-[10px] font-semibold uppercase tracking-wider">
          Pick override
        </p>
      </div>

      {candidates.length > 0 ? (
        <div className="max-h-48 space-y-0.5 overflow-y-auto">
          <PickerRow
            label="None"
            isSelected={!selectedOverrideProfileId}
            onClick={() => onSelect(null)}
          />
          {candidates.map(profile => (
            <PickerRow
              key={profile.id}
              label={profile.name}
              meta={formatCounts(profile)}
              isSelected={profile.id === selectedOverrideProfileId}
              onClick={() => onSelect(profile.id === selectedOverrideProfileId ? null : profile.id)}
            />
          ))}
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">No other profiles available.</p>
      )}
    </>
  );
}
