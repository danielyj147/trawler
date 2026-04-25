import type { CompanyInput } from '../schema.js';

export interface DiscoveryResult {
  company: CompanyInput;
  source_type: string;
  source_detail: string;
}

export interface DiscoverySource {
  readonly source_type: string;
  discover(): AsyncGenerator<DiscoveryResult>;
}
