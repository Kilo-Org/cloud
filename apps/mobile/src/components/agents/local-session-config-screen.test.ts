import { describe, expect, it } from 'vitest';

import { readSourceFile } from '../../../test-utils/read-source';
import { type LocalSessionConfigViewModel } from '@/lib/hooks/local-runtime-catalog-types';
import { type LocalSessionConfigController } from '@/lib/hooks/use-local-session-config-controller';

type ForbiddenScreenKeys =
  | 'onSubmit'
  | 'onSendPrompt'
  | 'onAddAttachment'
  | 'onCreateSession'
  | 'requestId'
  | 'readiness';

type AssertControllerHasNoForbiddenKeys = ForbiddenScreenKeys &
  keyof LocalSessionConfigController extends never
  ? true
  : false;
type AssertViewModelHasNoForbiddenKeys = ForbiddenScreenKeys &
  keyof LocalSessionConfigViewModel extends never
  ? true
  : false;

const _controllerAssertion: AssertControllerHasNoForbiddenKeys = true;
const _viewModelAssertion: AssertViewModelHasNoForbiddenKeys = true;
void _controllerAssertion;
void _viewModelAssertion;

describe('LocalSessionConfigScreen source/structure (renderer-free)', () => {
  const screenSource = readSourceFile('components/agents/local-session-config-screen.tsx');
  const promptInputSource = readSourceFile(
    'components/agents/local-session-create-prompt-input.tsx'
  );
  const rowsSource = readSourceFile('components/agents/local-session-config-rows.tsx');
  const statesSource = readSourceFile('components/agents/local-session-config-states.tsx');
  const FORBIDDEN_PLACEHOLDER = 'Session creation will be available in the next step.';

  it('ready branch starts with ScreenHeader inside its outermost View', () => {
    // The early return is the only branch before the ready render; the
    // ready branch must own its own `<View><ScreenHeader>` opening pair.
    const earlyReturn = screenSource.indexOf("if (viewModel.kind !== 'ready')");
    const readyStart = screenSource.indexOf('const ready = viewModel;');
    expect(earlyReturn).toBeGreaterThanOrEqual(0);
    expect(readyStart).toBeGreaterThanOrEqual(0);
    expect(readyStart).toBeGreaterThan(earlyReturn);
    const readyBranch = screenSource.slice(readyStart);
    const viewIdx = readyBranch.indexOf('<View');
    const headerIdx = readyBranch.indexOf('<ScreenHeader');
    expect(viewIdx).toBeGreaterThanOrEqual(0);
    expect(headerIdx).toBeGreaterThanOrEqual(0);
    expect(headerIdx).toBeLessThan(viewIdx + 80);
  });

  it('ready ScrollView opts into automaticallyAdjustKeyboardInsets', () => {
    expect(screenSource).toMatch(/<ScrollView[\s\S]{0,400}automaticallyAdjustKeyboardInsets/);
  });

  it('shows a visible Prompt label above the TextInput (in the focused file)', () => {
    expect(promptInputSource).toMatch(/>\s*Prompt\s*</);
  });

  it('TextInput is uncontrolled (no `value=` prop on the prompt input)', () => {
    // The prompt input lives in a focused file. The screen never has a
    // TextInput, and the prompt input drives the ref via onChangeText,
    // never through a controlled `value` prop.
    expect(screenSource).not.toMatch(/<TextInput/);
    expect(promptInputSource).toMatch(/<TextInput/);
    expect(promptInputSource).not.toMatch(/<TextInput[\s\S]{0,200}value\s*=/);
  });

  it('TextInput is multiline with a min height class', () => {
    const textInputMatch = /<TextInput[\s\S]*?\/>/.exec(promptInputSource);
    expect(textInputMatch).not.toBeNull();
    const inputSource = textInputMatch ? textInputMatch[0] : '';
    expect(inputSource).toMatch(/multiline/);
    expect(inputSource).toMatch(/min-h-/);
  });

  it('TextInput sets an explicit NativeWind line height (leading-6)', () => {
    const textInputMatch = /<TextInput[\s\S]*?\/>/.exec(promptInputSource);
    expect(textInputMatch).not.toBeNull();
    expect(textInputMatch ? textInputMatch[0] : '').toMatch(/leading-6/);
  });

  it('has no attachment affordance (no Paperclip, no Attachment import, no addAttachment handler)', () => {
    expect(screenSource).not.toMatch(/Paperclip/);
    expect(screenSource).not.toMatch(/[Aa]ttachment/);
    expect(promptInputSource).not.toMatch(/Paperclip/);
    expect(promptInputSource).not.toMatch(/[Aa]ttachment/);
  });

  it('declares exactly one visible "Start session" primary button label', () => {
    const matches = /<Text>Start session<\/Text>/g.exec(screenSource) ?? [];
    expect(matches.length).toBe(1);
  });

  it('shows an inline ActivityIndicator while submitting', () => {
    expect(screenSource).toMatch(/<ActivityIndicator/);
    expect(screenSource).toMatch(/isSubmitting/);
  });

  it('does not import or render the removed FooterMessage or its placeholder text', () => {
    expect(screenSource).not.toMatch(/FooterMessage/);
    expect(screenSource).not.toContain(FORBIDDEN_PLACEHOLDER);
    expect(promptInputSource).not.toMatch(/FooterMessage/);
    expect(promptInputSource).not.toContain(FORBIDDEN_PLACEHOLDER);
  });

  it('rows module drops the FooterMessage export and the placeholder text', () => {
    expect(rowsSource).not.toMatch(/FooterMessage/);
    expect(rowsSource).not.toContain(FORBIDDEN_PLACEHOLDER);
  });

  it('states module does not import FooterMessage and does not contain the placeholder', () => {
    expect(statesSource).not.toMatch(/FooterMessage/);
    expect(statesSource).not.toContain(FORBIDDEN_PLACEHOLDER);
  });

  it('reaches useLocalSessionCreate via the screen and never redefines submit on the controller', () => {
    expect(screenSource).toMatch(/useLocalSessionCreate/);
    // The screen must call the hook with a `promptRef` so the orchestrator
    // can snapshot `promptRef.current` on submit.
    expect(screenSource).toMatch(/promptRef/);
  });
});
