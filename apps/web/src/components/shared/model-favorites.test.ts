import { describe, expect, it } from '@jest/globals';
import type { ModelOption } from './model-combobox-options';
import {
  canonicalFavoriteId,
  favoriteKeysForOption,
  favoriteToggleAction,
  isFavoriteOption,
} from './model-favorites';

const gatewayClaude: ModelOption = {
  id: 'anthropic/claude-sonnet-4',
  name: 'Claude Sonnet 4',
};

const legacyGatewayClaude: ModelOption = {
  id: 'anthropic/claude-sonnet-4',
  name: 'Claude Sonnet 4',
  modelRef: { providerID: 'kilo', modelID: 'anthropic/claude-sonnet-4' },
  overrideSource: 'legacy-gateway',
};

const kiloCliClaude: ModelOption = {
  id: 'remote-model-0',
  name: 'Claude Sonnet 4',
  displayId: 'anthropic/claude-sonnet-4',
  modelRef: { providerID: 'kilo', modelID: 'anthropic/claude-sonnet-4' },
  overrideSource: 'cli-catalog',
};

const remoteWorkspaceClaude: ModelOption = {
  id: 'remote-model-1',
  name: 'Workspace Claude',
  displayId: 'shared/model.id',
  modelRef: { providerID: 'anthropic-local', modelID: 'shared/model.id' },
  overrideSource: 'cli-catalog',
};

describe('canonicalFavoriteId', () => {
  it('keys Gateway and legacy Gateway options by their Gateway model id', () => {
    expect(canonicalFavoriteId(gatewayClaude)).toBe('anthropic/claude-sonnet-4');
    expect(canonicalFavoriteId(legacyGatewayClaude)).toBe('anthropic/claude-sonnet-4');
  });

  it('keys a kilo CLI option by its Gateway model id, not remote:kilo', () => {
    expect(canonicalFavoriteId(kiloCliClaude)).toBe('anthropic/claude-sonnet-4');
  });

  it('keys other-provider CLI options by provider and model identity, not the opaque id', () => {
    expect(canonicalFavoriteId(remoteWorkspaceClaude)).toBe(
      'remote:anthropic-local:shared/model.id'
    );
  });
});

describe('isFavoriteOption', () => {
  it('matches Gateway and kilo CLI options by the Gateway id or the remote:kilo alias', () => {
    for (const option of [gatewayClaude, legacyGatewayClaude, kiloCliClaude]) {
      expect(isFavoriteOption(option, new Set(['anthropic/claude-sonnet-4']))).toBe(true);
      expect(isFavoriteOption(option, new Set(['remote:kilo:anthropic/claude-sonnet-4']))).toBe(
        true
      );
    }
  });

  it('matches a CLI option only by its own remote key', () => {
    expect(
      isFavoriteOption(remoteWorkspaceClaude, new Set(['remote:anthropic-local:shared/model.id']))
    ).toBe(true);
    expect(isFavoriteOption(remoteWorkspaceClaude, new Set(['shared/model.id']))).toBe(false);
    expect(isFavoriteOption(remoteWorkspaceClaude, new Set(['remote:kilo:shared/model.id']))).toBe(
      false
    );
  });

  it('does not match an unrelated stored key', () => {
    expect(isFavoriteOption(gatewayClaude, new Set(['openai/gpt-5']))).toBe(false);
  });
});

describe('favoriteKeysForOption', () => {
  it('includes the Gateway id and the remote:kilo alias for Gateway-shaped options', () => {
    expect(favoriteKeysForOption(gatewayClaude).sort()).toEqual([
      'anthropic/claude-sonnet-4',
      'remote:kilo:anthropic/claude-sonnet-4',
    ]);
    expect(favoriteKeysForOption(kiloCliClaude).sort()).toEqual([
      'anthropic/claude-sonnet-4',
      'remote:kilo:anthropic/claude-sonnet-4',
    ]);
  });

  it('includes only the remote key for other-provider CLI options', () => {
    expect(favoriteKeysForOption(remoteWorkspaceClaude)).toEqual([
      'remote:anthropic-local:shared/model.id',
    ]);
  });
});

describe('favoriteToggleAction', () => {
  it('adds the canonical id when no stored key matches', () => {
    expect(favoriteToggleAction(kiloCliClaude, [])).toEqual({
      type: 'add',
      model: 'anthropic/claude-sonnet-4',
    });
    expect(favoriteToggleAction(remoteWorkspaceClaude, [])).toEqual({
      type: 'add',
      model: 'remote:anthropic-local:shared/model.id',
    });
  });

  it('removes every stored key that marks the option starred', () => {
    expect(
      favoriteToggleAction(gatewayClaude, [
        'anthropic/claude-sonnet-4',
        'remote:kilo:anthropic/claude-sonnet-4',
        'openai/gpt-5',
      ])
    ).toEqual({
      type: 'remove',
      models: ['anthropic/claude-sonnet-4', 'remote:kilo:anthropic/claude-sonnet-4'],
    });
  });

  it('removes only the stored remote:kilo alias when that is all there is', () => {
    expect(favoriteToggleAction(gatewayClaude, ['remote:kilo:anthropic/claude-sonnet-4'])).toEqual({
      type: 'remove',
      models: ['remote:kilo:anthropic/claude-sonnet-4'],
    });
  });
});
