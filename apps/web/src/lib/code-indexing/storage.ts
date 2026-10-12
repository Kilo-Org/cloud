import { createEmbeddingService } from '@/lib/embeddings/embedding-providers';
import { MilvusIndexStorage } from '@/lib/code-indexing/milvus-storage';

export function getIndexStorage() {
  const embeddingService = createEmbeddingService('mistral');
  return new MilvusIndexStorage(embeddingService);
}
