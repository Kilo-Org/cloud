import { createOpenAI } from '@ai-sdk/openai';
import { embed, embedMany } from 'ai';
import { MISTRAL_API_KEY, OPENAI_API_KEY } from '@/lib/config.server';
import { Mistral } from '@mistralai/mistralai';

export type EmbeddingProvider = 'openai' | 'mistral' | 'mistral-text';
export const DEFAULT_EMBEDDING_PROVIDER: EmbeddingProvider = 'mistral';

const mistral = new Mistral({
  apiKey: MISTRAL_API_KEY,
});

const openai = createOpenAI({ apiKey: OPENAI_API_KEY });

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
  openai: {
    provider: 'openai',
    model: 'text-embedding-3-small',
    dimensions: 1536,
    apiKey: OPENAI_API_KEY,
  },
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

  constructor(provider: EmbeddingProvider = 'openai') {
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
    if (this.config.provider.includes('mistral')) {
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
    const model = this.getModelInstance();
    return await embed({
      model,
      value: text,
    });
  }

  async embedMany(texts: string[]): Promise<EmbedManyResult> {
    if (this.config.provider.includes('mistral')) {
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
    const model = this.getModelInstance();
    return await embedMany({
      model,
      values: texts,
    });
  }

  private getModelInstance() {
    switch (this.config.provider) {
      case 'openai':
        return openai.textEmbeddingModel(this.config.model);
      default:
        throw new Error(`Unsupported embedding provider: ${this.config.provider}`);
    }
  }
}

// Factory function to create embedding service with environment-based configuration
export function createEmbeddingService(
  provider: EmbeddingProvider = DEFAULT_EMBEDDING_PROVIDER
): EmbeddingService {
  return new EmbeddingService(provider);
}
