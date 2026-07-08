import * as Haptics from 'expo-haptics';
import { type Href, useRouter } from 'expo-router';
import { Check } from 'lucide-react-native';
import { useRef, useState } from 'react';
import { Pressable, ScrollView, TextInput, View } from 'react-native';
import { toast } from 'sonner-native';

import { ModelSelector } from '@/components/agents/model-selector';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { PLATFORM_CAPABILITIES } from '@/lib/code-reviewer-config';
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

const URL_PLACEHOLDER: Record<ManualReviewPlatform, string> = {
  github: 'https://github.com/owner/repo/pull/123',
  gitlab: 'https://gitlab.com/group/project/-/merge_requests/123',
};

const URL_PATTERN: Record<ManualReviewPlatform, RegExp> = {
  github: /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/,
  gitlab: /^https:\/\/.+\/-\/merge_requests\/\d+/,
};

export function ManualReviewScreen({ scope }: Readonly<{ scope: string }>) {
  const router = useRouter();
  const colors = useThemeColors();
  const githubStatus = useGitHubStatus(scope);
  const gitlabStatus = useGitLabStatus(scope);
  const statusFor = { github: githubStatus, gitlab: gitlabStatus };
  const isConnected = (option: ManualReviewPlatform) => statusFor[option].data?.connected === true;
  const firstConnected = MANUAL_REVIEW_PLATFORMS.find(option => isConnected(option));
  const [platformChoice, setPlatformChoice] = useState<ManualReviewPlatform | null>(null);
  const platform = platformChoice ?? firstConnected ?? 'github';
  const urlRef = useRef('');
  const instructionsRef = useRef('');
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
    if (!URL_PATTERN[platform].test(url)) {
      toast.error('Enter a valid pull request URL');
      return;
    }
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

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Manual Review" eyebrow="Code Reviewer" />
      <ScrollView
        className="flex-1 px-6"
        contentContainerClassName="gap-6 pt-4 pb-8"
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
      >
        <View className="gap-3">
          <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
            Platform
          </Text>
          <View className="overflow-hidden rounded-lg bg-secondary">
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
                    setPlatformChoice(option);
                  }}
                >
                  <View>
                    <Text className="text-sm font-medium">
                      {PLATFORM_CAPABILITIES[option].label}
                    </Text>
                    {!connected && (
                      <Text variant="muted" className="text-xs">
                        Not connected
                      </Text>
                    )}
                  </View>
                  <Check
                    size={18}
                    color={platform === option ? colors.foreground : 'transparent'}
                  />
                </Pressable>
              );
            })}
          </View>
        </View>

        <View className="gap-3">
          <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
            Pull request URL
          </Text>
          <TextInput
            key={platform}
            className="h-12 rounded-md border border-input bg-background px-3 text-sm leading-5 text-foreground"
            placeholder={URL_PLACEHOLDER[platform]}
            placeholderTextColor={colors.mutedForeground}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            onChangeText={value => {
              urlRef.current = value;
            }}
          />
        </View>

        <View className="gap-3">
          <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
            Instructions (optional)
          </Text>
          <TextInput
            className="h-24 rounded-lg bg-secondary p-3 text-sm leading-5 text-foreground"
            multiline
            textAlignVertical="top"
            placeholder="Anything specific the reviewer should focus on…"
            placeholderTextColor={colors.mutedForeground}
            onChangeText={value => {
              instructionsRef.current = value;
            }}
          />
        </View>

        <View className="gap-3">
          <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
            Model
          </Text>
          <ModelSelector
            options={models}
            value={effectiveModel.modelSlug}
            variant={effectiveModel.thinkingEffort ?? ''}
            onSelect={(modelId, variant) => {
              setModelChoice({ modelSlug: modelId, thinkingEffort: variant || null });
            }}
          />
        </View>

        <Button
          disabled={createReview.isPending || !config.data || !isConnected(platform)}
          onPress={onSubmit}
        >
          <Text>Start review</Text>
        </Button>
      </ScrollView>
    </View>
  );
}
