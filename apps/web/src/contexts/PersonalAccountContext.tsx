'use client';

import { createContext, useContext, type ReactNode } from 'react';

type PersonalAccountContextValue = {
  /** True when the signed-in user's personal account is disabled. */
  personalAccountDisabled: boolean;
};

const PersonalAccountContext = createContext<PersonalAccountContextValue>({
  personalAccountDisabled: false,
});

export function PersonalAccountProvider({
  personalAccountDisabled,
  children,
}: {
  personalAccountDisabled: boolean;
  children: ReactNode;
}) {
  return (
    <PersonalAccountContext.Provider value={{ personalAccountDisabled }}>
      {children}
    </PersonalAccountContext.Provider>
  );
}

export function usePersonalAccountDisabled(): boolean {
  return useContext(PersonalAccountContext).personalAccountDisabled;
}
