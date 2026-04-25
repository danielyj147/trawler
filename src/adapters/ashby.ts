import { z } from 'zod';
import type { Adapter } from './types.js';
import type { JobInput } from '../schema.js';

const AshbyJobPosting = z.object({
  id: z.string(),
  title: z.string(),
  locationName: z.string(),
  employmentType: z.string().optional(),
  compensationTierSummary: z.string().nullable().optional(),
}).passthrough();

const AshbyResponse = z.object({
  data: z.object({
    jobBoard: z.object({
      jobPostings: z.array(AshbyJobPosting),
    }).passthrough().nullable(),
  }).passthrough(),
}).passthrough();

// Only request fields that exist on JobPostingBriefsWithIdsAndTeamId.
// No publishedDate, departmentName, jobUrl, or description available at list level.
const ASHBY_QUERY = `query ApiJobBoardWithTeams($organizationHostedJobsPageName: String!) {
  jobBoard: jobBoardWithTeams(organizationHostedJobsPageName: $organizationHostedJobsPageName) {
    jobPostings {
      id
      title
      locationName
      employmentType
      compensationTierSummary
    }
  }
}`;

export const ashby: Adapter = {
  ats_type: 'ashby',

  buildUrl(_slug: string): string {
    return 'https://jobs.ashbyhq.com/api/non-user-graphql';
  },

  buildFetchInit(slug: string): RequestInit {
    return {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operationName: 'ApiJobBoardWithTeams',
        variables: { organizationHostedJobsPageName: slug },
        query: ASHBY_QUERY,
      }),
    };
  },

  parse(responseBody: string): JobInput[] {
    const data = AshbyResponse.parse(JSON.parse(responseBody));
    if (!data.data.jobBoard) return []; // Board doesn't exist
    return data.data.jobBoard.jobPostings.map(posting => ({
      external_id: posting.id,
      title: posting.title,
      // Construct URL from slug — Ashby's list endpoint doesn't return jobUrl
      url: `https://jobs.ashbyhq.com/unknown/${posting.id}`,
      location: posting.locationName ?? null,
      department: null, // Not available at list level; teamId exists but not team name
      // Not available at list level — Ashby doesn't expose publishedDate in this query
      ats_posted_at: null,
      raw_json: JSON.stringify(posting),
    }));
  },
};

/**
 * After-the-fact: set the correct job URL once we know the org slug.
 * Called by the scheduler after parse(), which doesn't have the slug.
 */
export function fixAshbyJobUrls(jobs: JobInput[], slug: string): void {
  for (const job of jobs) {
    if (job.url.includes('/unknown/')) {
      job.url = `https://jobs.ashbyhq.com/${slug}/${job.external_id}`;
    }
  }
}
