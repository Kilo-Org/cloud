/* eslint-disable max-lines -- New-session screen bundles closely related prompt/toolbar/repository concerns in a single component to keep navigation props colocated. */
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  type LayoutChangeEvent,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  type TextStyle,
  View,
} from 'react-native';
import { type Href, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { generateMessageId } from 'cloud-agent-sdk/message-id';
import * as Haptics from 'expo-haptics';
import * as WebBrowser from 'expo-web-browser';
import { ExternalLink, Paperclip, RefreshCw } from 'lucide-react-native';
import { toast } from 'sonner-native';

import { AttachmentPreviewStrip } from '@/components/agents/attachment-preview-strip';
import { pickAgentAttachments } from '@/components/agents/attachment-picker';
import { ChatToolbar } from '@/components/agents/chat-toolbar';
import { type AgentMode } from '@/components/agents/mode-selector';
import { RepoSelector } from '@/components/agents/repo-selector';
import { useTextHeight } from '@/components/agents/use-text-height';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { ScreenHeader } from '@/components/screen-header';
import { invalidateAgentSessionQueries } from '@/lib/agent-session-cache';
import {
  getGitHubIntegrationUrl,
  shouldShowGitHubIntegrationPrompt,
} from '@/lib/agent-github-integration';
import { AGENT_ATTACHMENT_MAX_FILES } from '@/lib/agent-attachments/constants';
import {
  type AgentAttachmentWire,
  useAgentAttachmentUpload,
} from '@/lib/agent-attachments/use-agent-attachment-upload';
import { WEB_BASE_URL } from '@/lib/config';
import { useAvailableModels } from '@/lib/hooks/use-available-models';
import { useAutoSelectModel } from '@/lib/hooks/use-auto-select-model';
import { useModelPreferences } from '@/lib/hooks/use-model-preferences';
import { usePersistedAgentModel } from '@/lib/hooks/use-persisted-agent-model';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { trpcClient, useTRPC } from '@/lib/trpc';

const PROMPT_INPUT_DEFAULT_LINES = 3;
const PROMPT_INPUT_MAX_LINES = 6;
const PROMPT_INPUT_LINE_HEIGHT = 24;
// Must mirror the TextInput's actual padding: py-2 (16 total) and px-2 on
// iOS (16 total) / the 24pt-per-side Android inset (48 total).
const PROMPT_INPUT_VERTICAL_PADDING = 16;
const PROMPT_INPUT_HORIZONTAL_PADDING = Platform.OS === 'android' ? 48 : 16;
const PROMPT_INPUT_ANDROID_HORIZONTAL_INSET = 24;
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
  const queryClient = useQueryClient();
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
  const { setLastSelected: persistServerLastSelected } = useModelPreferences(organizationId);
  const { saveModel } = usePersistedAgentModel();
  const autoSelected = useAutoSelectModel(models, organizationId);
  const attachments = useAgentAttachmentUpload({ organizationId });

  // Apply auto-selected model when the user hasn't picked one yet.
  const hasAppliedAutoSelection = useRef(false);
  if (!hasAppliedAutoSelection.current && autoSelected.model && !model) {
    hasAppliedAutoSelection.current = true;
    setModel(autoSelected.model);
    setVariant(autoSelected.variant);
  }

  // ── Repositories ─────────────────────────────────────────────────
  const trpc = useTRPC();
  const {
    data: repoData,
    isLoading: isLoadingRepos,
    isRefetching: isRefetchingRepos,
    refetch: refetchRepos,
  } = useQuery(
    organizationId
      ? trpc.organizations.cloudAgentNext.listGitHubRepositories.queryOptions({
          organizationId,
          forceRefresh: false,
        })
      : trpc.cloudAgentNext.listGitHubRepositories.queryOptions({
          forceRefresh: false,
        })
  );

  const showGitHubIntegrationPrompt = shouldShowGitHubIntegrationPrompt({
    isLoadingRepos,
    integrationInstalled: repoData?.integrationInstalled,
    repositoryCount: repoData?.repositories.length,
  });

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
  const handleModelSelect = useCallback(
    (modelId: string, newVariant: string) => {
      setModel(modelId);
      setVariant(newVariant);
      saveModel(organizationId, { model: modelId, variant: newVariant });
      persistServerLastSelected({ model: modelId, ...(newVariant ? { variant: newVariant } : {}) });
    },
    [organizationId, saveModel, persistServerLastSelected]
  );

  const handleOpenGitHubIntegration = useCallback(async () => {
    try {
      await WebBrowser.openAuthSessionAsync(getGitHubIntegrationUrl(WEB_BASE_URL, organizationId));
      await refetchRepos();
    } catch {
      toast.error('Could not open GitHub setup. Please try again.');
    }
  }, [organizationId, refetchRepos]);

  const handleCreate = useCallback(async () => {
    const prompt = promptRef.current.trim();
    // The backend requires a non-empty prompt even when attachments are present.
    if (!prompt || !selectedRepo || !model) {
      return;
    }
    if (attachments.isUploading) {
      toast.error('Wait for attachments to finish uploading.');
      return;
    }
    if (prompt.startsWith('/') && attachments.attachments.length > 0) {
      toast.error('Attachments cannot be sent with slash commands.');
      return;
    }

    setIsCreating(true);

    try {
      const initialMessageId = generateMessageId();
      const baseInput: {
        prompt: string;
        initialMessageId: string;
        mode: AgentMode;
        model: string;
        variant: string | undefined;
        githubRepo: string;
        autoCommit: boolean;
        autoInitiate: boolean;
        attachments?: AgentAttachmentWire;
      } = {
        prompt,
        initialMessageId,
        mode,
        model,
        variant: variant || undefined,
        githubRepo: selectedRepo,
        autoCommit: true,
        autoInitiate: true,
      };
      const wireAttachments = attachments.toWirePayload();
      if (wireAttachments) {
        baseInput.attachments = wireAttachments;
      }

      const result = organizationId
        ? await trpcClient.organizations.cloudAgentNext.prepareSession.mutate({
            ...baseInput,
            organizationId,
          })
        : await trpcClient.cloudAgentNext.prepareSession.mutate(baseInput);

      await invalidateAgentSessionQueries(queryClient, trpc);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      const path = organizationId
        ? `/(app)/agent-chat/${result.kiloSessionId}?organizationId=${organizationId}`
        : `/(app)/agent-chat/${result.kiloSessionId}`;
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
  }, [
    selectedRepo,
    model,
    mode,
    variant,
    organizationId,
    queryClient,
    trpc,
    router,
    navigation,
    attachments,
  ]);

  const canStart = hasPrompt && selectedRepo.length > 0 && model.length > 0 && !isCreating;

  const { addCandidates } = attachments;
  const handleAddAttachment = useCallback(async () => {
    addCandidates(await pickAgentAttachments());
  }, [addCandidates]);

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
          <AttachmentPreviewStrip
            attachments={attachments.attachments}
            onRemove={id => {
              attachments.removeAttachment(id);
            }}
          />
          <View className="flex-row items-end px-2 pt-2">
            <Pressable
              onPress={() => {
                void handleAddAttachment();
              }}
              disabled={isCreating || attachments.attachments.length >= AGENT_ATTACHMENT_MAX_FILES}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              className="h-9 w-9 items-center justify-center rounded-full active:opacity-70"
              accessibilityRole="button"
              accessibilityLabel="Add attachment"
            >
              <Paperclip size={18} color={colors.mutedForeground} />
            </Pressable>
            {promptMeasure.measureElement}
            <TextInput
              placeholder="What would you like to work on?"
              placeholderTextColor={colors.mutedForeground}
              multiline
              className="flex-1 px-2 py-2 text-base leading-6 text-foreground"
              style={[
                promptInputStyle,
                { height: promptMeasure.height },
                Platform.OS === 'android'
                  ? { paddingHorizontal: PROMPT_INPUT_ANDROID_HORIZONTAL_INSET }
                  : undefined,
              ]}
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
          </View>
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
          {showGitHubIntegrationPrompt ? (
            <View className="mt-3 gap-3 rounded-lg border border-border bg-card p-4">
              <View className="gap-1">
                <Text className="text-sm font-semibold text-foreground">Connect GitHub</Text>
                <Text variant="muted">
                  Connect GitHub in your browser, then return here to pick a repository.
                </Text>
              </View>
              <View className="flex-row gap-2">
                <Button
                  variant="outline"
                  className="flex-1"
                  onPress={() => {
                    void handleOpenGitHubIntegration();
                  }}
                >
                  <ExternalLink size={16} color={colors.foreground} />
                  <Text>Open</Text>
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  onPress={() => {
                    void refetchRepos();
                  }}
                  disabled={isRefetchingRepos}
                  accessibilityLabel="Refresh repositories"
                >
                  {isRefetchingRepos ? (
                    <ActivityIndicator size="small" color={colors.foreground} />
                  ) : (
                    <RefreshCw size={16} color={colors.foreground} />
                  )}
                </Button>
              </View>
            </View>
          ) : null}
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
