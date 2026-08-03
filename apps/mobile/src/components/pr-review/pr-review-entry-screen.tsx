import * as Clipboard from 'expo-clipboard';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  ChevronRight,
  Clipboard as ClipboardIcon,
  Clock,
  Link2,
  SearchX,
  X,
} from 'lucide-react-native';
import { type ReactNode, useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, TextInput, View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { parseGitHubPrUrl } from '@/lib/github-pr-url';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { getPrReviewPath } from '@/lib/profile-agent-navigation';
import { consumePrLinkInputEcho, pushPrLinkInputEcho } from '@/lib/pr-review/pr-link-input-echo';
import {
  decidePrLinkPaste,
  PR_LINK_TOAST_CLIPBOARD_EMPTY_COPY,
  PR_LINK_TOAST_INVALID_COPY,
  selectPrLinkClearButtonVisible,
} from '@/lib/pr-review/pr-link-paste';
import { getRecentPrs, type RecentPr, upsertRecentPr } from '@/lib/pr-review/recent-prs';

const URL_PLACEHOLDER = 'https://github.com/owner/repo/pull/123';

export function PrReviewEntryScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  // Uncontrolled iOS input — keep the raw text in a ref so the submit
  // handler reads the latest value without re-rendering on every
  // keystroke. State is only for derived UI (whether there's any text).
  // The TextInput component ref is for focus() and setNativeProps on
  // programmatic paste.
  const inputRef = useRef<TextInput>(null);
  const inputValueRef = useRef<string>('');
  // FIFO of values written via setNativeProps. Matching onChangeText values
  // are treated as programmatic echoes (do not clobber ref).
  // Order-agnostic membership so double-taps and delayed native echoes work.
  const pendingProgrammaticTextsRef = useRef<string[]>([]);
  const [hasInput, setHasInput] = useState(false);
  const [recent, setRecent] = useState<RecentPr[] | null>(null);

  useFocusEffect(
    useCallback(() => {
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
    }, [])
  );

  const applyFieldText = (text: string) => {
    pendingProgrammaticTextsRef.current = pushPrLinkInputEcho(
      pendingProgrammaticTextsRef.current,
      text
    );
    inputValueRef.current = text;
    inputRef.current?.setNativeProps({ text });
    setHasInput(text.length > 0);
  };

  const handleSubmit = async () => {
    const raw = inputValueRef.current;
    const parsed = parseGitHubPrUrl(raw.trim());
    if (!parsed) {
      announcingToast.error(PR_LINK_TOAST_INVALID_COPY);
      return;
    }
    // Title is backfilled on first successful load (S5).
    await upsertRecentPr({
      owner: parsed.owner,
      repo: parsed.repo,
      number: parsed.number,
      title: '',
      lastOpenedAt: Date.now(),
    });
    router.push(getPrReviewPath(parsed.owner, parsed.repo, parsed.number));
  };

  const handlePaste = async () => {
    const clipboard = await Clipboard.getStringAsync();
    const decision = decidePrLinkPaste(clipboard);
    if (decision.kind === 'empty') {
      announcingToast.error(PR_LINK_TOAST_CLIPBOARD_EMPTY_COPY);
      return;
    }
    // Replace entire field (never append-at-cursor): native field + ref + hasInput.
    applyFieldText(decision.text);
    if (decision.kind === 'non-url-text') {
      announcingToast.error(PR_LINK_TOAST_INVALID_COPY);
      return;
    }
    await handleSubmit();
  };

  const focusInput = () => {
    inputRef.current?.focus();
  };

  const handleRecentPress = async (entry: RecentPr) => {
    await upsertRecentPr({
      ...entry,
      lastOpenedAt: Date.now(),
    });
    router.push(getPrReviewPath(entry.owner, entry.repo, entry.number));
  };

  const showClearButton = selectPrLinkClearButtonVisible({ hasInput });

  let recentsBody: ReactNode = null;
  if (recent === null) {
    recentsBody = <ActivityIndicator size="small" color={colors.mutedForeground} />;
  } else if (recent.length === 0) {
    recentsBody = (
      <EmptyState
        icon={SearchX}
        title="No recent PRs"
        description="Paste a PR link above to start a review — it'll show up here next time."
        placement="top"
        action={
          <Button variant="outline" onPress={focusInput}>
            <Text>Paste a PR link</Text>
          </Button>
        }
      />
    );
  } else {
    recentsBody = (
      <View className="rounded-lg bg-secondary">
        {recent.map((entry, index) => {
          const isLast = index === recent.length - 1;
          return (
            <Pressable
              key={`${entry.owner}/${entry.repo}#${entry.number}`}
              onPress={() => {
                void handleRecentPress(entry);
              }}
              className={`flex-row items-center gap-3 px-3 py-3 active:opacity-70 ${
                isLast ? '' : 'border-b-[0.5px] border-hair-soft'
              }`}
            >
              <View className="flex-1">
                <Text className="text-sm font-medium" numberOfLines={1}>
                  {entry.title || `${entry.owner}/${entry.repo}#${entry.number}`}
                </Text>
                <Text variant="muted" className="text-xs">
                  {entry.owner}/{entry.repo}#{entry.number}
                </Text>
              </View>
              <ChevronRight size={16} color={colors.mutedForeground} />
            </Pressable>
          );
        })}
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="PR Review" eyebrow="Open a pull request by URL" />
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-6 px-6 pb-12 pt-4"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        <View className="gap-2">
          <View className="flex-row items-center gap-2">
            <Link2 size={16} color={colors.mutedForeground} />
            <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
              Paste a PR link
            </Text>
          </View>
          <View className="gap-3">
            <View className="flex-row items-center gap-2">
              <View
                className="min-h-14 min-w-0 flex-1 flex-row items-center rounded-md border border-border bg-card"
                testID="pr-link-input-row"
                collapsable={false}
              >
                <TextInput
                  ref={inputRef}
                  defaultValue=""
                  placeholder={URL_PLACEHOLDER}
                  placeholderTextColor={colors.mutedForeground}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  onChangeText={value => {
                    // Don't setState on every keystroke; track only whether the
                    // input has any text. The raw value lives in the ref so
                    // handleSubmit reads the latest text without re-rendering.
                    const decision = consumePrLinkInputEcho(
                      pendingProgrammaticTextsRef.current,
                      value
                    );
                    pendingProgrammaticTextsRef.current = [...decision.pending];
                    if (decision.kind === 'echo') {
                      // Echo of setNativeProps: inputValueRef already holds the
                      // intentional value from applyFieldText — do not clobber it
                      // with a delayed/stale echo.
                      return;
                    }
                    inputValueRef.current = value;
                    setHasInput(value.length > 0);
                  }}
                  // leading-[normal] so no lineHeight reaches the style: an explicit lineHeight
                  // makes iOS draw the placeholder lower than the typed text (see AGENTS.md).
                  className="min-w-0 flex-1 bg-transparent py-3 pl-3 pr-1 text-base text-foreground leading-[normal]"
                  accessibilityLabel="GitHub pull request URL"
                  returnKeyType="go"
                  onSubmitEditing={() => {
                    void handleSubmit();
                  }}
                />
                {showClearButton ? (
                  // h-13 w-13 measures 45×45pt on device; h-12 is 42pt and h-11 is
                  // 38pt in this app — do not "simplify" back to h-11/w-11.
                  <Pressable
                    onPress={() => {
                      // clear() is the iOS-safe native empty after real typing.
                      // setNativeProps({ text: '' }) loses the most-recent-event-count
                      // race and leaves the typed text visible while React state
                      // thinks the field is empty. Do not route through
                      // applyFieldText('') (paste-only path) and do not push an
                      // echo for '' — a non-arriving echo would stale the FIFO.
                      inputValueRef.current = '';
                      setHasInput(false);
                      inputRef.current?.clear();
                      inputRef.current?.focus();
                    }}
                    accessibilityRole="button"
                    accessibilityLabel="Clear pull request link"
                    className="h-13 w-13 items-center justify-center active:opacity-70"
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
                accessibilityLabel="Paste pull request link"
                hitSlop={4}
                className="h-11 w-11 items-center justify-center rounded-md border border-border bg-card active:opacity-70"
              >
                <ClipboardIcon size={18} color={colors.mutedForeground} />
              </Pressable>
            </View>
            <Button
              disabled={!hasInput}
              onPress={() => {
                void handleSubmit();
              }}
              accessibilityLabel="Open pull request"
            >
              <Text>Open</Text>
            </Button>
          </View>
        </View>

        <View className="gap-2">
          <View className="flex-row items-center gap-2">
            <Clock size={16} color={colors.mutedForeground} />
            <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
              Recent
            </Text>
          </View>
          {recentsBody}
        </View>
      </ScrollView>
    </View>
  );
}
