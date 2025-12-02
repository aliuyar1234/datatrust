/**
 * Custom error types for connectors
 * Actionable error messages are key for LLM usability
 */

export type ErrorCode =
  | 'CONNECTION_FAILED'
  | 'AUTHENTICATION_FAILED'
  | 'NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'PERMISSION_DENIED'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'SCHEMA_MISMATCH'
  | 'WRITE_FAILED'
  | 'READ_FAILED'
  | 'UNSUPPORTED_OPERATION'
  | 'CONFIGURATION_ERROR'
  | 'UNKNOWN';

export interface ConnectorErrorDetails {
  /** Error code for programmatic handling */
  code: ErrorCode;
  /** Human-readable message */
  message: string;
  /** Connector ID that raised the error */
  connectorId?: string;
  /** Suggested action to resolve */
  suggestion?: string;
  /** Original error (if wrapping) */
  cause?: Error;
  /** Additional context */
  context?: Record<string, unknown>;
}

export class ConnectorError extends Error {
  readonly code: ErrorCode;
  readonly connectorId?: string;
  readonly suggestion?: string;
  readonly context?: Record<string, unknown>;

  constructor(details: ConnectorErrorDetails) {
    super(details.message);
    this.name = 'ConnectorError';
    this.code = details.code;
    this.connectorId = details.connectorId;
    this.suggestion = details.suggestion;
    this.context = details.context;

    if (details.cause) {
      this.cause = details.cause;
    }

    // Maintains proper stack trace in V8 environments
    if ('captureStackTrace' in Error) {
      (Error as typeof Error & { captureStackTrace: (target: object, constructor?: Function) => void })
        .captureStackTrace(this, ConnectorError);
    }
  }

  /**
   * Format error for LLM consumption
   * Returns a structured, actionable error message
   */
  toActionableMessage(): string {
    const parts = [
      `Error [${this.code}]: ${this.message}`,
    ];

    if (this.connectorId) {
      parts.push(`Connector: ${this.connectorId}`);
    }

    if (this.suggestion) {
      parts.push(`Suggested action: ${this.suggestion}`);
    }

    return parts.join('\n');
  }

  /**
   * Convert to JSON for structured error responses
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      connectorId: this.connectorId,
      suggestion: this.suggestion,
      context: this.context,
    };
  }
}

/**
 * Helper to wrap unknown errors as ConnectorError
 */
export function wrapError(
  error: unknown,
  connectorId?: string,
  defaultCode: ErrorCode = 'UNKNOWN'
): ConnectorError {
  if (error instanceof ConnectorError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? error : undefined;

  return new ConnectorError({
    code: defaultCode,
    message,
    connectorId,
    cause,
  });
}
