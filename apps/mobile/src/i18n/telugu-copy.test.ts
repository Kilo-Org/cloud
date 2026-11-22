import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

/**
 * Telugu wording corrections.
 *
 * Each entry below disagreed with its English source. The tool-card labels
 * named the tool with a polite imperative addressed to the reader, so the
 * transcript row read as a command instead of naming the tool that ran; the
 * question label also dropped the "you" it addresses. "Start agent" ran into
 * the inability clause as a bare imperative, leaving that clause without a
 * subject. The trigger switch's name was a finite clause, so a switch that is
 * off still read as active. The Code Reviewer feature was named with a person
 * agent noun and a masculine passive, so a disabled feature read as a
 * suspended reviewer. The analytics empty state rendered "while it is enabled"
 * as "at the beginning", its disabled state named a role roster the canonical
 * sentence leaves unspecified, and the uncounted line was a slash ratio with
 * an added organization qualifier. The council label line named the council's
 * starting moment rather than the repository's enabled state, and its minimum
 * line pinned one passive plural verb on a live count. The testing
 * specialist's description collapsed "missing" coverage into "low" coverage.
 * "Custom instructions" split into two terms on one screen, "access" had two
 * terms inside one namespace object, and the review-ended row dropped the
 * review noun.
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
    expect(i18n.t('agentChat.toolCard.toolSkill')).toBe('నైపుణ్యం లోడ్ అవుతోంది');
    expect(i18n.t('agentChat.toolCard.toolQuestion')).toBe('మిమ్మల్ని ప్రశ్నలు అడుగుతోంది');
    expect(i18n.t('agentChat.toolCard.toolSuggest')).toBe('సూచనలు');
    expect(i18n.t('agentChat.toolCard.toolRecall')).toBe('జ్ఞాపకాల స్మరణ');
    expect(i18n.t('agentChat.toolCard.toolRepoClone')).toBe('రిపోజిటరీ క్లోనింగ్');
  });

  it('keeps the patch label different from the edit label', () => {
    expect(i18n.t('agentChat.toolCard.toolPatch')).not.toBe(i18n.t('agentChat.toolCard.toolEdit'));
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
