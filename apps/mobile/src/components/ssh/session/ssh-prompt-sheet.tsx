import { useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { PickerSheet } from '@/components/picker-sheet';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Text } from '@/components/ui/text';
import {
  closeSession,
  decideHostKey,
  submitPassphrase,
  submitPassword,
  submitPrompts,
} from '@/lib/ssh/session/manager';
import { needsPrompt, type SshSessionPhase } from '@/lib/ssh/session/types';
import { useSshSession } from '@/lib/ssh/session/use-sessions';
import { SSH_HOSTS_ROUTE } from '@/lib/ssh/routes';

/**
 * The questions a connection asks before it is live: an unknown host key, a
 * password the host does not store, a key's passphrase, and the server's own
 * keyboard-interactive rounds. They are one route because they are one place in
 * the connection, and only one of them can be waiting at a time.
 */
export function SshPromptSheet({ sessionId }: Readonly<{ sessionId: string }>) {
  const router = useRouter();
  const session = useSshSession(sessionId);
  const phase = session?.phase ?? null;
  const waiting = phase !== null && needsPrompt(phase);

  useEffect(() => {
    if (waiting) {
      return;
    }
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace(SSH_HOSTS_ROUTE);
  }, [waiting, router]);

  if (phase === null || !waiting) {
    return null;
  }
  switch (phase.kind) {
    case 'awaiting-host-key': {
      return <HostKeyForm sessionId={sessionId} phase={phase} />;
    }
    case 'awaiting-password':
    case 'awaiting-passphrase': {
      return <SecretForm sessionId={sessionId} phase={phase} />;
    }
    case 'awaiting-prompts': {
      return <PromptsForm sessionId={sessionId} phase={phase} />;
    }
    case 'connecting':
    case 'connected':
    case 'reconnecting':
    case 'closed': {
      return null;
    }
  }
}

function HostKeyForm({
  sessionId,
  phase,
}: Readonly<{ sessionId: string; phase: Extract<SshSessionPhase, { kind: 'awaiting-host-key' }> }>) {
  const { t } = useTranslation();
  const { hostKey } = phase;

  return (
    <PickerSheet
      title={t('ssh.session.hostKeyTitle')}
      doneLabel={t('ssh.session.trustAndSave')}
      onDone={() => {
        decideHostKey(sessionId, 'save');
      }}
      onCancel={() => {
        decideHostKey(sessionId, 'cancel');
      }}
      onHardwareBack={() => {
        decideHostKey(sessionId, 'cancel');
        return true;
      }}
    >
      <View className="gap-4 px-4 pt-2">
        <Text className="text-sm text-muted-foreground">
          {t('ssh.session.hostKeyBody', { pattern: hostKey.hostPattern })}
        </Text>
        <View className="gap-1 rounded-md border border-border bg-secondary p-3">
          <Text className="text-xs text-muted-foreground">{hostKey.algorithm}</Text>
          <Text variant="mono" className="text-xs text-foreground">
            {hostKey.fingerprintSha256}
          </Text>
        </View>
        <Button
          variant="outline"
          onPress={() => {
            decideHostKey(sessionId, 'once');
          }}
        >
          <Text>{t('ssh.session.trustOnce')}</Text>
        </Button>
      </View>
    </PickerSheet>
  );
}

function SecretForm({
  sessionId,
  phase,
}: Readonly<{
  sessionId: string;
  phase: Extract<SshSessionPhase, { kind: 'awaiting-password' | 'awaiting-passphrase' }>;
}>) {
  const { t } = useTranslation();
  const value = useRef('');
  const password = phase.kind === 'awaiting-password';
  const title = password ? t('ssh.editor.password') : t('ssh.session.passphraseTitle');
  const label = password ? t('ssh.editor.password') : t('ssh.session.passphrase');

  function submit() {
    if (password) {
      submitPassword(sessionId, value.current);
      return;
    }
    submitPassphrase(sessionId, value.current);
  }

  function cancel() {
    void closeSession(sessionId);
  }

  return (
    <PickerSheet
      title={title}
      doneLabel={password ? t('common.connect') : t('ssh.session.unlock')}
      onDone={submit}
      onCancel={cancel}
      onHardwareBack={() => {
        cancel();
        return true;
      }}
    >
      <View className="gap-4 px-4 pt-2">
        <Text className="text-sm text-muted-foreground">
          {password
            ? t('ssh.session.passwordBody')
            : t('ssh.session.passphraseBody', { label: t('ssh.editor.privateKey') })}
        </Text>
        {phase.failed ? (
          <Text className="text-sm text-destructive">
            {password ? t('ssh.session.reason.authFailed') : t('ssh.session.reason.wrongPassphrase')}
          </Text>
        ) : null}
        <FormField
          label={label}
          placeholder={label}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          onChangeText={next => {
            value.current = next;
          }}
        />
      </View>
    </PickerSheet>
  );
}

function PromptsForm({
  sessionId,
  phase,
}: Readonly<{
  sessionId: string;
  phase: Extract<SshSessionPhase, { kind: 'awaiting-prompts' }>;
}>) {
  const { t } = useTranslation();
  const answers = useRef<string[]>(phase.prompts.prompts.map(() => ''));

  function submit() {
    submitPrompts(sessionId, phase.prompts.prompts.map((_, index) => answers.current[index] ?? ''));
  }

  function cancel() {
    submitPrompts(sessionId, null);
  }

  return (
    <PickerSheet
      title={phase.prompts.name.trim() || t('modelChat.mcpOAuth.signIn')}
      doneLabel={t('ssh.session.promptsSubmit')}
      onDone={submit}
      onCancel={cancel}
      onHardwareBack={() => {
        cancel();
        return true;
      }}
    >
      <View className="gap-4 px-4 pt-2">
        {phase.prompts.instructions.trim().length === 0 ? null : (
          <Text className="text-sm text-muted-foreground">{phase.prompts.instructions}</Text>
        )}
        {phase.prompts.prompts.map((prompt, index) => {
          const label = prompt.text.trim() || t('ssh.session.promptLabel', { index: index + 1 });
          return (
            <FormField
              key={`${prompt.text}-${index}`}
              label={label}
              placeholder={label}
              secureTextEntry={!prompt.echo}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              onChangeText={next => {
                answers.current[index] = next;
              }}
            />
          );
        })}
      </View>
    </PickerSheet>
  );
}
