/**
 * User profile — loaded at module-init time from JSON.
 *
 * Lookup order:
 *   1. $TRAWLER_PROFILE_PATH (absolute or relative)
 *   2. ./profile.local.json (the operator's real profile — gitignored)
 *   3. ./profile.example.json (committed template — generic placeholder)
 *
 * The profile shape is intentionally flat data — no prompt strings, no code
 * conditioned on it. Re-tunable without touching source.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface HardConstraint {
  type: 'visa' | 'graduation' | 'min_years' | 'clearance' | 'exclude_pattern' | 'location_us_only';
  value: string;
}

export interface Profile {
  name: string;
  graduation: string;        // YYYY-MM
  degree: string;
  citizenship: string[];
  location_preference: string[];
  experience_years: number;
  role_targets: string[];
  hard_constraints: HardConstraint[];
  skills: {
    strong: string[];
    working: string[];
    exposure: string[];
  };
  highlights: string[];      // resume-style bullets the qualifier shows the LLM
}

function loadProfile(): Profile {
  const repoRoot = path.resolve(import.meta.dirname, '..', '..');
  const candidates = [
    process.env.TRAWLER_PROFILE_PATH,
    path.join(repoRoot, 'profile.local.json'),
    path.join(repoRoot, 'profile.example.json'),
  ].filter((p): p is string => !!p);

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        const raw = fs.readFileSync(p, 'utf-8');
        return JSON.parse(raw) as Profile;
      } catch (err) {
        throw new Error(`Failed to parse profile at ${p}: ${(err as Error).message}`);
      }
    }
  }

  throw new Error(
    'No profile found. Set TRAWLER_PROFILE_PATH, copy profile.example.json to profile.local.json, ' +
    'or create profile.local.json directly.'
  );
}

export const PROFILE: Profile = loadProfile();
