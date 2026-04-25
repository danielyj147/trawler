import { z } from 'zod';
import type { Adapter } from './types.js';
import type { JobInput } from '../schema.js';

// Workable's public widget API response format
const WorkableWidgetJob = z.object({
  shortcode: z.string(),
  title: z.string(),
  url: z.string(),
  city: z.string().nullable().optional(),
  department: z.string().nullable().optional(),
  published: z.string().nullable().optional(),
  shortlink: z.string().nullable().optional(),
}).passthrough();

const WorkableWidgetResponse = z.object({
  name: z.string().optional(),
  jobs: z.array(WorkableWidgetJob),
}).passthrough();

export const workable: Adapter = {
  ats_type: 'workable',

  // Public widget API — no auth required
  buildUrl(slug: string): string {
    return `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}`;
  },

  parse(responseBody: string): JobInput[] {
    const data = WorkableWidgetResponse.parse(JSON.parse(responseBody));
    return data.jobs.map(job => ({
      external_id: job.shortcode,
      title: job.title,
      url: job.url,
      location: job.city ?? null,
      department: job.department ?? null,
      ats_posted_at: job.published ?? null,
      raw_json: JSON.stringify(job),
    }));
  },
};
