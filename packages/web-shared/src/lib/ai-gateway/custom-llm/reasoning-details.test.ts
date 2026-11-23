import { describe, expect, it } from '@jest/globals';
import {
  ReasoningDetailArraySchema,
  ReasoningDetailEncryptedSchema,
  ReasoningDetailSummarySchema,
  ReasoningDetailTextSchema,
  ReasoningDetailType,
} from './reasoning-details';

const providerField = { provider_metadata: { region: 'eu' } };

describe('reasoning detail schemas', () => {
  it('strips an unknown provider field from each detail type', () => {
    expect(
      ReasoningDetailSummarySchema.parse({
        type: ReasoningDetailType.Summary,
        summary: 'short',
        ...providerField,
      })
    ).toEqual({ type: ReasoningDetailType.Summary, summary: 'short' });

    expect(
      ReasoningDetailEncryptedSchema.parse({
        type: ReasoningDetailType.Encrypted,
        data: 'blob',
        ...providerField,
      })
    ).toEqual({ type: ReasoningDetailType.Encrypted, data: 'blob' });

    expect(
      ReasoningDetailTextSchema.parse({
        type: ReasoningDetailType.Text,
        text: 'body',
        ...providerField,
      })
    ).toEqual({ type: ReasoningDetailType.Text, text: 'body' });
  });

  it('keeps matching details without their unknown fields and drops other entries', () => {
    const details = ReasoningDetailArraySchema.parse([
      { type: ReasoningDetailType.Text, text: 'body', index: 0, ...providerField },
      { type: ReasoningDetailType.Summary, summary: 'short' },
      { type: 'reasoning.unknown' },
      null,
      'text',
    ]);

    expect(details).toEqual([
      { type: ReasoningDetailType.Text, text: 'body', index: 0 },
      { type: ReasoningDetailType.Summary, summary: 'short' },
    ]);
  });
});
