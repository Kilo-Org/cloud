import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { ScreenHeader } from '@/components/screen-header';
import { HostEditorForm } from '@/components/ssh/host-editor-form';
import { SshStorageError } from '@/components/ssh/ssh-storage-error';
import { Skeleton } from '@/components/ui/skeleton';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { SSH_HOSTS_ROUTE } from '@/lib/ssh/routes';
import { useSshHostEditor, useSshHostMutations } from '@/lib/ssh/use-ssh';

type HostEditorScreenProps = Readonly<{
  /** The host to edit, or null when this screen creates one. */
  hostId: string | null;
}>;

export function HostEditorScreen({ hostId }: HostEditorScreenProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const editor = useSshHostEditor(hostId);
  const { save } = useSshHostMutations();
  const title = hostId === null ? t('ssh.editor.newTitle') : t('ssh.editor.editTitle');

  const leave = () => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace(SSH_HOSTS_ROUTE);
  };

  let body = null;
  if (editor.isPending) {
    body = (
      <View className="gap-5 px-4 pt-4">
        {[0, 1, 2, 3].map(field => (
          <Skeleton key={field} className="h-[74px] rounded-lg" />
        ))}
      </View>
    );
  } else if (editor.isError) {
    body = (
      <SshStorageError
        error={editor.error}
        onRetry={() => void editor.refetch()}
        isRetrying={editor.isFetching}
      />
    );
  } else if (hostId !== null && editor.data.host === null) {
    body = <InvalidRouteState backTo={SSH_HOSTS_ROUTE} />;
  } else {
    body = (
      <HostEditorForm
        host={editor.data.host}
        hosts={editor.data.hosts}
        keys={editor.data.keys}
        saving={save.isPending}
        saveError={save.error ?? undefined}
        onSubmit={host => {
          save.reset();
          save.mutate(
            { id: hostId, host },
            {
              onSuccess: () => {
                announcingToast.success(t('ssh.editor.saved'));
                leave();
              },
            }
          );
        }}
      />
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={title} backFallback={SSH_HOSTS_ROUTE} />
      {body}
    </View>
  );
}
