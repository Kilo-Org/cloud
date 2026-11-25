import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

/**
 * Telugu wording corrections for the tool card, the Start agent refusal, the
 * trigger switch, the Code Reviewer feature name, analytics, council and the
 * one-term-per-concept pairs.
 *
 * Each value below replaced one of four disagreements with its English source:
 * a tool-card row that addressed the reader with an imperative instead of
 * naming the tool that ran, an inability sentence whose subject was a bare
 * imperative, a switch name that was a finite clause and so asserted a state
 * even when the switch was off, and a feature named with a person agent noun
 * and a masculine passive. The Code Reviewer descriptions now name the product
 * with neuter agreement, the analytics empty state says "enabled" rather than
 * "at the beginning", the uncounted line states a count out of the finished
 * total, the council label line states the repository enabled state and its
 * minimum line fits any count, and "custom instructions" and "access" each use
 * one term on the screens that show them.
 *
 * The skill and question labels take the verbal-noun form because
 * `permission-tool-label.ts` interpolates the same values into the permission
 * card sentence. The spoken loading cost keeps the English entry's 'so far'
 * qualifier, because the context pill announces it while the session is still
 * resolving. This branch changes catalog values only: no key, placeholder,
 * or plural category moves.
 */

beforeAll(async () => {
  await i18n.changeLanguage('te');
});

afterAll(async () => {
  await i18n.changeLanguage('en');
});

describe('Telugu tool-card labels name the tool', () => {
  it('names each tool instead of instructing the reader', () => {
    expect(i18n.t('agentChat.toolCard.toolGlob')).toBe('ఫైల్ శోధన');
    expect(i18n.t('agentChat.toolCard.toolGrep')).toBe('వచన శోధన');
    expect(i18n.t('agentChat.toolCard.toolList')).toBe('జాబితా');
    expect(i18n.t('agentChat.toolCard.toolPatch')).toBe('ప్యాచ్');
    expect(i18n.t('agentChat.toolCard.toolWebFetch')).toBe('వెబ్ పేజీ పొందడం');
    expect(i18n.t('agentChat.toolCard.toolWebSearch')).toBe('ఆన్‌లైన్ శోధన');
    expect(i18n.t('agentChat.toolCard.toolSkill')).toBe('నైపుణ్యం లోడ్ చేయడం');
    expect(i18n.t('agentChat.toolCard.toolQuestion')).toBe('మీకు ప్రశ్నలు అడగడం');
    expect(i18n.t('agentChat.toolCard.toolSuggest')).toBe('సూచనలు');
    expect(i18n.t('agentChat.toolCard.toolRecall')).toBe('జ్ఞాపకాల స్మరణ');
    expect(i18n.t('agentChat.toolCard.toolRepoClone')).toBe('రిపోజిటరీ క్లోనింగ్');
  });

  it('keeps the patch label different from the edit label', () => {
    expect(i18n.t('agentChat.toolCard.toolPatch')).not.toBe(i18n.t('agentChat.toolCard.toolEdit'));
  });

  it('fits the permission sentence that interpolates the same labels', () => {
    // permission-tool-label.ts maps the skill and question ids onto these keys,
    // and the card reads "{{permission}} అనుమతించాలా?", so each value must be a
    // noun or gerund phrase rather than a finite clause. The assembled
    // sentences are pinned literally, so a label that stops being a noun or
    // gerund phrase fails here even though the template still interpolates.
    expect(
      i18n.t('agentChat.permissionCard.allowQuestion', {
        permission: i18n.t('agentChat.toolCard.toolSkill'),
      })
    ).toBe('నైపుణ్యం లోడ్ చేయడం అనుమతించాలా?');
    expect(
      i18n.t('agentChat.permissionCard.allowQuestion', {
        permission: i18n.t('agentChat.toolCard.toolQuestion'),
      })
    ).toBe('మీకు ప్రశ్నలు అడగడం అనుమతించాలా?');
  });
});

describe('Telugu declarative and label copy', () => {
  it('makes Start agent the subject that cannot use the repository', () => {
    expect(i18n.t('appActions.start.repositoryUnsupported', { repository: 'acme/widgets' })).toBe(
      'acme/widgets ఒక Bitbucket రిపోజిటరీ — ఏజెంట్ ప్రారంభించడం ఇంకా దాన్ని ఉపయోగించలేకపోతుంది. Kiloలో మరో రిపోజిటరీని ఎంచుకోండి.'
    );
  });

  it('names the trigger setting without asserting a state', () => {
    expect(i18n.t('cloudAgent.triggers.activeTitle')).toBe('ట్రిగ్గర్ యాక్టివ్');
  });

  it('names the review that ended', () => {
    expect(i18n.t('codeReviewer.reviewDetail.reviewEnded')).toBe('సమీక్ష ముగిసింది');
  });
});

describe('Telugu Code Reviewer feature copy', () => {
  it('states that the feature needs attention', () => {
    expect(i18n.t('codeReviewer.actionRequired.title')).toBe('Code Reviewerకి శ్రద్ధ అవసరం');
  });

  it('reports the feature being disabled, not a person being suspended', () => {
    const descriptions = [
      i18n.t('codeReviewer.actionRequired.githubInstallationRequired.description'),
      i18n.t('codeReviewer.actionRequired.githubIpAllowList.description', {
        supportEmail: 'support@example.com',
      }),
      i18n.t('codeReviewer.actionRequired.gitlabProjectAccessRequired.description'),
      i18n.t('codeReviewer.actionRequired.byokInvalidKey.description'),
      i18n.t('codeReviewer.actionRequired.selectedModelUnavailable.description'),
      i18n.t('codeReviewer.actionRequired.repeatedRepositoryCloneTimeout.description', {
        supportEmail: 'support@example.com',
      }),
    ];
    for (const description of descriptions) {
      expect(description).toContain('Code Reviewer నిలిపివేయబడింది');
      expect(description).not.toContain('కోడ్ సమీక్షకుడు');
      expect(description).toContain('Code Reviewerను మళ్లీ ప్రారంభించండి');
    }
  });

  it('names the feature one way across the banner card and its screens', () => {
    expect(i18n.t('common.codeReviewer')).toBe('Code Reviewer');
    expect(i18n.t('codeReviewer.actionRequired.selectedModelUnavailable.recoveryLabel')).toBe(
      'Code Reviewer సెట్టింగ్‌లను అప్‌డేట్ చేయండి'
    );
    const card = [
      i18n.t('codeReviewer.actionRequired.title'),
      i18n.t('codeReviewer.actionRequired.selectedModelUnavailable.description'),
      i18n.t('codeReviewer.actionRequired.selectedModelUnavailable.recoveryLabel'),
    ];
    for (const value of card) {
      expect(value).not.toContain('కోడ్ సమీక్షకుడు');
      expect(value).not.toContain('కోడ్ సమీక్షకుడి');
      expect(value).not.toContain('కోడ్ సమీక్షకుడిని');
    }
  });

  it('names the feature that is off before retrying a review', () => {
    expect(i18n.t('codeReviewer.reviewDetail.retryNeedsSettings')).toBe(
      'Code Reviewer ఆఫ్‌లో ఉంది లేదా దాని సెట్టింగ్‌లకు శ్రద్ధ అవసరం. సెట్టింగ్‌లను సరిచేసి, ఆపై ఈ సమీక్షను మళ్లీ ప్రయత్నించండి.'
    );
  });
});

describe('Telugu analytics copy', () => {
  it('says analytics records reviews while it is enabled', () => {
    expect(i18n.t('codeReviewer.analytics.emptyDescription')).toBe(
      'సంస్థ కోసం ఇది ప్రారంభించబడి ఉన్నప్పుడు విశ్లేషణలు పూర్తయిన సమీక్షలను రికార్డ్ చేస్తాయి.'
    );
  });

  it('leaves the billing roles unspecified', () => {
    expect(i18n.t('codeReviewer.analytics.offDescription')).toBe(
      'సంస్థ బిల్లింగ్ పాత్రలు పూర్తయిన సమీక్షలను రికార్డ్ చేయడానికి వెబ్‌లోని సెట్టింగ్‌లలో విశ్లేషణలను ఆన్ చేయగలరు.'
    );
  });

  it('expresses the uncounted reviews as a part of the finished total', () => {
    const values = { count: 3, displayCount: '3', total: 9, displayTotal: '9' };
    expect(i18n.t('codeReviewer.analytics.trackedReviewsUncounted', values)).toBe(
      'లెక్కించబడలేదు: 9 పూర్తయిన సమీక్షలలో 3 సమీక్షలకు ఫలితం క్యాప్చర్ చేయబడలేదు.'
    );
  });

  it('inflects the counted noun for a single review', () => {
    expect(
      i18n.t('codeReviewer.analytics.trackedReviewsUncounted', {
        count: 1,
        displayCount: '1',
        total: 9,
        displayTotal: '9',
      })
    ).toBe('లెక్కించబడలేదు: 9 పూర్తయిన సమీక్షలలో 1 సమీక్షకు ఫలితం క్యాప్చర్ చేయబడలేదు.');
  });
});

describe('Telugu council copy', () => {
  it('names the repository whose council is enabled', () => {
    expect(i18n.t('codeReviewer.council.labelsDescription')).toContain('మండలి ప్రారంభించబడిన రిపోజిటరీ');
    expect(i18n.t('codeReviewer.council.labelsDescription')).not.toContain('మండలి ప్రారంభంలో ఉన్న');
  });

  it('puts the selected count in a frame that fits any count', () => {
    expect(i18n.t('codeReviewer.council.minSpecialists', { minimum: '2', selected: '1' })).toBe(
      'కనీసం 2 నిపుణులను ఎంచుకోండి. ఎంచుకున్న నిపుణులు: 1'
    );
  });

  it('keeps missing coverage distinct from weak coverage', () => {
    expect(i18n.t('codeReviewer.council.specialist.testing')).toBe(
      'కొత్త ప్రవర్తనకు పరీక్ష కవరేజ్ లేకపోవడం లేదా బలహీనంగా ఉండటం.'
    );
  });
});

describe('Telugu one term per concept', () => {
  it('uses one term for custom instructions across the screen', () => {
    expect(i18n.t('codeReviewer.instructions.deprecation')).toContain('ప్రత్యేక సూచనలు');
    expect(i18n.t('codeReviewer.instructions.title')).toBe('ప్రత్యేక సూచనలు');
  });

  it('uses the access loan in both repository access strings', () => {
    expect(i18n.t('codeReviewer.repos.manageAccess')).toContain('యాక్సెస్');
    expect(i18n.t('codeReviewer.repos.repositoryAccess')).toContain('యాక్సెస్');
  });
});

describe('Telugu spoken loading cost', () => {
  it('marks the figure as accumulated so far, like the canonical entry', () => {
    expect(i18n.t('agentChat.contextUsage.loadingCostSpoken', { cost: '$0.04' })).toBe(
      'ఇంతవరకు ఖర్చు $0.04.'
    );
  });
});
