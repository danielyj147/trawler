import { z } from 'zod';
import type { Adapter } from './types.js';
import type { JobInput } from '../schema.js';

const LeverPosting = z.object({
  id: z.string(),
  text: z.string(),
  hostedUrl: z.string(),
  createdAt: z.number(),
  categories: z.object({
    location: z.string().optional(),
    department: z.string().optional(),
  }).passthrough().optional().default({}),
}).passthrough();

const LeverResponse = z.array(LeverPosting);

export const lever: Adapter = {
  ats_type: 'lever',

  buildUrl(slug: string): string {
    return `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}`;
  },

  parse(responseBody: string): JobInput[] {
    const data = LeverResponse.parse(JSON.parse(responseBody));
    return data.map(posting => ({
      external_id: posting.id,
      title: posting.text,
      url: posting.hostedUrl,
      location: posting.categories?.location ?? null,
      department: posting.categories?.department ?? null,
      // createdAt is epoch ms — the posting creation time
      ats_posted_at: new Date(posting.createdAt).toISOString(),
      raw_json: JSON.stringify(posting),
    }));
  },
};
