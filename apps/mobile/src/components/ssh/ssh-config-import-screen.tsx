import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type TextInput, View } from 'react-native';
import { toast } from 'sonner-native';

import { DetailScreenScrollView } from '@/components/detail-screen';
import { ScreenHeader } from '@/components/screen-header';
import { SshConfigImportPreview } from '@/components/ssh/import-preview';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { FormFieldLabel } from '@/components/ui/form-field-label';
import { FileText } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { planSshConfigImport, type SshConfigPlan } from '@/lib/ssh/config-import';
import { SSH_HOSTS_ROUTE } from '@/lib/ssh/routes';
import { useSshConfigImport, useSshHosts } from '@/lib/ssh/use-ssh';
import { cn } from '@/lib/utils';

/** The pasted config's text box: eight visible lines above the fold. */
const SOURCE_LINES = 8;

export function SshConfigImportScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const hosts = useSshHosts();
  const importHosts = useSshConfigImport();
  const textRef = useRef('');
  const inputRef = useRef<TextInput | null>(null);
  const [hasText, setHasText] = useState(false);
  const [plan, setPlan] = useState<SshConfigPlan | null>(null);
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set());
  const [fileFailed, setFileFailed] = useState(false);

  const leave = () => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace(SSH_HOSTS_ROUTE);
  };

  async function pickFile() {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        type: '*/*',
      });
      const asset = result.canceled ? undefined : result.assets[0];
      if (asset === undefined) {
        return;
      }
      const text = await new File(asset.uri).text();
      textRef.current = text;
      inputRef.current?.setNativeProps({ text });
      setHasText(text.trim().length > 0);
      setPlan(null);
      setFileFailed(false);
    } catch {
      setFileFailed(true);
    }
  }

  function toggle(alias: string) {
    setUnchecked(current => {
      const next = new Set(current);
      if (next.has(alias)) {
        next.delete(alias);
      } else {
        next.add(alias);
      }
      return next;
    });
  }

  function runImport() {
    if (plan === null) {
      return;
    }
    const kept = plan.hosts.filter(draft => !unchecked.has(draft.alias));
    importHosts.mutate(
      { ...plan, hosts: kept },
      {
        onSuccess: () => {
          announcingToast.success(t('ssh.import.imported'));
          leave();
        },
        onError: () => {
          toast.error(t('ssh.import.importFailed'));
        },
      }
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('ssh.import.title')} backFallback={SSH_HOSTS_ROUTE} />
      <DetailScreenScrollView
        className="flex-1"
        contentContainerClassName="gap-5 px-4 pt-4"
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Text className="text-sm text-muted-foreground">{t('ssh.import.description')}</Text>

        <View className="gap-1.5">
          <FormFieldLabel label={t('ssh.import.sourceLabel')} />
          <Input
            ref={inputRef}
            multiline
            numberOfLines={SOURCE_LINES}
            textAlignVertical="top"
            autoCapitalize="none"
            autoCorrect={false}
            className="min-h-[168px] rounded-md border border-input bg-background text-sm text-foreground dark:bg-[#FFFFFF0A]"
            onChangeText={value => {
              textRef.current = value;
              setHasText(value.trim().length > 0);
              setPlan(null);
            }}
          />
          <AccessibleStatus
            message={fileFailed ? t('ssh.import.unreadableFile') : null}
            className="text-sm"
          />
        </View>

        <View className="flex-row gap-2">
          <Button
            variant="outline"
            className={cn(STATE_ACTION_CLASS, 'flex-1')}
            onPress={() => void pickFile()}
          >
            <FileText size={16} />
            <Text>{t('ssh.import.chooseFile')}</Text>
          </Button>
          <Button
            className={cn(STATE_ACTION_CLASS, 'flex-1')}
            disabled={!hasText}
            onPress={() => {
              setPlan(planSshConfigImport(textRef.current, hosts.data ?? []));
              setUnchecked(new Set());
            }}
          >
            <Text>{t('ssh.import.preview')}</Text>
          </Button>
        </View>

        {plan === null ? null : (
          <SshConfigImportPreview
            plan={plan}
            unchecked={unchecked}
            onToggle={toggle}
            importing={importHosts.isPending}
            canImport={plan.hosts.some(draft => !unchecked.has(draft.alias))}
            onImport={runImport}
          />
        )}
      </DetailScreenScrollView>
    </View>
  );
}
