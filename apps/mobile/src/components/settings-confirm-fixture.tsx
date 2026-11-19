/* eslint-disable no-literal-copy/no-literal-copy -- Development-only destructive-confirm fixture; its labels never ship. */
import { Effect } from 'effect';
import { type ReactNode, useState } from 'react';
import { View } from 'react-native';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { chatToolsFor } from '@/lib/chat/tool-set';
import { useTrustedHosts } from '@/lib/hooks/use-trusted-hosts';

/**
 * Development-only screen for the destructive settings confirmation: it runs the
 * real `settings_set` tool on the trusted-host list, so the confirmation the
 * agent's call raises is the one the app ships, on the store the profile menu
 * shows.
 *
 * The link `kiloapp:///dev/settings-confirm-fixture` opens it through
 * `src/app/+native-intent.tsx`. The route refuses a release build outright.
 */

/** The refusal a tool writes for the model is a text `cause`; anything else reads as unknown. */
const REFUSAL_CAUSE_SCHEMA = z.string().min(1);

/** The call a model would make: the whole list, replaced. */
const SET_TRUSTED_HOSTS = {
  id: 'settings-confirm-fixture',
  name: 'settings_set',
  arguments: JSON.stringify({ setting: 'trustedHosts', value: ['fixture.example'] }),
} as const;

/** What the last call answered, or nothing before the first one. */
type Outcome =
  | { readonly kind: 'idle' }
  | { readonly kind: 'done'; readonly body: string }
  | { readonly kind: 'failed'; readonly reason: string };

/** The settings tools the app gives a chat, built the way a chat builds them. */
function settingsSetTool() {
  return chatToolsFor({
    settingsEnabled: true,
    webSearchEnabled: false,
    kiloEnabled: false,
    kiloNames: [],
    remoteNames: [],
    remoteTools: [],
  }).find(tool => tool.definition.name === SET_TRUSTED_HOSTS.name);
}

export function SettingsConfirmFixture() {
  const { trustedHosts } = useTrustedHosts();
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });
  const [running, setRunning] = useState(false);

  async function run(): Promise<void> {
    const tool = settingsSetTool();
    if (tool === undefined) {
      setOutcome({ kind: 'failed', reason: 'the settings tool is not in this build' });
      return;
    }
    setRunning(true);
    setOutcome({ kind: 'idle' });
    const answered = await Effect.runPromise(
      Effect.match(tool.run(SET_TRUSTED_HOSTS), {
        // The refusal the tool writes for the model travels as a text `cause`.
        onFailure: failure => {
          const parsed = REFUSAL_CAUSE_SCHEMA.safeParse(failure.cause);
          return {
            kind: 'failed',
            reason: parsed.success ? parsed.data : 'the tool refused without a reason',
          } as const;
        },
        onSuccess: body => ({ kind: 'done', body }) as const,
      })
    );
    setOutcome(answered);
    setRunning(false);
  }

  return (
    <View testID="settings-confirm-fixture" className="flex-1 gap-4 p-5">
      <Text accessibilityRole="header" className="text-lg font-semibold">
        Destructive settings confirmation
      </Text>
      <Text className="text-sm text-muted-foreground">
        Runs the agent's settings_set call on the trusted-host list.
      </Text>
      <Text testID="settings-confirm-fixture-trusted-hosts" className="text-sm">
        {`trustedHosts: ${trustedHosts.length === 0 ? '(empty)' : trustedHosts.join(', ')}`}
      </Text>
      <Button disabled={running} onPress={() => void run()} testID="settings-confirm-fixture-run">
        <Text>{running ? 'Running…' : 'Ask to replace the trusted-host list'}</Text>
      </Button>
      <OutcomeLine outcome={outcome} />
    </View>
  );
}

function OutcomeLine({ outcome }: Readonly<{ outcome: Outcome }>): ReactNode {
  switch (outcome.kind) {
    case 'idle': {
      return null;
    }
    case 'done': {
      return (
        <Text testID="settings-confirm-fixture-result" className="text-sm">
          {outcome.body}
        </Text>
      );
    }
    case 'failed': {
      return (
        <Text testID="settings-confirm-fixture-result" className="text-sm text-destructive">
          {outcome.reason}
        </Text>
      );
    }
    default: {
      return null;
    }
  }
}