import { useCallback, useEffect, useState } from 'react';

import {
  type LegalDocument,
  type LegalDocumentFailure,
  loadLegalDocument,
} from '@/lib/legal-document';

export type LegalDocumentState =
  | { kind: 'loading' }
  | { kind: 'content'; html: string }
  | { kind: 'failed'; failure: LegalDocumentFailure };

/**
 * Loads one legal document and keeps the retry attempt as the owner of the
 * result: a superseded or unmounted attempt publishes nothing.
 */
export function useLegalDocument(document: LegalDocument) {
  const [state, setState] = useState<LegalDocumentState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: 'loading' });

    void (async () => {
      const result = await loadLegalDocument(document, controller.signal);
      if (controller.signal.aborted) {
        return;
      }
      setState(
        result.kind === 'loaded'
          ? { kind: 'content', html: result.html }
          : { kind: 'failed', failure: result.failure }
      );
    })();

    return () => {
      controller.abort();
    };
  }, [document, attempt]);

  const retry = useCallback(() => {
    setAttempt(current => current + 1);
  }, []);

  return { state, retry };
}
