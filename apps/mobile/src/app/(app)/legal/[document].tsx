import { useLocalSearchParams } from 'expo-router';

import { legalDocumentFromParam } from '@/components/legal/legal-document-param';
import { LegalDocumentScreen } from '@/components/legal/legal-document-screen';

export default function AppLegalDocumentRoute() {
  const { document } = useLocalSearchParams<{ document?: string }>();

  return <LegalDocumentScreen document={legalDocumentFromParam(document)} group="(app)" />;
}
