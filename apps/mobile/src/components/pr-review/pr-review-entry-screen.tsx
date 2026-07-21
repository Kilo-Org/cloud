import { useFocusEffect, useRouter } from 'expo-router';
import { ChevronRight, Clock, Link2, SearchX } from 'lucide-react-native';
import { type ReactNode, useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, TextInput, View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { parseGitHubPrUrl } from '@/lib/github-pr-url';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { getPrReviewPath } from '@/lib/profile-agent-navigation';
import { getRecentPrs, type RecentPr, upsertRecentPr } from '@/lib/pr-review/recent-prs';

const URL_PLACEHOLDER = 'https://github.com/owner/repo/pull/123';

export function PrReviewEntryScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  // Uncontrolled iOS input — keep the raw text in a ref so the submit
  // handler reads the latest value without re-rendering on every
  // keystroke. State is only for derived UI (whether there's any text,
  // whether the user already tried an invalid value). The TextInput
  // component ref is for focus() (e.g. the empty-state CTA).
  const inputRef = useRef<TextInput>(null);
  const inputValueRef = useRef<string>('');
  const [hasInput, setHasInput] = useState(false);
  const [invalid, setInvalid] = useState(false);
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

  const handleSubmit = async () => {
    const raw = inputValueRef.current;
    const parsed = parseGitHubPrUrl(raw.trim());
    if (!parsed) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
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

  let helper: ReactNode = null;
  if (invalid) {
    helper = <Text className="text-sm text-destructive">Not a GitHub pull request link</Text>;
  } else if (!hasInput) {
    helper = (
      <Text variant="muted" className="text-sm">
        Paste a link like {URL_PLACEHOLDER}
      </Text>
    );
  }

  let recentsBody: ReactNode = null;
  if (recent === null) {
    recentsBody = <ActivityIndicator size="small" color={colors.mutedForeground} />;
  } else if (recent.length === 0) {
    recentsBody = (
      <EmptyState
        icon={SearchX}
        title="No recent PRs"
        description="Paste a PR link above to start a review — it'll show up here next time."
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
              // input has any text and whether the user has tried to
              // submit an invalid value. The raw value lives in the ref
              // so handleSubmit reads the latest text without re-rendering.
              inputValueRef.current = value;
              setHasInput(value.length > 0);
              if (invalid) {
                setInvalid(false);
              }
            }}
            // explicit line-height so the placeholder + typed text render
            // at the same vertical position on every iOS version.
            className="rounded-md border border-border bg-card px-3 py-3 text-base text-foreground leading-[22px]"
            accessibilityLabel="GitHub pull request URL"
            returnKeyType="go"
            onSubmitEditing={() => {
              void handleSubmit();
            }}
          />
          {helper}
          <Button
            className="mt-1"
            disabled={!hasInput || invalid}
            onPress={() => {
              void handleSubmit();
            }}
            accessibilityLabel="Open pull request"
          >
            <Text>Open</Text>
          </Button>
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
