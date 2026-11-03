import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { type ProfileNameError, validateProfileName } from '@/lib/agent-profile-forms';

/** The message each refusal shows under the field. */
const NAME_ERROR_KEYS = {
  empty: 'profiles.nameRequired',
  'too-long': 'agentChat.newSession.nameTooLong',
} as const satisfies Record<ProfileNameError, string>;

export type ProfileNameField = Readonly<{
  /** The uncontrolled text, so a caller reads the native field's value. */
  valueRef: { current: string };
  /** The message for the current text, or undefined when it is accepted. */
  error: string | undefined;
  handleChangeText: (value: string) => void;
  /**
   * Validate the current text: start showing its message and return the
   * trimmed name, or null when the form must not submit.
   */
  commit: () => string | null;
}>;

/**
 * The name field every profile form shares. The text stays in a ref (the app's
 * iOS text-input rule), so the message cannot come from the text on its own:
 * `commit` starts validation and, once it has, every keystroke recomputes the
 * message from the text the field holds now. A refusal therefore always names
 * the current text — an over-long name replaces "Enter a profile name" as soon
 * as it is typed, without another submit.
 */
export function useProfileNameField(initialName = ''): ProfileNameField {
  const { t } = useTranslation();
  const valueRef = useRef(initialName);
  const validationStarted = useRef(false);
  const [error, setError] = useState<ProfileNameError | null>(null);

  const handleChangeText = useCallback((value: string) => {
    valueRef.current = value;
    if (validationStarted.current) {
      setError(validateProfileName(value));
    }
  }, []);

  const commit = useCallback((): string | null => {
    validationStarted.current = true;
    const name = valueRef.current.trim();
    const issue = validateProfileName(name);
    setError(issue);
    return issue === null ? name : null;
  }, []);

  return {
    valueRef,
    error: error === null ? undefined : t(NAME_ERROR_KEYS[error]),
    handleChangeText,
    commit,
  };
}
