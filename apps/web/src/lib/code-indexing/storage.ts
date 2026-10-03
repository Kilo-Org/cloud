import { createEmbeddingService } from '@/lib/ai-gateway/embeddings/embedding-providers';
import { MilvusIndexStorage } from '@/lib/code-indexing/milvus-storage';

export function getIndexStorage() {
  const embeddingService = createEmbeddingService('mistral');
  return new MilvusIndexStorage(embeddingService);
}
