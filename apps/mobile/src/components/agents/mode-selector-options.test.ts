import { describe, expect, it } from 'vitest';

import {
  type AgentMode,
  dedupeCustomModeOptions,
  ensureSelectedCustomOption,
  type ModeOption,
} from '@/components/agents/mode-normalize';

// Local copy of the built-in rows in their pre-i18n shape (label/description
// strings; `MODE_OPTIONS` in `mode-options.ts` now holds catalog keys). Kept
// local so this suite never imports `mode-options`, which pulls in the Lucide /
// React Native tree and cannot load under the plain Node vitest environment.
const BUILTIN_OPTIONS: ModeOption[] = [
  { value: 'code', label: 'Code', description: 'Write and modify code' },
  { value: 'plan', label: 'Plan', description: 'Plan and design solutions' },
  { value: 'debug', label: 'Debug', description: 'Find and fix issues' },
  { value: 'orchestrator', label: 'Orchestrator', description: 'Coordinate complex tasks' },
  { value: 'ask', label: 'Ask', description: 'Get answers and explanations' },
];

// Mirrors the exact composition `ModeSelector` performs to resolve the rows
// and the selected label.
function resolveOptions(customOptions: ModeOption[], selected: AgentMode): ModeOption[] {
  const allOptions = [...BUILTIN_OPTIONS, ...dedupeCustomModeOptions(customOptions)];
  return ensureSelectedCustomOption(allOptions, selected);
}

function resolveLabel(customOptions: ModeOption[], selected: AgentMode): string {
  const selectedOption = resolveOptions(customOptions, selected).find(m => m.value === selected);
  return selectedOption?.label ?? selected;
}

describe('mode selector option resolution', () => {
  it('lists custom rows after built-ins', () => {
    const custom: ModeOption[] = [
      { value: 'reviewer', label: 'Reviewer', description: 'Review the change' },
    ];
    const options = resolveOptions(custom, 'code');
    expect(options.map(o => o.value)).toEqual([
      'code',
      'plan',
      'debug',
      'orchestrator',
      'ask',
      'reviewer',
    ]);
  });

  it('drops a custom option that collides with a built-in', () => {
    const custom: ModeOption[] = [
      { value: 'code', label: 'My Code', description: '' },
      { value: 'reviewer', label: 'Reviewer', description: '' },
    ];
    const options = resolveOptions(custom, 'code');
    expect(options.filter(o => o.value === 'code')).toHaveLength(1);
    expect(options.map(o => o.value)).toEqual([
      'code',
      'plan',
      'debug',
      'orchestrator',
      'ask',
      'reviewer',
    ]);
  });

  it('returns built-ins only for an empty custom list', () => {
    expect(resolveOptions([], 'code').map(o => o.value)).toEqual([
      'code',
      'plan',
      'debug',
      'orchestrator',
      'ask',
    ]);
  });

  it('appends the selected unknown slug once', () => {
    const options = resolveOptions([], 'reviewer');
    expect(options.map(o => o.value)).toEqual([
      'code',
      'plan',
      'debug',
      'orchestrator',
      'ask',
      'reviewer',
    ]);
  });

  it('labels a selected unknown slug with the raw slug, not "Code"', () => {
    expect(resolveLabel([], 'reviewer')).toBe('reviewer');
  });

  it('labels a selected built-in with its label', () => {
    expect(resolveLabel([], 'code')).toBe('Code');
  });
});
