import {
  Brain,
  FileSliders,
  FolderGit2,
  Gauge,
  type LucideIcon,
  MessageSquareText,
  ScrollText,
  ShieldCheck,
} from '@/components/ui/icons';

import { type PLATFORM_CAPABILITIES, type ReviewConfigData } from '@/lib/code-reviewer-config';
import { type ModelOption } from '@/lib/hooks/use-available-models';
import { capitalize } from '@/lib/utils';

type OverviewRow = {
  field: string;
  icon: LucideIcon;
  title: string;
  subtitle: string;
  onPress?: () => void;
  // A row members may open read-only even when they cannot edit config.
  readOnlyAccessible?: boolean;
};

/**
 * Config-derived rows shown on a connected provider's overview screen.
 * Pulled out of platform-overview-screen.tsx purely to keep that file under
 * the repo's max-lines limit — no behavior change.
 */
export function buildOverviewRows({
  data,
  capabilities,
  models,
  modelsLoading,
  onOpenModelPicker,
  onOpenReviewMemory,
}: {
  data: ReviewConfigData;
  capabilities: (typeof PLATFORM_CAPABILITIES)[keyof typeof PLATFORM_CAPABILITIES];
  models: ModelOption[];
  modelsLoading: boolean;
  onOpenModelPicker: () => void;
  onOpenReviewMemory?: () => void;
}): OverviewRow[] {
  return [
    {
      field: 'style',
      icon: MessageSquareText,
      title: 'Review Style',
      subtitle: capitalize(data.reviewStyle),
    },
    {
      field: 'focus-areas',
      icon: ShieldCheck,
      title: 'Focus Areas',
      subtitle:
        data.focusAreas.length > 0 ? data.focusAreas.map(capitalize).join(', ') : 'All areas',
    },
    // Custom Instructions is deprecated in favour of REVIEW.md, so the row is
    // only offered to configs that already have something stored in it.
    ...(data.customInstructions?.trim()
      ? [
          {
            field: 'instructions',
            icon: ScrollText,
            title: 'Custom Instructions',
            subtitle: 'Set',
          },
        ]
      : []),
    {
      field: 'model',
      icon: FileSliders,
      title: 'Model',
      subtitle: models.find(model => model.id === data.modelSlug)?.name ?? data.modelSlug,
      onPress: modelsLoading || models.length === 0 ? undefined : onOpenModelPicker,
    },
    ...(capabilities.gateRow
      ? [
          {
            field: 'gate',
            icon: Gauge,
            title: 'Merge gate',
            subtitle: capitalize(data.gateThreshold),
          },
        ]
      : []),
    {
      field: 'repos',
      icon: FolderGit2,
      title: 'Repositories',
      subtitle:
        capabilities.selectionModePicker && data.repositorySelectionMode === 'all'
          ? 'All repositories'
          : `${data.selectedRepositoryIds.length} selected`,
    },
    // Review memory is GitHub-only and only offered when the caller wires the
    // navigation callback (the overview screen pushes the scope-level route,
    // not a per-platform settings field). Members may open it read-only: the
    // server allows member reads and the screen ships a member off-state.
    ...(onOpenReviewMemory
      ? [
          {
            field: 'review-memory',
            icon: Brain,
            title: 'Review memory',
            subtitle: 'Proposed REVIEW.md guidance',
            onPress: onOpenReviewMemory,
            readOnlyAccessible: true,
          },
        ]
      : []),
  ];
}

/** Shared onPress resolution for an overview row: no-op when read-only unless
 * the row is marked read-only-accessible, the row's own handler (e.g. the
 * model picker or review memory) when it has one, otherwise a push to its
 * settings field. */
export function resolveRowOnPress(
  row: OverviewRow,
  canEdit: boolean,
  pushField: (field: string) => void
): (() => void) | undefined {
  if (!canEdit && !row.readOnlyAccessible) {
    return undefined;
  }
  if ('onPress' in row) {
    return row.onPress;
  }
  return () => {
    pushField(row.field);
  };
}
