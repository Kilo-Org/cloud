import { i18n } from '@/i18n';

export type VoiceInputStatus = 'idle' | 'starting' | 'listening' | 'stopping';
export type VoiceInputAvailability = 'available' | 'unavailable';

export type VoiceInputFeedback = {
  action: 'none' | 'open-settings';
  availability: VoiceInputAvailability;
  message: string;
  retryable: boolean;
};

export type VoiceTranscriptState = {
  finalSegments: string[];
  interim: string;
  transcript: string;
};

type VoiceInputPermission = {
  granted: boolean;
  canAskAgain: boolean;
  restricted?: boolean;
};

export type VoiceInputLifecycleInput = {
  appState: 'active' | 'background' | 'inactive';
  disabled: boolean;
};

export function createVoiceTranscriptState(): VoiceTranscriptState {
  return { finalSegments: [], interim: '', transcript: '' };
}

function renderTranscript(finalSegments: readonly string[], interim: string): string {
  const finals = finalSegments.join(' ');
  if (!interim) {
    return finals;
  }
  return finals ? `${finals} ${interim}` : interim;
}

function normalizeSegment(transcript: string): string {
  return transcript.trim();
}

export function applyVoiceRecognitionResult(
  state: VoiceTranscriptState,
  result: { isFinal: boolean; transcript: string }
): VoiceTranscriptState {
  const normalized = normalizeSegment(result.transcript);

  if (result.isFinal) {
    const finalSegments =
      normalized.length === 0 ? state.finalSegments : [...state.finalSegments, normalized];
    return {
      finalSegments,
      interim: '',
      transcript: renderTranscript(finalSegments, ''),
    };
  }

  return {
    finalSegments: state.finalSegments,
    interim: normalized,
    transcript: renderTranscript(state.finalSegments, normalized),
  };
}

export function appendVoiceTranscript(baseDraft: string, transcript: string): string {
  const trimmedTranscript = transcript.trimStart();
  if (trimmedTranscript.length === 0) {
    return baseDraft;
  }
  if (baseDraft.length === 0) {
    return trimmedTranscript;
  }
  const lastChar = baseDraft.at(-1);
  if (lastChar === ' ' || lastChar === '\n' || lastChar === '\t' || lastChar === '\r') {
    return `${baseDraft}${trimmedTranscript}`;
  }
  return `${baseDraft} ${trimmedTranscript}`;
}

export function classifyVoiceInputPermission(
  permission: VoiceInputPermission
): VoiceInputFeedback | null {
  if (permission.granted) {
    return null;
  }
  if (permission.restricted) {
    return {
      action: 'none',
      availability: 'available',
      message: i18n.t('voiceInput.restricted'),
      retryable: false,
    };
  }
  if (permission.canAskAgain) {
    return {
      action: 'none',
      availability: 'available',
      message: i18n.t('voiceInput.micRequired'),
      retryable: true,
    };
  }
  return {
    action: 'open-settings',
    availability: 'available',
    message: i18n.t('voiceInput.micOff'),
    retryable: false,
  };
}

export function classifyVoiceInputError(code: string): VoiceInputFeedback {
  switch (code) {
    case 'no-speech':
    case 'speech-timeout': {
      return {
        action: 'none',
        availability: 'available',
        message: i18n.t('voiceInput.noSpeech'),
        retryable: true,
      };
    }
    case 'network': {
      return {
        action: 'none',
        availability: 'available',
        message: i18n.t('voiceInput.needsConnection'),
        retryable: true,
      };
    }
    case 'busy': {
      return {
        action: 'none',
        availability: 'available',
        message: i18n.t('voiceInput.busy'),
        retryable: true,
      };
    }
    case 'audio-capture':
    case 'interrupted':
    case 'client':
    case 'unknown':
    case 'bad-grammar':
    case 'aborted': {
      return {
        action: 'none',
        availability: 'available',
        message: i18n.t('voiceInput.stopped'),
        retryable: true,
      };
    }
    case 'not-allowed': {
      return {
        action: 'open-settings',
        availability: 'available',
        message: i18n.t('voiceInput.micOff'),
        retryable: false,
      };
    }
    case 'service-not-allowed': {
      return {
        action: 'none',
        availability: 'unavailable',
        message: i18n.t('voiceInput.unavailableDevice'),
        retryable: false,
      };
    }
    case 'language-not-supported': {
      return {
        action: 'none',
        availability: 'available',
        message: i18n.t('voiceInput.unavailableLanguage'),
        retryable: false,
      };
    }
    default: {
      return {
        action: 'none',
        availability: 'available',
        message: i18n.t('voiceInput.stopped'),
        retryable: true,
      };
    }
  }
}

export function shouldAbortVoiceInput(input: VoiceInputLifecycleInput): boolean {
  return input.disabled || input.appState !== 'active';
}
