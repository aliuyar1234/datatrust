/**
 * HubSpot Connector
 *
 * Exports for HubSpot CRM integration.
 */

export { HubSpotClient } from './client.js';
export type {
  HubSpotClientConfig,
  HubSpotObjectType,
  HubSpotFilterOperator,
  HubSpotFilter,
  HubSpotSearchRequest,
  HubSpotRecord,
  HubSpotListResponse,
  HubSpotProperty,
} from './client.js';

export { HubSpotConnector, createHubSpotConnector } from './connector.js';
export type { HubSpotConnectorConfig } from './connector.js';
