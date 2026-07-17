import { describe, expect, it } from 'vitest';

import {
  resolveOwnerVoiceInputView,
  resolveVoiceInputControlState,
  type VoiceInputControlState,
} from './voice-input-view-state';
import { type VoiceInputControllerSnapshot } from './voice-input-controller';

const AVAILABLE: VoiceInputControllerSnapshot = {
  availability: 'available',
  owner: 'composer-A',
  status: 'idle',
};

const UNAVAILABLE: VoiceInputControllerSnapshot = {
  availability: 'unavailable',
  owner: null,
  status: 'idle',
};

describe('resolveOwnerVoiceInputView', () => {
  it('marks the owner active and preserves the starting status', () => {
    const view = resolveOwnerVoiceInputView({ ...AVAILABLE, status: 'starting' }, 'composer-A');
    expect(view).toEqual({ available: true, isActive: true, status: 'starting' });
  });

  it('marks the owner active and preserves the listening status', () => {
    const view = resolveOwnerVoiceInputView({ ...AVAILABLE, status: 'listening' }, 'composer-A');
    expect(view).toEqual({ available: true, isActive: true, status: 'listening' });
  });

  it('marks the owner active and preserves the stopping status', () => {
    const view = resolveOwnerVoiceInputView({ ...AVAILABLE, status: 'stopping' }, 'composer-A');
    expect(view).toEqual({ available: true, isActive: true, status: 'stopping' });
  });

  it('returns inactive idle for an owner that does not match', () => {
    const view = resolveOwnerVoiceInputView({ ...AVAILABLE, status: 'listening' }, 'composer-B');
    expect(view).toEqual({ available: true, isActive: false, status: 'idle' });
  });

  it('returns inactive idle when the snapshot owner is null', () => {
    const view = resolveOwnerVoiceInputView(
      { ...AVAILABLE, owner: null, status: 'listening' },
      'composer-A'
    );
    expect(view).toEqual({ available: true, isActive: false, status: 'idle' });
  });

  it('returns inactive idle when the snapshot owner is null and the controller is unavailable', () => {
    const view = resolveOwnerVoiceInputView(UNAVAILABLE, 'composer-A');
    expect(view).toEqual({ available: false, isActive: false, status: 'idle' });
  });

  it('reports availability unavailable while still respecting ownership rules', () => {
    const view = resolveOwnerVoiceInputView({ ...UNAVAILABLE, status: 'starting' }, 'composer-A');
    expect(view).toEqual({ available: false, isActive: false, status: 'idle' });
  });
});

describe('resolveVoiceInputControlState', () => {
  it('idle + not disabled => Start label, microphone icon, not busy, enabled', () => {
    expect(resolveVoiceInputControlState('idle', false)).toEqual<VoiceInputControlState>({
      accessibilityLabel: 'Start voice input',
      busy: false,
      disabled: false,
      icon: 'microphone',
      showListeningStatus: false,
    });
  });

  it('idle + external disabled => Start label, microphone icon, not busy, disabled', () => {
    expect(resolveVoiceInputControlState('idle', true)).toEqual<VoiceInputControlState>({
      accessibilityLabel: 'Start voice input',
      busy: false,
      disabled: true,
      icon: 'microphone',
      showListeningStatus: false,
    });
  });

  it('starting => busy + disabled, Start label, microphone icon, no listening status', () => {
    expect(resolveVoiceInputControlState('starting', false)).toEqual<VoiceInputControlState>({
      accessibilityLabel: 'Start voice input',
      busy: true,
      disabled: true,
      icon: 'microphone',
      showListeningStatus: false,
    });
  });

  it('stopping => busy + disabled, Stop label, stop icon, no listening status', () => {
    expect(resolveVoiceInputControlState('stopping', false)).toEqual<VoiceInputControlState>({
      accessibilityLabel: 'Stop voice input',
      busy: true,
      disabled: true,
      icon: 'stop',
      showListeningStatus: false,
    });
  });

  it('listening + not disabled => Stop label, stop icon, not busy, enabled, listening status shown', () => {
    expect(resolveVoiceInputControlState('listening', false)).toEqual<VoiceInputControlState>({
      accessibilityLabel: 'Stop voice input',
      busy: false,
      disabled: false,
      icon: 'stop',
      showListeningStatus: true,
    });
  });

  it('listening + external disabled => Stop label, stop icon, not busy, disabled, listening status shown', () => {
    expect(resolveVoiceInputControlState('listening', true)).toEqual<VoiceInputControlState>({
      accessibilityLabel: 'Stop voice input',
      busy: false,
      disabled: true,
      icon: 'stop',
      showListeningStatus: true,
    });
  });
});
