type SessionKeyboardContainerKind = 'app-aware-padding' | 'keyboard-avoiding';

export function getSessionKeyboardContainerKind(platform: string): SessionKeyboardContainerKind {
  return platform === 'android' ? 'app-aware-padding' : 'keyboard-avoiding';
}
