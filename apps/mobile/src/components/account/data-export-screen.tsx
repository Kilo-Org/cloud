import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { toast } from 'sonner-native';

import { ExportRow } from '@/components/account/data-export-row';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { FormField } from '@/components/ui/form-field';
import { Archive, FileText, Share } from '@/components/ui/icons';
import { RowGroup } from '@/components/ui/row-group';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { codeFailureMessage, DOWNLOAD_CODE_PATTERN } from '@/lib/data-export-code';
import { getDataExportFailureMessage, shareDataExport } from '@/lib/data-export-download';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { PROFILE_TAB_HREF } from '@/lib/profile-navigation';
import { useTRPC } from '@/lib/trpc';

const SKELETON_ROWS = [0, 1];

/** The emailed-code step: either closed, or open for one export. */
type ExportChallenge =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'open';
      readonly exportId: string;
      readonly challengeId: string;
      readonly entryError: string | null;
    };

/**
 * A copy of the account's own data, as a file the reader can share.
 *
 * Requesting is one tap and asynchronous: a worker produces the export, so a new
 * row appears queued and the list reports its status. The two terminal statuses
 * are the server's to explain — a failed export reports its own reason — and the
 * only way forward is another request.
 *
 * The download is a two-step walk: a code is emailed to the account address, and
 * entering it exchanges the code for one signed URL. That URL is fetched and
 * handed to the platform share sheet, never displayed.
 */
export function DataExportScreen() {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const colors = useThemeColors();
  const codeRef = useRef('');
  const [challenge, setChallenge] = useState<ExportChallenge>({ kind: 'none' });
  // A rejected code request has no challenge to render inside, so its message
  // lives under the export list beside the row that raised it.
  const [requestCodeError, setRequestCodeError] = useState<string | null>(null);
  const listKey = trpc.userExports.list.queryKey();

  const access = useQuery(trpc.userExports.uiAccess.queryOptions());
  const exportsQuery = useQuery({
    ...trpc.userExports.list.queryOptions(),
    enabled: access.data?.enabled === true,
  });
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: listKey });

  const request = useMutation(
    trpc.userExports.request.mutationOptions({
      onSuccess: () => {
        invalidate();
        announcingToast.success(t('profile.dataExport.requested'));
      },
      onError: error => toast.error(error.message),
    })
  );

  const requestCode = useMutation(
    trpc.userExports.requestDownloadCode.mutationOptions({
      onSuccess: (result, input) => {
        setChallenge({
          kind: 'open',
          exportId: input.exportId,
          challengeId: result.challengeId,
          entryError: null,
        });
        codeRef.current = '';
        setRequestCodeError(null);
        announcingToast.success(
          t('profile.dataExport.codeSent', { minutes: result.expiresInMinutes })
        );
      },
      onError: error => {
        // This failure is the request that *sends* a code, so the entry-field
        // copy ("Enter the code from the email.") would describe a field that is
        // not on screen yet. A structured rejection has no reader-facing text,
        // so it falls back to the generic retry line.
        setRequestCodeError(codeFailureMessage(error, t('queryError.neutralDescription')));
      },
    })
  );

  const download = useMutation(
    trpc.userExports.createDownload.mutationOptions({
      onSuccess: async (result, variables) => {
        // The code is spent, so the form closes: nothing may resubmit it.
        codeRef.current = '';
        setChallenge({ kind: 'none' });
        setRequestCodeError(null);
        try {
          await shareDataExport({ downloadUrl: result.downloadUrl, exportId: variables.exportId });
        } catch (error) {
          toast.error(getDataExportFailureMessage(error));
        }
      },
      onError: error => {
        const message = codeFailureMessage(error, t('profile.dataExport.codeRequired'));
        setChallenge(current =>
          current.kind === 'open' ? { ...current, entryError: message } : current
        );
      },
    })
  );

  // The feature is released per account. Until the answer arrives, and while it
  // says no, there is nothing here to request: the unavailable state is terminal,
  // so it offers no retry that could only fail the same way.
  if (access.isPending) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t('profile.dataExport.title')} backFallback={PROFILE_TAB_HREF} />
        <View className={SCREEN_BODY_CLASS}>
          {/* The description line, the request action and the list keep their
              settled heights, so the page does not move when the release check
              answers and the real content arrives. */}
          <RowGroup>
            {SKELETON_ROWS.map(row => (
              // The export row's subtitle is the server's own status sentence,
              // which the row lets run to two lines.
              <RowSkeleton key={row} tile lines={3} />
            ))}
          </RowGroup>
          <Skeleton className="h-11 rounded-md" />
        </View>
      </View>
    );
  }

  if (access.isError) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t('profile.dataExport.title')} backFallback={PROFILE_TAB_HREF} />
        <QueryError onRetry={() => void access.refetch()} isRetrying={access.isFetching} />
      </View>
    );
  }

  if (!access.data.enabled) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t('profile.dataExport.title')} backFallback={PROFILE_TAB_HREF} />
        <EmptyState
          icon={Archive}
          title={t('profile.dataExport.unavailableTitle')}
          description={t('profile.dataExport.unavailableDescription')}
        />
      </View>
    );
  }

  const openChallenge = challenge.kind === 'open' ? challenge : null;

  let body: ReactNode = null;
  if (exportsQuery.isPending) {
    body = (
      <RowGroup>
        {SKELETON_ROWS.map(row => (
          <RowSkeleton key={row} tile lines={3} />
        ))}
      </RowGroup>
    );
  } else if (exportsQuery.isError) {
    body = (
      <QueryError
        onRetry={() => void exportsQuery.refetch()}
        isRetrying={exportsQuery.isFetching}
      />
    );
  } else if (exportsQuery.data.exports.length === 0) {
    body = (
      <EmptyState
        icon={Archive}
        title={t('profile.dataExport.emptyTitle')}
        description={t('profile.dataExport.emptyDescription')}
      />
    );
  } else {
    body = (
      <RowGroup leadingTile>
        {exportsQuery.data.exports.map(dataExport => (
          <ExportRow
            key={dataExport.id}
            dataExport={dataExport}
            requestingCode={
              requestCode.isPending && requestCode.variables.exportId === dataExport.id
            }
            onRequestCode={() => {
              setRequestCodeError(null);
              requestCode.mutate({ exportId: dataExport.id });
            }}
          />
        ))}
      </RowGroup>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('profile.dataExport.title')} backFallback={PROFILE_TAB_HREF} />
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName={SCREEN_BODY_CLASS}
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Text variant="muted">{t('profile.dataExport.description')}</Text>
        <Button
          className={STATE_ACTION_CLASS}
          loading={request.isPending}
          disabled={request.isPending}
          onPress={() => {
            request.mutate(undefined);
          }}
        >
          <FileText size={16} color={colors.primaryForeground} />
          <Text>{t('profile.dataExport.request')}</Text>
        </Button>
        {body}
        {requestCodeError === null ? null : (
          <Text className="text-destructive">{requestCodeError}</Text>
        )}
        {openChallenge === null ? null : (
          <Card>
            <FormField
              key={openChallenge.challengeId}
              label={t('profile.dataExport.codeLabel')}
              placeholder={t('profile.dataExport.codePlaceholder')}
              keyboardType="number-pad"
              autoComplete="one-time-code"
              textContentType="oneTimeCode"
              disabled={download.isPending}
              onChangeText={value => {
                codeRef.current = value;
                setChallenge(current =>
                  current.kind === 'open' ? { ...current, entryError: null } : current
                );
              }}
            />
            <Button
              variant="outline"
              className={STATE_ACTION_CLASS}
              loading={download.isPending}
              disabled={download.isPending}
              onPress={() => {
                const code = codeRef.current.trim();
                // The server only redeems eight digits; anything else would come
                // back as a schema payload rather than a sentence.
                if (!DOWNLOAD_CODE_PATTERN.test(code)) {
                  toast.error(t('profile.dataExport.codeRequired'));
                  return;
                }
                download.mutate({
                  exportId: openChallenge.exportId,
                  code,
                  challengeId: openChallenge.challengeId,
                });
              }}
            >
              <Share size={16} color={colors.foreground} />
              <Text>{t('profile.dataExport.download')}</Text>
            </Button>
            {openChallenge.entryError === null ? null : (
              <Text className="text-destructive">{openChallenge.entryError}</Text>
            )}
          </Card>
        )}
      </TabScreenScrollView>
    </View>
  );
}
