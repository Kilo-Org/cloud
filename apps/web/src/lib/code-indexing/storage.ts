import { createEmbeddingService } from '@/lib/embeddings/embedding-providers';
import { MilvusIndexStorage } from '@/lib/code-indexing/milvus-storage';
// import { QdrantIndexStorage } from '@/lib/code-indexing/qdrant-storage';

export function getIndexStorage() {
  const embeddingService = createEmbeddingService('mistral');
  // return new QdrantIndexStorage(embeddingService);
  return new MilvusIndexStorage(embeddingService);
}
