import { describe, expect, it } from 'vitest';

import {
  buildKiloCommandCreatePayload,
  buildKiloCommandUpdatePayload,
  initialKiloCommandFormState,
  type KiloCommandFormState,
  kiloCommandOrderAfterMove,
  kiloCommandRows,
  type KiloCommandSource,
  validateKiloCommandForm,
} from '@/components/profiles/profile-kilo-commands-model';

function source(overrides: Partial<KiloCommandSource> = {}): KiloCommandSource {
  return {
    id: 'cmd-1',
    name: 'explain',
    description: 'Explains code',
    template: 'Explain $ARGUMENTS',
    agent: 'code',
    model: null,
    subtask: true,
    enabled: true,
    sortOrder: 0,
    ...overrides,
  };
}

describe('kiloCommandRows', () => {
  it('projects the row fields and normalizes nulls to empty strings', () => {
    expect(
      kiloCommandRows([source(), source({ id: 'cmd-2', agent: null, description: null })])
    ).toEqual([
      {
        id: 'cmd-1',
        name: 'explain',
        description: 'Explains code',
        template: 'Explain $ARGUMENTS',
        subtask: true,
        agent: 'code',
        model: '',
        enabled: true,
      },
      {
        id: 'cmd-2',
        name: 'explain',
        description: '',
        template: 'Explain $ARGUMENTS',
        subtask: true,
        agent: '',
        model: '',
        enabled: true,
      },
    ]);
  });
});

describe('kiloCommandOrderAfterMove', () => {
  const commands = [source({ id: 'a' }), source({ id: 'b' }), source({ id: 'c' })];

  it('moves an item down and up', () => {
    expect(kiloCommandOrderAfterMove(commands, 0, 1)).toEqual(['b', 'a', 'c']);
    expect(kiloCommandOrderAfterMove(commands, 2, -1)).toEqual(['a', 'c', 'b']);
  });

  it('clamps at the edges', () => {
    expect(kiloCommandOrderAfterMove(commands, 0, -1)).toEqual(['a', 'b', 'c']);
    expect(kiloCommandOrderAfterMove(commands, 2, 1)).toEqual(['a', 'b', 'c']);
  });

  it('ignores an out-of-range index', () => {
    expect(kiloCommandOrderAfterMove(commands, 9, 1)).toEqual(['a', 'b', 'c']);
  });
});

describe('initialKiloCommandFormState', () => {
  it('seeds blank defaults for an add', () => {
    expect(initialKiloCommandFormState()).toEqual({
      name: '',
      description: '',
      template: '',
      agent: '',
      model: '',
      subtask: false,
    });
  });

  it('seeds a command with its nullable fields normalized', () => {
    expect(initialKiloCommandFormState(source())).toEqual({
      name: 'explain',
      description: 'Explains code',
      template: 'Explain $ARGUMENTS',
      agent: 'code',
      model: '',
      subtask: true,
    });
  });
});

function formState(overrides: Partial<KiloCommandFormState> = {}): KiloCommandFormState {
  return {
    name: 'explain',
    description: '',
    template: 'Explain $ARGUMENTS',
    agent: '',
    model: '',
    subtask: false,
    ...overrides,
  };
}

describe('validateKiloCommandForm', () => {
  it('requires a name and a template', () => {
    expect(validateKiloCommandForm(formState({ name: '  ' }))).toBe('name-required');
    expect(validateKiloCommandForm(formState({ template: '  ' }))).toBe('template-required');
  });

  it('refuses a name outside the server pattern', () => {
    expect(validateKiloCommandForm(formState({ name: 'Bad Name' }))).toBe('name-invalid');
    expect(validateKiloCommandForm(formState({ name: '1cmd' }))).toBe('name-invalid');
  });

  it('refuses a name reserved by a built-in command', () => {
    expect(validateKiloCommandForm(formState({ name: 'review' }))).toBe('name-conflict');
  });

  it('accepts a valid command', () => {
    expect(validateKiloCommandForm(formState())).toBeNull();
  });
});

describe('buildKiloCommandCreatePayload', () => {
  it('omits empty optional fields', () => {
    expect(buildKiloCommandCreatePayload(formState())).toEqual({
      name: 'explain',
      template: 'Explain $ARGUMENTS',
      subtask: false,
    });
  });

  it('trims and includes the optionals when set', () => {
    expect(
      buildKiloCommandCreatePayload(
        formState({ description: ' Explains ', agent: 'code', model: 'x', subtask: true })
      )
    ).toEqual({
      name: 'explain',
      description: 'Explains',
      template: 'Explain $ARGUMENTS',
      agent: 'code',
      model: 'x',
      subtask: true,
    });
  });
});

describe('buildKiloCommandUpdatePayload', () => {
  it('sends null for emptied optional fields', () => {
    expect(buildKiloCommandUpdatePayload(formState())).toEqual({
      name: 'explain',
      description: null,
      template: 'Explain $ARGUMENTS',
      agent: null,
      model: null,
      subtask: false,
    });
  });

  it('keeps set optional fields', () => {
    expect(
      buildKiloCommandUpdatePayload(formState({ description: 'Explains', agent: 'code' }))
    ).toEqual({
      name: 'explain',
      description: 'Explains',
      template: 'Explain $ARGUMENTS',
      agent: 'code',
      model: null,
      subtask: false,
    });
  });
});
