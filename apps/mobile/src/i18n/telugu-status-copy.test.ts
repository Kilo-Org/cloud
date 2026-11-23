import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

/**
 * Pins the status-fragment terminators, the agentless failure voice and the
 * nominal run-target label: a share, copy or preview failure is a fragment
 * shown beside a control and so carries no closing period, the environment
 * failures say that something could not happen instead of addressing a
 * compiler-like "we", and the run target names the Cloud Agent rather than
 * instructing the reader to run in it. This branch changes catalog values
 * only: no key, placeholder, or plural category moves.
 */

beforeAll(async () => {
  await i18n.changeLanguage('te');
});

afterAll(async () => {
  await i18n.changeLanguage('en');
});

type Case = { key: string; value: string };

const CASES: Case[] = [
  { key: 'agentChat.chatLink.couldNotCopyLink', value: 'లింక్‌ను కాపీ చేయలేకపోయాము' },
  { key: 'agentChat.chatLink.couldNotShareLink', value: 'లింక్‌ను పంచుకోలేకపోయాము' },
  { key: 'agentChat.filePart.shareFailed', value: 'పంచుకోలేకపోయాము' },
  { key: 'agentChat.filePart.previewUnavailable', value: 'ప్రివ్యూ అందుబాటులో లేదు' },
  {
    key: 'agentChat.folderPicker.tapToListHint',
    value: 'ఫోల్డర్‌లో ఏముందో చూడటానికి దాన్ని నొక్కండి',
  },
  {
    key: 'agentChat.attachmentPicker.maxFilesAllowed',
    value: 'గరిష్టంగా {{displayCount}} ఫైళ్లను జోడించవచ్చు',
  },
  {
    key: 'agentChat.attachmentPicker.maxFilesAllowed_one',
    value: 'గరిష్టంగా {{displayCount}} ఫైల్ జోడించవచ్చు',
  },
  {
    key: 'agentChat.attachmentPicker.maxFilesAllowed_other',
    value: 'గరిష్టంగా {{displayCount}} ఫైళ్లను జోడించవచ్చు',
  },
  {
    key: 'agentChat.environment.failureRuntime',
    value: 'ఎంచుకున్న రన్‌టైమ్ రిలీజ్‌ను ఇన్‌స్టాల్ చేయడం సాధ్యపడలేదు.',
  },
  {
    key: 'agentChat.environment.failureClone',
    value: 'రిపోజిటరీని క్లోన్ చేయడం సాధ్యపడలేదు.',
  },
  {
    key: 'agentChat.environment.failureCapture',
    value: 'స్నాప్‌షాట్‌ను క్యాప్చర్ చేయడం సాధ్యపడలేదు.',
  },
  {
    key: 'agentChat.environment.failureCleanup',
    value: 'క్రెడెన్షియల్స్‌ను తీసివేయడం సాధ్యపడలేదు, కాబట్టి స్నాప్‌షాట్ తీయలేదు.',
  },
  {
    key: 'agentChat.environment.selectEnvironmentToStart',
    value: 'ప్రారంభించడానికి ఒక వాతావరణాన్ని ఎంచుకోండి.',
  },
  { key: 'agentChat.instancePicker.runOnCloudAgent', value: 'Cloud Agentలో అమలు' },
  { key: 'agentChat.environment.loadingEnvironments', value: 'వాతావరణాలను లోడ్ చేస్తోంది' },
  { key: 'agentChat.environment.couldNotLoadEnvironments', value: 'వాతావరణాలను లోడ్ చేయలేకపోయాం' },
  {
    key: 'agentChat.environment.couldNotLoadEnvironmentsDetail',
    value: 'ఈ రిపోజిటరీ కోసం వాతావరణాలను లోడ్ చేయడానికి మళ్లీ ప్రయత్నించండి.',
  },
  { key: 'agentChat.environment.noEnvironment', value: 'వాతావరణం లేదు' },
  { key: 'agentChat.environment.chooseEnvironment', value: 'వాతావరణాన్ని ఎంచుకోండి' },
  {
    key: 'agentChat.environment.chooseEnvironmentDetail',
    value: 'ఈ రిపోజిటరీకి ఒకటి కంటే ఎక్కువ వాతావరణాలు ఉన్నాయి.',
  },
  {
    key: 'agentChat.environment.environmentAccessibility',
    value: 'వాతావరణాన్ని ఎంచుకోండి: {{label}}',
  },
  {
    key: 'agentChat.environment.environmentsForRepository',
    value: '{{repository}} కోసం వాతావరణాలు',
  },
  { key: 'agentChat.environment.buildSetup', value: 'వాతావరణ సెటప్‌ను అమలు చేస్తోంది' },
  {
    key: 'agentChat.environment.buildsUnavailable',
    value: 'ఈ వాతావరణానికి స్నాప్‌షాట్ బిల్డ్‌లు అందుబాటులో లేవు.',
  },
  { key: 'agentChat.newSession.environment', value: 'వాతావరణం' },
  {
    key: 'agentChat.newSession.couldNotLoadEnvironment',
    value: 'మీ వాతావరణాన్ని లోడ్ చేయలేకపోయాము.',
  },
  {
    key: 'agentChat.newSession.retryLoadingEnvironment',
    value: 'వాతావరణాన్ని లోడ్ చేయడానికి మళ్లీ ప్రయత్నించండి',
  },
  { key: 'agentChat.newSession.defaultEnvironment', value: 'డిఫాల్ట్ వాతావరణం' },
  {
    key: 'agentChat.preparation.preparingEnvironment',
    value: 'వాతావరణాన్ని సిద్ధం చేస్తోంది',
  },
  { key: 'agentChat.preparation.stepReady', value: 'వాతావరణం సిద్ధంగా ఉంది' },
  { key: 'agentChat.preparation.stepFailed', value: 'వాతావరణ సెటప్ విఫలమైంది' },
  { key: 'agentChat.preparation.stepUnknown', value: 'వాతావరణ సెటప్' },
  {
    key: 'agentChat.preparation.errorPreparationTimeout',
    value: 'వాతావరణ సిద్ధత సమయం ముగిసింది',
  },
  {
    key: 'agentChat.composer.preparingPlaceholder',
    value: 'వాతావరణాన్ని సిద్ధం చేస్తోంది…',
  },
];

describe('Telugu status and run-target copy', () => {
  it('renders every corrected value', () => {
    for (const c of CASES) {
      expect(i18n.t(c.key)).toBe(c.value);
    }
  });
});
