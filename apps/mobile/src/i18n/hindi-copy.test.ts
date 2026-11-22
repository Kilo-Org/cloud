import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { describePrBadge } from '@/components/agents/session-pr-badge-model';
import { i18n } from '@/i18n';
import { formatList } from '@/lib/format';

/**
 * Hindi wording corrections. Each entry below disagreed with its English
 * source: a replacement narrowed to another device, a singular noun paired
 * with a plural auxiliary, a fallback in the direct case inside an oblique
 * `द्वारा` slot, a plural adjective in the one category, an empty state that
 * named only link hosts, "offline" read as a property of the produced text,
 * and a voice-input notice that stopped before its remediation sentence.
 *
 * The agent-chat surfaces named the wrong thing too: the "Code" and "Debug"
 * mode titles restated their own descriptions as imperatives, the open
 * pull-request badge read as a command and asked the reader to open it, the
 * permission subjects carried a direct infinitive that "की अनुमति दें?"
 * cannot govern, and the generic failure line said no reply arrived instead
 * of that the response failed. The attachment warning repeated its plural
 * noun in the one-file form, the "Your Profiles" heading named a single
 * profile where the screen lists several, the "Used" row was a
 * finished-event clause rather than a label, and the spoken loading cost
 * dropped the qualifier that marks it as still growing.
 *
 * The changelog sentence joins the areas a release touched with
 * `Intl.ListFormat`, so the profile area label has to join its own two nouns
 * without the list conjunction.
 */

beforeAll(async () => {
  await i18n.changeLanguage('hi');
});

afterAll(async () => {
  await i18n.changeLanguage('en');
});

describe('Hindi share copy', () => {
  it('leaves the replacement place-neutral', () => {
    expect(i18n.t('sessionShare.superseded')).toBe(
      'यह लिंक कहीं और से बदल दिया गया है, इसलिए यह अब काम नहीं करता।'
    );
  });

  it('agrees the one-file notice with its singular noun', () => {
    const one = i18n.t('share.onlyFirstFilesAttached', { count: 1, displayCount: '1' });
    const many = i18n.t('share.onlyFirstFilesAttached', { count: 3, displayCount: '3' });
    expect(one).toBe('केवल पहली 1 फ़ाइल संलग्न की जाएगी।');
    expect(many).toBe('केवल पहली 3 फ़ाइलें संलग्न की जाएँगी।');
  });
});

describe('Hindi shared-session copy', () => {
  it('composes the shared-by line in the oblique case when the owner is unknown', () => {
    expect(i18n.t('sharedSession.sharedBy', { owner: i18n.t('sharedSession.someone') })).toBe(
      'किसी व्यक्ति द्वारा शेयर किया गया'
    );
  });
});

describe('Hindi mode labels', () => {
  it('names each mode with a noun and leaves the action to its description', () => {
    expect(i18n.t('agentChat.modeOptions.code')).toBe('कोड');
    expect(i18n.t('agentChat.modeOptions.debug')).toBe('डीबग');
    expect(i18n.t('agentChat.modeOptions.ask')).toBe('प्रश्न');
    expect(i18n.t('agentChat.modeOptions.codeDescription')).toBe('कोड लिखें और बदलें');
    expect(i18n.t('agentChat.modeOptions.debugDescription')).toBe('समस्याएँ खोजें और ठीक करें');
  });
});

describe('Hindi permission card', () => {
  it('composes each subject with the allow question', () => {
    const question = (permission: string) =>
      i18n.t('agentChat.permissionCard.allowQuestion', { permission });
    expect(question(i18n.t('agentChat.permissionCard.subjectExternalDirectory'))).toBe(
      'प्रोजेक्ट के बाहर की निर्देशिका तक पहुँच की अनुमति दें?'
    );
    expect(question(i18n.t('agentChat.permissionCard.subjectSandboxEscalation'))).toBe(
      'होस्ट एक्सेस की अनुमति दें?'
    );
    expect(question(i18n.t('agentChat.permissionCard.subjectDoomLoop'))).toBe(
      'एक ही टूल कॉल का दोहराव की अनुमति दें?'
    );
    expect(question(i18n.t('agentChat.permissionCard.subjectAgentManager'))).toBe(
      'सबएजेंट प्रबंधन की अनुमति दें?'
    );
  });
});

describe('Hindi pull-request badge', () => {
  it('names the pull request state instead of asking the reader to open it', () => {
    expect(
      describePrBadge({
        state: 'open',
        number: 42,
        reviewDecision: null,
        reviewDecisionPending: false,
      }).accessibilityLabel
    ).toBe('खुली पुल रिक्वेस्ट संख्या 42');
  });
});

describe('Hindi context usage', () => {
  it('labels the used count and keeps the running cost qualified', () => {
    expect(i18n.t('agentChat.contextUsage.used')).toBe('उपयोग किया गया');
    expect(i18n.t('agentChat.contextUsage.loadingCostSpoken', { cost: '$0.04' })).toBe(
      'अब तक की लागत $0.04।'
    );
  });
});

describe('Hindi attachment capacity warning', () => {
  it('inflects the admitted count', () => {
    const warning = (count: number) =>
      i18n.t('agentChat.attachmentPicker.onlyAddingFiles', {
        count,
        accepted: String(count),
        total: '5',
        max: '3',
      });
    expect(warning(1)).toBe('5 में से केवल 1 फ़ाइल जोड़ी जा रही है (अधिकतम 3)');
    expect(warning(2)).toBe('5 में से केवल 2 फ़ाइलें जोड़ी जा रही हैं (अधिकतम 3)');
  });
});

describe('Hindi profile and session headings', () => {
  it('keeps the plural heading and the reached nesting depth', () => {
    expect(i18n.t('agentChat.newSession.yourProfiles')).toBe('आपकी प्रोफ़ाइलें');
    expect(i18n.t('agentChat.childSession.maxNestingDepth')).toBe(
      'अधिकतम नेस्टिंग गहराई पूरी हो गई है।'
    );
  });
});

describe('Hindi failed response', () => {
  it('states that the response failed', () => {
    expect(i18n.t('agentChat.messageFailure.assistantTitle')).toBe('उत्तर विफल रहा।');
    expect(i18n.t('agentChat.messageFailure.assistantFailed')).toBe('उत्तर विफल रहा।');
  });
});

describe('Hindi restore report', () => {
  it('agrees with the masculine loanword', () => {
    expect(i18n.t('agentChat.preparation.detailReasonMissingContent')).toBe(
      'स्नैपशॉट में फ़ाइल का कोई कंटेंट नहीं था'
    );
  });
});

describe('Hindi changelog sentence', () => {
  it('names three areas with one list conjunction', () => {
    // The two areas the app never translates keep their product names; the
    // third renders from the catalog, which is the value under test.
    const areas = [
      'Cloud Agent',
      'Security Agent',
      i18n.t('profile.changelogAreas.profileOrganizations'),
    ];
    expect(i18n.t('profile.changelogFixesIn', { areas: formatList(areas, 'hi') })).toBe(
      'Cloud Agent, Security Agent, और प्रोफ़ाइल व संगठन में त्रुटि-सुधार और बेहतरी।'
    );
  });

  it('states the empty-area fallback without a scope claim', () => {
    expect(i18n.t('profile.changelogFixesPolish')).toBe('त्रुटि-सुधार और बेहतरी।');
  });
});

describe('Hindi to-do copy', () => {
  it('inflects the open count to the singular in the one category', () => {
    expect(i18n.t('todos.lists.openCount', { count: 1 })).toBe('1 खुला');
    expect(i18n.t('todos.lists.openCount', { count: 3 })).toBe('3 खुले');
  });

  it('keeps the plural wording for an empty list, which CLDR routes into the one category', () => {
    expect(i18n.t('todos.lists.openCount', { count: 0 })).toBe('0 खुले');
  });
});

describe('Hindi trusted-host and voice copy', () => {
  it('names both host kinds in the empty state', () => {
    expect(i18n.t('trustedHosts.emptyDescription')).toBe(
      'जब आप किसी लिंक के होस्ट या किसी छवि होस्ट पर भरोसा करते हैं, तो वह बिना दोबारा पूछे खुल जाता है।'
    );
  });

  it('states offline as the condition on transcription', () => {
    expect(i18n.t('voiceInput.onlineMessage', { provider: 'Google' })).toBe(
      'यह डिवाइस ऑफ़लाइन आवाज़ को टेक्स्ट में नहीं बदल सकता। आपकी रिकॉर्डिंग टेक्स्ट में बदलने के लिए Google को भेजी जाती है। Kilo ऑडियो सहेजकर नहीं रखता।'
    );
  });

  it('keeps both recovery paths in the unavailable-language notice', () => {
    expect(i18n.t('voiceInput.unavailableLanguage')).toBe(
      'इस डिवाइस की भाषा के लिए वॉइस इनपुट उपलब्ध नहीं है। इसकी ऑफ़लाइन स्पीच फ़ाइलें इंस्टॉल करें या ऐप की कोई दूसरी भाषा इस्तेमाल करें।'
    );
  });
});

describe('Hindi instruction file-name rule', () => {
  it('names the Latin letters a rules file name may use', () => {
    // The rule is shown before Save, so it must say which alphabet the name
    // takes rather than only naming "small letters", which Devanagari also has.
    expect(i18n.t('profiles.instructionNameInvalid')).toBe(
      'अक्षर या अंक से शुरू करें और केवल छोटे ASCII अक्षर, अंक और डैश रखें'
    );
  });
});
