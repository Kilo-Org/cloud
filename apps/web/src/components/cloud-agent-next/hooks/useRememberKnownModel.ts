'use client';

import { useEffect, useRef } from 'react';
import { writeCloudAgentCookie } from '../cloud-agent-cookie';
import { encodeKnownModels, KNOWN_MODELS_COOKIE, rememberKnownModel } from '../known-models';
import type { KnownModel } from '../known-models';

type Scope = { userId: string | undefined; organizationId: string | undefined };

/** Writes the selected catalog model to the cookie the server reads on the next load. */
export function useRememberKnownModel(
  knownModels: readonly KnownModel[],
  model: KnownModel | null,
  { userId, organizationId }: Scope
): void {
  const storedRef = useRef(knownModels);

  useEffect(() => {
    if (!model || !userId) return;
    const next = rememberKnownModel(storedRef.current, model);
    if (next === storedRef.current) return;
    storedRef.current = next;
    writeCloudAgentCookie(
      KNOWN_MODELS_COOKIE,
      encodeKnownModels(next, userId),
      organizationId ?? null
    );
  }, [model, organizationId, userId]);
}
