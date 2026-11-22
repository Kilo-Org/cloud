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
 * The two lists are the ones the row shows apart: a model that runs no tool
 * loop runs none of the offered tools, and a model that runs the loop names
 * exactly what the schema converter leaves out — the tools it never sees, and
 * the optional arguments of the tools that still reach it. The settings tools
 * are the real case: their `value` argument is a type list, so `settings_set`
 * never reaches a native model.
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

/** A tool that still reaches the model, with one optional argument it does not. */
const lookupTool = (name = 'lookup'): ToolDefinition => ({
  name,
  description: 'Looks something up',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      filter: { anyOf: [{ type: 'string' }, { type: 'number' }] },
    },
    required: ['query'],
  },
});

describe('tool use of an on-device model', () => {
  it('answers nothing before the availability check', () => {
    expect(toolUseOf(undefined, settings())).toEqual({ kind: 'unknown' });
  });

  it('names every enabled tool while the model runs no tool loop', () => {
    expect(toolUseOf({ ...available(true), tools: undefined }, settings())).toEqual({
      kind: 'some',
      tools: ['settings_list', 'settings_set'],
      arguments: [],
    });
  });

  it('names every enabled tool even while the model cannot run at all', () => {
    expect(
      toolUseOf({ ...available(false), status: 'unavailable', reason: 'model_not_ready' }, [
        timeTool().definition,
      ])
    ).toEqual({ kind: 'some', tools: ['time'], arguments: [] });
  });

  it('names a name once when two offered tools share it', () => {
    expect(
      toolUseOf({ ...available(true), tools: undefined }, [
        timeTool().definition,
        timeTool().definition,
      ])
    ).toEqual({ kind: 'some', tools: ['time'], arguments: [] });
  });

  it('names only the tool the converter leaves out', () => {
    expect(toolUseOf(available(true), [...settings(), timeTool().definition])).toEqual({
      kind: 'some',
      tools: ['settings_set'],
      arguments: [],
    });
  });

  it('names a dropped optional argument by its tool and argument, not as a dead tool', () => {
    expect(toolUseOf(available(true), [lookupTool()])).toEqual({
      kind: 'some',
      tools: [],
      arguments: [{ tool: 'lookup', argument: 'filter' }],
    });
  });

  it('keeps a dropped tool and a dropped argument in their own lists', () => {
    expect(toolUseOf(available(true), [...settings(), lookupTool()])).toEqual({
      kind: 'some',
      tools: ['settings_set'],
      arguments: [{ tool: 'lookup', argument: 'filter' }],
    });
  });

  it('names one argument path once when two tools drop it', () => {
    expect(toolUseOf(available(true), [lookupTool('lookup'), lookupTool('other_lookup')])).toEqual({
      kind: 'some',
      tools: [],
      arguments: [
        { tool: 'lookup', argument: 'filter' },
        { tool: 'other_lookup', argument: 'filter' },
      ],
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
