/**
 * Connector Registry
 *
 * Manages connector instances at runtime.
 * The MCP server uses this to route tool calls to the appropriate connector.
 */

import type { IConnector, ConnectorConfig } from '@datatrust/core';
import { ConnectorError } from '@datatrust/core';

export class ConnectorRegistry {
  private connectors = new Map<string, IConnector>();

  /**
   * Register a connector instance
   */
  register(connector: IConnector): void {
    const id = connector.config.id;

    if (this.connectors.has(id)) {
      throw new ConnectorError({
        code: 'CONFIGURATION_ERROR',
        message: `Connector with id '${id}' is already registered`,
        suggestion: 'Use a unique id for each connector instance.',
      });
    }

    this.connectors.set(id, connector);
  }

  /**
   * Get a connector by id
   */
  get(id: string): IConnector | undefined {
    return this.connectors.get(id);
  }

  /**
   * Get a connector by id, throw if not found
   */
  getOrThrow(id: string): IConnector {
    const connector = this.connectors.get(id);

    if (!connector) {
      throw new ConnectorError({
        code: 'NOT_FOUND',
        message: `Connector '${id}' not found`,
        suggestion: `Available connectors: ${this.listIds().join(', ') || 'none'}`,
      });
    }

    return connector;
  }

  /**
   * Remove a connector
   */
  async unregister(id: string): Promise<void> {
    const connector = this.connectors.get(id);

    if (connector) {
      await connector.disconnect();
      this.connectors.delete(id);
    }
  }

  /**
   * List all registered connector ids
   */
  listIds(): string[] {
    return Array.from(this.connectors.keys());
  }

  /**
   * List all registered connectors with basic info
   */
  list(): Array<{ id: string; name: string; type: string; state: string }> {
    return Array.from(this.connectors.values()).map((c) => ({
      id: c.config.id,
      name: c.config.name,
      type: c.config.type,
      state: c.state,
    }));
  }

  /**
   * Connect all registered connectors
   */
  async connectAll(): Promise<void> {
    const promises = Array.from(this.connectors.values()).map((c) => c.connect());
    await Promise.all(promises);
  }

  /**
   * Disconnect all registered connectors
   */
  async disconnectAll(): Promise<void> {
    const promises = Array.from(this.connectors.values()).map((c) => c.disconnect());
    await Promise.all(promises);
  }

  /**
   * Get count of registered connectors
   */
  get size(): number {
    return this.connectors.size;
  }
}

// Singleton instance
export const registry = new ConnectorRegistry();
