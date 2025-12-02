import { describe, expect, it, vi } from 'vitest';
import { ConnectorError } from '@datatrust/core';

vi.mock('../src/postgresql/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/postgresql/client.js')>();
  class FailingClient extends actual.PostgresClient {
    async connect(): Promise<void> {
      throw new Error('timeout');
    }
  }
  return { ...actual, PostgresClient: FailingClient };
});

import { createPostgresConnector } from '../src/postgresql/connector.js';

describe('Database connection error handling', () => {
  it('wraps connection timeouts in ConnectorError', async () => {
    const connector = createPostgresConnector({
      id: 'pg',
      name: 'pg',
      type: 'postgresql',
      table: 'dummy',
    });

    await expect(connector.connect()).rejects.toBeInstanceOf(ConnectorError);
  });
});
