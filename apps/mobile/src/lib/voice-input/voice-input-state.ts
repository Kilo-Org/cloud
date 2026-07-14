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
      message: 'Voice input is restricted on this device.',
      retryable: false,
    };
  }
  if (permission.canAskAgain) {
    return {
      action: 'none',
      availability: 'available',
      message: 'Microphone access is required for voice input.',
      retryable: true,
    };
  }
  return {
    action: 'open-settings',
    availability: 'available',
    message: 'Microphone access is off. Enable it in Settings to use voice input.',
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
        message: 'No speech detected. Tap the microphone to try again.',
        retryable: true,
      };
    }
    case 'network': {
      return {
        action: 'none',
        availability: 'available',
        message: 'Voice input needs a connection right now. Try again.',
        retryable: true,
      };
    }
    case 'busy': {
      return {
        action: 'none',
        availability: 'available',
        message: 'Voice input is busy. Try again.',
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
        message: 'Voice input stopped. Tap the microphone to try again.',
        retryable: true,
      };
    }
    case 'not-allowed': {
      return {
        action: 'open-settings',
        availability: 'available',
        message: 'Microphone access is off. Enable it in Settings to use voice input.',
        retryable: false,
      };
    }
    case 'service-not-allowed': {
      return {
        action: 'none',
        availability: 'unavailable',
        message: "Voice input isn't available on this device.",
        retryable: false,
      };
    }
    case 'language-not-supported': {
      return {
        action: 'none',
        availability: 'unavailable',
        message: "Voice input isn't available for this device language.",
        retryable: false,
      };
    }
    default: {
      return {
        action: 'none',
        availability: 'available',
        message: 'Voice input stopped. Tap the microphone to try again.',
        retryable: true,
      };
    }
  }
}

export function shouldAbortVoiceInput(input: VoiceInputLifecycleInput): boolean {
  return input.disabled || input.appState !== 'active';
}
