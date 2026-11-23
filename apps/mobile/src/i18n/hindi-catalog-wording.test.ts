import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

/**
 * Pins the corrected Hindi wording: the GitHub surface is spelled as the app
 * spells every other GitHub string, the short status labels are fragments
 * rather than sentences, the sessions placeholder says what to do instead of
 * naming a search, the schema help agrees with the feminine बॉडी, the
 * scheduled prompt names the trigger, and the empty deliveries list describes
 * a run that was scheduled. The change is catalog values only: no key,
 * placeholder, or plural category moves.
 */

beforeAll(async () => {
  await i18n.changeLanguage('hi');
});

afterAll(async () => {
  await i18n.changeLanguage('en');
});

type Case = { key: string; value: string };

const CASES: Case[] = [
  {
    key: 'agents.githubInstall.installationUnavailableMessage',
    value:
      'यह GitHub ऐप इंस्टॉलेशन सस्पेंड है या अब उपलब्ध नहीं है। इसे GitHub में रीस्टोर करें या फिर से इंस्टॉल करें, फिर दोबारा शुरू करें।',
  },
  { key: 'agents.search.searchSessionsPlaceholder', value: 'सत्र खोजें…' },
  { key: 'authErrors.codeExpired', value: 'कोड समाप्त' },
  { key: 'chat.attachment.networkError', value: 'नेटवर्क त्रुटि' },
  { key: 'common.accessDenied', value: 'पहुँच अस्वीकृत' },
  {
    key: 'authErrors.codeInProgress',
    value: 'आपका कोड संसाधित किया जा रहा है। थोड़ा इंतज़ार करें और फिर से कोशिश करें।',
  },
  {
    key: 'authErrors.retryableAdmission',
    value: 'इस डिवाइस की पुष्टि नहीं हो सकी। कृपया फिर से कोशिश करें।',
  },
  { key: 'chat.attachmentPreview.accessibility', value: '{{filename}}, {{status}}' },
  {
    key: 'cloudAgent.triggers.bodySchemaHelp',
    value: 'वैकल्पिक JSON Schema। जिस अनुरोध की बॉडी इससे मेल नहीं खाती, वह अस्वीकार हो जाता है।',
  },
  {
    key: 'cloudAgent.triggers.defaultPromptScheduled',
    value: 'निर्धारित कार्य चलाएँ। यह {{scheduledTime}} पर ट्रिगर हुआ।',
  },
  {
    key: 'cloudAgent.triggers.defaultPromptWebhook',
    value: 'इस वेबहुक अनुरोध की पेलोड का वर्णन करें:\n\n{{body}}',
  },
  {
    key: 'cloudAgent.triggers.deliveriesEmptyDescription',
    value: 'वेबहुक कॉल या शेड्यूल किया गया रन आने के बाद यहाँ दिखाई देता है।',
  },
];

describe('Hindi catalog wording', () => {
  it.each(CASES)('reads $value at $key', ({ key, value }) => {
    expect(i18n.t(key)).toBe(value);
  });
});
