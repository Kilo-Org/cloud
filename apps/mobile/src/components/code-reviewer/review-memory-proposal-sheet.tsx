import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';

import { SessionPageSheet } from '@/components/agents/session-page-sheet';
import { SheetHeader } from '@/components/sheet-header';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/dialog';
import { FormField } from '@/components/ui/form-field';
import { Text } from '@/components/ui/text';
import { openExternalUrl } from '@/lib/external-link';
import {
  type ProposalEditorInput,
  useReviewMemoryProposalEditor,
} from '@/lib/hooks/use-review-memory-proposal-editor';
import { proposalStatusLabel } from '@/lib/review-memory-proposals';

export function ReviewMemoryProposalSheet(props: ProposalEditorInput) {
  const { permission } = props;
  const { t } = useTranslation();
  const dismissal = useConfirmDialog();
  const {
    record,
    draft,
    revision,
    dirty,
    valid,
    failure,
    pending,
    canEdit,
    busy,
    changeField,
    perform,
    requestClose,
    requestDismiss,
    dialog,
  } = useReviewMemoryProposalEditor(props);

  return (
    <SessionPageSheet visible onClose={requestClose} onRequestDismiss={requestDismiss}>
      <SheetHeader
        title={t('codeReviewer.reviewMemory.proposalDetails')}
        onDone={requestClose}
        doneLabel={t('common.close')}
        disabled={busy}
        topInset="ios-page-sheet"
      />
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-4 px-6 pt-4 pb-8"
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
      >
        <Text className="text-base font-semibold">{record.title}</Text>
        <Text variant="muted" selectable>
          {record.repo_full_name}
        </Text>
        <Text>{proposalStatusLabel(record.status, t)}</Text>
        {permission.status === 'error' ? (
          <View className="gap-2">
            <Text variant="muted">{t('common.somethingWentWrong')}</Text>
            <Button
              variant="outline"
              onPress={() => {
                permission.refetch();
              }}
              disabled={busy || permission.isRetrying}
            >
              <Text>{t('common.retry')}</Text>
            </Button>
          </View>
        ) : null}
        {permission.status === 'loading' ? (
          <Text variant="muted">{t('common.loading')}</Text>
        ) : null}
        {permission.status === 'ready' && !permission.canEdit ? (
          <Text variant="muted">{t('codeReviewer.reviewMemory.readOnlyDescription')}</Text>
        ) : null}
        {canEdit ? (
          <View key={revision} className="gap-4">
            <FormField
              label={t('codeReviewer.reviewMemory.proposalTitle')}
              defaultValue={draft.current.title}
              maxLength={140}
              required
              disabled={busy}
              onChangeText={value => {
                changeField('title', value);
              }}
            />
            <FormField
              label={t('codeReviewer.reviewMemory.rationale')}
              defaultValue={draft.current.rationale}
              maxLength={1_500}
              required
              multiline
              textAlignVertical="top"
              className="min-h-[96px] leading-[20px]"
              disabled={busy}
              onChangeText={value => {
                changeField('rationale', value);
              }}
            />
            <FormField
              label={t('codeReviewer.overview.proposedReviewMdGuidance')}
              defaultValue={draft.current.proposedMarkdown}
              maxLength={4_000}
              required
              multiline
              textAlignVertical="top"
              className="min-h-[192px] font-mono leading-[20px]"
              autoCapitalize="none"
              autoCorrect={false}
              disabled={busy}
              onChangeText={value => {
                changeField('proposedMarkdown', value);
              }}
            />
          </View>
        ) : (
          <View className="gap-4">
            <View className="gap-1.5">
              <Text className="font-medium">{t('codeReviewer.reviewMemory.rationale')}</Text>
              <Text selectable>{record.rationale}</Text>
            </View>
            <View className="gap-1.5">
              <Text className="font-medium">
                {t('codeReviewer.overview.proposedReviewMdGuidance')}
              </Text>
              <Text selectable className="font-mono text-sm leading-[20px]">
                {record.proposed_markdown}
              </Text>
            </View>
          </View>
        )}
        {record.change_request_url ? (
          <Button
            variant="outline"
            disabled={busy}
            onPress={() => {
              if (record.change_request_url) {
                void openExternalUrl(record.change_request_url, { label: t('common.pullRequest') });
              }
            }}
          >
            <Text>{t('common.openPullRequest')}</Text>
          </Button>
        ) : null}
        <AccessibleStatus message={failure?.message ?? null} />
        {failure && canEdit ? (
          <Button
            variant="outline"
            disabled={
              busy ||
              (failure.action === 'approve' && dirty) ||
              (failure.action === 'save' && (!dirty || !valid))
            }
            onPress={() => void perform(failure.action)}
          >
            <Text>{t('common.retry')}</Text>
          </Button>
        ) : null}
        {canEdit ? (
          <View className="gap-3">
            <Button
              disabled={busy || !dirty || !valid}
              loading={pending === 'save'}
              onPress={() => void perform('save')}
            >
              <Text>{t('common.save')}</Text>
            </Button>
            {dirty ? <Text variant="muted">{t('codeReviewer.reviewMemory.saveFirst')}</Text> : null}
            <Button
              disabled={busy || dirty}
              loading={pending === 'approve'}
              onPress={() => void perform('approve')}
            >
              <Text>{t('common.openPullRequest')}</Text>
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              loading={pending === 'reject'}
              onPress={() => {
                dismissal.confirm({
                  title: t('codeReviewer.reviewMemory.dismissProposalTitle'),
                  message: t('codeReviewer.reviewMemory.dismissProposalMessage'),
                  confirmLabel: t('securityAgent.analysis.action.dismiss'),
                  onConfirm: () => {
                    void perform('reject');
                  },
                });
              }}
            >
              <Text>{t('securityAgent.analysis.action.dismiss')}</Text>
            </Button>
          </View>
        ) : null}
      </ScrollView>
      {dialog}
      {dismissal.dialog}
    </SessionPageSheet>
  );
}
