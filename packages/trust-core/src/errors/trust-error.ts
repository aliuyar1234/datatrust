/**
 * Trust-specific Error Types
 */

export type TrustErrorCode =
  | 'SOURCE_NOT_CONNECTED'
  | 'TARGET_NOT_CONNECTED'
  | 'CONNECTOR_NOT_CONNECTED'
  | 'CONNECTOR_MISMATCH'
  | 'MAPPING_ERROR'
  | 'KEY_FIELD_MISSING'
  | 'COMPARISON_FAILED'
  | 'BATCH_PROCESSING_ERROR'
  | 'INVALID_OPTIONS'
  | 'SNAPSHOT_ERROR'
  | 'SNAPSHOT_EXISTS'
  | 'SNAPSHOT_NOT_FOUND'
  | 'AUDIT_LOG_ERROR'
  | 'AUDIT_QUERY_ERROR'
  | 'RECONCILIATION_ERROR'
  | 'INVALID_RULE';

export interface TrustErrorDetails {
  code: TrustErrorCode;
  message: string;
  suggestion?: string;
  cause?: Error;
  context?: Record<string, unknown>;
}

export class TrustError extends Error {
  readonly code: TrustErrorCode;
  readonly suggestion?: string;
  readonly context?: Record<string, unknown>;

  constructor(details: TrustErrorDetails) {
    super(details.message);
    this.name = 'TrustError';
    this.code = details.code;
    this.suggestion = details.suggestion;
    this.context = details.context;

    if (details.cause) {
      this.cause = details.cause;
    }
  }

  /**
   * Format error for LLM/MCP consumption
   */
  toActionableMessage(): string {
    const parts = [`Error [${this.code}]: ${this.message}`];
    if (this.suggestion) {
      parts.push(`Suggested action: ${this.suggestion}`);
    }
    return parts.join('\n');
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      suggestion: this.suggestion,
      context: this.context,
    };
  }
}
