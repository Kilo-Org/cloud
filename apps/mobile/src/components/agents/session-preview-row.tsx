import { useMutation, useQuery } from '@tanstack/react-query';
import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { toast } from 'sonner-native';

import { SheetHeader } from '@/components/sheet-header';
import { DirectionalChevronRight } from '@/components/ui/directional-icons';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { openExternalUrl } from '@/lib/external-link';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { isCloudAgentSessionId } from '@/lib/session-compute-total';
import { useTRPC } from '@/lib/trpc';

import { SessionPageSheet } from './session-page-sheet';

/** What one sandbox service scan answers. */
type PreviewServices = inferRouterOutputs<MobileRouter>['cloudAgentNext']['listPreviewServices'];
type PreviewServicesStatus = PreviewServices['status'];
type PreviewService = PreviewServices['services'][number];
type PreviewUnavailableStatus = Exclude<PreviewServicesStatus, 'running'>;

/** One state the preview sheet paints. */
type PreviewState =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'unavailable'; status: PreviewUnavailableStatus }
  | { kind: 'empty' }
  | { kind: 'services'; services: PreviewService[] };

/**
 * Pick the state a scan is in from its own readings. The tRPC `queryOptions`
 * result is typed as a settled success, so this selector takes the same fields
 * through the honest view (a promise that may still be pending, a scan that may
 * have failed). It is pure, so the stopped, not-ready and unsupported answers
 * are covered without a device.
 */
function selectPreviewState(query: {
  data: PreviewServices | undefined;
  isError: boolean;
  isPending: boolean;
}): PreviewState {
  if (query.isPending) {
    return { kind: 'loading' };
  }
  if (query.isError || query.data === undefined) {
    return { kind: 'failed' };
  }
  const { status } = query.data;
  if (status !== 'running') {
    return { kind: 'unavailable', status };
  }
  if (query.data.services.length === 0) {
    return { kind: 'empty' };
  }
  return { kind: 'services', services: query.data.services };
}

/**
 * The sentence a sandbox state answers. A stopped, not-ready or unsupported
 * sandbox is not a failure the reader can retry their way out of, so each names
 * what is actually true instead of the shared failure copy.
 */
function sandboxStateMessage(status: PreviewUnavailableStatus): string {
  if (status === 'not_running') {
    return i18n.t('cloudAgent.preview.notRunning');
  }
  if (status === 'not_ready') {
    return i18n.t('cloudAgent.preview.notReady');
  }
  return i18n.t('cloudAgent.preview.unsupported');
}

type SessionPreviewRowProps = {
  /** The viewed session's Cloud Agent id; only a `workspace_` id has a preview. */
  cloudAgentSessionId?: string | null;
  /** Set for an organization-owned session, which previews through its own router. */
  organizationId?: string;
};

/**
 * Session-level entry to the sandbox's listening services. A legacy `agent_*`
 * session has no preview at all (the control plane would only answer 404), so
 * the row is absent rather than disabled.
 */
export function SessionPreviewRow({
  cloudAgentSessionId,
  organizationId,
}: Readonly<SessionPreviewRowProps>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const [visible, setVisible] = useState(false);
  if (!isCloudAgentSessionId(cloudAgentSessionId)) {
    return null;
  }
  const label = t('cloudAgent.preview.title');
  return (
    <>
      <Pressable
        onPress={() => {
          setVisible(true);
        }}
        accessibilityRole="button"
        accessibilityLabel={label}
        className="min-h-[44px] flex-row items-center justify-between gap-3 active:opacity-70"
        testID="session-context-sheet-preview"
      >
        <Text className="text-base font-medium text-foreground">{label}</Text>
        <DirectionalChevronRight size={16} color={colors.mutedForeground} />
      </Pressable>
      <SessionPreviewSheet
        visible={visible}
        onClose={() => {
          setVisible(false);
        }}
        cloudAgentSessionId={cloudAgentSessionId}
        organizationId={organizationId}
      />
    </>
  );
}

type SessionPreviewSheetProps = {
  visible: boolean;
  onClose: () => void;
  cloudAgentSessionId: `workspace_${string}`;
  organizationId: string | undefined;
};

/**
 * The services the session's sandbox is listening on. Opening one mints a
 * short-lived preview URL and hands it to the in-app browser, so the browser
 * never carries the user's session credential.
 *
 * A scan that fails is reported with a retry; a sandbox that is stopped, not
 * ready, or not supported answers its own sentence, because none of those is a
 * failure the user can retry their way out of.
 */
function SessionPreviewSheet({
  visible,
  onClose,
  cloudAgentSessionId,
  organizationId,
}: Readonly<SessionPreviewSheetProps>) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const colors = useThemeColors();
  const trpc = useTRPC();
  const [openingPort, setOpeningPort] = useState<number | null>(null);

  const personal = useQuery(
    trpc.cloudAgentNext.listPreviewServices.queryOptions(
      { cloudAgentSessionId },
      { enabled: visible && organizationId === undefined, retry: false }
    )
  );
  const organization = useQuery(
    trpc.organizations.cloudAgentNext.listPreviewServices.queryOptions(
      { organizationId: organizationId ?? '', cloudAgentSessionId },
      { enabled: visible && organizationId !== undefined, retry: false }
    )
  );
  const services = organizationId === undefined ? personal : organization;
  const state = selectPreviewState(services);

  const personalPreview = useMutation(
    trpc.cloudAgentNext.createPreview.mutationOptions({
      onError: error => {
        toast.error(error.message);
      },
    })
  );
  const organizationPreview = useMutation(
    trpc.organizations.cloudAgentNext.createPreview.mutationOptions({
      onError: error => {
        toast.error(error.message);
      },
    })
  );

  const openPort = async (port: number, label: string) => {
    setOpeningPort(port);
    try {
      const result =
        organizationId === undefined
          ? await personalPreview.mutateAsync({ cloudAgentSessionId, port })
          : await organizationPreview.mutateAsync({ organizationId, cloudAgentSessionId, port });
      await openExternalUrl(result.url, { label, retryOnError: true });
    } catch {
      // The mutation's onError already surfaced the reason with the same toast.
    } finally {
      setOpeningPort(null);
    }
  };

  const refetch = () => {
    void services.refetch();
  };

  let body: ReactNode = null;
  if (state.kind === 'loading') {
    body = (
      <View className="min-h-[120px] flex-row items-center justify-center gap-2">
        <ActivityIndicator />
        <Text className="text-sm text-muted-foreground">{t('common.loading')}</Text>
      </View>
    );
  } else if (state.kind === 'failed') {
    body = (
      <StateBlock
        message={t('cloudAgent.preview.failed')}
        actionLabel={t('common.retry')}
        onAction={refetch}
      />
    );
  } else if (state.kind === 'unavailable') {
    body = (
      <StateBlock
        message={sandboxStateMessage(state.status)}
        actionLabel={t('common.refresh')}
        onAction={refetch}
      />
    );
  } else if (state.kind === 'empty') {
    body = (
      <StateBlock
        message={t('cloudAgent.preview.empty')}
        actionLabel={t('common.refresh')}
        onAction={refetch}
      />
    );
  } else {
    body = (
      <View className="gap-2">
        {state.services.map(service => (
          <Pressable
            key={service.port}
            onPress={() => void openPort(service.port, service.name)}
            disabled={openingPort !== null}
            accessibilityRole="button"
            accessibilityLabel={t('cloudAgent.preview.openService', {
              name: service.name,
              port: service.port,
            })}
            className="min-h-[44px] flex-row items-center gap-3 rounded-md border border-border px-3 py-3 active:opacity-70"
          >
            <View className="min-w-0 flex-1 gap-0.5">
              <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
                {service.name}
              </Text>
              {service.description ? (
                <Text className="text-xs text-muted-foreground" numberOfLines={2}>
                  {service.description}
                </Text>
              ) : null}
              <Text variant="mono" className="text-xs text-muted-foreground">
                {t('cloudAgent.preview.portLabel', { port: service.port })}
              </Text>
            </View>
            {openingPort === service.port ? (
              <ActivityIndicator />
            ) : (
              <DirectionalChevronRight size={16} color={colors.mutedForeground} />
            )}
          </Pressable>
        ))}
      </View>
    );
  }

  return (
    <SessionPageSheet visible={visible} onClose={onClose} dismissible>
      <SheetHeader title={t('cloudAgent.preview.title')} onDone={onClose} topInset="ios-page-sheet" />
      <ScrollView className="flex-1" contentContainerClassName="gap-3 px-6 pb-6 pt-3">
        <View className="flex-row items-center justify-between gap-3">
          <Text className="text-xs uppercase tracking-wide text-muted-foreground">
            {t('cloudAgent.preview.listeningServices')}
          </Text>
          <Pressable
            onPress={refetch}
            disabled={openingPort !== null}
            accessibilityRole="button"
            accessibilityLabel={t('common.refresh')}
            hitSlop={8}
            className="active:opacity-70"
            testID="session-preview-refresh"
          >
            <Text className="text-sm font-medium text-primary">{t('common.refresh')}</Text>
          </Pressable>
        </View>
        {body}
      </ScrollView>
      <View style={{ height: insets.bottom }} className="bg-background" />
    </SessionPageSheet>
  );
}

function StateBlock({
  message,
  actionLabel,
  onAction,
}: Readonly<{ message: string; actionLabel: string; onAction: () => void }>) {
  return (
    <View className="gap-3 rounded-md border border-border p-4">
      <Text className="text-sm text-muted-foreground">{message}</Text>
      <Pressable
        onPress={onAction}
        accessibilityRole="button"
        accessibilityLabel={actionLabel}
        className="min-h-[44px] justify-center active:opacity-70"
      >
        <Text className="text-sm font-medium text-primary">{actionLabel}</Text>
      </Pressable>
    </View>
  );
}
