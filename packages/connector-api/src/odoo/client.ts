/**
 * Odoo JSON-RPC Client
 *
 * Low-level client for Odoo's JSON-RPC API.
 * Handles authentication and request formatting.
 */

import { ConnectorError } from '@datatrust/core';

export interface OdooClientConfig {
  /** Odoo server URL (e.g., https://mycompany.odoo.com) */
  url: string;
  /** Database name */
  database: string;
  /** Username (email) */
  username: string;
  /** Password or API key */
  password: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeoutMs?: number;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: 'call';
  params: {
    service: 'common' | 'object';
    method: string;
    args: unknown[];
  };
  id: number;
}

interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id: number;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: {
      name?: string;
      debug?: string;
      message?: string;
      arguments?: string[];
    };
  };
}

export class OdooClient {
  private config: OdooClientConfig;
  private uid: number | null = null;
  private requestId = 0;

  constructor(config: OdooClientConfig) {
    this.config = config;
  }

  /**
   * Authenticate and get user ID
   */
  async authenticate(): Promise<number> {
    const response = await this.jsonRpc<number | false>({
      service: 'common',
      method: 'authenticate',
      args: [
        this.config.database,
        this.config.username,
        this.config.password,
        {},
      ],
    });

    if (response === false) {
      throw new ConnectorError({
        code: 'AUTHENTICATION_FAILED',
        message: 'Odoo authentication failed',
        suggestion: 'Check database name, username, and password/API key.',
      });
    }

    this.uid = response;
    return response;
  }

  /**
   * Check if authenticated
   */
  get isAuthenticated(): boolean {
    return this.uid !== null;
  }

  /**
   * Get server version info
   */
  async version(): Promise<Record<string, unknown>> {
    return this.jsonRpc({
      service: 'common',
      method: 'version',
      args: [],
    });
  }

  /**
   * Execute a method on an Odoo model
   */
  async execute<T = unknown>(
    model: string,
    method: string,
    args: unknown[] = [],
    kwargs: Record<string, unknown> = {}
  ): Promise<T> {
    if (!this.uid) {
      throw new ConnectorError({
        code: 'AUTHENTICATION_FAILED',
        message: 'Not authenticated. Call authenticate() first.',
      });
    }

    return this.jsonRpc<T>({
      service: 'object',
      method: 'execute_kw',
      args: [
        this.config.database,
        this.uid,
        this.config.password,
        model,
        method,
        args,
        kwargs,
      ],
    });
  }

  /**
   * Search for record IDs matching domain
   */
  async search(
    model: string,
    domain: unknown[][] = [],
    options: { offset?: number; limit?: number; order?: string } = {}
  ): Promise<number[]> {
    return this.execute<number[]>(model, 'search', [domain], options);
  }

  /**
   * Read records by IDs
   */
  async read(
    model: string,
    ids: number[],
    fields: string[] = []
  ): Promise<Record<string, unknown>[]> {
    const kwargs = fields.length > 0 ? { fields } : {};
    return this.execute<Record<string, unknown>[]>(model, 'read', [ids], kwargs);
  }

  /**
   * Search and read in one call (most efficient)
   */
  async searchRead(
    model: string,
    domain: unknown[][] = [],
    options: {
      fields?: string[];
      offset?: number;
      limit?: number;
      order?: string;
    } = {}
  ): Promise<Record<string, unknown>[]> {
    return this.execute<Record<string, unknown>[]>(
      model,
      'search_read',
      [domain],
      options
    );
  }

  /**
   * Count records matching domain
   */
  async searchCount(model: string, domain: unknown[][] = []): Promise<number> {
    return this.execute<number>(model, 'search_count', [domain]);
  }

  /**
   * Create a new record
   */
  async create(
    model: string,
    values: Record<string, unknown>
  ): Promise<number> {
    return this.execute<number>(model, 'create', [values]);
  }

  /**
   * Update existing records
   */
  async write(
    model: string,
    ids: number[],
    values: Record<string, unknown>
  ): Promise<boolean> {
    return this.execute<boolean>(model, 'write', [ids, values]);
  }

  /**
   * Delete records
   */
  async unlink(model: string, ids: number[]): Promise<boolean> {
    return this.execute<boolean>(model, 'unlink', [ids]);
  }

  /**
   * Get field definitions for a model
   */
  async fieldsGet(
    model: string,
    attributes: string[] = ['string', 'type', 'required', 'readonly']
  ): Promise<Record<string, Record<string, unknown>>> {
    return this.execute<Record<string, Record<string, unknown>>>(
      model,
      'fields_get',
      [],
      { attributes }
    );
  }

  /**
   * Make a JSON-RPC request
   */
  private async jsonRpc<T>(params: {
    service: 'common' | 'object';
    method: string;
    args: unknown[];
  }): Promise<T> {
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      method: 'call',
      params,
      id: ++this.requestId,
    };

    const endpoint = `${this.config.url}/jsonrpc`;
    const timeoutMs = this.config.timeoutMs ?? 30_000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') {
        throw new ConnectorError({
          code: 'TIMEOUT',
          message: `Odoo request timed out after ${timeoutMs}ms`,
          suggestion: 'Increase timeoutMs or check network connectivity.',
        });
      }

      throw new ConnectorError({
        code: 'CONNECTION_FAILED',
        message: `Failed to connect to Odoo server: ${(err as Error).message}`,
        suggestion: 'Check the Odoo server URL and network connectivity.',
        cause: err instanceof Error ? err : undefined,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new ConnectorError({
        code: 'CONNECTION_FAILED',
        message: `HTTP ${response.status}: ${response.statusText}`,
        suggestion: 'Check the Odoo server URL and network connectivity.',
      });
    }

    const json = (await response.json()) as JsonRpcResponse<T>;

    if (json.error) {
      const errorMsg = json.error.data?.message || json.error.message;
      throw new ConnectorError({
        code: 'READ_FAILED',
        message: `Odoo error: ${errorMsg}`,
        context: { odooError: json.error },
      });
    }

    return json.result as T;
  }
}
