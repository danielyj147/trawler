import { z } from 'zod';
import type { Adapter } from './types.js';
import type { JobInput } from '../schema.js';

// .passthrough() on every object so raw_json preserves the full ATS response.
// Matching needs fields we don't normalize (content, metadata, offices, etc.).
const GreenhouseJob = z.object({
  id: z.number(),
  title: z.string(),
  absolute_url: z.string(),
  updated_at: z.string(),
  location: z.object({ name: z.string() }).passthrough().nullable().optional(),
  departments: z.array(z.object({ name: z.string() }).passthrough()).optional().default([]),
}).passthrough();

const GreenhouseResponse = z.object({
  jobs: z.array(GreenhouseJob),
}).passthrough();

export const greenhouse: Adapter = {
  ats_type: 'greenhouse',

  buildUrl(slug: string): string {
    return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`;
  },

  parse(responseBody: string): JobInput[] {
    const data = GreenhouseResponse.parse(JSON.parse(responseBody));
    return data.jobs.map(job => ({
      external_id: String(job.id),
      title: job.title,
      url: job.absolute_url,
      location: job.location?.name ?? null,
      department: job.departments[0]?.name ?? null,
      // first_published is the original posting date (stable).
      // updated_at changes on edits. Prefer first_published when available.
      ats_posted_at: (job as any).first_published ?? job.updated_at ?? null,
      raw_json: JSON.stringify(job),
    }));
  },
};
