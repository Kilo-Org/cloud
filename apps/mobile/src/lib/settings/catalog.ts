import { Effect } from 'effect';
import { z } from 'zod';

import { SUPPORTED_LANGUAGES } from '@/i18n/languages';
import { type NotificationPreferences } from '@/lib/hooks/agent-push-preference';
import {
  getCondenseToolCalls,
  setCondenseToolCalls,
} from '@/lib/hooks/use-condense-tool-calls-preference';
import { getHideBalance, setHideBalance } from '@/lib/hooks/use-hide-balance-preference';
import { getHideThinking, setHideThinking } from '@/lib/hooks/use-hide-thinking-preference';
import { getKeepScreenOn, setKeepScreenOn } from '@/lib/hooks/use-keep-screen-on-preference';
import {
  getLanguagePreference,
  type LanguagePreference,
  setLanguagePreferenceAsync,
} from '@/lib/hooks/use-language-preference';
import {
  getStoredModelPreference,
  setDefaultModelForContext,
} from '@/lib/hooks/use-persisted-agent-model';
import { getPrReviewFooter, setPrReviewFooter } from '@/lib/hooks/use-pr-review-footer-preference';
import { getAutoExpandThinking, setAutoExpandThinking } from '@/lib/hooks/use-reasoning-preference';
import {
  getReturnSendsMessage,
  setReturnSendsMessage,
} from '@/lib/hooks/use-return-sends-message-preference';
import {
  getThemePreference,
  setThemePreference,
  type ThemePreference,
} from '@/lib/hooks/use-theme-preference';
import { getTrustedHosts, setTrustedHosts } from '@/lib/hooks/use-trusted-hosts';
import { queryClient } from '@/lib/query-client';
import { trpcClient } from '@/lib/trpc';
import {
  isToolSummaryTranslationEnabled,
  readToolSummaryTranslationModel,
  writeToolSummaryTranslationEnabled,
  writeToolSummaryTranslationModel,
} from '@/lib/tool-summary-translation/tool-summary-translation-preference';
import {
  isGatewayTranscriptionEnabled,
  readGatewayTranscriptionModel,
  setGatewayTranscriptionEnabled,
  writeGatewayTranscriptionModel,
} from '@/lib/voice-input/gateway/gateway-transcription-preference';
import {
  readVoiceInputLanguage,
  writeVoiceInputLanguage,
} from '@/lib/voice-input/voice-input-language-preference';

import {
  booleanSetting,
  changed,
  enumSetting,
  failure,
  invalidValue,
  listSetting,
  NOTIFICATION_PREFERENCES_QUERY_KEY,
  stringSetting,
} from './bindings';
import { notificationToggleEntries } from './notification-catalog';
import { type AppSettingEntry } from './types';

/**
 * Every setting an agent may read and change, each one bound to the exact store
 * the manual screen writes. This table is a view over those stores, never a
 * second copy, so a manual change and an agent change are the same change.
 *
 * Excluded on purpose: biometric unlock (it needs a device-auth gesture an agent
 * cannot perform), feature flags (`__DEV__` only), and the account-lifecycle
 * actions — sign out and delete account — because they end the session the tool
 * is running in, and delete account also needs an emailed code.
 */

const THEME_OPTIONS = ['system', 'light', 'dark'] as const;
const LANGUAGE_OPTIONS = ['device', ...SUPPORTED_LANGUAGES];
const PREVIEW_OPTIONS = ['generic', 'full'] as const;

const languageSchema = z.union([z.literal('device'), z.enum(SUPPORTED_LANGUAGES)]);
const previewSchema = z.enum(PREVIEW_OPTIONS);

type BooleanToggle = Readonly<{
  name: string;
  description: string;
  read: () => boolean;
  write: (next: boolean) => void;
}>;

const BOOLEAN_TOGGLES: readonly BooleanToggle[] = [
  {
    name: 'hideThinking',
    description: "Hide the model's thinking rows in the transcript.",
    read: getHideThinking,
    write: setHideThinking,
  },
  {
    name: 'autoExpandThinking',
    description: 'Expand thinking rows by default in new messages.',
    read: getAutoExpandThinking,
    write: setAutoExpandThinking,
  },
  {
    name: 'condenseToolCalls',
    description: 'Show tool calls condensed into a single summary row.',
    read: getCondenseToolCalls,
    write: setCondenseToolCalls,
  },
  {
    name: 'keepScreenOn',
    description: 'Keep the screen awake while the app is in the foreground.',
    read: getKeepScreenOn,
    write: setKeepScreenOn,
  },
  {
    name: 'returnSendsMessage',
    description: 'The Return key sends the message instead of inserting a newline.',
    read: getReturnSendsMessage,
    write: setReturnSendsMessage,
  },
  {
    name: 'prReviewAttribution',
    description: 'Append the Kilo attribution footer to submitted pull-request reviews.',
    read: getPrReviewFooter,
    write: setPrReviewFooter,
  },
  {
    name: 'hideBalance',
    description: 'Hide the account balance on the profile screen.',
    read: getHideBalance,
    write: setHideBalance,
  },
  {
    name: 'gatewayTranscription',
    description: 'Transcribe voice input through the Kilo gateway instead of on device.',
    read: isGatewayTranscriptionEnabled,
    write: setGatewayTranscriptionEnabled,
  },
  {
    name: 'toolSummaryTranslation',
    description: 'Translate tool summaries in the transcript to the app language.',
    read: isToolSummaryTranslationEnabled,
    write: writeToolSummaryTranslationEnabled,
  },
];

const toggleEntries: readonly AppSettingEntry[] = BOOLEAN_TOGGLES.map(toggle => ({
  name: toggle.name,
  description: toggle.description,
  kind: 'boolean',
  bind: () => booleanSetting(toggle.name, toggle.read, toggle.write),
}));

export const ENTRIES: readonly AppSettingEntry[] = [
  ...toggleEntries,
  ...notificationToggleEntries,
  {
    name: 'theme',
    description: 'The color theme: follow the system, or force light or dark.',
    kind: 'enum',
    options: THEME_OPTIONS,
    bind: () =>
      enumSetting({
        name: 'theme',
        options: THEME_OPTIONS,
        read: getThemePreference,
        write: value => {
          setThemePreference(value as ThemePreference);
        },
      }),
  },
  {
    name: 'language',
    description: 'The app language: a supported tag, or "device" to follow the system.',
    kind: 'enum',
    options: LANGUAGE_OPTIONS,
    bind: () => ({
      read: getLanguagePreference,
      write: value => {
        const parsed = languageSchema.safeParse(value);
        if (!parsed.success) {
          return Effect.fail(invalidValue('language', value, LANGUAGE_OPTIONS.join(', ')));
        }
        const language: LanguagePreference = parsed.data;
        return Effect.tryPromise({
          try: async () => {
            const saved = await setLanguagePreferenceAsync(language);
            if (!saved) {
              throw new Error('the language could not be saved to disk');
            }
            return changed('language', language);
          },
          catch: error => failure(`Could not change language: ${String(error)}`),
        });
      },
    }),
  },
  {
    name: 'notifications.previews',
    description: 'Whether notification previews show their content or stay generic.',
    kind: 'enum',
    options: PREVIEW_OPTIONS,
    bind: () => ({
      read: () =>
        queryClient.getQueryData<NotificationPreferences>(NOTIFICATION_PREFERENCES_QUERY_KEY)
          ?.notificationPreviews ?? 'generic',
      write: value => {
        const parsed = previewSchema.safeParse(value);
        if (!parsed.success) {
          return Effect.fail(
            invalidValue('notifications.previews', value, PREVIEW_OPTIONS.join(', '))
          );
        }
        const preview = parsed.data;
        return Effect.tryPromise({
          try: async () => {
            await trpcClient.user.setNotificationPreferences.mutate({
              notificationPreviews: preview,
            });
            await queryClient.invalidateQueries({ queryKey: NOTIFICATION_PREFERENCES_QUERY_KEY });
            return changed('notifications.previews', preview);
          },
          catch: error => failure(`Could not change notifications.previews: ${String(error)}`),
        });
      },
    }),
  },
  {
    name: 'defaultModel',
    description: 'The default model id for new chats in this organization context.',
    kind: 'string',
    bind: organizationId =>
      stringSetting(
        'defaultModel',
        () => getStoredModelPreference(organizationId)?.model ?? '',
        value => {
          setDefaultModelForContext(organizationId, {
            model: value,
            variant: getStoredModelPreference(organizationId)?.variant ?? '',
          });
        }
      ),
  },
  {
    name: 'defaultVariant',
    description: 'The default model variant/reasoning effort for new chats.',
    kind: 'string',
    bind: organizationId =>
      stringSetting(
        'defaultVariant',
        () => getStoredModelPreference(organizationId)?.variant ?? '',
        value => {
          setDefaultModelForContext(organizationId, {
            model: getStoredModelPreference(organizationId)?.model ?? '',
            variant: value,
          });
        }
      ),
  },
  {
    name: 'transcriptionModel',
    description: 'The gateway transcription model id. Empty keeps the model unchosen.',
    kind: 'string',
    bind: () =>
      stringSetting(
        'transcriptionModel',
        () => readGatewayTranscriptionModel()?.id ?? '',
        value => {
          writeGatewayTranscriptionModel(value === '' ? null : { id: value, name: value });
        }
      ),
  },
  {
    name: 'toolSummaryTranslationModel',
    description: 'The tool-summary translation model id.',
    kind: 'string',
    bind: () =>
      stringSetting(
        'toolSummaryTranslationModel',
        () => readToolSummaryTranslationModel().id,
        value => {
          writeToolSummaryTranslationModel({ id: value, name: value });
        }
      ),
  },
  {
    name: 'voiceInputLanguage',
    description: 'The voice-input language tag. Empty means auto.',
    kind: 'string',
    bind: () =>
      stringSetting(
        'voiceInputLanguage',
        () => readVoiceInputLanguage() ?? '',
        value => {
          writeVoiceInputLanguage(value === '' ? null : value);
        }
      ),
  },
  {
    name: 'trustedHosts',
    description: 'Hosts whose links open without a confirmation prompt. Replaces the whole list.',
    kind: 'list',
    destructive: true,
    bind: () => listSetting('trustedHosts', getTrustedHosts, setTrustedHosts),
  },
];
