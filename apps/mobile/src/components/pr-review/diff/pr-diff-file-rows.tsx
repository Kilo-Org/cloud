// File-level row components for the PR diff FlashList.

import { selectionHaptic } from '@/lib/haptics';
import {
  type ProviderPrFilePatchMissingCause,
  type ProviderPrPlatform,
} from '@kilocode/app-shared/provider-review';
import { ChevronDown, ChevronUp, Eye, EyeOff, File, Link2 } from '@/components/ui/icons';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { fileStatusIcon, fileStatusLabel } from '@/components/pr-review/diff/pr-diff-file-status';
import { Text } from '@/components/ui/text';
import { selectableRowA11y } from '@/lib/a11y/selectable-row';
import {
  COMPACT_CONTROL_BOX_CLASS,
  COMPACT_CONTROL_HIT_SLOP,
  LINE_ACTION_BOX_CLASS,
  ROW_FRAME_CONTENT_PRESS_CLASS,
} from '@/lib/a11y/tap-target';
import { isolateLtrBidiText } from '@/lib/bidi';
import { reviewerPlatformLabel } from '@/lib/code-reviewer-config';
import { openExternalUrl } from '@/lib/external-link';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type PrReviewFile } from '@/lib/pr-review/diff/pr-review-file-types';
import { cn } from '@/lib/utils';

function ExpandChevron({ hasDiff, expanded }: { hasDiff: boolean; expanded: boolean }) {
  const colors = useThemeColors();
  if (!hasDiff) {
    return <View className="h-3 w-3" />;
  }
  // A disclosure caret, not a navigation chevron: it names the state of the
  // patch under the row, so it stays on the vertical pair every other
  // disclosure row uses instead of the row-trailing `RowChevron`.
  return expanded ? (
    <ChevronUp size={18} color={colors.mutedForeground} />
  ) : (
    <ChevronDown size={18} color={colors.mutedForeground} />
  );
}

/**
 * Fixed-size mark-viewed icon toggle — no path-text reflow on toggle (D9/AC6).
 * The compact box plus its slop reach 48 dp: `h-9 w-9` measured 31.5 dp at
 * NativeWind's 14pt rem, so a 4 dp slop stopped at 39.5 dp.
 */
export function MarkViewedToggle({
  path,
  viewed,
  onToggle,
}: {
  path: string;
  viewed: boolean;
  onToggle: () => void;
}) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  return (
    <Pressable
      onPress={() => {
        selectionHaptic();
        onToggle();
      }}
      hitSlop={COMPACT_CONTROL_HIT_SLOP}
      {...selectableRowA11y({ multi: true, selected: viewed })}
      accessibilityLabel={
        viewed
          ? t('prReview.fileRows.unmarkViewed', { path })
          : t('prReview.fileRows.markViewed', { path })
      }
      className={cn(COMPACT_CONTROL_BOX_CLASS, 'active:opacity-70')}
    >
      {viewed ? (
        <Eye size={18} color={colors.foreground} />
      ) : (
        <EyeOff size={18} color={colors.mutedForeground} />
      )}
    </Pressable>
  );
}

export function TruncationBannerRow({ text }: { text: string }) {
  return (
    <View className="mx-4 mt-3 rounded-lg border border-warn-tile-border bg-warn-tile-bg p-3">
      <Text className="text-sm text-foreground">{text}</Text>
    </View>
  );
}

/** A file's mark-viewed state and its toggle; `null` renders no toggle. */
export type FileViewedToggle = { viewed: boolean; handleToggle: () => void } | null;

export function FileHeaderRow({
  file,
  expanded,
  hasDiff,
  viewedToggle,
  onToggleExpand,
}: {
  file: PrReviewFile;
  expanded: boolean;
  hasDiff: boolean;
  viewedToggle: FileViewedToggle;
  onToggleExpand: () => void;
}) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const StatusIcon = fileStatusIcon(file.status);
  const isRename = Boolean(file.previousPath) && file.previousPath !== file.path;
  const pathLine = isRename ? `${file.previousPath} → ${file.path}` : file.path;

  return (
    // The row's padding sits on the inner row, the parent both controls touch
    // in: Android delivers a touch only inside the parent view, so the expand
    // control's cancelled padding and the toggle's slop stay reachable.
    <View className="border-b-[0.5px] border-hair-soft bg-card">
      <View className="flex-row items-center gap-2 px-4 py-3">
        <Pressable
          onPress={hasDiff ? onToggleExpand : undefined}
          disabled={!hasDiff}
          accessibilityRole="button"
          accessibilityLabel={
            expanded ? t('prReview.fileRows.collapseFile') : t('prReview.fileRows.expandFile')
          }
          accessibilityState={{ expanded, disabled: !hasDiff }}
          // The control spans the row's vertical padding, so its own node is
          // the whole row height (the path lines alone measured 33.1 dp).
          className={cn(
            ROW_FRAME_CONTENT_PRESS_CLASS,
            'min-h-9 flex-1 flex-row items-center gap-2 active:opacity-70'
          )}
        >
          <View className="h-7 w-7 items-center justify-center">
            <ExpandChevron hasDiff={hasDiff} expanded={expanded} />
          </View>
          <StatusIcon size={14} color={colors.mutedForeground} />
          <View className="flex-1">
            <Text className="font-mono-medium text-sm text-foreground" numberOfLines={2}>
              {isolateLtrBidiText(pathLine)}
            </Text>
            {/* Each count is its own run, and a sign is a neutral: an RTL
                paragraph would take it and paint `+1` as `1+`. The isolate
                pins the count's order; the row itself still mirrors. */}
            <View className="mt-0.5 flex-row items-center gap-2">
              <Text variant="muted" className="text-xs">
                {fileStatusLabel(file.status)}
              </Text>
              <Text variant="muted" className="text-xs">
                {isolateLtrBidiText(`+${file.additions}`)}
              </Text>
              <Text variant="muted" className="text-xs">
                {isolateLtrBidiText(`-${file.deletions}`)}
              </Text>
            </View>
          </View>
        </Pressable>
        {viewedToggle ? (
          <MarkViewedToggle
            path={file.path}
            viewed={viewedToggle.viewed}
            onToggle={viewedToggle.handleToggle}
          />
        ) : null}
      </View>
    </View>
  );
}

/**
 * One key per reason a patch can be absent. The record is exhaustive, so a
 * cause added to the contract fails this module instead of painting a raw word.
 */
const PATCH_MISSING_COPY_KEY = {
  too_large: 'prReview.fileRows.diffTooLarge',
  binary: 'prReview.fileRows.binaryDiff',
  provider_omitted: 'prReview.fileRows.diffUnavailable',
  content_unchanged: 'prReview.fileRows.contentUnchanged',
} as const satisfies Record<ProviderPrFilePatchMissingCause, string>;

/**
 * A file whose patch is absent. The row names WHY in the provider's terms
 * (`file.patchMissingCause`), and links to the provider's whole diff page when
 * the diff has one — every provider here except a session diff, which has no
 * web page at all.
 */
export function PatchMissingRow({
  file,
  viewedToggle,
  link,
}: {
  file: PrReviewFile;
  viewedToggle: FileViewedToggle;
  link: { url: string; provider: ProviderPrPlatform } | null;
}) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  // A null cause with no patch means the read carried one that parsed to no
  // hunks, which is its own sentence.
  const causeCopy =
    file.patchMissingCause === null
      ? t('prReview.fileRows.noPreview')
      : t(PATCH_MISSING_COPY_KEY[file.patchMissingCause]);
  const provider = link === null ? null : reviewerPlatformLabel(link.provider);
  return (
    <View className="border-b-[0.5px] border-hair-soft bg-secondary px-4 py-3">
      {/* The row spans 7 dp of the padding around it and cancels it again, so
          the toggle's slop lands inside the row it touches in (46 dp) without
          reaching the provider link's own `mt-2` gap below. */}
      <View className="-my-2 flex-row items-center gap-2 py-2">
        <File size={14} color={colors.mutedForeground} />
        <View className="flex-1">
          <Text className="text-sm text-foreground">{causeCopy}</Text>
          <Text variant="muted" className="text-xs">
            {isolateLtrBidiText(file.path)}
          </Text>
        </View>
        {viewedToggle ? (
          <MarkViewedToggle
            path={file.path}
            viewed={viewedToggle.viewed}
            onToggle={viewedToggle.handleToggle}
          />
        ) : null}
      </View>
      {link === null || provider === null ? null : (
        <Pressable
          onPress={() => {
            void openExternalUrl(link.url, {
              label: t('prReview.fileRows.providerDiff', { provider }),
            });
          }}
          accessibilityRole="link"
          accessibilityLabel={t('prReview.fileRows.openDiffOnProvider', { provider })}
          // The shared caption-line action box: it lifts the link's own node to
          // the control-size floor, and its negative margin keeps the row's
          // height unchanged.
          className={cn(LINE_ACTION_BOX_CLASS, 'mt-2 flex-row items-center gap-1.5 self-start')}
        >
          <Link2 size={14} color={colors.info} />
          {/* eslint-disable-next-line react-native/no-inline-styles, react-native/no-color-literals -- dynamic theme info color */}
          <Text className="text-sm" style={{ color: colors.info }}>
            {t('prReview.fileRows.openOnProvider', { provider })}
          </Text>
        </Pressable>
      )}
    </View>
  );
}
