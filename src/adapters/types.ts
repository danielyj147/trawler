import type { JobInput } from '../schema.js';

export interface Adapter {
  readonly ats_type: string;
  /** Build the URL to fetch for a given company slug */
  buildUrl(slug: string): string;
  /** Optional: return RequestInit for non-GET requests (e.g. Ashby GraphQL POST) */
  buildFetchInit?(slug: string): RequestInit;
  /** Parse a raw API response body into normalized jobs */
  parse(responseBody: string): JobInput[];
}
