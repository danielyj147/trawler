import { z } from 'zod';

export const ATS_TYPES = ['greenhouse', 'lever', 'ashby', 'workable'] as const;
export type AtsType = (typeof ATS_TYPES)[number];

// --- Input schemas: what discovery sources and adapters produce ---

export const CompanyInput = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
  ats_type: z.enum(ATS_TYPES),
  ats_url: z.string().url(),
});
export type CompanyInput = z.infer<typeof CompanyInput>;

export const SourceInput = z.object({
  source_type: z.string().min(1),
  source_detail: z.string().min(1),
});
export type SourceInput = z.infer<typeof SourceInput>;

export const JobInput = z.object({
  external_id: z.string().min(1),
  title: z.string().min(1),
  url: z.string().url(),
  location: z.string().nullable(),
  department: z.string().nullable(),
  ats_posted_at: z.string().nullable(),
  raw_json: z.string().min(1),
});
export type JobInput = z.infer<typeof JobInput>;

// --- Row schemas: what the database returns ---

export const CompanyRow = z.object({
  id: z.number().int(),
  name: z.string(),
  slug: z.string(),
  ats_type: z.string(),
  ats_url: z.string(),
  discovered_at: z.string(),
  active: z.number().int(),
  next_poll_at: z.string().nullable(),
  poll_interval_ms: z.number().int(),
  consecutive_failures: z.number().int(),
  disabled_at: z.string().nullable(),
});
export type CompanyRow = z.infer<typeof CompanyRow>;

export const JobRow = z.object({
  id: z.number().int(),
  external_id: z.string(),
  company_id: z.number().int(),
  title: z.string(),
  url: z.string(),
  location: z.string().nullable(),
  department: z.string().nullable(),
  ats_posted_at: z.string().nullable(),
  first_seen_at: z.string(),
  updated_at: z.string(),
  raw_json: z.string(),
});
export type JobRow = z.infer<typeof JobRow>;
