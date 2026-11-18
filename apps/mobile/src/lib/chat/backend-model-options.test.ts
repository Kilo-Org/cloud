import { describe, expect, it } from 'vitest';

import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';

import { defaultChatModel } from './backend-model-options';
import { localTargetId } from './backend-target';

function option(id: string, isPreferred = false): SessionModelOption {
  return {
    id,
    name: id,
    displayId: id,
    variants: [],
    isPreferred,
    showGatewayMetadata: false,
  };
}

const custom = option('backend:server:1:model', false);
const apple = option(localTargetId('apple'), false);
const kilo = option('kilo/one', false);
const preferred = option('kilo/preferred', true);

describe('defaultChatModel', () => {
  it("prefers Kilo's preferred model when the latest chat's model is gone", () => {
    expect(
      defaultChatModel({
        options: [kilo, preferred, custom, apple],
        latestChatModel: 'backend:deleted:1:model',
        catalogLoading: false,
      })
    ).toBe(preferred.id);
  });

  it('starts on an on-device model when the catalog could not load', () => {
    expect(
      defaultChatModel({
        options: [custom, apple],
        latestChatModel: kilo.id,
        catalogLoading: false,
      })
    ).toBe(apple.id);
  });

  // Each case pins one rung of the documented ladder: the latest chat's model,
  // the wait for the catalog, Kilo's preferred model, any Kilo model, an
  // on-device model, then anything offered.
  it.each<{
    readonly name: string;
    readonly options: readonly SessionModelOption[];
    readonly latestChatModel: string | undefined;
    readonly catalogLoading: boolean;
    readonly expected: string | undefined;
  }>([
    {
      name: 'starts where the latest chat is, even while the catalog loads',
      options: [custom, apple],
      latestChatModel: apple.id,
      catalogLoading: true,
      expected: apple.id,
    },
    {
      name: 'waits for the catalog while only backend and on-device models are offered',
      options: [custom, apple],
      latestChatModel: undefined,
      catalogLoading: true,
      expected: undefined,
    },
    {
      name: "prefers Kilo's preferred model over a plain Kilo model",
      options: [kilo, preferred],
      latestChatModel: undefined,
      catalogLoading: false,
      expected: preferred.id,
    },
    {
      name: 'starts on the first Kilo model when a plain one competes with an on-device model',
      options: [kilo, apple],
      latestChatModel: undefined,
      catalogLoading: false,
      expected: kilo.id,
    },
    {
      name: 'starts on an on-device model when it is the only offer',
      options: [apple],
      latestChatModel: undefined,
      catalogLoading: false,
      expected: apple.id,
    },
    {
      name: 'starts on a custom backend when it is the only offer',
      options: [custom],
      latestChatModel: undefined,
      catalogLoading: false,
      expected: custom.id,
    },
    {
      name: 'returns undefined when nothing is offered',
      options: [],
      latestChatModel: undefined,
      catalogLoading: false,
      expected: undefined,
    },
  ])('$name', ({ options, latestChatModel, catalogLoading, expected }) => {
    expect(defaultChatModel({ options, latestChatModel, catalogLoading })).toBe(expected);
  });
});
