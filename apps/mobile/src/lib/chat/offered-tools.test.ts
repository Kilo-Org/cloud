import { asOffered } from '@kilocode/harness-sdk/core';
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import { offeredTools } from './offered-tools';

/** A tool as the harness offers it: the definition plus the field the harness adds. */
const offered = asOffered({
  definition: {
    name: 'time',
    description: 'Current time',
    parameters: {
      type: 'object',
      properties: { zone: { type: 'string', description: 'An IANA zone' } },
      required: ['zone'],
    },
  },
  run: () => Effect.succeed('noon'),
});

describe('the tools a model that runs on the device is offered', () => {
  it('drops the harness wait field and keeps everything else', () => {
    expect(Object.keys(offered.parameters.properties)).toEqual(['zone', 'wait']);
    expect(offeredTools([offered])).toEqual([
      {
        name: 'time',
        description: 'Current time',
        parameters: {
          type: 'object',
          properties: { zone: { type: 'string', description: 'An IANA zone' } },
          required: ['zone'],
        },
      },
    ]);
  });

  it('leaves the tool the harness handed in untouched', () => {
    offeredTools([offered]);
    expect(Object.keys(offered.parameters.properties)).toEqual(['zone', 'wait']);
  });
});
