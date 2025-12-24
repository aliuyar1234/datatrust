/**
 * JSON Connector
 * Reads and writes JSON files (arrays of objects)
 */

import type { Record } from '@datatrust/core';
import { ConnectorError } from '@datatrust/core';
import {
  BaseFileConnector,
  type FileConnectorConfig,
} from './base-file-connector.js';

export interface JsonConnectorConfig extends FileConnectorConfig {
  type: 'json';
  /** JSON path to the records array (e.g., 'data.items') */
  recordsPath?: string;
  /** Pretty print output (default: true) */
  prettyPrint?: boolean;
  /** Indentation spaces (default: 2) */
  indent?: number;
}

const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

function parseSafePath(path: string, connectorId: string): string[] {
  const parts = path.split('.');
  if (parts.length === 0 || parts.some((p) => p.length === 0)) {
    throw new ConnectorError({
      code: 'CONFIGURATION_ERROR',
      message: `Invalid recordsPath: "${path}"`,
      connectorId,
      suggestion: 'Use dot notation with non-empty segments (e.g., "data.items").',
    });
  }

  for (const part of parts) {
    if (FORBIDDEN_PATH_SEGMENTS.has(part)) {
      throw new ConnectorError({
        code: 'CONFIGURATION_ERROR',
        message: `Unsafe recordsPath segment: "${part}"`,
        connectorId,
        suggestion:
          'Avoid __proto__/prototype/constructor in recordsPath to prevent prototype pollution.',
      });
    }
  }

  return parts;
}

/**
 * Get nested value from object using dot notation path
 */
function getNestedValue(obj: unknown, path: string, connectorId: string): unknown {
  const parts = parseSafePath(path, connectorId);
  let current = obj;

  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }

    if (typeof current !== 'object') {
      return undefined;
    }

    if (!Object.prototype.hasOwnProperty.call(current, part)) {
      return undefined;
    }

    current = (current as Record)[part];
  }

  return current;
}

/**
 * Set nested value in object using dot notation path
 */
function setNestedValue(
  obj: Record,
  path: string,
  value: unknown,
  connectorId: string
): void {
  const parts = parseSafePath(path, connectorId);
  let current = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;

    const next = Object.prototype.hasOwnProperty.call(current, part)
      ? current[part]
      : undefined;

    if (next === null || next === undefined || typeof next !== 'object') {
      current[part] = Object.create(null);
    }

    current = current[part] as Record;
  }

  current[parts[parts.length - 1]!] = value;
}

export class JsonConnector extends BaseFileConnector<JsonConnectorConfig> {
  private _originalStructure: unknown = null;

  constructor(config: Omit<JsonConnectorConfig, 'type'> & { type?: 'json' }) {
    super({ ...config, type: 'json' });
  }

  protected async parseContent(content: string | Buffer): Promise<Record[]> {
    try {
      const parsed = JSON.parse(content.toString());
      this._originalStructure = parsed;

      // If recordsPath is specified, extract from that path
      if (this.config.recordsPath) {
        const records = getNestedValue(
          parsed,
          this.config.recordsPath,
          this.config.id
        );

        if (!Array.isArray(records)) {
          throw new ConnectorError({
            code: 'SCHEMA_MISMATCH',
            message: `Path '${this.config.recordsPath}' does not contain an array`,
            connectorId: this.config.id,
            suggestion: 'Check that recordsPath points to an array of objects.',
          });
        }

        return records as Record[];
      }

      // Default: expect root to be an array
      if (!Array.isArray(parsed)) {
        throw new ConnectorError({
          code: 'SCHEMA_MISMATCH',
          message: 'JSON file does not contain an array at root level',
          connectorId: this.config.id,
          suggestion:
            'Either provide a JSON file with an array at root, or specify recordsPath.',
        });
      }

      return parsed as Record[];
    } catch (error) {
      if (error instanceof ConnectorError) {
        throw error;
      }

      throw new ConnectorError({
        code: 'SCHEMA_MISMATCH',
        message: `Invalid JSON: ${(error as Error).message}`,
        connectorId: this.config.id,
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  protected async serializeContent(records: Record[]): Promise<string> {
    const indent = this.config.prettyPrint !== false ? (this.config.indent ?? 2) : 0;

    // If we have a recordsPath, preserve the original structure
    if (this.config.recordsPath && this._originalStructure) {
      const output: Record = Object.create(null);
      if (typeof this._originalStructure === 'object' && this._originalStructure) {
        for (const key of Object.keys(this._originalStructure as Record)) {
          output[key] = (this._originalStructure as Record)[key];
        }
      }

      setNestedValue(output, this.config.recordsPath, records, this.config.id);
      return JSON.stringify(output, null, indent);
    }

    // Default: write array directly
    return JSON.stringify(records, null, indent);
  }
}

/**
 * Factory function to create a JSON connector
 */
export function createJsonConnector(
  config: Omit<JsonConnectorConfig, 'type'>
): JsonConnector {
  return new JsonConnector(config);
}
