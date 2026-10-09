import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, ScrollView, View } from 'react-native';

import { SessionPageSheet } from '@/components/agents/session-page-sheet';
import { SheetHeader } from '@/components/sheet-header';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
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
import { type LocalModelStatus, useLocalModels } from '@/lib/chat/local-models';

import { BackendForm } from './backend-form';
import { ModelDownloadControl } from './model-download-control';

type FormTarget = { kind: 'add' } | { kind: 'edit'; backend: StoredChatBackend };

/** Fixed copy for the stable reason codes each native provider reports. */
const UNAVAILABLE_REASON_KEYS = {
  apple: new Map([
    ['apple_intelligence_disabled', 'modelChat.localModels.reasons.appleIntelligenceDisabled'],
    ['device_not_eligible', 'modelChat.localModels.reasons.deviceNotEligible'],
    ['model_not_ready', 'modelChat.localModels.reasons.modelNotReady'],
    ['unsupported_os', 'modelChat.localModels.reasons.unsupportedOs'],
  ]),
  android: new Map([
    ['unsupported_os', 'modelChat.localModels.reasons.androidUnsupportedOs'],
    ['model_unavailable', 'modelChat.localModels.reasons.androidModelUnavailable'],
    ['aicore_incompatible', 'modelChat.localModels.reasons.aicoreUpdateRequired'],
    ['system_update_required', 'modelChat.localModels.reasons.aicoreUpdateRequired'],
  ]),
} satisfies Record<LocalModelStatus['provider'], ReadonlyMap<string, string>>;

/** A model the system can still fetch is explained by its status, whatever reason rides along. */
const PENDING_STATUS_KEYS = {
  downloadable: 'modelChat.localModels.reasons.downloadable',
  downloading: 'modelChat.localModels.reasons.downloading',
} as const;

function reasonKeyOf({ provider, availability }: LocalModelStatus): string | undefined {
  if (availability === undefined || availability.status === 'available') {
    return undefined;
  }
  if (availability.status !== 'unavailable') {
    return PENDING_STATUS_KEYS[availability.status];
  }
  return (
    UNAVAILABLE_REASON_KEYS[provider].get(availability.reason ?? '') ??
    'modelChat.localModels.reasons.unknown'
  );
}

function LocalModelRow({ status }: Readonly<{ status: LocalModelStatus }>) {
  const { t } = useTranslation();
  const { availability } = status;
  let statusKey = 'modelChat.localModels.notAvailable';
  if (availability === undefined) {
    statusKey = 'modelChat.localModels.checking';
  } else if (availability.status === 'available') {
    statusKey = 'modelChat.localModels.ready';
  }
  const reasonKey = reasonKeyOf(status);
  return (
    <View className="gap-1 rounded-xl border border-border p-4">
      <Text className="font-semibold">{t(status.nameKey)}</Text>
      <Text className="text-sm">{t(statusKey)}</Text>
      {reasonKey !== undefined && (
        <Text className="text-sm text-muted-foreground">{t(reasonKey)}</Text>
      )}
      <ModelDownloadControl status={status} />
    </View>
  );
}

function LocalModelSection() {
  const { t } = useTranslation();
  const localModels = useLocalModels();
  if (localModels.length === 0) {
    return null;
  }
  return (
    <View className="gap-2">
      <Text className="font-semibold">{t('modelChat.localModels.title')}</Text>
      <Text className="text-sm text-muted-foreground">{t('modelChat.localModels.help')}</Text>
      {localModels.map(status => (
        <LocalModelRow key={status.provider} status={status} />
      ))}
    </View>
  );
}

export function BackendSettingsControl() {
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
        className="h-11 w-11 items-center justify-center active:opacity-70"
      >
        <Server size={22} color={colors.foreground} />
      </Pressable>
      <BackendSettingsSheet visible={visible} onClose={close} />
    </>
  );
}

function BackendSettingsSheet({
  visible,
  onClose,
}: Readonly<{ visible: boolean; onClose: () => void }>) {
  if (!visible) {
    return null;
  }
  return <BackendSettingsContent onClose={onClose} />;
}

function BackendSettingsContent({ onClose }: Readonly<{ onClose: () => void }>) {
  const { t } = useTranslation();
  const backends = useChatBackends();
  const loaded = useSyncExternalStore(
    subscribeChatBackends,
    getChatBackendsHasLoaded,
    getChatBackendsHasLoaded
  );
  const [target, setTarget] = useState<FormTarget | null>(null);
  const [formError, setError] = useState<string | null>(null);
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
    Alert.alert(
      t('modelChat.backends.deleteTitle'),
      t('modelChat.backends.deleteMessage', { name: backend.name }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => {
            if (isCurrentAuthEpoch(epoch.current)) {
              deleteChatBackend(backend.id);
            }
          },
        },
      ]
    );
  };
  return (
    <SessionPageSheet visible onClose={onClose}>
      <SheetHeader
        title={t('modelChat.backends.title')}
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
        <Text>{t('modelChat.backends.defaultKilo')}</Text>
        <Text className="text-sm text-muted-foreground">{t('modelChat.backends.kiloHelp')}</Text>
        <LocalModelSection />
        {!loaded ? (
          <Text>{t('common.loading')}</Text>
        ) : (
          <>
            {backends.length === 0 && <Text>{t('modelChat.backends.empty')}</Text>}
            {backends.map(backend => (
              <View key={backend.id} className="gap-2 rounded-xl border border-border p-4">
                <Text className="font-semibold">{backend.name}</Text>
                <Text className="text-sm text-muted-foreground">{backend.baseUrl}</Text>
                <Button
                  variant="outline"
                  onPress={() => {
                    setError(null);
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
            <Button
              onPress={() => {
                setError(null);
                setTarget({ kind: 'add' });
              }}
            >
              <Text>{t('modelChat.backends.add')}</Text>
            </Button>
          </>
        )}
      </ScrollView>
      {target !== null && (
        <SessionPageSheet
          visible
          onClose={() => {
            setTarget(null);
          }}
        >
          <SheetHeader
            title={t(target.kind === 'add' ? 'modelChat.backends.add' : 'modelChat.backends.edit')}
            onDone={() => {
              setTarget(null);
            }}
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
            />
            {formError !== null && <Text accessibilityRole="alert">{t(formError)}</Text>}
          </ScrollView>
        </SessionPageSheet>
      )}
    </SessionPageSheet>
  );
}
