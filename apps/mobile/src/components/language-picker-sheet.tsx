import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { reloadAppAsync } from 'expo';
import { useFocusEffect, usePreventRemove } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  I18nManager,
  type TextInput,
  useWindowDimensions,
  View,
  type ViewStyle,
} from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { toast } from 'sonner-native';

import { CenteredState } from '@/components/centered-state';
import { EmptyState } from '@/components/empty-state';
import { LanguagePickerRow } from '@/components/language-picker-row';
import { LanguageSearchField } from '@/components/language-search-field';
import { PickerSheet } from '@/components/picker-sheet';
import { SearchX } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { applyLanguagePreference } from '@/i18n/apply-language';
import { type LanguagePickerItem, languagePickerItems } from '@/i18n/language-rows';
import { LANGUAGE_ENDONYMS, type SupportedLanguage } from '@/i18n/languages';
import { resolveDeviceLanguage } from '@/i18n/resolve-language';
import { isRtlLanguage } from '@/i18n/rtl';
import { type LanguageReturnTarget } from '@/i18n/return-target';
import { searchPickerHeaderInList } from '@/lib/form-sheet-detents';
import {
  getLanguagePreference,
  getResolvedLanguage,
  type LanguagePreference,
} from '@/lib/hooks/use-language-preference';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { dismissSearchPickerKeyboard, SEARCHABLE_PICKER_LIST_PROPS } from '@/lib/picker-list';

// The picker sheet renders its own scroll container (`scrollable={false}`), so
// the list fills the sheet's body. The list stays transparent: the route's
// themed `contentStyle` paints the surface (see the (auth) layout), and a
// second opaque layer would cover the sheet's own themed surface.
const listFlexStyle = { flex: 1 } satisfies ViewStyle,
  listPadStyle = { paddingHorizontal: 16, paddingBottom: 16 } satisfies ViewStyle;
// A query that matches nothing leaves the no-match state as the list's only
// content, and the sheet body is far taller than it. Without this the content
// box shrinks to the state's own height, so the state's own centring collapses
// and the message hugs the top of a blank sheet. The box then fills the body and
// centres the state in it. Rows keep the box at its own height, so the first row
// starts at the list's first pixel; a search field that leads the list is
// content too, and must stay at the top, so that list keeps the plain style.
const emptyListContentContainerStyle = {
  ...listPadStyle,
  flexGrow: 1,
  justifyContent: 'center',
} satisfies ViewStyle;

type RestartFailure = 'reload-failed' | 'restart-skipped';

export function LanguagePickerSheet({
  onClose,
  onApplied,
  returnTarget,
  beforeReload,
}: Readonly<{
  onClose: () => void;
  onApplied?: () => void;
  returnTarget: LanguageReturnTarget;
  beforeReload?: () => Promise<void>;
}>) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const colors = useThemeColors();
  // A sheet shorter than its header plus one row (a short window, and the
  // keyboard takes more of it) cannot show a pinned search field and a result
  // row at the same time. The search field then leads the scrolling list
  // instead of pinning under the title row.
  const searchInList = searchPickerHeaderInList({ windowHeight: useWindowDimensions().height });
  const [selected, setSelected] = useState<LanguagePreference>('device');
  const [applied, setApplied] = useState<LanguagePreference>('device');
  const [appliedLanguage, setAppliedLanguage] = useState<SupportedLanguage>('en');
  const [busy, setBusy] = useState(false);
  const [restarting, setRestarting] = useState(false);
  // Which step of the restart failed. `reload-failed` got as far as forcing the
  // direction and only the reload threw; `restart-skipped` never forced it
  // because the attempt record could not be written. The Retry control has to
  // resume from the step that failed, not blindly reload.
  const [restartFailure, setRestartFailure] = useState<RestartFailure | null>(null);
  const [query, setQuery] = useState('');
  // The search field is uncontrolled (iOS drops keystrokes when state drives
  // `value`), so an emptied field is cleared through this ref rather than by
  // remounting the input.
  const searchInputRef = useRef<TextInput>(null);
  // The typed term, kept out of the controlled path but readable when the field
  // is mounted again. A window resize that crosses the short-window threshold
  // moves the field between the pinned header and the list header, which mounts
  // a new native input: without this the field would come back empty while the
  // list stayed filtered by the query it no longer shows.
  const searchTextRef = useRef('');
  const listRef = useRef<FlashListRef<LanguagePickerItem>>(null);
  const [closing, setClosing] = useState(false);
  const closeRequestedRef = useRef(false);
  const disablePrevention = usePreventRemove(
    (busy || restarting || restartFailure !== null) && !closing
  );
  const closePicker = useCallback(() => {
    if (closeRequestedRef.current) {
      return;
    }
    closeRequestedRef.current = true;
    setClosing(true);
    disablePrevention();
    onClose();
  }, [disablePrevention, onClose]);

  useFocusEffect(
    useCallback(() => {
      closeRequestedRef.current = false;
      setClosing(false);
      setQuery('');
      // Empty the field imperatively instead of remounting it. A remount hands
      // the recreated native EditText the text it still holds, and the next
      // keystroke then appends to that stale copy: the sheet's search field
      // read the typed term twice, as one run ("DeutschDeutsch", "ArabicArabic"),
      // which then matched nothing (language-search-deutsch,
      // language-search-kb-up, 2026-09-20). Clearing the live field keeps the
      // same behaviour — a reopened sheet starts empty — without recreating the
      // view.
      searchInputRef.current?.clear();
      searchTextRef.current = '';
      setSelected(getLanguagePreference());
      setApplied(getLanguagePreference());
      setAppliedLanguage(getResolvedLanguage());
      setBusy(false);
      setRestarting(false);
      setRestartFailure(null);
    }, [])
  );

  const deviceEndonym = LANGUAGE_ENDONYMS[resolveDeviceLanguage()];
  // The native layout direction, not the catalog's: the row insets and the
  // search alignment follow how the interface is laid out.
  const isRtl = I18nManager.isRTL;
  // The copy/fold/collate of the whole language table and the fresh row objects
  // are only valid while the query and the applied language stand. Keyed the
  // same way so a `selected` or `busy` change keeps the list identity and
  // leaves the rows' props comparable.
  const items = useMemo(
    () => languagePickerItems(query, appliedLanguage, applied === 'device'),
    [query, appliedLanguage, applied]
  );
  const listIsEmpty = items.length === 0 && !searchInList;
  // A query change draws a shorter list under the kept offset, so reset the
  // scroll to the top; the header field cannot move into a body swap without
  // losing the draft, so `repository-rows-list`'s reset is the answer here.
  useEffect(() => {
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [query]);

  // The list's memoized cells compare `renderItem` and `extraData` by identity
  // before re-rendering a row (see the security-agent finding list). `selected`
  // and the in-flight `busy` state therefore have to travel through `extraData`:
  // without it a tapped row keeps the `checked` state and the check mark of the
  // selection the sheet opened with, and the picker reads as inert.
  const rowExtraData = useMemo(() => ({ selected, disabled: busy }), [selected, busy]);
  // A row tap marks the choice and closes the search keyboard with it, so the
  // check mark and the sheet's Done control sit where the keyboard was instead
  // of under it.
  const handleSelectRow = useCallback((preference: LanguagePreference) => {
    dismissSearchPickerKeyboard();
    setSelected(preference);
  }, []);
  // Hoisted so the cell keeps one renderer identity while only the selection or
  // the busy state change, and memoized `LanguagePickerRow`s re-render only
  // when their own flag moved.
  const renderItem = useCallback(
    ({ item, index }: { item: LanguagePickerItem; index: number }) => (
      <LanguagePickerRow
        item={item}
        first={index === 0}
        showDivider={items[index + 1]?.kind !== 'section'}
        selected={
          item.kind === 'device'
            ? selected === 'device'
            : item.kind === 'language' && selected === item.row.tag
        }
        disabled={busy}
        deviceEndonym={deviceEndonym}
        isRtl={isRtl}
        onSelect={handleSelectRow}
      />
    ),
    [items, selected, busy, deviceEndonym, isRtl, handleSelectRow]
  );

  const handleDone = async () => {
    if (busy) {
      return;
    }
    const resolved = selected === 'device' ? resolveDeviceLanguage() : selected;
    if (I18nManager.isRTL !== isRtlLanguage(resolved)) {
      setRestarting(true);
    }
    setBusy(true);
    const outcome = await applyLanguagePreference(selected, resolved, returnTarget, beforeReload);
    // `ApplyLanguageOutcome` is a closed union and every kind is handled
    // above, so no `default` branch is reachable.
    // eslint-disable-next-line default-case
    switch (outcome.kind) {
      case 'applied-ltr': {
        setBusy(false);
        onApplied?.();
        closePicker();
        break;
      }
      case 'restarting-rtl': {
        // reloadAppAsync succeeded; the native reload wipes this state.
        break;
      }
      case 'reload-failed':
      case 'restart-skipped': {
        // Both leave the language saved without a relaunch; offer the sheet's
        // retry so the user can ask for the restart again. The outcome names
        // the step that failed, so Retry resumes from there.
        setBusy(false);
        setRestarting(false);
        setRestartFailure(outcome.kind);
        break;
      }
      case 'persist-failed': {
        // setAsync already toasts the failure; keep the current language.
        setBusy(false);
        setRestarting(false);
        break;
      }
      case 'catalog-failed': {
        toast.error(t('language.catalogLoadFailed'));
        setBusy(false);
        break;
      }
    }
  };

  // The preference was persisted before the reload attempt, so a failed reload
  // is not a failed change: Continue leaves the sheet with the saved language.
  // Clearing the failed state first keeps the normal sheet from re-arming the
  // guard, and `closePicker` releases the guard the failed state still holds.
  const handleContinue = () => {
    setRestartFailure(null);
    closePicker();
  };

  // A failed reload already forced the direction, so Retry only reloads again.
  // A skipped restart never forced it: the attempt record could not be
  // written, which is exactly the state the automatic relaunch refuses to run
  // from. Reloading there would come back in the previous direction with no
  // record, so Retry re-runs the apply path instead and the record write is
  // retried before anything reloads.
  const retryRestart = async () => {
    if (busy) {
      return;
    }
    if (restartFailure === 'restart-skipped') {
      setRestartFailure(null);
      await handleDone();
      return;
    }
    setBusy(true);
    try {
      await reloadAppAsync();
    } catch {
      setBusy(false);
    }
  };

  if (restartFailure !== null) {
    return (
      <PickerSheet
        title={t('language.couldNotRestart')}
        onDone={() => {
          void retryRestart();
        }}
        doneLabel={t('common.retry')}
        onCancel={handleContinue}
        cancelLabel={t('common.continue')}
        disabled={busy}
        scrollable={false}
      >
        <CenteredState>
          <View className="items-center px-6">
            <Text variant="muted" className="text-center">
              {t('language.languageSaved')}
            </Text>
          </View>
        </CenteredState>
      </PickerSheet>
    );
  }
  if (restarting) {
    return (
      <PickerSheet
        title={t('common.language')}
        onDone={() => {
          // Restarting: the native reload replaces this sheet.
        }}
        onCancel={() => {
          // Restarting: the native reload replaces this sheet.
        }}
        doneLabel={t('common.done')}
        disabled
        scrollable={false}
      >
        <CenteredState>
          <View className="items-center gap-3 px-6">
            <ActivityIndicator color={colors.mutedForeground} />
            <Text variant="muted" className="text-center">
              {t('language.restarting')}
            </Text>
          </View>
        </CenteredState>
      </PickerSheet>
    );
  }
  // The field lives in `@/components/language-search-field`: the pill chrome
  // and the shared single-line `Input`, extracted to keep this sheet within
  // its max-lines budget.
  const searchField = (
    <LanguageSearchField
      searchInList={searchInList}
      editable={!busy}
      inputRef={searchInputRef}
      draftRef={searchTextRef}
      onChangeText={text => {
        searchTextRef.current = text;
        setQuery(text);
      }}
    />
  );
  return (
    <PickerSheet
      title={t('common.language')}
      onDone={() => {
        void handleDone();
      }}
      onCancel={closePicker}
      doneLabel={t('common.done')}
      disabled={busy}
      scrollable={false}
      headerInBody={searchInList}
      headerContent={searchField}
    >
      {/*
        One list for both states. The search field is uncontrolled (see its
        `ref` above), so a branch that re-parents it between the list header and
        an empty-state wrapper remounts the native input: a query that matched
        nothing would close the keyboard and drop the typed text. The empty
        state is the list's own empty component, which leaves the field in
        place; `placement="static"` keeps it out of a scroller of its own, so the
        list's content box owns where it sits (see
        `emptyListContentContainerStyle`).
      */}
      <FlashList<LanguagePickerItem>
        nestedScrollEnabled
        ref={listRef}
        style={listFlexStyle}
        contentContainerStyle={listIsEmpty ? emptyListContentContainerStyle : listPadStyle}
        data={items}
        extraData={rowExtraData}
        // The `undefined` guards cover FlashList indexing `data` past its end
        // for a discarded render (see the model picker's comment).
        keyExtractor={(item: LanguagePickerItem | undefined, index) => item?.key ?? String(index)}
        maintainVisibleContentPosition={{ disabled: true }}
        {...SEARCHABLE_PICKER_LIST_PROPS}
        ListHeaderComponent={searchInList ? searchField : undefined}
        ListEmptyComponent={
          <EmptyState
            placement="static"
            icon={SearchX}
            title={t('language.noMatches')}
            description={t('agents.sessionList.tryDifferentSearch')}
          />
        }
        ListFooterComponent={<View style={{ height: insets.bottom }} pointerEvents="none" />}
        renderItem={renderItem}
      />
    </PickerSheet>
  );
}
