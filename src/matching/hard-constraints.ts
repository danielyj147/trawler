import type { Profile } from './profile.js';

export interface ConstraintResult {
  passed: boolean;
  failures: string[];
}

// Languages that, when required as PRIMARY, should reject if not in candidate's strong/working skills
const PRIMARY_LANG_PATTERNS: { pattern: RegExp; skill: string }[] = [
  { pattern: /\b(?:golang|go\b(?!od))/i, skill: 'go' },
  { pattern: /\brust\b/i, skill: 'rust' },
  { pattern: /\bscala\b/i, skill: 'scala' },
  { pattern: /\bc#|\.net\b|dotnet/i, skill: 'c#' },
  { pattern: /\bswift\b/i, skill: 'swift' },
  { pattern: /\bruby\b/i, skill: 'ruby' },
  { pattern: /\bphp\b/i, skill: 'php' },
  { pattern: /\bkotlin\b/i, skill: 'kotlin' },
  { pattern: /\belixir\b/i, skill: 'elixir' },
  { pattern: /\berlang\b/i, skill: 'erlang' },
];

// Phrases indicating "this is the primary language, not optional"
const PRIMARY_INDICATORS = /(?:build|maintain|develop|write|using|proficien|expert|strong|require|must|primary|core)\b/i;

// Role patterns that are NOT SWE even if they contain "engineer" or "security"
const OPS_ADMIN_PATTERNS = /\b(?:vulnerability.?management|security.?operations|soc\b|compliance.?(?:engineer|analyst)|security.?tooling|sast.?\/?\s?dast|devsecops|penetration.?test|red.?team|blue.?team|security.?admin|it.?security|information.?security.?(?:officer|analyst)|grc\b)/i;

// Title patterns that signal a non-SWE security role even when no ops phrasing
// appears in the body. "Application Security Engineer" / "Security Engineer"
// without "software" in the title is almost always a security-admin function.
const SECURITY_TITLE = /\b(?:application\s+security|product\s+security|infrastructure\s+security|cloud\s+security|cybersecurity)\s+(?:engineer|analyst|specialist|architect)\b/i;

/**
 * Deterministic hard constraint check. No LLM.
 */
export function checkHardConstraints(profile: Profile, jobTitle: string, jobText: string): ConstraintResult {
  const failures: string[] = [];
  const titleLower = jobTitle.toLowerCase();
  const textLower = (jobText || '').toLowerCase();
  const combined = titleLower + ' ' + textLower;

  // Strip HTML for cleaner matching
  const cleanText = combined.replace(/<[^>]+>/g, ' ');

  for (const c of profile.hard_constraints) {
    switch (c.type) {
      case 'min_years': {
        const maxYears = parseInt(c.value, 10);

        // Anchors that, when near a "N years" phrase, indicate it's a requirement
        // (not marketing copy like "50 years of innovation").
        // Allow up to ~80 chars of filler between "years" and the anchor word.
        const anchor = '(?:experience|professional|work|relevant|engineering|development|software|industry|background|coding|programming|career|building)';

        // Range: "3-5 years of X" — lower bound is the requirement.
        const rangePattern = new RegExp(
          `(\\d+)\\s*[-–]\\s*(\\d+)\\s*(?:years?|yrs?)(?:\\s+of\\s+[^.;\\n]{0,80}?${anchor}|\\s+${anchor})`,
          'gi'
        );
        for (const match of cleanText.matchAll(rangePattern)) {
          const lower = parseInt(match[1], 10);
          if (lower >= maxYears) {
            failures.push(`Requires ${lower}-${match[2]} years experience (max ${maxYears - 1})`);
          }
        }

        // Non-range: "5+ years", "minimum 4 years", "4 years of engineering experience"
        const plusWithAnchor = new RegExp(
          `(?<!\\d\\s*[-–]\\s*)(\\d+)\\+?\\s*(?:years?|yrs?)(?:\\s+of\\s+[^.;\\n]{0,80}?${anchor}|\\s+${anchor})`,
          'gi'
        );
        const minimumPattern = /(?:minimum|at least|require[sd]?)\s+(\d+)\s*(?:years?|yrs?)/gi;
        const plusBareYears = /(?<!\d\s*[-–]\s*)(\d+)\+\s*(?:years?|yrs?)/gi;

        for (const pattern of [plusWithAnchor, minimumPattern, plusBareYears]) {
          for (const match of cleanText.matchAll(pattern)) {
            const years = parseInt(match[1], 10);
            if (years >= maxYears) {
              failures.push(`Requires ${years}+ years experience (max ${maxYears - 1})`);
            }
          }
        }
        break;
      }

      case 'exclude_pattern': {
        const patterns = c.value.split('|').map(p => p.trim().toLowerCase());
        for (const pattern of patterns) {
          if (titleLower.includes(pattern)) {
            failures.push(`Title contains excluded term: "${pattern}"`);
          }
        }
        break;
      }

      case 'clearance': {
        if (c.value === 'none') {
          const clearancePatterns = /(?:active\s+)?(?:ts\/sci|top secret|secret|ts)\s+(?:clearance|security)/gi;
          if (clearancePatterns.test(cleanText)) {
            failures.push('Requires security clearance');
          }
        }
        break;
      }
    }
  }

  // US-only location check
  for (const c of profile.hard_constraints) {
    if (c.type === 'location_us_only' && c.value === 'true') {
      const locLower = (jobTitle + ' ' + jobText).toLowerCase();
      const NON_US_INDICATORS = /\b(?:london|paris|berlin|munich|stuttgart|dublin|amsterdam|toronto|vancouver|montreal|singapore|tokyo|seoul|sydney|melbourne|bangalore|hyderabad|ireland|spain|germany|france|uk|united kingdom|canada|india|japan|australia|emea|apac|eu\b)/i;
      const US_INDICATORS = /\b(?:united states|usa?\b|new york|nyc|san francisco|sf|los angeles|la|seattle|austin|boston|chicago|denver|atlanta|remote.{0,20}(?:us|united states|usa))/i;

      // Check job location field if available
      let locationField = '';
      try {
        const raw = JSON.parse(jobText);
        locationField = (raw.location?.name || raw.locationName || raw.city || '').toLowerCase();
      } catch { /* jobText isn't JSON, use title+text matching only */ }
      const allLocationText = locationField + ' ' + locLower;

      if (NON_US_INDICATORS.test(allLocationText) && !US_INDICATORS.test(allLocationText)) {
        failures.push('Non-US location');
      }
    }
  }

  // Primary language mismatch — if the posting requires a language the candidate doesn't know
  const allSkills = new Set([
    ...profile.skills.strong.map(s => s.toLowerCase()),
    ...profile.skills.working.map(s => s.toLowerCase()),
  ]);

  for (const { pattern, skill } of PRIMARY_LANG_PATTERNS) {
    if (pattern.test(cleanText)) {
      // Check if it appears to be a primary requirement (near an indicator word)
      const sentences = cleanText.split(/[.;!\n]/).filter(s => pattern.test(s));
      const isPrimary = sentences.some(s => PRIMARY_INDICATORS.test(s));
      if (isPrimary && !allSkills.has(skill)) {
        failures.push(`Primary language: ${skill} (not in candidate skills)`);
      }
    }
  }

  // Security-ops vs SWE check — reject roles that are security operations/admin, not product engineering
  if (OPS_ADMIN_PATTERNS.test(cleanText) && !titleLower.includes('software')) {
    failures.push('Security operations/admin role, not software engineering');
  }

  // Title-only security-role check (catches "Application Security Engineer" etc.
  // even when the body doesn't use ops vocabulary).
  if (SECURITY_TITLE.test(jobTitle) && !titleLower.includes('software')) {
    failures.push(`Security role title (${jobTitle}), not software engineering`);
  }

  const unique = [...new Set(failures)];
  return { passed: unique.length === 0, failures: unique };
}
