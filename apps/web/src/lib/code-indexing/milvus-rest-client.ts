/**
 * Custom Milvus REST API client that uses native fetch.
 * This is a drop-in replacement for the @zilliz/milvus2-sdk-node MilvusClient
 * that avoids issues with gRPC and the SDK's HTTP client on certain systems.
 *
 * API Reference: https://docs.zilliz.com/reference/restful/data-plane-v2
 */

// ============================================================================
// Types matching the MilvusClient interface
// ============================================================================

export type DataType =
  | 'None'
  | 'Bool'
  | 'Int8'
  | 'Int16'
  | 'Int32'
  | 'Int64'
  | 'Float'
  | 'Double'
  | 'String'
  | 'VarChar'
  | 'Array'
  | 'JSON'
  | 'BinaryVector'
  | 'FloatVector'
  | 'Float16Vector'
  | 'BFloat16Vector'
  | 'SparseFloatVector';

type FieldSchema = {
  name: string;
  data_type: DataType;
  is_primary_key?: boolean;
  max_length?: number;
  dim?: number;
  nullable?: boolean;
  is_partition_key?: boolean;
};

type HasCollectionParams = {
  collection_name: string;
};

type HasCollectionResponse = {
  value: boolean;
};

type DropCollectionParams = {
  collection_name: string;
};

type CreateCollectionParams = {
  collection_name: string;
  fields: FieldSchema[];
  num_partitions?: number;
  auto_id?: boolean;
  properties?: Record<string, unknown>;
};

type CreateIndexParams = {
  collection_name: string;
  field_name: string;
  index_type: string;
  metric_type?: string;
};

type LoadCollectionParams = {
  collection_name: string;
};

type DeleteParams = {
  collection_name: string;
  filter: string;
};

type UpsertParams = {
  collection_name: string;
  data: Record<string, unknown>[];
};

type SearchParams = {
  collection_name: string;
  data: number[][];
  limit: number;
  filter?: string;
  output_fields?: string[];
};

type SearchResult = {
  id: string | number;
  score?: number;
  distance?: number;
  [key: string]: unknown;
};

type SearchResponse = {
  results: SearchResult[];
};

type MilvusRestClientConfig = {
  address: string;
  token?: string;
  timeout?: number;
};

// ============================================================================
// REST API Response Types
// ============================================================================

type MilvusApiResponse<T = unknown> = {
  code: number;
  message?: string;
  data?: T;
};

// ============================================================================
// MilvusRestClient Implementation
// ============================================================================

export class MilvusRestClient {
  private baseUrl: string;
  private token: string;
  private timeout: number;

  constructor(config: MilvusRestClientConfig) {
    // Normalize the address to a proper URL
    let address = config.address || '';

    // If address doesn't have a protocol, add https://
    if (!address.startsWith('http://') && !address.startsWith('https://')) {
      address = `https://${address}`;
    }

    // Remove trailing slash
    this.baseUrl = address.replace(/\/$/, '');
    this.token = config.token || '';
    this.timeout = config.timeout || 30000;
  }

  private async request<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Milvus API error: ${response.status} ${response.statusText} - ${errorText}`
        );
      }

      const result = (await response.json()) as MilvusApiResponse<T>;

      // Milvus REST API returns code 0 for success, non-zero for errors
      if (result.code !== 0) {
        throw new Error(
          `Milvus API error: code ${result.code} - ${result.message || 'Unknown error'}`
        );
      }

      return result.data as T;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Milvus API request timed out after ${this.timeout}ms`);
      }
      throw error;
    }
  }

  /**
   * Check if a collection exists
   */
  async hasCollection(params: HasCollectionParams): Promise<HasCollectionResponse> {
    const result = await this.request<{ has: boolean }>('/v2/vectordb/collections/has', {
      collectionName: params.collection_name,
    });

    return { value: result?.has ?? false };
  }

  /**
   * Drop a collection
   */
  async dropCollection(params: DropCollectionParams): Promise<void> {
    await this.request('/v2/vectordb/collections/drop', {
      collectionName: params.collection_name,
    });
  }

  /**
   * Create a collection with schema
   */
  async createCollection(params: CreateCollectionParams): Promise<void> {
    // Convert field schemas to REST API format
    const schema = {
      autoId: params.auto_id ?? false,
      enableDynamicField: false,
      fields: params.fields.map(field => {
        const fieldDef: Record<string, unknown> = {
          fieldName: field.name,
          dataType: field.data_type,
          isPrimary: field.is_primary_key ?? false,
        };

        // Build elementTypeParams object with all applicable properties
        const elementTypeParams: Record<string, string> = {};
        if (field.max_length !== undefined) {
          elementTypeParams.max_length = String(field.max_length);
        }
        if (field.dim !== undefined) {
          elementTypeParams.dim = String(field.dim);
        }
        if (Object.keys(elementTypeParams).length > 0) {
          fieldDef.elementTypeParams = elementTypeParams;
        }

        if (field.nullable !== undefined) {
          fieldDef.nullable = field.nullable;
        }

        if (field.is_partition_key) {
          fieldDef.isPartitionKey = true;
        }

        return fieldDef;
      }),
    };

    const requestBody: Record<string, unknown> = {
      collectionName: params.collection_name,
      schema,
    };

    if (params.num_partitions !== undefined) {
      requestBody.numPartitions = params.num_partitions;
    }

    if (params.properties) {
      requestBody.properties = params.properties;
    }

    await this.request('/v2/vectordb/collections/create', requestBody);
  }

  /**
   * Create an index on a field
   */
  async createIndex(params: CreateIndexParams): Promise<void> {
    const indexParams: Record<string, unknown>[] = [
      {
        fieldName: params.field_name,
        indexType: params.index_type,
      },
    ];

    if (params.metric_type) {
      indexParams[0].metricType = params.metric_type;
    }

    await this.request('/v2/vectordb/indexes/create', {
      collectionName: params.collection_name,
      indexParams,
    });
  }

  /**
   * Load a collection into memory
   */
  async loadCollection(params: LoadCollectionParams): Promise<void> {
    await this.request('/v2/vectordb/collections/load', {
      collectionName: params.collection_name,
    });
  }

  /**
   * Delete entities by filter
   */
  async delete(params: DeleteParams): Promise<void> {
    await this.request('/v2/vectordb/entities/delete', {
      collectionName: params.collection_name,
      filter: params.filter,
    });
  }

  /**
   * Upsert data into a collection
   */
  async upsert(params: UpsertParams): Promise<void> {
    await this.request('/v2/vectordb/entities/upsert', {
      collectionName: params.collection_name,
      data: params.data,
    });
  }

  /**
   * Search for similar vectors
   */
  async search(params: SearchParams): Promise<SearchResponse> {
    const requestBody: Record<string, unknown> = {
      collectionName: params.collection_name,
      data: params.data,
      limit: params.limit,
      outputFields: params.output_fields || [],
    };

    if (params.filter) {
      requestBody.filter = params.filter;
    }

    // Milvus REST API can return results in different formats:
    // - Array of arrays (one per query vector): [[{id, distance, ...}], ...]
    // - Flat array: [{id, distance, ...}, ...]
    const rawResults = await this.request<unknown>('/v2/vectordb/entities/search', requestBody);

    // Normalize results to a flat array
    const results: SearchResult[] = [];

    if (rawResults == null) {
      return { results };
    }

    // Handle array response
    if (Array.isArray(rawResults)) {
      for (const item of rawResults) {
        if (Array.isArray(item)) {
          // Nested array format: [[{...}, {...}], ...]
          for (const result of item) {
            if (result && typeof result === 'object') {
              const normalizedResult = this.normalizeSearchResult(result as SearchResult);
              results.push(normalizedResult);
            }
          }
        } else if (item && typeof item === 'object') {
          // Flat array format: [{...}, {...}, ...]
          const normalizedResult = this.normalizeSearchResult(item as SearchResult);
          results.push(normalizedResult);
        }
      }
    }

    return { results };
  }

  /**
   * Normalize a search result to have consistent field names
   */
  private normalizeSearchResult(result: SearchResult): SearchResult {
    // Convert 'distance' to 'score' for compatibility with existing code
    // For COSINE similarity, distance is already the similarity score (0-1)
    return {
      ...result,
      score: result.distance !== undefined ? Number(result.distance) : result.score,
    };
  }
}
