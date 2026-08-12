import { MISTRAL_API_KEY } from '@/lib/config.server';
import { Mistral } from '@mistralai/mistralai';

export type EmbeddingProvider = 'mistral' | 'mistral-text';
export const DEFAULT_EMBEDDING_PROVIDER: EmbeddingProvider = 'mistral';

const mistral = new Mistral({
  apiKey: MISTRAL_API_KEY,
});

async function callMistralEmbeddings(
  model: string,
  outputDimension: number | undefined,
  inputs: string | string[]
) {
  const maxRetries = 3;
  const delays = [1000, 2000]; // 1s, 2s delays for retries

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await mistral.embeddings.create({
        model,
        outputDimension,
        inputs,
      });
      return response;
    } catch (error: unknown) {
      const isLastAttempt = attempt === maxRetries - 1;

      if (isLastAttempt) {
        throw error;
      }

      const errorObj = error as {
        status?: number;
        statusCode?: number;
        message?: string;
        body?: string;
      };
      const statusCode = errorObj.status || errorObj.statusCode || 'unknown';
      const body = errorObj.message || errorObj.body || 'unknown error';
      console.warn(`mistral embedding failed: ${statusCode} ${body}`);

      await new Promise(resolve => setTimeout(resolve, delays[attempt]));
    }
  }

  throw new Error('Mistral embedding failed after all retries');
}

type EmbeddingConfig = {
  provider: EmbeddingProvider;
  model: string;
  dimensions: number | undefined;
  apiKey: string;
};

export const EMBEDDING_CONFIGS: Record<EmbeddingProvider, EmbeddingConfig> = {
  mistral: {
    provider: 'mistral',
    model: 'codestral-embed-2505',
    dimensions: 256,
    apiKey: MISTRAL_API_KEY,
  },
  'mistral-text': {
    provider: 'mistral-text',
    model: 'mistral-embed', // For text/issues (auto-triage)
    dimensions: undefined, // Let Mistral decide
    apiKey: MISTRAL_API_KEY,
  },
};

type EmbedSingleResult = {
  embedding: number[];
};

type EmbedManyResult = {
  embeddings: number[][];
};

export class EmbeddingService {
  private config: EmbeddingConfig;

  constructor(provider: EmbeddingProvider = DEFAULT_EMBEDDING_PROVIDER) {
    this.config = EMBEDDING_CONFIGS[provider];
  }

  getProvider(): EmbeddingProvider {
    return this.config.provider;
  }

  getModel(): string {
    return this.config.model;
  }

  getDimensions(): number | undefined {
    return this.config.dimensions;
  }

  async embedSingle(text: string): Promise<EmbedSingleResult> {
    const response = await callMistralEmbeddings(this.getModel(), this.getDimensions(), text);
    const embedding = [];
    for (const data of response.data) {
      if (data.embedding == null) {
        throw new Error('No embedding returned from Mistral');
      }
      embedding.push(...data.embedding);
    }
    return { embedding };
  }

  async embedMany(texts: string[]): Promise<EmbedManyResult> {
    const response = await callMistralEmbeddings(this.getModel(), this.getDimensions(), texts);
    const embeddings: number[][] = [];
    for (const data of response.data) {
      if (data.embedding == null) {
        throw new Error('No embedding returned from Mistral');
      }
      embeddings.push(data.embedding);
    }
    return { embeddings: embeddings };
  }
}

export function createEmbeddingService(
  provider: EmbeddingProvider = DEFAULT_EMBEDDING_PROVIDER
): EmbeddingService {
  return new EmbeddingService(provider);
}
