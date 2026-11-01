import * as Clipboard from 'expo-clipboard';
import { useFocusEffect, useRouter } from 'expo-router';
import { Clipboard as ClipboardIcon, SearchX, X } from '@/components/ui/icons';
import { DirectionalChevronRight } from '@/components/ui/directional-icons';
import { type ReactNode, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';

import { ContextControl } from '@/components/context-control';
import { EmptyState } from '@/components/empty-state';
import { PrLinkPlaceholder } from '@/components/pr-review/pr-link-placeholder';
import {
  PR_REVIEW_SECTION_BREAK,
  PrReviewInboxList,
} from '@/components/pr-review/pr-review-inbox-list';
import { providerPrNounKey } from '@/components/pr-review/pr-review-provider-noun';
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
      message: `${providerPrRefLabel(providerRefFromRecentPr(entry))}\n${t('prReview.entry.removeFromRecentsMessage')}`,
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
      <View className="gap-3">
        {recent.map(entry => {
          const rowState = selectRecentPrRowState(entry);
          const removeLabel = t('prReview.entry.removeRecentAccessibility', {
            repo: providerPrRefLabel(providerRefFromRecentPr(entry)),
          });
          return (
            <View
              key={recentPrKey(entry)}
              testID="recent-row"
              className="rounded-xl border border-border bg-card"
            >
              <Pressable
                onPress={() => {
                  handleRecentPress(entry);
                }}
                onLongPress={() => {
                  handleRemoveRecent(entry);
                }}
                accessibilityRole="button"
                accessibilityActions={[{ name: 'remove', label: removeLabel }]}
                onAccessibilityAction={event => {
                  if (event.nativeEvent.actionName === 'remove') {
                    handleRemoveRecent(entry);
                  }
                }}
                className="flex-row items-center gap-3 p-3 active:opacity-70"
              >
                <View className="min-w-0 flex-1 gap-1">
                  <Text
                    variant="small"
                    className="text-[10px] uppercase tracking-wide text-muted-foreground"
                  >
                    {rowState.provider}
                  </Text>
                  <Text className="text-sm font-medium" numberOfLines={2}>
                    {rowState.primary}
                  </Text>
                  {rowState.secondary ? (
                    <Text
                      variant="muted"
                      className="text-xs"
                      numberOfLines={1}
                      ellipsizeMode="middle"
                    >
                      {rowState.secondary}
                    </Text>
                  ) : null}
                </View>
                <DirectionalChevronRight size={16} color={colors.mutedForeground} />
              </Pressable>
              {rowState.failed ? (
                // The footer names the item that failed, not just "couldn't
                // load": the row stands for one pull/merge request, so the
                // provider's own noun says what to retry. The retry keeps the
                // link treatment — a bordered control beside the card's plain
                // lines read as a piece of another surface — while its own node
                // still carries the state-action box, because `hitSlop` widens
                // the touch region without enlarging the rect an audit reads.
                <View className="flex-row items-center justify-between gap-3 border-t border-hair-soft px-3 py-1">
                  <Text variant="muted" className="min-w-0 flex-1 text-xs">
                    {t('common.couldNotOpen', {
                      label: t(providerPrNounKey(entry.platform ?? 'github')),
                    })}
                  </Text>
                  <Button
                    size="action"
                    variant="link"
                    className="px-0"
                    hitSlop={{ top: 4, bottom: 4, left: 8, right: 8 }}
                    onPress={() => {
                      handleRecentPress(entry);
                    }}
                    accessibilityLabel={t('common.retry')}
                  >
                    {/* The card's own ink, not the link accent: this retry sits
                        in a footer under a row's plain lines, and the accent is
                        the loudest colour the dark card can carry, so it read
                        as a second primary action over the screen's own Open
                        button. The link affordance (the press underline) and
                        the action box stay. */}
                    <Text className="text-foreground">{t('common.retry')}</Text>
                  </Button>
                </View>
              ) : null}
            </View>
          );
        })}
      </View>
    );
  }

  const pasteBlock = (
    <View>
      <View className="gap-4">
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
        <Button
          disabled={linkState !== 'valid'}
          onPress={handleSubmit}
          accessibilityLabel={t('prReview.entry.openAccessibility')}
        >
          <Text>{t('prReview.entry.open')}</Text>
        </Button>
      </View>
      {/* The invalid-link notice is the field's own error and sits under the
          field's action, not between the field and Open: a line there pushed
          Open 38.5 dp away from the field and the two stopped reading as one
          group. Its line occupies the section break above the INBOX header
          instead of a block of its own, so the break is the one section-gap
          token in either state and a pasted non-PR link never moves the
          sections below the form. */}
      <View className={PR_REVIEW_SECTION_BREAK.room}>
        <AccessibleStatus
          className="text-sm"
          message={linkState === 'invalid' ? t('prReview.linkPasteNotAPullRequest') : null}
        />
      </View>
    </View>
  );

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={t('common.prReview')}
        headerRight={<ContextControl />}
        headerRightShrinks
        allowHeaderRightStacking={false}
      />
      <PrReviewInboxList header={pasteBlock} recents={recentsBody} />
      {dialog}
    </View>
  );
}
