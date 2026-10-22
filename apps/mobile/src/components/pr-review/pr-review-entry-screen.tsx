import * as Clipboard from 'expo-clipboard';
import { useFocusEffect, useRouter } from 'expo-router';
import { Clipboard as ClipboardIcon, SearchX, X } from '@/components/ui/icons';
import { DirectionalChevronRight } from '@/components/ui/directional-icons';
import { type ReactNode, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';

import { EmptyState } from '@/components/empty-state';
import { PrLinkPlaceholder } from '@/components/pr-review/pr-link-placeholder';
import { PrReviewContextLine } from '@/components/pr-review/pr-review-context-line';
import { PrReviewInboxList } from '@/components/pr-review/pr-review-inbox-list';
import { selectRecentPrRowState } from '@/lib/pr-review/recent-pr-row-state';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { ICON_TARGET_BOX_CLASS } from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { providerPrRefLabel, providerPrRoutePath } from '@/lib/pr-review/provider-pr-ref';
import {
  decidePrLinkPaste,
  prLinkToastClipboardEmptyCopy,
  prLinkToastPasteDeniedCopy,
  selectPrLinkClearButtonVisible,
  selectPrLinkPasteEmptyReason,
} from '@/lib/pr-review/pr-link-paste';
import {
  getRecentPrs,
  providerRefFromRecentPr,
  type RecentPr,
  recentPrKey,
  removeRecentPr,
} from '@/lib/pr-review/recent-prs';
import { usePrLinkField } from '@/lib/pr-review/use-pr-link-field';

export function PrReviewEntryScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const { t } = useTranslation();
  const { confirm, dialog } = useConfirmDialog();
  // Seeded from the module draft: a review push unmounts this screen, and
  // Back must bring the link and an enabled Open back without a re-paste.
  const {
    inputRef,
    initialText,
    hasInput,
    linkState,
    writeField,
    handleFieldChange,
    clearField,
    restoreDraft,
    submitDecision,
  } = usePrLinkField();
  const [recent, setRecent] = useState<RecentPr[] | null>(null);

  useFocusEffect(
    useCallback(() => {
      // A review push unmounts this screen; the module draft brings the link
      // back when Back remounts it, so a cancelled open needs no re-paste.
      restoreDraft();
      const state = { cancelled: false };
      void (async () => {
        const list = await getRecentPrs();
        if (!state.cancelled) {
          setRecent(list);
        }
      })();
      return () => {
        state.cancelled = true;
      };
    }, [restoreDraft])
  );

  const handleSubmit = () => {
    const decision = submitDecision();
    if (decision.kind === 'invalid') {
      return;
    }
    // Navigate straight to the ref's own provider route. Recents are written
    // only after an authorized payload (the review screen's backfill effect),
    // so a failed or unauthorized open never persists an entry. A
    // self-managed GitLab host parses to a ref whose instanceHint rides as
    // the route's `instance` param — the server re-derives the authoritative
    // instance, so a mismatched host lands on the clear not-authorized state.
    router.push(providerPrRoutePath(decision.ref));
  };

  const handlePaste = async () => {
    const clipboard = await Clipboard.getStringAsync();
    const decision = decidePrLinkPaste(clipboard);
    if (decision.kind === 'empty') {
      // iOS answers a denied prompt with an empty read, so ask the prompt-free
      // probe whether the clipboard still holds text before calling it empty.
      const clipboardHasString = await Clipboard.hasStringAsync();
      announcingToast.error(
        selectPrLinkPasteEmptyReason(clipboard, clipboardHasString) === 'denied'
          ? prLinkToastPasteDeniedCopy()
          : prLinkToastClipboardEmptyCopy()
      );
      return;
    }
    // Replace the native field, ref and derived UI together, never append at the cursor.
    writeField(decision.text);
    if (decision.kind === 'non-url-text') {
      return;
    }
    handleSubmit();
  };

  const handleRecentPress = (entry: RecentPr) => {
    // Navigate only. The review screen's backfill effect updates
    // `lastOpenedAt` (and `lastResult`) once an authorized payload loads.
    // The entry's platform (legacy entries: GitHub) decides the route, so a
    // GitLab row opens the GitLab surface, never a same-named GitHub PR.
    router.push(providerPrRoutePath(providerRefFromRecentPr(entry)));
  };

  const handleRemoveRecent = (entry: RecentPr) => {
    confirm({
      title: t('prReview.entry.removeFromRecentsTitle'),
      message: t('prReview.entry.removeFromRecentsMessage'),
      confirmLabel: t('common.remove'),
      onConfirm: () => {
        void (async () => {
          await removeRecentPr(entry);
          const list = await getRecentPrs();
          setRecent(list);
        })();
      },
    });
  };

  const showClearButton = selectPrLinkClearButtonVisible({ hasInput });
  const urlPlaceholder = t('prReview.entry.urlPlaceholder');

  let recentsBody: ReactNode = null;
  if (recent === null) {
    recentsBody = <ActivityIndicator size="small" color={colors.mutedForeground} />;
  } else if (recent.length === 0) {
    recentsBody = (
      <EmptyState
        icon={SearchX}
        title={t('prReview.entry.noRecentPrs')}
        description={t('prReview.entry.noRecentPrsDescription')}
        placement="top"
      />
    );
  } else {
    recentsBody = (
      <View className="rounded-lg bg-secondary">
        {recent.map((entry, index) => {
          const isLast = index === recent.length - 1;
          const rowState = selectRecentPrRowState(entry);
          const removeLabel = t('prReview.entry.removeRecentAccessibility', {
            repo: providerPrRefLabel(providerRefFromRecentPr(entry)),
          });
          return (
            <View
              key={recentPrKey(entry)}
              testID="recent-row"
              className={isLast ? '' : 'border-b-[0.5px] border-hair-soft'}
            >
              <Pressable
                onPress={() => {
                  handleRecentPress(entry);
                }}
                className="flex-row items-center gap-3 px-3 py-3 active:opacity-70"
              >
                <View className="flex-1 gap-1">
                  <Text
                    variant="small"
                    className="text-[10px] uppercase tracking-wide text-muted-foreground"
                  >
                    {rowState.provider}
                  </Text>
                  <Text className="text-sm font-medium" numberOfLines={1}>
                    {rowState.primary}
                  </Text>
                  {rowState.secondary ? (
                    <Text variant="muted" className="text-xs">
                      {rowState.secondary}
                    </Text>
                  ) : null}
                </View>
                <DirectionalChevronRight size={16} color={colors.mutedForeground} />
              </Pressable>
              <View className="flex-row items-center justify-between gap-2 px-3 pb-3">
                {rowState.failed ? (
                  <Text variant="muted" className="text-xs">
                    {t('prReview.entry.couldNotLoad')}
                  </Text>
                ) : (
                  <View />
                )}
                <View className="flex-row items-center gap-2">
                  {rowState.failed ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onPress={() => {
                        handleRecentPress(entry);
                      }}
                      accessibilityLabel={t('common.retry')}
                    >
                      <Text>{t('common.retry')}</Text>
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="outline"
                    onPress={() => {
                      handleRemoveRecent(entry);
                    }}
                    accessibilityLabel={removeLabel}
                  >
                    <Text>{t('common.remove')}</Text>
                  </Button>
                </View>
              </View>
            </View>
          );
        })}
      </View>
    );
  }

  const pasteBlock = (
    <View className="gap-3">
      <View className="flex-row items-center gap-2">
        <View
          className="min-h-14 min-w-0 flex-1 flex-row items-center rounded-md border border-border bg-card"
          testID="pr-link-input-row"
          collapsable={false}
        >
          <Input
            ref={inputRef}
            defaultValue={initialText}
            placeholder={urlPlaceholder}
            // The native hint is not reliably one line: Android lays it out
            // on a second line the one-line field clips. Both platforms draw
            // the visible placeholder with the one-line PrLinkPlaceholder
            // overlay instead; the hint stays set for the digest and
            // accessibility text but is invisible.
            placeholderTextColor="transparent"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            numberOfLines={1}
            onChangeText={handleFieldChange}
            // The shared single-line box (`@/components/ui/input`) supplies the
            // height floor, the one line box for the placeholder and the value,
            // and the RTL content alignment, so this field keeps only its own
            // chrome and text size.
            className="min-w-0 flex-1 bg-transparent pl-3 pr-1 text-base text-foreground"
            accessibilityLabel={t('prReview.entry.urlAccessibility')}
            returnKeyType="go"
            onSubmitEditing={handleSubmit}
          />
          {!hasInput ? <PrLinkPlaceholder label={urlPlaceholder} /> : null}
          {showClearButton ? (
            // The clear control is icon-only like the paste control beside it,
            // so it carries the same shared 48dp target; the 45pt box it used
            // to render (`h-13`, which is 45pt at this app's 14pt rem) sits
            // under Android's minimum.
            <Pressable
              onPress={clearField}
              accessibilityRole="button"
              accessibilityLabel={t('prReview.entry.clearLink')}
              className={`${ICON_TARGET_BOX_CLASS} active:opacity-70`}
            >
              <X size={16} color={colors.mutedForeground} />
            </Pressable>
          ) : null}
        </View>
        <Pressable
          onPress={() => {
            void handlePaste();
          }}
          accessibilityRole="button"
          accessibilityLabel={t('prReview.entry.pasteLink')}
          className={`${ICON_TARGET_BOX_CLASS} rounded-md border border-border bg-card active:opacity-70`}
        >
          <ClipboardIcon size={18} color={colors.mutedForeground} />
        </Pressable>
      </View>
      <View>
        <Text
          className="text-sm opacity-0"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          {t('prReview.linkPasteNotAPullRequest')}
        </Text>
        <View className="absolute inset-0">
          <AccessibleStatus
            className="text-sm"
            message={linkState === 'invalid' ? t('prReview.linkPasteNotAPullRequest') : null}
          />
        </View>
      </View>
      <Button
        disabled={linkState !== 'valid'}
        onPress={handleSubmit}
        accessibilityLabel={t('prReview.entry.openAccessibility')}
      >
        <Text>{t('prReview.entry.open')}</Text>
      </Button>
    </View>
  );

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('common.prReview')} />
      <PrReviewContextLine />
      <PrReviewInboxList header={pasteBlock} recents={recentsBody} />
      {dialog}
    </View>
  );
}
