import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { describePrBadge } from '@/components/agents/session-pr-badge-model';
import { i18n } from '@/i18n';
import { formatList } from '@/lib/format';

/**
 * The Hindi catalog named several agent-chat surfaces after the wrong thing:
 * the "Code" and "Debug" mode titles restated their own descriptions as
 * imperatives, the open pull-request badge read as a command and asked the
 * reader to open it, the permission subjects carried a direct infinitive that
 * "की अनुमति दें?" cannot govern, and the generic failure line said no reply
 * arrived instead of that the response failed. The attachment warning and the
 * "Your Profiles" heading stayed plural at a count of one, the "Used" row was
 * a finished-event clause rather than a label, and the spoken loading cost
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
    const areas = ['cloudAgent', 'securityAgent', 'profileOrganizations'].map(area =>
      area === 'profileOrganizations'
        ? i18n.t('profile.changelogAreas.profileOrganizations')
        : area === 'cloudAgent'
          ? 'Cloud Agent'
          : 'Security Agent'
    );
    expect(i18n.t('profile.changelogFixesIn', { areas: formatList(areas, 'hi') })).toBe(
      'Cloud Agent, Security Agent, और प्रोफ़ाइल व संगठन में त्रुटि-सुधार और बेहतरी।'
    );
  });

  it('states the empty-area fallback without a scope claim', () => {
    expect(i18n.t('profile.changelogFixesPolish')).toBe('त्रुटि-सुधार और बेहतरी।');
  });
});
