import { Validator, type Schema as JsonSchema } from '@cfworker/json-schema';
import { merge, type Schema } from '@/app/config.json/route';

const upstream: Schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  ref: 'Config',
  type: 'object',
  $defs: {
    PermissionConfig: {
      anyOf: [
        { $ref: '#/$defs/PermissionActionConfig' },
        {
          type: 'object',
          properties: {
            read: { $ref: '#/$defs/PermissionRuleConfig' },
          },
          additionalProperties: { $ref: '#/$defs/PermissionRuleConfig' },
        },
      ],
    },
  },
  properties: {
    agent: {
      type: 'object',
      properties: {
        build: { ref: 'AgentConfig', type: 'object', properties: {} },
        plan: { ref: 'AgentConfig', type: 'object', properties: {} },
      },
    },
    experimental: {
      type: 'object',
      properties: {
        batch_tool: { type: 'boolean' },
      },
    },
    model: {
      $ref: 'https://models.dev/model-schema.json#/$defs/Model',
      type: 'string',
    },
  },
};

const referencedUpstream: Schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $ref: '#/$defs/Config',
  $defs: {
    Config: {
      type: 'object',
      properties: {
        existing: { type: 'boolean' },
        agent: {
          type: 'object',
          properties: {
            build: { ref: 'AgentConfig', type: 'object', properties: {} },
          },
        },
        experimental: {
          type: 'object',
          properties: {
            batch_tool: { type: 'boolean' },
          },
        },
      },
      additionalProperties: false,
    },
    PermissionConfig: {
      anyOf: [
        { $ref: '#/$defs/PermissionActionConfig' },
        {
          type: 'object',
          properties: {
            read: { $ref: '#/$defs/PermissionRuleConfig' },
          },
          additionalProperties: { $ref: '#/$defs/PermissionRuleConfig' },
        },
      ],
    },
  },
};

const validates = (schema: Schema, instance: unknown) =>
  new Validator(schema as JsonSchema, '2020-12', false).validate(instance).valid;

describe('kilo config.json schema merge', () => {
  const out = merge(upstream);
  const props = out.properties as Record<string, unknown>;

  test('adds kilo-only top-level keys', () => {
    expect(props.commit_message).toBeDefined();
    expect(props.remote_control).toBeDefined();
    expect(props.auto_expand_history).toBeDefined();
    expect(props.auto_collapse_reasoning).toBeDefined();
    expect(props.reasoning_display).toBeDefined();
    expect(props.terminal_command_display).toBeDefined();
    expect(props.code_edit_display).toBeDefined();
    expect(props.hide_prompt_training_models).toBeDefined();
    expect(props.web_search).toEqual(expect.objectContaining({ type: 'boolean', default: false }));
    expect(props.privacy_mode).toBeDefined();
  });

  test('privacy_mode is a boolean', () => {
    expect(props.privacy_mode).toEqual(expect.objectContaining({ type: 'boolean' }));
  });

  test('adds require_approval_for_config_edits as a top-level boolean with a scoped description', () => {
    const field = props.require_approval_for_config_edits as {
      type?: string;
      description?: string;
    };
    expect(field.type).toBe('boolean');
    const description = field.description ?? '';
    expect(description.length).toBeGreaterThan(0);
    expect(description).toContain('defaults to true');
    expect(description).toContain('project');
    expect(description).toContain('global');
    expect(description).toContain('re-enabling protection');
    expect(description).toContain('permission rules');
  });

  test('validates require_approval_for_config_edits true and false against the composed schema', () => {
    expect(validates(out, { require_approval_for_config_edits: true })).toBe(true);
    expect(validates(out, { require_approval_for_config_edits: false })).toBe(true);
  });

  test('validates omitting require_approval_for_config_edits', () => {
    expect(validates(out, {})).toBe(true);
    expect(validates(out, { web_search: true })).toBe(true);
  });

  test('rejects non-boolean require_approval_for_config_edits values', () => {
    for (const value of ['true', 'false', 1, 0, null, {}, []]) {
      expect(validates(out, { require_approval_for_config_edits: value })).toBe(false);
    }
  });

  test('rejects unknown top-level properties under the strict referenced composition', () => {
    const referenced = merge(referencedUpstream);
    expect(validates(referenced, { require_approval_for_config_edits: true })).toBe(true);
    expect(validates(referenced, { require_approval_for_config_edits: false })).toBe(true);
    expect(validates(referenced, {})).toBe(true);
    expect(validates(referenced, { existing: true })).toBe(true);
    expect(validates(referenced, { require_approval_for_config_edits: 'yes' })).toBe(false);
    expect(validates(referenced, { unknown_property: true })).toBe(false);
  });

  test('auto_collapse_reasoning is a boolean', () => {
    expect(props.auto_collapse_reasoning).toEqual(expect.objectContaining({ type: 'boolean' }));
  });

  test('terminal_command_display is an enum of expanded/collapsed', () => {
    const tcd = props.terminal_command_display as {
      type: string;
      enum: string[];
    };
    expect(tcd.type).toBe('string');
    expect(tcd.enum).toEqual(['expanded', 'collapsed']);
  });

  test('code_edit_display is an enum of expanded/collapsed', () => {
    const ced = props.code_edit_display as { type: string; enum: string[] };
    expect(ced.type).toBe('string');
    expect(ced.enum).toEqual(['expanded', 'collapsed']);
  });

  test('reasoning_display is an enum of expanded/preview/headline', () => {
    const rd = props.reasoning_display as { type: string; enum: string[] };
    expect(rd.type).toBe('string');
    expect(rd.enum).toEqual(['expanded', 'preview', 'headline']);
  });

  test('commit_message has a prompt string property', () => {
    const cm = props.commit_message as { properties: { prompt: unknown } };
    expect(cm.properties.prompt).toEqual(expect.objectContaining({ type: 'string' }));
  });

  test('allows null on model and small_model', () => {
    const model = props.model as { anyOf: Array<{ type?: string }> };
    expect(model.anyOf.some(m => m.type === 'null')).toBe(true);
    const small = props.small_model as { anyOf: Array<{ type?: string }> };
    expect(small.anyOf.some(m => m.type === 'null')).toBe(true);
  });

  test('adds kilo primary agents', () => {
    const agent = props.agent as { properties: Record<string, unknown> };
    expect(agent.properties.ask).toBeDefined();
    expect(agent.properties.debug).toBeDefined();
    expect(agent.properties.orchestrator).toBeDefined();
    expect(agent.properties.build).toBeDefined(); // upstream key preserved
  });

  test('adds notebook permission keys without dropping upstream', () => {
    const defs = out.$defs as Record<string, unknown>;
    const permissionConfig = defs.PermissionConfig as {
      anyOf: Array<Record<string, unknown>>;
    };
    const permissionObject = permissionConfig.anyOf.find(variant => variant.type === 'object') as {
      properties: Record<string, unknown>;
    };

    expect(permissionObject.properties.notebook_read).toEqual({
      $ref: '#/$defs/PermissionRuleConfig',
    });
    expect(permissionObject.properties.notebook_edit).toEqual({
      $ref: '#/$defs/PermissionRuleConfig',
    });
    expect(permissionObject.properties.notebook_execute).toEqual({
      $ref: '#/$defs/PermissionRuleConfig',
    });
    expect(permissionObject.properties.read).toBeDefined();
  });

  test('merges kilo experimental keys without restoring retired keys', () => {
    const exp = props.experimental as { properties: Record<string, unknown> };
    expect(exp.properties.codebase_search).toBeUndefined();
    expect(exp.properties.agent_requirements).toEqual(expect.objectContaining({ type: 'boolean' }));
    expect(exp.properties.native_notebook_tools).toEqual(
      expect.objectContaining({ type: 'boolean' })
    );
    expect(exp.properties.openTelemetry).toBeDefined();
    expect(exp.properties.batch_tool).toBeDefined(); // upstream key preserved
  });

  test('preserves upstream root-level keys', () => {
    expect(out.$schema).toBe(upstream.$schema);
    expect(out.ref).toBe('Config');
    expect(out.type).toBe('object');
  });

  test('adds Kilo keys to a referenced Config definition', () => {
    const out = merge(referencedUpstream);
    const defs = out.$defs as Record<string, unknown>;
    const config = defs.Config as {
      properties: Record<string, unknown>;
      additionalProperties: boolean;
    };
    const props = config.properties;

    expect(props.commit_message).toBeDefined();
    expect(props.remote_control).toBeDefined();
    expect(props.web_search).toBeDefined();
    expect(props.privacy_mode).toBeDefined();
    expect(props.require_approval_for_config_edits).toBeDefined();
    expect(props.existing).toEqual({ type: 'boolean' });

    const agent = props.agent as { properties: Record<string, unknown> };
    expect(agent.properties.ask).toBeDefined();
    expect(agent.properties.debug).toBeDefined();
    expect(agent.properties.orchestrator).toBeDefined();
    expect(agent.properties.build).toBeDefined();

    const experimental = props.experimental as { properties: Record<string, unknown> };
    expect(experimental.properties.codebase_search).toBeUndefined();
    expect(experimental.properties.batch_tool).toBeDefined();
    expect(config.additionalProperties).toBe(false);
    expect(out.properties).toBeUndefined();
  });

  test('does not mutate the upstream referenced schema', () => {
    const before = structuredClone(referencedUpstream);

    merge(referencedUpstream);

    expect(referencedUpstream).toEqual(before);
  });
});
