/* eslint-disable no-literal-copy/no-literal-copy -- Development-only fixture controls and results do not ship. */
import { type ComponentProps, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ReactionPickerSheet } from '@/components/pr-review/discussion/reaction-picker-sheet';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/dialog';
import { Text } from '@/components/ui/text';

import { QuestionCard } from './question-card';

// Development-only two-question release-choice fixture: kiloapp:///dev/question-card-fixture.
// All outcomes stay in component state; no release workflow or API is called.
const questions = [
  {
    header: 'Version change',
    question: 'Which version change should the release use?',
    options: [
      {
        label: 'patch',
        description: 'Bump the patch version (0.0.0 → 0.0.1) for backward-compatible fixes.',
      },
      {
        label: 'minor',
        description: 'Bump the minor version (0.0.0 → 0.1.0) for backward-compatible features.',
      },
      {
        label: 'major',
        description: 'Bump the major version (0.0.0 → 1.0.0) for changes that break compatibility.',
      },
    ],
    multiple: false,
    custom: true,
  },
  {
    header: 'Workflow ref',
    question: 'Which ref should the release workflow run against?',
    options: [
      {
        label: 'main',
        description: 'Run the workflow on the main branch (default)',
      },
      {
        label: 'Current branch',
        description: 'Run the workflow on the current branch',
      },
    ],
    multiple: false,
    custom: true,
  },
] satisfies ComponentProps<typeof QuestionCard>['questions'];

type Outcome =
  | { kind: 'pending' }
  | { kind: 'answered'; answers: string[][] }
  | { kind: 'skipped' };

export function QuestionCardFixture() {
  const { t } = useTranslation();
  const { confirm, dialog } = useConfirmDialog();
  const [request, setRequest] = useState(1);
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'pending' });
  const [reactionPickerVisible, setReactionPickerVisible] = useState(false);
  const [reaction, setReaction] = useState<string | null>(null);
  const [confirmationCount, setConfirmationCount] = useState(0);
  let outcomeMessage = 'No answer or skip received.';
  if (outcome.kind === 'answered') {
    outcomeMessage = `Received answers: ${JSON.stringify(outcome.answers)}`;
  } else if (outcome.kind === 'skipped') {
    outcomeMessage = 'Received skip: true';
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={t('agentChat.session.title')}
        headerRight={
          <Button
            variant="ghost"
            size="sm"
            onPress={() => {
              setRequest(current => current + 1);
              setOutcome({ kind: 'pending' });
              setConfirmationCount(0);
            }}
          >
            <Text>{t('common.refresh')}</Text>
          </Button>
        }
      />
      <KeyboardAvoidingView className="flex-1" behavior="padding">
        <View className="flex-1">
          <ScrollView className="flex-1" keyboardShouldPersistTaps="handled">
            <View className="gap-3 px-4 py-3">
              <Text className="text-sm font-medium">Question card fixture</Text>
              <Text className="text-sm text-muted-foreground">
                Choose a version change and workflow ref. This fixture does not run a workflow.
              </Text>
              <Text accessibilityLiveRegion="polite" className="text-sm">
                {outcomeMessage}
              </Text>
              <Button
                variant="outline"
                onPress={() => {
                  confirm({
                    title: t('agents.sessionRow.deleteTitle'),
                    message: t('agents.sessionRow.deleteMessage'),
                    confirmLabel: t('common.delete'),
                    onConfirm: () => {
                      setConfirmationCount(current => current + 1);
                    },
                  });
                }}
              >
                <Text>Unrelated confirmation</Text>
              </Button>
              <Text accessibilityLiveRegion="polite" className="text-sm text-muted-foreground">
                {`Unrelated confirmations received: ${confirmationCount}. No session is deleted.`}
              </Text>
              <Button
                variant="outline"
                onPress={() => {
                  setReactionPickerVisible(true);
                }}
              >
                <Text>{t('common.reactions')}</Text>
              </Button>
              <Text className="text-sm">{`Selected reaction: ${reaction ?? 'none'}`}</Text>
            </View>
          </ScrollView>
        </View>
        {outcome.kind === 'pending' ? (
          <QuestionCard
            key={request}
            requestId={`question-card-fixture-${request}`}
            questions={questions}
            onAnswer={answers => {
              setOutcome({ kind: 'answered', answers });
            }}
            onReject={() => {
              setOutcome({ kind: 'skipped' });
            }}
          />
        ) : null}
      </KeyboardAvoidingView>
      <SafeAreaView edges={['bottom']} />
      {dialog}
      <ReactionPickerSheet
        visible={reactionPickerVisible}
        reactions={[]}
        onClose={() => {
          setReactionPickerVisible(false);
        }}
        onPick={content => {
          setReaction(content);
          setReactionPickerVisible(false);
        }}
      />
    </View>
  );
}
