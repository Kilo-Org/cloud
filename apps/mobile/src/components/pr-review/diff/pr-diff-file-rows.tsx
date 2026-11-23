// File-level row components for the PR diff FlashList.

import { selectionHaptic } from '@/lib/haptics';
import {
  type ProviderPrFilePatchMissingCause,
  type ProviderPrPlatform,
} from '@kilocode/app-shared/provider-review';
import { ChevronDown, ChevronUp, Eye, EyeOff, Info, Link2 } from '@/components/ui/icons';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { fileStatusIcon, fileStatusLabel } from '@/components/pr-review/diff/pr-diff-file-status';
import { Text } from '@/components/ui/text';
import { selectableRowA11y } from '@/lib/a11y/selectable-row';
import {
  COMPACT_CONTROL_BOX_CLASS,
  COMPACT_CONTROL_HIT_SLOP,
  LINE_ACTION_BOX_CLASS,
  LINE_ACTION_HIT_SLOP,
  ROW_FRAME_CONTENT_PRESS_CLASS,
} from '@/lib/a11y/tap-target';
import { isolateLtrBidiText } from '@/lib/bidi';
import { reviewerPlatformLabel } from '@/lib/code-reviewer-config';
import { openExternalUrl } from '@/lib/external-link';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type PrReviewFile } from '@/lib/pr-review/diff/pr-review-file-types';
import { cn } from '@/lib/utils';

function ExpandChevron({ expanded }: { expanded: boolean }) {
  const colors = useThemeColors();
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

  const rowContent = (
    <>
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
    </>
  );

  return (
    // The row's padding sits on the inner row, the parent both controls touch
    // in: Android delivers a touch only inside the parent view, so the expand
    // control's cancelled padding and the toggle's slop stay reachable. A row
    // whose file has no patch renders no expand control at all.
    <View className="border-b-[0.5px] border-hair-soft bg-card">
      <View className="flex-row items-center gap-2 px-4 py-3">
        {hasDiff ? (
          <Pressable
            onPress={onToggleExpand}
            accessibilityRole="button"
            accessibilityLabel={
              expanded ? t('prReview.fileRows.collapseFile') : t('prReview.fileRows.expandFile')
            }
            accessibilityState={{ expanded, disabled: false }}
            // The control spans the row's vertical padding, so its own node is
            // the whole row height (the path lines alone measured 33.1 dp).
            className={cn(
              ROW_FRAME_CONTENT_PRESS_CLASS,
              'min-h-9 flex-1 flex-row items-center gap-2 active:opacity-70'
            )}
          >
            <View className="h-7 w-7 items-center justify-center">
              <ExpandChevron expanded={expanded} />
            </View>
            {rowContent}
          </Pressable>
        ) : (
          // A file with no patch always shows its notice and cannot collapse,
          // so this row carries no control at all: no caret slot, no button.
          // The status icon starts at the row's own padding instead.
          <View className="min-h-9 flex-1 flex-row items-center gap-2">{rowContent}</View>
        )}
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
 *
 * It says nothing the file header row above it already paints: that row owns
 * the file's path and its mark-viewed toggle, so this one carries neither.
 */
export function PatchMissingRow({
  file,
  link,
}: {
  file: PrReviewFile;
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
  return (
    // The file row above paints `bg-card`, which in dark is what `secondary`
    // also paints, so the notice would merge with the rows: it takes the raised
    // neutral step there. Light keeps `secondary`, where `secondary-fill` is the
    // same colour.
    <View className="border-b-[0.5px] border-hair-soft bg-secondary px-4 py-3 dark:bg-secondary-fill">
      <View className="flex-row items-center gap-2">
        <Info size={14} color={colors.mutedForeground} />
        <Text className="flex-1 text-sm text-foreground">{causeCopy}</Text>
      </View>
      {link === null ? null : <ProviderDiffLink link={link} />}
    </View>
  );
}

/**
 * The card's one control, when the diff has a provider page. `link` is
 * non-null here, so the platform's name is read straight from it — every
 * platform names itself, so there is no second "no label" case to guard.
 *
 * It is a caption action, not a status: the quiet second-line ink and the
 * leading glyph carry it, as the linked-issues row does, instead of the status
 * blue that pulled the eye off the file rows and the review action.
 */
function ProviderDiffLink({ link }: { link: { url: string; provider: ProviderPrPlatform } }) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const provider = reviewerPlatformLabel(link.provider);
  return (
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
      // height unchanged. The matching hit slop reaches the 44 dp touch
      // target the design gate measures.
      className={cn(LINE_ACTION_BOX_CLASS, 'mt-2 flex-row items-center gap-1.5 self-start')}
      hitSlop={LINE_ACTION_HIT_SLOP}
    >
      <Link2 size={14} color={colors.ink2} />
      <Text className="text-sm text-ink2">
        {t('prReview.fileRows.openOnProvider', { provider })}
      </Text>
    </Pressable>
  );
}
