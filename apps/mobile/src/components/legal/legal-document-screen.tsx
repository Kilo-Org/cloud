import { useRouter } from 'expo-router';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';

import { MarkdownText } from '@/components/agents/markdown-text';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Skeleton } from '@/components/ui/skeleton';
import { useLegalDocument } from '@/lib/hooks/use-legal-document';
import { type LegalDocument } from '@/lib/legal-document';
import { useSideInsetStyle } from '@/lib/screen-insets';

import { planLegalInContentLink } from './legal-document-link';

const TITLE_KEY = {
  terms: 'login.termsInSentence',
  privacy: 'common.privacyPolicy',
} as const satisfies Record<LegalDocument, string>;

const LOADING_LINE_WIDTHS = ['w-full', 'w-11/12', 'w-full', 'w-2/3', 'w-full', 'w-10/12'];

/** The stack the screen was pushed on, so an in-content cross reference stays in it. */
export type LegalDocumentGroup = '(app)' | '(auth)';

/**
 * One legal document (terms or privacy policy) rendered from the sanitized
 * content the app API serves, in place of a browser hand-off. A fetch that can
 * succeed again offers Retry; a document this server does not serve is a dead
 * end and shows no action.
 */
export function LegalDocumentScreen({
  document,
  group,
}: Readonly<{ document: LegalDocument; group: LegalDocumentGroup }>) {
  const { t } = useTranslation();
  const router = useRouter();
  const { state, retry } = useLegalDocument(document);
  const sideInsetStyle = useSideInsetStyle();

  // The documents cross-reference each other. Both stay in the app: opening the
  // web page would hand the reader the marketing site's chrome, pricing links
  // included. An in-page anchor is consumed here instead of reaching the
  // external-link flow, which would report it as a broken link.
  const openInContentLink = useCallback(
    (href: string) => {
      const plan = planLegalInContentLink(href, document);
      if (plan.kind === 'handled') {
        return true;
      }
      if (plan.kind === 'external') {
        return false;
      }

      if (group === '(auth)') {
        router.push({
          pathname: '/(auth)/legal/[document]',
          params: { document: plan.document },
        });
      } else {
        router.push({
          pathname: '/(app)/legal/[document]',
          params: { document: plan.document },
        });
      }
      return true;
    },
    [document, group, router]
  );

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t(TITLE_KEY[document])} />
      {renderState()}
    </View>
  );

  function renderState() {
    if (state.kind === 'loading') {
      return (
        <View className="gap-3 px-5 pt-4">
          {LOADING_LINE_WIDTHS.map((width, index) => (
            <Skeleton key={index} className={`h-4 rounded ${width}`} />
          ))}
        </View>
      );
    }
    if (state.kind === 'failed') {
      return state.failure === 'retryable' ? (
        <QueryError variant="server" onRetry={retry} />
      ) : (
        <QueryError variant="not-found" />
      );
    }
    return (
      <ScrollView
        className="flex-1"
        contentContainerStyle={sideInsetStyle}
        contentContainerClassName="px-5 pt-4 pb-10"
        showsVerticalScrollIndicator={false}
      >
        <MarkdownText value={state.html} onPressLink={openInContentLink} />
      </ScrollView>
    );
  }
}
