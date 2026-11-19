/* eslint-disable no-literal-copy/no-literal-copy -- Development-only fixture; its reason codes and heading never ship. */
import { ScrollView, View } from 'react-native';

import { ChatFailureRow } from '@/components/chat/chat-failure-row';
import { GGUF_FAILURE_KEYS } from '@/components/chat/gguf-model-section';
import { ScreenHeader } from '@/components/screen-header';
import { Text } from '@/components/ui/text';
import { type GgufDownloadProblem } from '@/lib/chat/gguf-records';

import { backendFailureKey } from './backend-target';
import { LocalModelError, type LocalModelProblem } from './local-model-error';
import { nativeModelFailure } from './native-model-error';

/**
 * The states that hold a case, in the order `all` lists them. `all` comes last
 * because it is the state that paints the rest.
 */
const CASE_STATES = [
  'unavailable',
  'busy',
  'failed',
  'background',
  'download-required',
  'downloading',
  'preparing',
  'update-required',
  'settings-off',
  'ineligible',
  'quota-exhausted',
  'check-failed',
  'gguf',
] as const;

const STATES = [...CASE_STATES, 'all'] as const;

type CaseState = (typeof CASE_STATES)[number];

export type LocalFailureCopyState = (typeof STATES)[number];

export function isLocalFailureCopyState(value: string | undefined): value is LocalFailureCopyState {
  return value !== undefined && STATES.some(state => state === value);
}

/**
 * One native refusal the chat row can show, and the class its code picks. The
 * code is the stable string a native module reports; `undefined` is a refusal
 * that names none, which the app shows as the generic failure.
 */
type FailureCase = {
  readonly code: string | undefined;
  readonly problem: LocalModelProblem;
};

/**
 * The refusal each state stands for. `unavailable` and `update-required` hold
 * two cases each because both of their codes are stable and both are emitted:
 * the OS refusal and the Android AICore one.
 */
const CASES = {
  unavailable: [
    { code: 'unsupported_os', problem: 'unavailable' },
    { code: 'model_unavailable', problem: 'unavailable' },
  ],
  busy: [{ code: 'busy', problem: 'busy' }],
  failed: [{ code: undefined, problem: 'failed' }],
  background: [{ code: 'background_use_blocked', problem: 'background' }],
  'download-required': [{ code: 'model_download_required', problem: 'downloadRequired' }],
  downloading: [{ code: 'model_downloading', problem: 'downloading' }],
  preparing: [{ code: 'model_not_ready', problem: 'preparing' }],
  'update-required': [
    { code: 'system_update_required', problem: 'updateRequired' },
    { code: 'aicore_incompatible', problem: 'updateRequired' },
  ],
  'settings-off': [{ code: 'apple_intelligence_disabled', problem: 'settingsOff' }],
  ineligible: [{ code: 'device_not_eligible', problem: 'ineligible' }],
  'quota-exhausted': [{ code: 'battery_quota_exceeded', problem: 'quotaExhausted' }],
  'check-failed': [{ code: 'check_failed', problem: 'checkFailed' }],
} satisfies Record<Exclude<CaseState, 'gguf'>, readonly FailureCase[]>;

/** The GGUF problems, as the codes the fixture rows show. */
const GGUF_PROBLEMS = [
  'space',
  'network',
  'invalidFile',
  'checksum',
] as const satisfies readonly GgufDownloadProblem[];

/** One row: the code a native module would report, and the key its row paints. */
type Row = {
  readonly code: string | undefined;
  readonly failureKey: string;
};

/**
 * The failure key a refusal reaches through the production path: the stable
 * code picks its problem class, the class builds the `LocalModelError` a real
 * refusal carries, and `backendFailureKey` reads that error's own key - the
 * place the chat screen asks for the copy. The declared class is checked here
 * so a table that no longer matches the classification breaks the fixture
 * instead of painting another reason's copy.
 */
function failureKeyOf(one: FailureCase): string {
  // Not started: a refusal is answered before the stream begins.
  const error = nativeModelFailure(one.code, false);
  const { cause } = error;
  if (!(cause instanceof LocalModelError) || cause.problem !== one.problem) {
    throw new Error(`The fixture's ${one.problem} case no longer resolves to that class`);
  }
  return backendFailureKey(error);
}

function rowsOf(state: LocalFailureCopyState): readonly Row[] {
  const wanted: readonly CaseState[] = state === 'all' ? CASE_STATES : [state];
  return wanted.flatMap(stateName =>
    stateName === 'gguf'
      ? GGUF_PROBLEMS.map(problem => ({ code: problem, failureKey: GGUF_FAILURE_KEYS[problem] }))
      : CASES[stateName].map(entry => ({ code: entry.code, failureKey: failureKeyOf(entry) }))
  );
}

/** One case: the code a native module reports, and the chat row the app shows for it. */
function CaseRow({ code, failureKey }: Readonly<{ code: string | undefined; failureKey: string }>) {
  return (
    <View testID={`failure-copy-case-${code ?? 'no-code'}`} className="gap-1">
      <Text variant="mono" className="px-4 text-xs text-muted-foreground">
        {code ?? 'undefined'}
      </Text>
      <ChatFailureRow failureKey={failureKey} />
    </View>
  );
}

/**
 * The screen behind `/(app)/local-failure-copy-fixture`, reachable only through
 * the dev fixture link in `src/app/+native-intent.tsx`.
 *
 * It renders the chat's own `ChatFailureRow` for every stable on-device refusal
 * code, through the production classification and the production copy, so a
 * design-gate cell measures what an idle chat shows after that refusal. The
 * state itself needs a device that refuses a request, which no link can
 * produce. It sends no requests.
 */
export function LocalFailureCopyFixture({ state }: Readonly<{ state: LocalFailureCopyState }>) {
  return (
    <View className="flex-1 bg-background" testID="failure-copy-fixture">
      <ScreenHeader title="On-device failure copy" />
      <ScrollView contentContainerClassName="gap-4 pb-8">
        <View testID={`failure-copy-${state}`} className="gap-3 pt-2">
          {rowsOf(state).map(row => (
            <CaseRow key={row.code ?? 'no-code'} code={row.code} failureKey={row.failureKey} />
          ))}
        </View>
      </ScrollView>
    </View>
  );
}
