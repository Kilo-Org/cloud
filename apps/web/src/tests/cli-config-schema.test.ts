import { merge, type Schema } from '@/app/config.json/route';

const upstream: Schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  ref: 'Config',
  type: 'object',
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

describe('kilo config.json schema merge', () => {
  const out = merge(upstream);
  const props = out.properties as Record<string, unknown>;

  test('adds kilo-only top-level keys', () => {
    expect(props.commit_message).toBeDefined();
    expect(props.remote_control).toBeDefined();
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

  test('adds kilo experimental keys without dropping upstream', () => {
    const exp = props.experimental as { properties: Record<string, unknown> };
    expect(exp.properties.codebase_search).toBeDefined();
    expect(exp.properties.openTelemetry).toBeDefined();
    expect(exp.properties.batch_tool).toBeDefined(); // upstream key preserved
  });

  test('preserves upstream root-level keys', () => {
    expect(out.$schema).toBe(upstream.$schema);
    expect(out.ref).toBe('Config');
    expect(out.type).toBe('object');
  });
});
