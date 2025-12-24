/**
 * HubSpot CRM API Client
 *
 * REST client for HubSpot CRM API v3 (2025).
 * Supports contacts, companies, deals via Private App Token.
 */

import { ConnectorError } from '@datatrust/core';

export interface HubSpotClientConfig {
  /** Private App Access Token */
  accessToken: string;
  /** API base URL (default: https://api.hubspot.com) */
  baseUrl?: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeoutMs?: number;
}

/** HubSpot CRM object types */
export type HubSpotObjectType = 'contacts' | 'companies' | 'deals' | 'tickets';

/** HubSpot filter operator */
export type HubSpotFilterOperator =
  | 'EQ'
  | 'NEQ'
  | 'LT'
  | 'LTE'
  | 'GT'
  | 'GTE'
  | 'CONTAINS_TOKEN'
  | 'IN';

/** HubSpot search filter */
export interface HubSpotFilter {
  propertyName: string;
  operator: HubSpotFilterOperator;
  value: string;
}

/** HubSpot search request */
export interface HubSpotSearchRequest {
  filterGroups?: { filters: HubSpotFilter[] }[];
  sorts?: { propertyName: string; direction: 'ASCENDING' | 'DESCENDING' }[];
  properties?: string[];
  limit?: number;
  after?: string;
}

/** HubSpot record */
export interface HubSpotRecord {
  id: string;
  properties: Record<string, string | null>;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}

/** HubSpot list response */
export interface HubSpotListResponse {
  results: HubSpotRecord[];
  paging?: {
    next?: {
      after: string;
    };
  };
  total?: number;
}

/** HubSpot property definition */
export interface HubSpotProperty {
  name: string;
  label: string;
  type: string;
  fieldType: string;
  description: string;
  groupName: string;
  options?: { label: string; value: string }[];
  calculated: boolean;
  hasUniqueValue: boolean;
  modificationMetadata: {
    readOnlyValue: boolean;
  };
}

export class HubSpotClient {
  private config: HubSpotClientConfig;
  private baseUrl: string;

  constructor(config: HubSpotClientConfig) {
    this.config = config;
    this.baseUrl = config.baseUrl ?? 'https://api.hubspot.com';
  }

  /**
   * List records with pagination
   */
  async list(
    objectType: HubSpotObjectType,
    options: {
      properties?: string[];
      limit?: number;
      after?: string;
    } = {}
  ): Promise<HubSpotListResponse> {
    const params = new URLSearchParams();

    if (options.properties?.length) {
      params.set('properties', options.properties.join(','));
    }
    if (options.limit) {
      params.set('limit', String(Math.min(options.limit, 100)));
    }
    if (options.after) {
      params.set('after', options.after);
    }

    const query = params.toString();
    const url = `/crm/v3/objects/${objectType}${query ? `?${query}` : ''}`;

    return this.request<HubSpotListResponse>('GET', url);
  }

  /**
   * Search records with filters
   */
  async search(
    objectType: HubSpotObjectType,
    searchRequest: HubSpotSearchRequest
  ): Promise<HubSpotListResponse> {
    return this.request<HubSpotListResponse>(
      'POST',
      `/crm/v3/objects/${objectType}/search`,
      searchRequest
    );
  }

  /**
   * Get a single record by ID
   */
  async get(
    objectType: HubSpotObjectType,
    id: string,
    properties?: string[]
  ): Promise<HubSpotRecord> {
    const params = properties?.length
      ? `?properties=${properties.join(',')}`
      : '';

    return this.request<HubSpotRecord>(
      'GET',
      `/crm/v3/objects/${objectType}/${id}${params}`
    );
  }

  /**
   * Create a new record
   */
  async create(
    objectType: HubSpotObjectType,
    properties: Record<string, string>
  ): Promise<HubSpotRecord> {
    return this.request<HubSpotRecord>(
      'POST',
      `/crm/v3/objects/${objectType}`,
      { properties }
    );
  }

  /**
   * Update an existing record
   */
  async update(
    objectType: HubSpotObjectType,
    id: string,
    properties: Record<string, string>
  ): Promise<HubSpotRecord> {
    return this.request<HubSpotRecord>(
      'PATCH',
      `/crm/v3/objects/${objectType}/${id}`,
      { properties }
    );
  }

  /**
   * Delete a record
   */
  async delete(objectType: HubSpotObjectType, id: string): Promise<void> {
    await this.request('DELETE', `/crm/v3/objects/${objectType}/${id}`);
  }

  /**
   * Batch create records
   */
  async batchCreate(
    objectType: HubSpotObjectType,
    records: { properties: Record<string, string> }[]
  ): Promise<HubSpotListResponse> {
    return this.request<HubSpotListResponse>(
      'POST',
      `/crm/v3/objects/${objectType}/batch/create`,
      { inputs: records }
    );
  }

  /**
   * Batch update records
   */
  async batchUpdate(
    objectType: HubSpotObjectType,
    records: { id: string; properties: Record<string, string> }[]
  ): Promise<HubSpotListResponse> {
    return this.request<HubSpotListResponse>(
      'POST',
      `/crm/v3/objects/${objectType}/batch/update`,
      { inputs: records }
    );
  }

  /**
   * Get properties for an object type
   */
  async getProperties(objectType: HubSpotObjectType): Promise<HubSpotProperty[]> {
    const response = await this.request<{ results: HubSpotProperty[] }>(
      'GET',
      `/crm/v3/properties/${objectType}`
    );
    return response.results;
  }

  /**
   * Test connection by fetching account info
   */
  async testConnection(): Promise<boolean> {
    try {
      await this.request('GET', '/crm/v3/objects/contacts?limit=1');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Make an API request
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const timeoutMs = this.config.timeoutMs ?? 30_000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') {
        throw new ConnectorError({
          code: 'TIMEOUT',
          message: `HubSpot request timed out after ${timeoutMs}ms`,
          suggestion: 'Increase timeoutMs or check network connectivity.',
        });
      }

      throw new ConnectorError({
        code: 'CONNECTION_FAILED',
        message: `Failed to connect to HubSpot API: ${(err as Error).message}`,
        cause: err instanceof Error ? err : undefined,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      let errorMessage = `HTTP ${response.status}`;

      try {
        const errorBody = await response.json() as { message?: string };
        if (errorBody.message) {
          errorMessage = errorBody.message;
        }
      } catch {
        // Ignore JSON parse errors
      }

      if (response.status === 401) {
        throw new ConnectorError({
          code: 'AUTHENTICATION_FAILED',
          message: `HubSpot authentication failed: ${errorMessage}`,
          suggestion: 'Check your Private App access token.',
        });
      }

      if (response.status === 429) {
        throw new ConnectorError({
          code: 'RATE_LIMITED',
          message: 'HubSpot API rate limit exceeded',
          suggestion: 'Wait and retry, or reduce request frequency.',
        });
      }

      throw new ConnectorError({
        code: 'READ_FAILED',
        message: `HubSpot API error: ${errorMessage}`,
      });
    }

    // Handle 204 No Content
    if (response.status === 204) {
      return undefined as T;
    }

    return response.json() as Promise<T>;
  }
}
