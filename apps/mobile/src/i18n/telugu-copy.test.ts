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

describe('Telugu share, spend-alert and voice copy', () => {
  it('names the share sheet as unavailable rather than as a finished share', () => {
    expect(i18n.t('share.staleTitle')).toBe('పంచుకోవడం అందుబాటులో లేదు');
  });

  it('keeps both host kinds in the trusted-host empty state', () => {
    expect(i18n.t('trustedHosts.emptyDescription')).toBe(
      'లింక్ హోస్ట్‌ను లేదా చిత్ర హోస్ట్‌ను విశ్వసిస్తే, అది మళ్లీ అనుమతి అడగకుండా తెరుచుకుంటుంది.'
    );
  });

  it('scopes the missing voice input to the selected language', () => {
    expect(i18n.t('voiceInput.unavailableLanguage')).toBe(
      'ఈ పరికరంలో ఎంచుకున్న భాషకు వాయిస్ ఇన్‌పుట్ అందుబాటులో లేదు. దాని ఆఫ్‌లైన్ స్పీచ్ ఫైల్‌లను ఇన్‌స్టాల్ చేయండి లేదా యాప్‌లో మరొక భాషను ఉపయోగించండి.'
    );
  });

  it('asks for a gateway sign-in before transcription', () => {
    expect(i18n.t('voiceInput.gatewaySignInRequired')).toBe(
      'Kilo Gateway వచనంగా మార్చే సదుపాయాన్ని ఉపయోగించడానికి సైన్ ఇన్ చేయండి.'
    );
  });

  it('describes the spend threshold and the hourly spike in one sentence', () => {
    expect(i18n.t('spendAlerts.subtitle')).toBe(
      'ఈ పరిధి స్వంత ఖర్చు ఒక పరిమితిని దాటినప్పుడు లేదా దాని సాధారణ గంటవారీ రేటు కంటే హఠాత్తుగా పెరిగినప్పుడు బిల్లింగ్ పరిచయాలకు ఇమెయిల్ లేదా పుష్ ద్వారా హెచ్చరిక పంపండి.'
    );
  });

  it('names the hourly spike as a heading rather than a finished event', () => {
    expect(i18n.t('spendAlerts.anomalyTitle')).toBe('గంటవారీ హఠాత్తు పెరుగుదల');
  });
});

describe('Telugu session share durations and expiry sentence', () => {
  it('keeps each duration a standalone label', () => {
    expect(i18n.t('sessionShare.duration1d')).toBe('1 రోజు');
    expect(i18n.t('sessionShare.duration7d')).toBe('7 రోజులు');
    expect(i18n.t('sessionShare.duration30d')).toBe('30 రోజులు');
  });

  it('keeps the duration a bare label inside the expiry line', () => {
    const duration = i18n.t('sessionShare.duration7d');
    expect(i18n.t('sessionShare.expiresIn', { duration })).toBe(`గడువు: ${duration}`);
  });
});

describe('Telugu link revoke copy', () => {
  it('keeps the button, title and failure line on one revoke verb', () => {
    expect(i18n.t('sessionShare.revoke')).toBe('లింక్‌ను ఉపసంహరించండి');
    expect(i18n.t('sessionShare.revokeTitle')).toBe('లింక్‌ను ఉపసంహరించాలా?');
    expect(i18n.t('sessionShare.revokeFailed')).toBe('లింక్‌ను ఉపసంహరించలేకపోయాము.');
  });
});

describe('Telugu to-do counts', () => {
  it('keeps the singular wording for one open item', () => {
    expect(i18n.t('todos.lists.openCount', { count: 1 })).toBe('1 తెరిచి ఉన్నది');
  });

  it('uses the plural wording for an empty list, which CLDR routes into the other category', () => {
    expect(i18n.t('todos.lists.openCount', { count: 0 })).toBe('0 తెరిచి ఉన్నవి');
  });

  it('uses the plural wording above one', () => {
    expect(i18n.t('todos.lists.openCount', { count: 2 })).toBe('2 తెరిచి ఉన్నవి');
  });

  it('keeps the run count singular for one run and plural for two', () => {
    expect(i18n.t('todos.item.runCount', { count: 1 })).toBe('1 అమలు');
    expect(i18n.t('todos.item.runCount', { count: 2 })).toBe('2 అమలులు');
  });
});

describe('Telugu organization, offline and invite copy', () => {
  it('leaves the offline banner label and the organization boundary titles unpunctuated', () => {
    expect(i18n.t('offline.noInternet')).toBe('ఇంటర్నెట్ కనెక్షన్ లేదు');
    expect(i18n.t('organization.boundary.loadErrorTitle')).toBe('మీ సంస్థలను లోడ్ చేయలేకపోయాము');
    expect(i18n.t('organization.boundary.organizationUnavailable')).toBe('సంస్థ అందుబాటులో లేదు');
  });

  it('names the organization-defined credit category without an added noun', () => {
    expect(i18n.t('organization.creditActivity.category.organization_custom')).toBe('సంస్థ కస్టమ్');
  });

  it('keeps the invite email error unpunctuated like its canonical entry', () => {
    expect(i18n.t('organization.inviteMember.emailError')).toBe(
      'చెల్లుబాటు అయ్యే ఇమెయిల్ చిరునామాను నమోదు చేయండి'
    );
  });

  it('describes the low-balance alert the setting emails without addressing the reader', () => {
    expect(i18n.t('organization.lowBalanceAlert.subtitle')).toBe(
      'ఈ సంస్థ బ్యాలెన్స్ మీరు సెట్ చేసిన మొత్తం కంటే తగ్గినప్పుడు, మీరు జాబితా చేసిన చిరునామాలకు ఇమెయిల్ ద్వారా హెచ్చరిక పంపబడుతుంది.'
    );
    expect(i18n.t('organization.lowBalanceAlert.thresholdError')).toBe(
      '0 కంటే ఎక్కువ మొత్తాన్ని నమోదు చేయండి'
    );
  });

  it('keeps the daily-limit messages unpunctuated and the placeholder intact', () => {
    expect(i18n.t('organization.memberLimit.memberNotFound')).toBe('సభ్యుడు కనిపించలేదు');
    expect(i18n.t('organization.memberLimit.blankError')).toBe(
      'మొత్తాన్ని నమోదు చేయండి లేదా కింద ఉన్న ‘పరిమితిని తీసివేయండి’ నొక్కండి'
    );
    expect(i18n.t('organization.memberLimit.blankWithoutLimitError', { max: '2,000' })).toBe(
      '0 నుండి 2,000 మధ్య రోజువారీ పరిమితిని నమోదు చేయండి'
    );
    expect(i18n.t('organization.memberLimit.rangeError', { max: '2,000' })).toBe(
      '0 నుండి 2,000 మధ్య మొత్తాన్ని నమోదు చేయండి'
    );
  });
});
