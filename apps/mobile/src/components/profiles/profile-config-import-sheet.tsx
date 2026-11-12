import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { toast } from 'sonner-native';

import { SessionPageSheet } from '@/components/agents/session-page-sheet';
import {
  defaultImportSelection,
  hasImportableItems,
  type ImportCategoryView,
  importCategoryViews,
  type ImportIssueView,
  importIssueViews,
  type ImportSelection,
  importSelectionRequest,
  selectedImportCount,
  selectedOverwriteCount,
} from '@/components/profiles/config-import-preview-model';
import { SheetHeader } from '@/components/sheet-header';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/dialog';
import { FormField } from '@/components/ui/form-field';
import { ClipboardPaste } from '@/components/ui/icons';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { useSheetDismissGuard } from '@/components/ui/use-sheet-dismiss-guard';
import { configImportArchiveFromText } from '@/lib/config-import-archive';
import { useConfigImportMutations } from '@/lib/hooks/use-config-import-mutations';

type ProfileConfigImportSheetProps = Readonly<{
  profileId: string;
  organizationId?: string;
  onClose: () => void;
}>;

type Status = 'idle' | 'previewing' | 'applying';

/**
 * The mutation hooks report failures inline here: the sheet renders them above
 * its own content, so the reader sees the server's reason without leaving it.
 * A refusal without a readable message falls back to the sheet's own copy.
 */
function errorMessage(error: unknown): string | null {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : null;
}

/**
 * Paste a local Kilo config, review what the import would add or change, and
 * apply the sections kept. The server owns the parse and the diff, so an
 * invalid config comes back as its own issues and messages.
 *
 * The archive is built from the pasted text in the app
 * (`config-import-archive.ts`): the import procedures take a base64 ZIP, which
 * is also what the web uploader sends.
 */
export function ProfileConfigImportSheet({
  profileId,
  organizationId,
  onClose,
}: Readonly<ProfileConfigImportSheetProps>) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { confirm, dialog } = useConfirmDialog();
  const { previewConfigImport, applyConfigImport } = useConfigImportMutations(organizationId);

  const textRef = useRef('');
  const archiveRef = useRef<string | null>(null);
  // Remount token for the pasted-config field, which is uncontrolled.
  const [pasteToken, setPasteToken] = useState(0);
  const [views, setViews] = useState<readonly ImportCategoryView[]>([]);
  const [selection, setSelection] = useState<ImportSelection>({
    agents: false,
    commands: false,
    skills: false,
    instructions: false,
  });
  const [issues, setIssues] = useState<readonly ImportIssueView[]>([]);
  const [hasPreview, setHasPreview] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('idle');

  const busy = status !== 'idle';
  const selectedCount = selectedImportCount(views, selection);
  const nothingToImport = hasPreview && !hasImportableItems(views);

  const {
    requestClose,
    requestDismiss,
    dialog: discardDialog,
  } = useSheetDismissGuard({
    isDirty: () => !hasPreview && textRef.current.trim().length > 0,
    onDiscard: onClose,
  });

  const pasteFromClipboard = async () => {
    try {
      // Loaded on tap, like the composer's copy actions: the sheet's own module
      // graph stays free of a native module it does not need until then.
      const { getStringAsync } = await import('expo-clipboard');
      const text = await getStringAsync();
      if (text.trim().length === 0) {
        return;
      }
      textRef.current = text;
      setPasteToken(token => token + 1);
      setFailure(null);
    } catch {
      setFailure(t('profiles.importConfigPasteFailed'));
    }
  };

  const runPreview = async () => {
    setFailure(null);
    const built = configImportArchiveFromText(textRef.current);
    if (!built.ok) {
      setFailure(
        t(built.error === 'empty' ? 'profiles.importConfigEmpty' : 'profiles.importConfigTooLarge')
      );
      return;
    }
    setStatus('previewing');
    try {
      const result = await previewConfigImport.mutateAsync({
        profileId,
        archive: built.archive,
      });
      const categoryViews = importCategoryViews(result);
      archiveRef.current = built.archive;
      setViews(categoryViews);
      setSelection(defaultImportSelection(categoryViews));
      setIssues(importIssueViews(result));
      setHasPreview(true);
    } catch (error) {
      setFailure(errorMessage(error) ?? t('profiles.importConfigPreviewFailed'));
    } finally {
      setStatus('idle');
    }
  };

  const applySelection = async () => {
    if (archiveRef.current === null || selectedCount === 0) {
      return;
    }
    setStatus('applying');
    setFailure(null);
    try {
      await applyConfigImport.mutateAsync({
        profileId,
        archive: archiveRef.current,
        selection: importSelectionRequest(views, selection),
      });
      toast.success(t('profiles.importConfigApplied'));
      onClose();
    } catch (error) {
      setFailure(errorMessage(error) ?? t('profiles.importConfigApplyFailed'));
    } finally {
      setStatus('idle');
    }
  };

  const runApply = () => {
    if (archiveRef.current === null || selectedCount === 0) {
      return;
    }
    // Only a selected definition marked Changed replaces a cloud version, so
    // the confirmation follows the diff rather than the number of sections.
    if (selectedOverwriteCount(views, selection) === 0) {
      void applySelection();
      return;
    }
    confirm({
      title: t('profiles.importConfigOverwriteTitle'),
      message: t('profiles.importConfigOverwriteMessage'),
      confirmLabel: t('profiles.importConfigApplyAction'),
      onConfirm: () => {
        void applySelection();
      },
    });
  };

  return (
    <SessionPageSheet visible onClose={onClose} onRequestDismiss={requestDismiss}>
      <SheetHeader
        title={t('profiles.importConfigTitle')}
        onDone={() => {
          if (hasPreview) {
            runApply();
            return;
          }
          void runPreview();
        }}
        onCancel={requestClose}
        doneLabel={
          hasPreview
            ? t('profiles.importConfigApplyAction')
            : t('profiles.importConfigPreviewAction')
        }
        doneDisabled={busy || (hasPreview && selectedCount === 0)}
        topInset="ios-page-sheet"
      />
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-4 px-6 pt-4 pb-8"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        showsVerticalScrollIndicator={false}
      >
        {failure === null ? null : (
          <AccessibleStatus message={failure} tone="error" className="text-sm" />
        )}

        <Text variant="muted">{t('profiles.importConfigHint')}</Text>
        <FormField
          key={`config-import-${pasteToken}`}
          label={t('profiles.importConfigLabel')}
          defaultValue={textRef.current}
          disabled={busy || hasPreview}
          multiline
          textAlignVertical="top"
          className="min-h-40 max-h-56 leading-[1.25rem] font-mono text-xs"
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={value => {
            textRef.current = value;
          }}
        />
        <Button
          variant="outline"
          onPress={() => {
            void pasteFromClipboard();
          }}
          disabled={busy || hasPreview}
        >
          <ClipboardPaste size={16} />
          <Text>{t('profiles.importConfigPasteAction')}</Text>
        </Button>

        {hasPreview ? (
          <Button
            variant="ghost"
            disabled={busy}
            onPress={() => {
              archiveRef.current = null;
              setViews([]);
              setSelection({
                agents: false,
                commands: false,
                skills: false,
                instructions: false,
              });
              setIssues([]);
              setHasPreview(false);
              setFailure(null);
            }}
          >
            <Text>{t('profiles.importConfigStartOver')}</Text>
          </Button>
        ) : null}

        {nothingToImport ? (
          <Text variant="muted">{t('profiles.importConfigNothingToImport')}</Text>
        ) : null}

        {views.map(section => (
          <View key={section.category} className="gap-1">
            <View className="flex-row items-center gap-2">
              <Text className="min-w-0 flex-1" numberOfLines={2}>
                {t(section.titleKey)}
              </Text>
              <Switch
                value={selection[section.category]}
                accessibilityLabel={t('profiles.importConfigIncludeSection', {
                  name: t(section.titleKey),
                })}
                disabled={busy}
                onValueChange={selected => {
                  setSelection(current => ({ ...current, [section.category]: selected }));
                }}
              />
            </View>
            {section.items.map(item => (
              <View key={`${section.category}:${item.id}`} className="flex-row gap-2 pl-2">
                <Text variant="mono" className="min-w-0 flex-1 text-xs" numberOfLines={1}>
                  {item.label}
                </Text>
                <Text variant="muted" className="text-xs">
                  {t(
                    item.status === 'added'
                      ? 'profiles.importConfigAdded'
                      : 'profiles.importConfigChanged'
                  )}
                </Text>
              </View>
            ))}
          </View>
        ))}

        {issues.length === 0 ? null : (
          <View className="gap-1">
            <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
              {t('profiles.importConfigIssuesTitle')}
            </Text>
            {issues.map((issue, index) => (
              <Text key={`${issue.severity}:${String(index)}`} variant="muted" className="text-xs">
                {`${issue.severity === 'error' ? '●' : '○'} ${issue.message}`}
              </Text>
            ))}
          </View>
        )}
      </ScrollView>
      <View style={{ height: insets.bottom }} className="bg-background" />
      {dialog}
      {discardDialog}
    </SessionPageSheet>
  );
}
