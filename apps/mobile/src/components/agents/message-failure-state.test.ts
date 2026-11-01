import { describe, expect, it } from 'vitest';

import { type MessageInfo } from '@kilocode/cloud-agent-sdk';

import { CATALOG_LOADERS } from '@/i18n/catalogs';
import { i18n } from '@/i18n';
import { SUPPORTED_LANGUAGES } from '@/i18n/languages';

import {
  composeFailureLabel,
  messageFailureLabel,
  NON_RETRYABLE_ASSISTANT_ERRORS,
  selectMessageFailure,
} from './message-failure-state';

function userInfo(): MessageInfo {
  return {
    id: 'u1',
    sessionID: 'ses_1',
    role: 'user',
    time: { created: 1_761_000_000_000 },
    agent: 'build',
    model: { providerID: 'openrouter', modelID: 'anthropic/claude-sonnet-4' },
  };
}

type AssistantError = NonNullable<Extract<MessageInfo, { role: 'assistant' }>['error']>;

function assistantInfo(errorName: string): MessageInfo {
  return {
    id: 'a1',
    sessionID: 'ses_1',
    role: 'assistant',
    time: { created: 1_761_000_000_000 },
    // Deliberately carries raw provider text; the helper must never surface it.
    error: { name: errorName, data: { message: 'RAW_PROVIDER_TEXT' } } as unknown as AssistantError,
    parentID: 'u1',
    modelID: 'anthropic/claude-sonnet-4',
    providerID: 'kilo',
    mode: 'code',
    agent: 'build',
    path: { cwd: '/', root: '/' },
    cost: 0,
    tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

function assistantInfoWithoutError(): MessageInfo {
  const info = assistantInfo('ProviderAuthError') as Extract<MessageInfo, { role: 'assistant' }>;
  delete info.error;
  return info;
}

describe('selectMessageFailure', () => {
  it('returns null when there is no failed delivery and no assistant error', () => {
    expect(selectMessageFailure({ info: userInfo() })).toBeNull();
    expect(selectMessageFailure({ info: assistantInfo('UnknownError') })).not.toBeNull();
  });

  it('returns null for a queued delivery state', () => {
    expect(
      selectMessageFailure({ info: userInfo(), deliveryState: { status: 'queued' } })
    ).toBeNull();
  });

  describe('delivery', () => {
    it('maps every delivery reason to fixed copy and never emits raw error text', () => {
      const cases = [
        { reason: 'interrupted', title: 'Failed to deliver', detail: 'You stopped this message.' },
        {
          reason: 'exhausted',
          title: 'Failed to deliver',
          detail: 'We could not deliver this message after several attempts.',
        },
      ] as const;

      for (const { reason, title, detail } of cases) {
        const result = selectMessageFailure({
          info: userInfo(),
          deliveryState: { status: 'failed', error: 'RAW_TRANSPORT_TEXT', reason },
        });
        expect(result).not.toBeNull();
        expect(result?.kind).toBe('delivery');
        expect(result?.title).toBe(title);
        expect(result?.detail).toBe(detail);
        expect(result?.title).not.toContain('RAW_TRANSPORT_TEXT');
        expect(result?.detail).not.toContain('RAW_TRANSPORT_TEXT');
        // The raw transport text stays reachable behind the copy action only.
        expect(result?.copyDetail).toBe('RAW_TRANSPORT_TEXT');
        expect(result?.canRetry).toBe(true);
        expect(result?.canCopy).toBe(true);
      }
    });

    it('states an agent-execution failure once, in the assistant-failure copy', () => {
      const result = selectMessageFailure({
        info: userInfo(),
        deliveryState: { status: 'failed', error: 'RAW_TRANSPORT_TEXT', reason: 'execution' },
      });
      expect(result).not.toBeNull();
      expect(result?.kind).toBe('delivery');
      expect(result?.title).toBe('Response failed');
      expect(result?.detail).toBeNull();
      expect(result?.copyDetail).toBe('RAW_TRANSPORT_TEXT');
      expect(result?.canRetry).toBe(true);
      expect(result?.canCopy).toBe(true);
    });

    it('exposes no copy detail when the delivery failure carries no transport text', () => {
      const result = selectMessageFailure({
        info: userInfo(),
        deliveryState: { status: 'failed', error: '', reason: 'exhausted' },
      });
      expect(result?.copyDetail).toBe('');
    });
  });

  describe('assistant', () => {
    it('returns null for an assistant info with no error', () => {
      expect(selectMessageFailure({ info: assistantInfoWithoutError() })).toBeNull();
    });

    it('never carries a copy detail for an assistant row', () => {
      const result = selectMessageFailure({ info: assistantInfo('APIError') });
      expect(result?.copyDetail).toBe('');
    });

    it('derives a fixed detail line from every classified error name and never emits provider text', () => {
      const cases = [
        ['ProviderAuthError', 'The provider rejected the request.'],
        ['MessageAbortedError', 'The response was stopped.'],
        ['ContextOverflowError', 'The conversation is too long for the model.'],
        ['APIError', 'The provider returned an error.'],
        ['MessageOutputLengthError', "The response reached the model's output limit."],
        ['StructuredOutputError', 'The response did not match the required format.'],
      ] as const;

      for (const [name, detail] of cases) {
        const result = selectMessageFailure({ info: assistantInfo(name) });
        expect(result, name).not.toBeNull();
        expect(result?.kind).toBe('assistant');
        expect(result?.title).toBe('Response failed');
        expect(result?.detail, name).toBe(detail);
        expect(result?.detail).not.toContain('RAW_PROVIDER_TEXT');
        expect(result?.canCopy).toBe(false);
      }
    });

    it('adds no detail line for an unknown error name, which the title states', () => {
      const result = selectMessageFailure({ info: assistantInfo('UnknownError') });
      expect(result?.title).toBe('Response failed');
      expect(result?.detail).toBeNull();
      expect(JSON.stringify(result)).not.toContain('RAW_PROVIDER_TEXT');
    });

    it('sets canRetry false only for NON_RETRYABLE_ASSISTANT_ERRORS', () => {
      for (const name of NON_RETRYABLE_ASSISTANT_ERRORS) {
        const result = selectMessageFailure({ info: assistantInfo(name) });
        expect(result?.canRetry).toBe(false);
      }
    });

    it('sets canRetry true for an assistant error outside the non-retryable set', () => {
      const result = selectMessageFailure({ info: assistantInfo('APIError') });
      expect(result?.canRetry).toBe(true);
    });

    it('never sets canCopy true for an assistant row', () => {
      const result = selectMessageFailure({ info: assistantInfo('APIError') });
      expect(result?.canCopy).toBe(false);
    });
  });
});

/**
 * The failed row's label is the one place the footer copy and a failure title
 * meet, and the titles end their own sentence in most catalogs. Every language
 * is checked here because the doubled stop was a per-catalog property: `de`
 * shipped "fehlgeschlagen.. Du kannst es erneut versuchen." while `en` was
 * right, so a spot check in one language could not see it.
 */
describe('messageFailureLabel', () => {
  const TERMINATORS = '.!?؟…।॥。｡．！？።។။։';
  const TERMINATOR = new RegExp(`[${TERMINATORS}]`);
  // Any two sentence ends in a row, from the same script or not: a terminator
  // this set omits still lands next to the template's own.
  const ADJACENT_TERMINATORS = new RegExp(`[${TERMINATORS}]{2}`);
  const PLACEHOLDER = '{{title}}';

  function catalogString(catalog: unknown, path: string): string {
    let value: unknown = catalog;
    for (const key of path.split('.')) {
      if (value === null || typeof value !== 'object') {
        value = undefined;
        break;
      }
      value = (value as Record<string, unknown>)[key];
    }
    if (typeof value !== 'string') {
      throw new TypeError(`no catalog string at ${path}`);
    }
    return value;
  }

  it('states the failure once, in one terminator, in every catalog', async () => {
    try {
      for (const language of SUPPORTED_LANGUAGES) {
        // The active language is one piece of global i18next state, so each
        // catalog has to be measured before the next one is selected.
        // eslint-disable-next-line no-await-in-loop
        await i18n.changeLanguage(language);
        const catalog: unknown = CATALOG_LOADERS[language]();
        for (const titleKey of [
          'agentChat.messageFailure.deliveryTitle',
          'agentChat.messageFailure.assistantTitle',
        ]) {
          for (const canRetry of [true, false]) {
            const where = `${language} ${titleKey} canRetry=${canRetry}`;
            const label = messageFailureLabel({ titleKey, canRetry });
            expect(label, where).not.toMatch(ADJACENT_TERMINATORS);

            const template = catalogString(
              catalog,
              canRetry
                ? 'agentChat.messageBubble.failureRetryAvailable'
                : 'agentChat.messageBubble.failure'
            );
            const title = i18n.t(titleKey);
            const placeholder = template.indexOf(PLACEHOLDER);
            const head = template.slice(0, placeholder);
            const tail = template.slice(placeholder + PLACEHOLDER.length);
            // The label is the template's own text around the title, nothing
            // else, so the retry line is neither lost nor duplicated.
            expect(label.startsWith(head), where).toBe(true);
            expect(label.endsWith(tail), where).toBe(true);

            const middle = label.slice(head.length, label.length - tail.length);
            const templateEndsTheSentence = TERMINATOR.test(tail.slice(0, 1));
            // A template that supplies the sentence end replaces the title's
            // own; a bare `{{title}}` template leaves the title untouched.
            expect(middle, where).toBe(
              templateEndsTheSentence ? title.replace(/[.!?؟…।॥。｡．！？።។။։]+$/, '') : title
            );
          }
        }
      }
    } finally {
      await i18n.changeLanguage('en');
    }
  });

  it('keeps the German delivery failure to one full stop', async () => {
    await i18n.changeLanguage('de');
    try {
      expect(
        messageFailureLabel({
          titleKey: 'agentChat.messageFailure.deliveryTitle',
          canRetry: true,
        })
      ).toBe('Die Zustellung ist fehlgeschlagen. Du kannst es erneut versuchen.');
      expect(
        messageFailureLabel({
          titleKey: 'agentChat.messageFailure.assistantTitle',
          canRetry: false,
        })
      ).toBe('Die Antwort konnte nicht erstellt werden.');
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});

describe('composeFailureLabel', () => {
  it('leaves one terminator when the title ends its sentence and the template adds one', () => {
    expect(composeFailureLabel('Die Zustellung ist fehlgeschlagen.', '{{title}}. Weiter.')).toBe(
      'Die Zustellung ist fehlgeschlagen. Weiter.'
    );
  });

  it('adds the template terminator to a title that has none', () => {
    expect(composeFailureLabel('Failed to deliver', '{{title}}. Retry available.')).toBe(
      'Failed to deliver. Retry available.'
    );
  });

  it('keeps a title whose sentence end is not in Latin script', () => {
    expect(composeFailureLabel('ส่งไม่สำเร็จ。', '{{title}}')).toBe('ส่งไม่สำเร็จ。');
    expect(composeFailureLabel('送信に失敗しました。', '{{title}}。再試行できます。')).toBe(
      '送信に失敗しました。再試行できます。'
    );
  });

  it('drops a terminator the template itself replaces, whatever script it is in', () => {
    expect(composeFailureLabel('Falha！', '{{title}}。 Tente de novo.')).toBe(
      'Falha。 Tente de novo.'
    );
  });

  it('keeps the template text before the title', () => {
    expect(composeFailureLabel('تعذّر تسليم الرسالة.', 'خطأ: {{title}}.')).toBe(
      'خطأ: تعذّر تسليم الرسالة.'
    );
  });
});
