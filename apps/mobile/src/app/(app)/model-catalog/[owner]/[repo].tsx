import { useLocalSearchParams } from 'expo-router';

import { ModelCatalogDetailScreen } from '@/components/chat/model-catalog-detail-screen';

export default function ModelCatalogDetailRoute() {
  const { owner, repo } = useLocalSearchParams<{ owner: string; repo: string }>();
  return <ModelCatalogDetailScreen id={`${owner}/${repo}`} />;
}
