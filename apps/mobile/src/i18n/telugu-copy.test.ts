import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

/**
 * Telugu wording corrections. Every value below replaced a sentence that
 * read as a finished event where the app shows progress, addressed the
 * reader with an imperative where the row is a label, or used a noun form
 * the surrounding sentence cannot govern.
 *
 * The preparation rows are the bulk of the change: a transitive verb with
 * no stated object became a process the prepared thing is undergoing, the
 * retry step lost its trailing verb, and the devcontainer step corrected
 * its `డె` spelling. The provider failure lines now agree with their neuter
 * subject, the branch notices spell the repository loanword with a long
 * `ో`, and the repository search and question-card placeholders prompt the
 * reader instead of naming their field. This branch changes catalog values
 * only: no key, placeholder, or plural category moves.
 */

beforeAll(async () => {
  await i18n.changeLanguage('te');
});

afterAll(async () => {
  await i18n.changeLanguage('en');
});

describe('Telugu folder picker and accessibility descriptors', () => {
  it('states what the CLI cannot show', () => {
    expect(i18n.t('agentChat.folderPicker.unsupportedDescription')).toBe(
      'ఈ CLI ఫోల్డర్‌ల జాబితాను చూపలేకపోతుంది. ‘పూర్తయింది’ నొక్కితే ప్రారంభ ఫోల్డర్ అలాగే ఉంటుంది. ‘సెషన్ ప్రారంభించండి’ నొక్కితే సెషన్ అక్కడే మొదలవుతుంది.'
    );
  });

  it('labels the run target before its value', () => {
    expect(i18n.t('agentChat.instancePicker.runOnAccessibility', { label: 'Kilo Cloud' })).toBe(
      'అమలు చేసే చోటు: Kilo Cloud'
    );
  });
});

describe('Telugu image trust copy', () => {
  it('names the admitted scheme in the nominative', () => {
    expect(i18n.t('agentChat.markdownImage.httpsOnly')).toBe('HTTPS చిత్రాలు మాత్రమే');
  });

  it('composes the host placeholder with its suffix', () => {
    expect(i18n.t('agentChat.markdownImage.trustMessage', { host: 'example.com' })).toBe(
      'example.comను విశ్వసిస్తే, దాని చిత్రాలు ప్రతిసారీ అడగకుండా లోడ్ అవుతాయి. తర్వాత విశ్వసించిన హోస్ట్‌లలో దీన్ని ఉపసంహరించవచ్చు.'
    );
  });
});

describe('Telugu provider failure lines', () => {
  it('agrees the rejected line with the provider noun', () => {
    expect(i18n.t('agentChat.messageFailure.assistantProviderRejected')).toBe(
      'ప్రొవైడర్ అభ్యర్థనను తిరస్కరించింది.'
    );
  });

  it('agrees the refused line with the provider noun', () => {
    expect(i18n.t('agentChat.messageFailure.assistantProviderRefused')).toBe(
      'ప్రొవైడర్ ఈ అభ్యర్థనను తిరస్కరించింది; దీన్ని మళ్లీ ప్రయత్నించలేము.'
    );
  });
});

describe('Telugu plan mode description', () => {
  it('keeps the plan term of the label', () => {
    expect(i18n.t('agentChat.modeOptions.planDescription')).toBe('పరిష్కారాలను ప్లాన్ చేసి రూపకల్పన చేయండి');
  });
});

describe('Telugu new-session branch and profile copy', () => {
  it('spells the repository loanword and keeps both recovery steps', () => {
    expect(i18n.t('agentChat.newSession.branchUnavailable')).toBe(
      'ఈ రిపోజిటరీ కోసం బ్రాంచ్‌లు అందుబాటులో లేవు. ప్రొవైడర్ వద్ద మీ యాక్సెస్‌ను తనిఖీ చేసి, వేరే రిపోజిటరీని ఎంచుకోండి.'
    );
  });

  it('states that the listed branches are a subset', () => {
    expect(i18n.t('agentChat.newSession.branchListIncomplete')).toBe(
      'కొన్ని బ్రాంచ్‌లు మాత్రమే చూపబడుతున్నాయి. ఈ జాబితాలో చేర్చగలిగిన దానికి మించి రిపోజిటరీలో మరిన్ని బ్రాంచ్‌లు ఉన్నాయి.'
    );
  });

  it('states the resolution of the profile name', () => {
    expect(i18n.t('agentChat.newSession.defaultProfileResolvesTo', { name: 'Work' })).toBe(
      'Workకి రిజాల్వ్ అవుతుంది'
    );
  });

  it('pluralizes the profile heading', () => {
    expect(i18n.t('agentChat.newSession.organizationProfiles')).toBe('సంస్థ ప్రొఫైల్‌లు');
  });
});

describe('Telugu updated-file count', () => {
  it('selects the one-file value for a single file', () => {
    expect(i18n.t('agentChat.partRenderer.updatedFileCount', { count: 1, displayCount: '1' })).toBe(
      '1 ఫైల్‌ను నవీకరించారు.'
    );
  });

  it('selects the other value for several files', () => {
    expect(i18n.t('agentChat.partRenderer.updatedFileCount', { count: 3, displayCount: '3' })).toBe(
      '3 ఫైళ్లను నవీకరించారు.'
    );
  });
});

describe('Telugu permission subjects', () => {
  it('names the escalated host access', () => {
    expect(i18n.t('agentChat.permissionCard.subjectSandboxEscalation')).toBe('హోస్ట్ యాక్సెస్');
  });

  it('names the external directory access', () => {
    expect(i18n.t('agentChat.permissionCard.subjectExternalDirectory')).toBe('బాహ్య డైరెక్టరీకి యాక్సెస్');
  });

  it('names the agent management permission', () => {
    expect(i18n.t('agentChat.permissionCard.subjectAgentManager')).toBe('ఏజెంట్ నిర్వహణ');
  });
});

describe('Telugu question card', () => {
  it('names input as what the agent needs', () => {
    expect(i18n.t('agentChat.questionCard.title')).toBe('ఏజెంట్‌కు ఇన్‌పుట్ అవసరం');
  });

  it('prompts the reader to type their own answer', () => {
    expect(i18n.t('agentChat.questionCard.typeYourOwnAnswerPlaceholder')).toBe(
      'మీ స్వంత సమాధానాన్ని టైప్ చేయండి…'
    );
  });
});

describe('Telugu restart and session history copy', () => {
  it('says the previous session is still open', () => {
    expect(i18n.t('agentChat.remoteSession.restartExitFailed')).toBe(
      'కొత్త సెషన్ ప్రారంభమైంది. మునుపటి సెషన్ ఇంకా తెరిచి ఉంది.'
    );
  });

  it('names a transcript that is too large to load', () => {
    expect(i18n.t('agentChat.session.historyTooLarge')).toBe('ఈ సెషన్ ట్రాన్స్క్రిప్ట్ లోడ్ చేయడానికి చాలా పెద్దది.');
  });

  it('names a transcript that could not be read', () => {
    expect(i18n.t('agentChat.session.historyUnavailable')).toBe('ఈ సెషన్ ట్రాన్స్క్రిప్ట్‌ను చదవలేకపోయింది.');
  });
});

describe('Telugu repository search placeholder', () => {
  it('prompts a repository search', () => {
    expect(i18n.t('agentChat.repoPicker.searchPlaceholder')).toBe('రిపోజిటరీలను శోధించండి…');
  });
});

describe('Telugu discard review and goal copy', () => {
  it('names the reader as the loser of the comments', () => {
    expect(i18n.t('agentChat.sessionChanges.discardReviewMessage')).toBe('మీరు మీ వ్యాఖ్యలను కోల్పోతారు.');
  });

  it('keeps the waiting behaviour of goal mode', () => {
    expect(i18n.t('agentChat.slashCommands.goalDescription')).toBe(
      'సెషన్ లక్ష్యం వైపు పని కొనసాగించండి. /goal <objective> లేదా pause, resume, clear. ఒక లక్ష్యం షెడ్యూల్ చేసిన వేకప్, క్రాన్ పని లేదా బ్యాక్‌గ్రౌండ్ ప్రాసెస్ కోసం వేచి ఉండవచ్చు: ఆ వేచి ఉండటం లక్ష్యాన్ని అది జరిగే వరకు నిలిపివేస్తుంది, ఆ తర్వాత లక్ష్యం తనంతట తానే తిరిగి కొనసాగుతుంది; /goal pause మరియు /goal clear దాని షెడ్యూల్ చేసిన టైమర్‌లను రద్దు చేస్తాయి. లక్ష్యం డిప్లాయ్, బిల్డ్ లేదా CI పని కోసం వేచి ఉండటం అయితే, ఆ వేచి ఉండటాన్ని వెంటనే షెడ్యూల్ చేయండి; మొదట రిపోజిటరీని అన్వేషించవద్దు.'
    );
  });
});

describe('Telugu tool card labels', () => {
  it('reads as reading the plan', () => {
    expect(i18n.t('agentChat.toolCard.readTodos')).toBe('ప్లాన్ చదవడం');
  });

  it('reads as browser access', () => {
    expect(i18n.t('agentChat.toolCard.toolBrowser')).toBe('బ్రౌజర్ యాక్సెస్');
  });

  it('reads as board access', () => {
    expect(i18n.t('agentChat.toolCard.toolBoard')).toBe('బోర్డు యాక్సెస్');
  });

  it('reads as an action in progress', () => {
    expect(i18n.t('agentChat.toolCard.toolCodeSearch')).toBe('కోడ్‌ను వెతుకుతోంది');
  });
});

describe('Telugu preparation progress rows', () => {
  it('reports the sandbox being created', () => {
    expect(i18n.t('agentChat.preparation.detailCreatingSandbox')).toBe('సాండ్‌బాక్స్ సృష్టించబడుతోంది');
  });

  it('reports the sandbox starting', () => {
    expect(i18n.t('agentChat.preparation.detailStartingSandbox')).toBe('సాండ్‌బాక్స్ ప్రారంభమవుతోంది');
  });

  it('reports the repository being cloned', () => {
    expect(i18n.t('agentChat.preparation.detailCloningRepository')).toBe('రిపోజిటరీ క్లోన్ అవుతోంది');
  });

  it('reports the repository being updated', () => {
    expect(i18n.t('agentChat.preparation.detailUpdatingRepository')).toBe('రిపోజిటరీ అప్‌డేట్ అవుతోంది');
  });

  it('reports the branch being checked out', () => {
    expect(i18n.t('agentChat.preparation.detailCheckingOutBranch')).toBe('బ్రాంచ్ చెక్ అవుట్ అవుతోంది');
  });

  it('reports the branch being set up', () => {
    expect(i18n.t('agentChat.preparation.detailSettingUpBranch')).toBe('బ్రాంచ్ సెటప్ అవుతోంది');
  });

  it('reports the repository being saved', () => {
    expect(i18n.t('agentChat.preparation.detailSavingRepository')).toBe(
      'వేగవంతమైన ప్రారంభం కోసం రిపోజిటరీ సేవ్ అవుతోంది'
    );
  });

  it('reports Kilo starting', () => {
    expect(i18n.t('agentChat.preparation.detailStartingKilo')).toBe('Kilo ప్రారంభమవుతోంది');
  });

  it('reports the Kilo runtime starting', () => {
    expect(i18n.t('agentChat.preparation.detailStartingKiloRuntime')).toBe('Kilo రన్‌టైమ్ ప్రారంభమవుతోంది');
  });

  it('reports the Kilo session being prepared', () => {
    expect(i18n.t('agentChat.preparation.detailPreparingKiloSession')).toBe('Kilo సెషన్ సిద్ధమవుతోంది');
  });

  it('reports the sandbox creation being retried', () => {
    expect(i18n.t('agentChat.preparation.detailRetryingSandboxCreation')).toBe(
      'సాండ్‌బాక్స్ సృష్టిని మళ్లీ ప్రయత్నిస్తోంది'
    );
  });

  it('reports the sandbox starting without a snapshot', () => {
    expect(i18n.t('agentChat.preparation.detailStartingSandboxWithoutSnapshot')).toBe(
      'స్నాప్‌షాట్ లేకుండా సాండ్‌బాక్స్ ప్రారంభమవుతోంది'
    );
  });

  it('reports the workspace being set up', () => {
    expect(i18n.t('agentChat.preparation.detailSettingUpWorkspace')).toBe('వర్క్‌స్పేస్ సెటప్ అవుతోంది');
  });

  it('reports the session being restored', () => {
    expect(i18n.t('agentChat.preparation.detailRestoringSession')).toBe('సెషన్ రిస్టోర్ అవుతోంది');
  });

  it('carries both attempt counts', () => {
    expect(i18n.t('agentChat.preparation.detailRetryingClone', { attempt: '2', total: '3' })).toBe(
      'క్లోన్‌ను మళ్లీ ప్రయత్నిస్తోంది (మొత్తం 3 ప్రయత్నాలలో 2)'
    );
  });

  it('reports preparation still in progress', () => {
    expect(i18n.t('agentChat.preparation.detailUnknown')).toBe('ఇంకా సిద్ధమవుతోంది');
  });

  it('binds the restore counts and ends the sentence', () => {
    expect(
      i18n.t('agentChat.preparation.detailRestoreIncompleteFiles', {
        skipped: '2',
        total: '5',
        reasons: 'అందుబాటులో లేదు',
      })
    ).toBe('రిస్టోర్ కాని ఫైళ్లు: 2 / 5 (అందుబాటులో లేదు).');
  });
});

describe('Telugu preparation fallbacks and failure', () => {
  it('names the retry without a snapshot', () => {
    expect(i18n.t('agentChat.preparation.stepSnapshotFallback')).toBe('స్నాప్‌షాట్ లేకుండా మళ్లీ ప్రయత్నం');
  });

  it('names the devcontainer step', () => {
    expect(i18n.t('agentChat.preparation.stepDevcontainerSetup')).toBe('డెవ్ కంటైనర్ సెటప్');
  });

  it('names the process that failed', () => {
    expect(i18n.t('agentChat.preparation.preparationFailed')).toBe('సిద్ధం చేయడం విఫలమైంది');
  });

  it('states the agent becoming unavailable', () => {
    expect(i18n.t('agentChat.preparation.errorAgentUnavailable')).toBe('ఏజెంట్ అందుబాటులో లేకుండా పోయింది');
  });
});

// This work item's own corrections: tool-card labels, Start agent, the trigger switch,
// Code Reviewer as a feature, analytics, council and the one-term-per-concept pairs.
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
    // noun or gerund phrase rather than a finite clause.
    for (const key of ['agentChat.toolCard.toolSkill', 'agentChat.toolCard.toolQuestion']) {
      const sentence = i18n.t('agentChat.permissionCard.allowQuestion', {
        permission: i18n.t(key),
      });
      expect(sentence).toBe(`${i18n.t(key)} అనుమతించాలా?`);
    }
    expect(i18n.t('agentChat.toolCard.toolSkill')).toBe('నైపుణ్యం లోడ్ చేయడం');
    expect(i18n.t('agentChat.toolCard.toolQuestion')).toBe('మీకు ప్రశ్నలు అడగడం');
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
