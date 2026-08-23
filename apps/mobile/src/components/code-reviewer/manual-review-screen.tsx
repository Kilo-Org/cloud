import * as Haptics from 'expo-haptics';
import { type Href, useRouter } from 'expo-router';
import { Check, GitPullRequest } from '@/components/ui/icons';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, TextInput, View } from 'react-native';

import { matchesCodeReviewUrlSuffix } from '@kilocode/app-shared/code-review';
import { ModelSelector } from '@/components/agents/model-selector';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { formFieldA11y } from '@/components/ui/form-field-a11y';
import { RadioGroup, radioItemA11y } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { TabScreenScrollView } from '@/components/tab-screen';
import { PLATFORM_CAPABILITIES } from '@/lib/code-reviewer-config';
import { classifyProviderErrorCode } from '@/lib/code-reviewer-status';
import { useAvailableModels } from '@/lib/hooks/use-available-models';
import {
  PERSONAL_SCOPE,
  useGitHubStatus,
  useGitLabStatus,
  useReviewConfig,
} from '@/lib/hooks/use-code-reviewer';
import { useCreateManualReview } from '@/lib/hooks/use-code-reviews';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

const MANUAL_REVIEW_PLATFORMS = ['github', 'gitlab'] as const;
type ManualReviewPlatform = (typeof MANUAL_REVIEW_PLATFORMS)[number];

const URL_PLACEHOLDER = {
  github: 'https://github.com/owner/repo/pull/123',
  gitlab: 'https://gitlab.com/group/project/-/merge_requests/123',
} satisfies Record<ManualReviewPlatform, string>;

// The shared suffix check (matchesCodeReviewUrlSuffix, ported from web's
// code-review-links.ts) only looks at the end of the URL — it isn't
// anchored to a host or protocol, so on its own it would accept e.g.
// "ftp://evil.example/owner/repo/pull/123". Mobile keeps this host/protocol
// anchor locally and combines it with the shared suffix check, rather than
// adopting the shared regex unanchored (see isValidManualReviewUrl below).
// GitHub PR URLs always carry an owner/repo prefix, so the anchor requires
// it — otherwise structure-free URLs like https://github.com/pull/123 would
// pass. GitLab nests groups arbitrarily deep, so only the protocol is
// anchored there; the shared suffix requires the /-/merge_requests/<n> tail.
const URL_HOST_PATTERN = {
  github: /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\//,
  gitlab: /^https:\/\//,
} satisfies Record<ManualReviewPlatform, RegExp>;

function isValidManualReviewUrl(platform: ManualReviewPlatform, url: string): boolean {
  return URL_HOST_PATTERN[platform].test(url) && matchesCodeReviewUrlSuffix(platform, url);
}

export function ManualReviewScreen({ scope }: Readonly<{ scope: string }>) {
  const router = useRouter();
  const { t } = useTranslation();
  const colors = useThemeColors();
  const githubStatus = useGitHubStatus(scope);
  const gitlabStatus = useGitLabStatus(scope);
  const statusFor = { github: githubStatus, gitlab: gitlabStatus };
  const isConnected = (option: ManualReviewPlatform) => statusFor[option].data?.connected === true;
  const statusesLoading = githubStatus.isLoading || gitlabStatus.isLoading;
  const statusesError = githubStatus.isError || gitlabStatus.isError;
  const firstConnected = MANUAL_REVIEW_PLATFORMS.find(option => isConnected(option));
  const [platformChoice, setPlatformChoice] = useState<ManualReviewPlatform | null>(null);
  const platform = platformChoice ?? firstConnected ?? 'github';
  const urlRef = useRef('');
  const instructionsRef = useRef('');
  const [urlError, setUrlError] = useState<string | null>(null);
  const config = useReviewConfig(scope, platform);
  const createReview = useCreateManualReview(scope);
  const { models } = useAvailableModels(scope === PERSONAL_SCOPE ? undefined : scope);
  const [modelChoice, setModelChoice] = useState<{
    modelSlug: string;
    thinkingEffort: string | null;
  } | null>(null);
  const effectiveModel = modelChoice ?? {
    modelSlug: config.data?.modelSlug ?? '',
    thinkingEffort: config.data?.thinkingEffort ?? null,
  };

  const onSubmit = () => {
    const url = urlRef.current.trim();
    if (!isValidManualReviewUrl(platform, url)) {
      setUrlError(t('codeReviewer.manualReview.invalidUrl'));
      return;
    }
    setUrlError(null);
    if (!config.data) {
      return;
    }
    createReview.mutate(
      {
        platform,
        url,
        modelSlug: effectiveModel.modelSlug,
        thinkingEffort: effectiveModel.thinkingEffort,
        instructions: instructionsRef.current.trim() || undefined,
      },
      {
        onSuccess: ({ reviewId }) => {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          router.replace(
            `/(app)/(tabs)/(3_profile)/code-reviewer/${scope}/reviews/${reviewId}` as Href
          );
        },
      }
    );
  };

  if (!statusesLoading && statusesError && !isConnected('github') && !isConnected('gitlab')) {
    // A permission/not-found error can't be fixed by retrying — show the
    // permanent variant with no retry instead of a misleading "try again".
    const statusErrorCode =
      (githubStatus.error as { data?: { code?: string } } | null)?.data?.code ??
      (gitlabStatus.error as { data?: { code?: string } } | null)?.data?.code;
    const { permanent, variant } = classifyProviderErrorCode(statusErrorCode);
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader
          title={t('codeReviewer.manualReview.title')}
          eyebrow={t('codeReviewer.title')}
        />
        <QueryError
          variant={variant}
          title={permanent ? undefined : t('codeReviewer.manualReview.couldNotCheckProviderStatus')}
          message={permanent ? undefined : t('codeReviewer.manualReview.couldNotLoadProviders')}
          onRetry={
            permanent
              ? undefined
              : () => {
                  void githubStatus.refetch();
                  void gitlabStatus.refetch();
                }
          }
          isRetrying={githubStatus.isRefetching || gitlabStatus.isRefetching}
        />
      </View>
    );
  }

  if (!statusesLoading && !statusesError && !isConnected('github') && !isConnected('gitlab')) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader
          title={t('codeReviewer.manualReview.title')}
          eyebrow={t('codeReviewer.title')}
        />
        <EmptyState
          icon={GitPullRequest}
          title={t('codeReviewer.manualReview.connectProvider')}
          description={t('codeReviewer.manualReview.connectProviderDescription')}
          action={
            <Button
              onPress={() => {
                router.push(`/(app)/(tabs)/(3_profile)/code-reviewer/${scope}/github` as Href);
              }}
            >
              <Text>{t('codeReviewer.manualReview.connectGitHub')}</Text>
            </Button>
          }
        />
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={t('codeReviewer.manualReview.title')}
        eyebrow={t('codeReviewer.title')}
      />
      <TabScreenScrollView
        className="flex-1 px-6"
        contentContainerClassName="gap-6 pt-4"
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        <View className="gap-3">
          <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
            {t('codeReviewer.manualReview.platform')}
          </Text>
          {statusesLoading ? (
            <View className="gap-2">
              <Skeleton className="h-14 w-full rounded-lg" />
              <Skeleton className="h-14 w-full rounded-lg" />
            </View>
          ) : (
            <RadioGroup
              label={t('codeReviewer.manualReview.platform')}
              className="overflow-hidden rounded-lg bg-secondary"
            >
              {MANUAL_REVIEW_PLATFORMS.map((option, index) => {
                const connected = isConnected(option);
                return (
                  <Pressable
                    key={option}
                    disabled={!connected}
                    className={cn(
                      'flex-row items-center justify-between px-4 py-3 active:opacity-70',
                      index < MANUAL_REVIEW_PLATFORMS.length - 1 &&
                        'border-b-[0.5px] border-hair-soft',
                      !connected && 'opacity-50'
                    )}
                    onPress={() => {
                      void Haptics.selectionAsync();
                      urlRef.current = '';
                      setUrlError(null);
                      setPlatformChoice(option);
                    }}
                    {...radioItemA11y({
                      label: PLATFORM_CAPABILITIES[option].label,
                      checked: connected && platform === option,
                      disabled: !connected,
                    })}
                  >
                    <View>
                      <Text className="text-sm font-medium">
                        {PLATFORM_CAPABILITIES[option].label}
                      </Text>
                      {!connected && (
                        <Text variant="muted" className="text-xs">
                          {t('codeReviewer.manualReview.notConnected')}
                        </Text>
                      )}
                    </View>
                    <Check
                      size={18}
                      color={connected && platform === option ? colors.foreground : 'transparent'}
                    />
                  </Pressable>
                );
              })}
            </RadioGroup>
          )}
        </View>

        <View className="gap-3">
          <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
            {t('codeReviewer.manualReview.pullRequestUrl')}
          </Text>
          <TextInput
            key={platform}
            className="h-12 rounded-md border border-input bg-background px-3 text-sm leading-[normal] text-foreground"
            placeholder={URL_PLACEHOLDER[platform]}
            placeholderTextColor={colors.mutedForeground}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            accessibilityLabel={formFieldA11y({
              label: t('codeReviewer.manualReview.pullRequestUrl'),
              error: urlError,
            })}
            onChangeText={value => {
              urlRef.current = value;
              if (urlError) {
                setUrlError(null);
              }
            }}
          />
          {urlError ? <Text className="text-xs text-destructive">{urlError}</Text> : null}
        </View>

        <View className="gap-3">
          <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
            {t('codeReviewer.manualReview.instructions')}
          </Text>
          <TextInput
            className="h-24 rounded-lg bg-secondary p-3 text-sm leading-5 text-foreground"
            multiline
            textAlignVertical="top"
            placeholder={t('codeReviewer.manualReview.instructionsPlaceholder')}
            placeholderTextColor={colors.mutedForeground}
            onChangeText={value => {
              instructionsRef.current = value;
            }}
          />
        </View>

        <View className="gap-3">
          <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
            {t('codeReviewer.manualReview.model')}
          </Text>
          {/* flex-row so the pill hugs its content instead of stretching to column width */}
          <View className="flex-row">
            <ModelSelector
              options={models}
              value={effectiveModel.modelSlug}
              variant={effectiveModel.thinkingEffort ?? ''}
              onSelect={(modelId, variant) => {
                setModelChoice({ modelSlug: modelId, thinkingEffort: variant || null });
              }}
            />
          </View>
        </View>

        <Button
          loading={createReview.isPending}
          disabled={!config.data || !isConnected(platform)}
          onPress={onSubmit}
        >
          <Text>
            {createReview.isPending
              ? t('codeReviewer.manualReview.starting')
              : t('codeReviewer.manualReview.start')}
          </Text>
        </Button>
      </TabScreenScrollView>
    </View>
  );
}
