import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, View } from 'react-native';

import { SessionPageSheet } from '@/components/agents/session-page-sheet';
import { SheetHeader } from '@/components/sheet-header';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/dialog';
import { Text } from '@/components/ui/text';
import { useSheetDismissGuard } from '@/components/ui/use-sheet-dismiss-guard';
import { Server } from '@/components/ui/icons';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import {
  addChatBackend,
  BACKEND_INPUT_ERROR_KEYS,
  BackendInputError,
  type ChatBackendDraft,
  deleteChatBackend,
  getChatBackendsHasLoaded,
  type StoredChatBackend,
  subscribeChatBackends,
  updateChatBackend,
  useChatBackends,
} from '@/lib/chat/backend-store';
import { backendTargetId } from '@/lib/chat/backend-target';
import { ICON_TARGET_BOX_CLASS } from '@/lib/a11y/tap-target';
import { cn } from '@/lib/utils';

import { BackendForm } from './backend-form';
import {
  BackendProviderChoice,
  CloudProviderChoice,
  type ProviderSelection,
} from './backend-provider-choices';
import { GgufModelSection } from './gguf-model-section';
import { LocalModelSection } from './local-model-section';
import { modelCapabilityKey } from './model-capability';

type FormTarget = { kind: 'add' } | { kind: 'edit'; backend: StoredChatBackend };

export function BackendSettingsControl(selection: ProviderSelection) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const [visible, setVisible] = useState(false);
  const close = useCallback(() => {
    setVisible(false);
  }, []);
  return (
    <>
      <Pressable
        onPress={() => {
          setVisible(true);
        }}
        accessibilityRole="button"
        accessibilityLabel={t('modelChat.backends.manage')}
        className={cn(ICON_TARGET_BOX_CLASS, 'active:opacity-70')}
      >
        <Server size={22} color={colors.foreground} />
      </Pressable>
      <BackendSettingsSheet visible={visible} onClose={close} {...selection} />
    </>
  );
}

function BackendSettingsSheet({
  visible,
  onClose,
  ...selection
}: Readonly<{ visible: boolean; onClose: () => void }> & ProviderSelection) {
  if (!visible) {
    return null;
  }
  return <BackendSettingsContent onClose={onClose} {...selection} />;
}

function BackendSettingsContent({
  onClose,
  ...selection
}: Readonly<{ onClose: () => void }> & ProviderSelection) {
  const { confirm, dialog } = useConfirmDialog();
  const { t } = useTranslation();
  const backends = useChatBackends();
  const router = useRouter();
  const loaded = useSyncExternalStore(
    subscribeChatBackends,
    getChatBackendsHasLoaded,
    getChatBackendsHasLoaded
  );
  const [target, setTarget] = useState<FormTarget | null>(null);
  const [formError, setError] = useState<string | null>(null);
  const backendDirtyRef = useRef(false);
  const {
    requestClose,
    requestDismiss,
    dialog: discardDialog,
  } = useSheetDismissGuard({
    isDirty: () => backendDirtyRef.current,
    onDiscard: () => {
      backendDirtyRef.current = false;
      setTarget(null);
    },
  });
  const epoch = useRef(currentAuthEpoch());
  useEffect(() => {
    if (!isCurrentAuthEpoch(epoch.current)) {
      onClose();
    }
  }, [backends, onClose]);
  if (!isCurrentAuthEpoch(epoch.current)) {
    return null;
  }
  const save = (draft: ChatBackendDraft) => {
    if (!isCurrentAuthEpoch(epoch.current)) {
      setError('modelChat.backends.staleBackend');
      return;
    }
    try {
      if (target?.kind === 'edit') {
        updateChatBackend(target.backend.id, draft);
      } else {
        addChatBackend(draft);
      }
      setError(null);
      backendDirtyRef.current = false;
      setTarget(null);
    } catch (error) {
      setError(
        error instanceof BackendInputError
          ? BACKEND_INPUT_ERROR_KEYS[error.problem]
          : 'modelChat.backends.invalidInput'
      );
    }
  };
  const remove = (backend: StoredChatBackend) => {
    confirm({
      title: t('modelChat.backends.deleteTitle'),
      message: t('modelChat.backends.deleteMessage', { name: backend.name }),
      confirmLabel: t('common.delete'),
      onConfirm: () => {
        if (isCurrentAuthEpoch(epoch.current)) {
          deleteChatBackend(backend.id);
        }
      },
    });
  };
  const chooseModel =
    selection.onSelectModel === undefined
      ? undefined
      : (modelId: string) => {
          if (isCurrentAuthEpoch(epoch.current)) {
            onClose();
            selection.onSelectModel?.(modelId);
          }
        };
  const providerSelection = { selectedModel: selection.selectedModel, onSelectModel: chooseModel };
  return (
    <SessionPageSheet visible onClose={onClose}>
      <SheetHeader
        title={t('modelChat.backends.providersTitle')}
        onDone={onClose}
        doneLabel={t('common.close')}
        topInset="ios-page-sheet"
      />
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-4 px-6 pt-4 pb-8"
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
      >
        <View className="gap-2">
          <Text className="font-semibold">{t('modelChat.backends.cloud')}</Text>
          <CloudProviderChoice {...providerSelection} />
        </View>
        <View className="gap-2">
          <Text className="font-semibold">{t('modelChat.localModels.title')}</Text>
          <Text className="text-sm text-muted-foreground">{t('modelChat.localModels.help')}</Text>
          <LocalModelSection {...providerSelection} />
          <GgufModelSection
            {...providerSelection}
            onBrowse={() => {
              onClose();
              router.push('/model-catalog');
            }}
          />
        </View>
        <View className="gap-2">
          <Text className="font-semibold">{t('modelChat.backends.title')}</Text>
          {!loaded ? (
            <Text>{t('common.loading')}</Text>
          ) : (
            <>
              {backends.length === 0 && <Text>{t('modelChat.backends.empty')}</Text>}
              {backends.map(backend => (
                <View key={backend.id} className="gap-2 rounded-xl border border-border p-4">
                  <Text className="font-semibold">{backend.name}</Text>
                  <Text className="text-sm text-muted-foreground">{backend.baseUrl}</Text>
                  {backend.models.map(model => (
                    <BackendProviderChoice
                      key={model.id}
                      {...providerSelection}
                      name={model.name}
                      description={t(modelCapabilityKey(model.tools, model.images))}
                      modelId={backendTargetId(backend, model.id)}
                    />
                  ))}
                  <Button
                    variant="outline"
                    onPress={() => {
                      setError(null);
                      backendDirtyRef.current = false;
                      setTarget({ kind: 'edit', backend });
                    }}
                  >
                    <Text>{t('modelChat.backends.edit')}</Text>
                  </Button>
                  <Button
                    variant="ghost"
                    onPress={() => {
                      remove(backend);
                    }}
                  >
                    <Text>{t('common.delete')}</Text>
                  </Button>
                </View>
              ))}
            </>
          )}
          {loaded && (
            <Button
              variant="outline"
              onPress={() => {
                setError(null);
                backendDirtyRef.current = false;
                setTarget({ kind: 'add' });
              }}
            >
              <Text>{t('modelChat.backends.add')}</Text>
            </Button>
          )}
        </View>
      </ScrollView>
      {target !== null && (
        <SessionPageSheet
          visible
          onClose={() => {
            backendDirtyRef.current = false;
            setTarget(null);
          }}
          onRequestDismiss={requestDismiss}
        >
          <SheetHeader
            title={t(target.kind === 'add' ? 'modelChat.backends.add' : 'modelChat.backends.edit')}
            onDone={requestClose}
            doneLabel={t('common.close')}
            topInset="ios-page-sheet"
          />
          <ScrollView
            className="flex-1"
            contentContainerClassName="gap-4 px-6 pt-4 pb-8"
            automaticallyAdjustKeyboardInsets
            keyboardShouldPersistTaps="handled"
          >
            <BackendForm
              key={
                target.kind === 'edit' ? `${target.backend.id}:${target.backend.revision}` : 'add'
              }
              backend={target.kind === 'edit' ? target.backend : undefined}
              onSave={save}
              onDirtyChange={dirty => {
                backendDirtyRef.current = dirty;
              }}
            />
            {formError !== null && <Text accessibilityRole="alert">{t(formError)}</Text>}
          </ScrollView>
          {discardDialog}
        </SessionPageSheet>
      )}
      {dialog}
    </SessionPageSheet>
  );
}
