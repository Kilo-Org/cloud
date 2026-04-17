import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  type LayoutChangeEvent,
  ScrollView,
  TextInput,
  type TextStyle,
  View,
} from 'react-native';
import { type Href, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { generateMessageId } from 'cloud-agent-sdk/message-id';
import * as Haptics from 'expo-haptics';
import { toast } from 'sonner-native';

import { ChatToolbar } from '@/components/agents/chat-toolbar';
import { type AgentMode } from '@/components/agents/mode-selector';
import { RepoSelector } from '@/components/agents/repo-selector';
import { useTextHeight } from '@/components/agents/use-text-height';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { ScreenHeader } from '@/components/screen-header';
import { useAvailableModels } from '@/lib/hooks/use-available-models';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { trpcClient, useTRPC } from '@/lib/trpc';

const PROMPT_INPUT_DEFAULT_LINES = 3;
const PROMPT_INPUT_MAX_LINES = 6;
const PROMPT_INPUT_LINE_HEIGHT = 24;
const PROMPT_INPUT_VERTICAL_PADDING = 32;
const PROMPT_INPUT_HORIZONTAL_PADDING = 32;
const PROMPT_INPUT_MIN_HEIGHT =
  PROMPT_INPUT_LINE_HEIGHT * PROMPT_INPUT_DEFAULT_LINES + PROMPT_INPUT_VERTICAL_PADDING;
const PROMPT_INPUT_MAX_HEIGHT =
  PROMPT_INPUT_LINE_HEIGHT * PROMPT_INPUT_MAX_LINES + PROMPT_INPUT_VERTICAL_PADDING;

const promptInputStyle = {
  includeFontPadding: false,
  lineHeight: PROMPT_INPUT_LINE_HEIGHT,
  textAlignVertical: 'top',
} satisfies TextStyle;

export default function NewSessionScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const colors = useThemeColors();
  const { organizationId } = useLocalSearchParams<{ organizationId?: string }>();

  // ── Selectors state ──────────────────────────────────────────────
  const [mode, setMode] = useState<AgentMode>('code');
  const [model, setModel] = useState('');
  const [variant, setVariant] = useState('');
  const [selectedRepo, setSelectedRepo] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  // Prompt ref (uncontrolled TextInput on iOS)
  const promptRef = useRef('');
  const [hasPrompt, setHasPrompt] = useState(false);
  const [promptInputWidth, setPromptInputWidth] = useState(0);
  const promptMeasure = useTextHeight({
    minHeight: PROMPT_INPUT_MIN_HEIGHT,
    maxHeight: PROMPT_INPUT_MAX_HEIGHT,
    verticalPadding: PROMPT_INPUT_VERTICAL_PADDING,
    textContentWidth: promptInputWidth - PROMPT_INPUT_HORIZONTAL_PADDING,
    fontSize: 16,
    lineHeight: PROMPT_INPUT_LINE_HEIGHT,
  });

  // ── Models ───────────────────────────────────────────────────────
  const { models } = useAvailableModels(organizationId);

  // Auto-select first model when models load
  const hasAutoSelectedModel = useRef(false);
  if (models.length > 0 && !model && !hasAutoSelectedModel.current) {
    const firstModel = models[0];
    if (firstModel) {
      hasAutoSelectedModel.current = true;
      setModel(firstModel.id);
      setVariant(firstModel.variants[0] ?? '');
    }
  }

  // ── Repositories ─────────────────────────────────────────────────
  const trpc = useTRPC();
  const { data: repoData, isLoading: isLoadingRepos } = useQuery(
    organizationId
      ? trpc.organizations.cloudAgentNext.listGitHubRepositories.queryOptions({
          organizationId,
          forceRefresh: false,
        })
      : trpc.cloudAgentNext.listGitHubRepositories.queryOptions({
          forceRefresh: false,
        })
  );

  const repositories = useMemo(() => {
    if (!repoData?.repositories) {
      return [];
    }
    return (repoData.repositories as { fullName: string; private: boolean }[]).map(r => ({
      fullName: r.fullName,
      isPrivate: r.private,
    }));
  }, [repoData]);

  // ── Handlers ─────────────────────────────────────────────────────
  const handleModelSelect = useCallback((modelId: string, newVariant: string) => {
    setModel(modelId);
    setVariant(newVariant);
  }, []);

  const handleCreate = useCallback(async () => {
    const prompt = promptRef.current.trim();
    if (!prompt || !selectedRepo || !model) {
      return;
    }

    setIsCreating(true);

    try {
      const initialMessageId = generateMessageId();
      const baseInput = {
        prompt,
        initialMessageId,
        mode,
        model,
        variant: variant || undefined,
        githubRepo: selectedRepo,
        autoCommit: true,
        autoInitiate: true,
      };

      const result = organizationId
        ? await trpcClient.organizations.cloudAgentNext.prepareSession.mutate({
            ...baseInput,
            organizationId,
          })
        : await trpcClient.cloudAgentNext.prepareSession.mutate(baseInput);

      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      const path = organizationId
        ? `/(app)/agent-chat/${result.kiloSessionId}?organizationId=${organizationId}`
        : `/(app)/agent-chat/${result.kiloSessionId}`;
      // router.replace() crashes on Android Fabric (react-native-screens
      // "addViewAt: View already has a parent"). Work around it by pushing
      // first, then removing this screen from the stack on the next frame
      // so the back button goes straight to the session list.
      router.push(path as Href);
      requestAnimationFrame(() => {
        navigation.dispatch(state => {
          const routes = state.routes.filter((r: { name: string }) => r.name !== 'agent-chat/new');
          return {
            type: 'RESET' as const,
            payload: { ...state, routes, index: routes.length - 1 },
          };
        });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create session';
      toast.error(message);
    } finally {
      setIsCreating(false);
    }
  }, [selectedRepo, model, mode, variant, organizationId, router, navigation]);

  const canStart = hasPrompt && selectedRepo.length > 0 && model.length > 0 && !isCreating;

  function handlePromptInputLayout(event: LayoutChangeEvent) {
    const nextWidth = Math.max(Math.round(event.nativeEvent.layout.width), 0);
    setPromptInputWidth(current => (current === nextWidth ? current : nextWidth));
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="New Session" />

      <ScrollView
        className="flex-1"
        contentContainerClassName="flex-grow px-4 pb-8 pt-4"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        <View className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm shadow-black/5">
          {promptMeasure.measureElement}
          <TextInput
            placeholder="What would you like to work on?"
            placeholderTextColor={colors.mutedForeground}
            multiline
            className="px-4 py-4 text-base leading-6 text-foreground"
            style={[promptInputStyle, { height: promptMeasure.height }]}
            onChangeText={text => {
              promptRef.current = text;
              promptMeasure.setText(text);
              setHasPrompt(text.trim().length > 0);
            }}
            onLayout={handlePromptInputLayout}
            scrollEnabled={promptMeasure.height >= PROMPT_INPUT_MAX_HEIGHT}
            editable={!isCreating}
            autoFocus
          />
          <ChatToolbar
            mode={mode}
            onModeChange={setMode}
            model={model}
            variant={variant}
            modelOptions={models}
            onModelSelect={handleModelSelect}
            disabled={isCreating}
            className="border-t border-border bg-neutral-100 dark:bg-neutral-900 px-3 py-3"
          />
        </View>

        <View className="mt-5">
          <Text className="mb-2 text-sm font-medium text-muted-foreground">Repository</Text>
          <RepoSelector
            value={selectedRepo}
            repositories={repositories}
            isLoading={isLoadingRepos}
            onChange={setSelectedRepo}
            disabled={isCreating}
          />
        </View>

        <Button
          size="lg"
          className="mt-6"
          disabled={!canStart}
          onPress={() => {
            void handleCreate();
          }}
        >
          {isCreating ? (
            <ActivityIndicator size="small" color={colors.primaryForeground} />
          ) : (
            <Text>Start Session</Text>
          )}
        </Button>
      </ScrollView>
    </View>
  );
}
