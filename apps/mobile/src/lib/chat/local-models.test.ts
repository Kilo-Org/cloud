import { type ToolDefinition } from '@kilocode/harness-sdk';
import { settingsTools, timeTool } from '@kilocode/harness-sdk/plugins/tools';
import { describe, expect, it, vi } from 'vitest';

import { type NativeAvailability } from './native-model-client';
import { toolUseOf } from './local-models';

// The status module reads the device's own modules at load time; this pure
// function needs none of them.
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo', () => ({ requireOptionalNativeModule: () => null }));
// The registry loads the GGUF provider, whose module scope reaches native code.
vi.mock('./gguf-models', () => ({ ggufModelProvider: undefined }));

/**
 * What the model can do with the enabled tools.
 *
 * The two facts are the ones the row shows: a model that runs no tool loop runs
 * none of the offered tools, and a model that runs the loop names exactly what
 * the schema converter leaves out. The settings tools are the real case: their
 * `value` argument is a type list, so `settings_set` never reaches a native model.
 */
const available = (tools: boolean): NativeAvailability => ({
  status: 'available',
  modelId: 'system',
  contextWindow: 4096,
  maxOutputTokens: 512,
  systemInstructions: true,
  tools,
});

const settings = (): readonly ToolDefinition[] =>
  settingsTools({
    settings: [],
    read: () => {
      throw new Error('not read in this test');
    },
    write: () => {
      throw new Error('not written in this test');
    },
  }).map(one => one.definition);

describe('tool use of an on-device model', () => {
  it('answers nothing before the availability check', () => {
    expect(toolUseOf(undefined, settings())).toEqual({ kind: 'unknown' });
  });

  it('names every enabled tool while the model runs no tool loop', () => {
    expect(toolUseOf({ ...available(true), tools: undefined }, settings())).toEqual({
      kind: 'some',
      unusable: ['settings_list', 'settings_set'],
    });
  });

  it('names every enabled tool even while the model cannot run at all', () => {
    expect(
      toolUseOf({ ...available(false), status: 'unavailable', reason: 'model_not_ready' }, [
        timeTool().definition,
      ])
    ).toEqual({ kind: 'some', unusable: ['time'] });
  });

  it('names only the tool the converter leaves out, and the argument it leaves out', () => {
    expect(toolUseOf(available(true), [...settings(), timeTool().definition])).toEqual({
      kind: 'some',
      unusable: ['settings_set'],
    });
  });

  it('names a dropped optional argument by its tool and argument', () => {
    const partial: ToolDefinition = {
      name: 'lookup',
      description: 'Looks something up',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          filter: { anyOf: [{ type: 'string' }, { type: 'number' }] },
        },
        required: ['query'],
      },
    };
    expect(toolUseOf(available(true), [partial])).toEqual({
      kind: 'some',
      unusable: ['lookup.filter'],
    });
  });

  it('says the model takes every offered tool when the converter leaves nothing out', () => {
    expect(toolUseOf(available(true), [timeTool().definition])).toEqual({ kind: 'none' });
  });

  it('says nothing when there are no enabled tools to name', () => {
    expect(toolUseOf(available(true), [])).toEqual({ kind: 'none' });
    expect(toolUseOf({ ...available(true), tools: undefined }, [])).toEqual({ kind: 'none' });
  });
});
