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

const custom = option('backend:server:1:model');
const apple = option(localTargetId('apple'));
const kilo = option('kilo/one');
const preferred = option('kilo/preferred', true);

describe('defaultChatModel', () => {
  it('starts where the latest chat is, even before the catalog loads', () => {
    expect(
      defaultChatModel({
        options: [custom, apple],
        latestChatModel: apple.id,
        catalogLoading: true,
      })
    ).toBe(apple.id);
  });

  it('waits for the catalog rather than starting on a model that arrived first', () => {
    expect(
      defaultChatModel({
        options: [custom, apple],
        latestChatModel: undefined,
        catalogLoading: true,
      })
    ).toBeUndefined();
  });

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

  it('starts on a custom backend when nothing else is offered', () => {
    expect(
      defaultChatModel({ options: [custom], latestChatModel: undefined, catalogLoading: false })
    ).toBe(custom.id);
  });
});
