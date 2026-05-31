/**
 * Filter Engine — Rule-based job rejection
 *
 * Philosophy: every rejected job has an explicit reason.
 * No silent drops. The FilterResult tells you exactly what passed/failed and why.
 *
 * Rules are applied in order. First failing rule short-circuits the rest.
 */

import type { NormalizedJob } from "../scraper/types.js";

export interface FilterResult {
    passed: NormalizedJob[];
    rejected: Array<{ job: NormalizedJob; reason: string }>;
}

// ─── Rule configuration ───────────────────────────────────────────────────────

/**
 * Title must contain at least one of these (case-insensitive).
 * Keeps: "DevOps Engineer", "Cloud Platform SRE", "Infrastructure Engineer"
 */
const ROLE_KEYWORDS = [
    "devops",
    "dev ops",
    "dev. ops",
    "cloud",
    "sre",
    "site reliability",
    "platform engineer",
    "infrastructure engineer",
    "cloud engineer",
    "devsecops",
];

/**
 * Titles containing any of these are auto-rejected.
 * Catches senior/lead roles that slip through entry-level filters.
 */
// const SENIORITY_BLOCKLIST = [
//     "senior",
//     "sr.",
//     "sr ",
//     "lead",
//     "principal",
//     "staff",
//     "head of",
//     "director",
//     "vp ",
//     "vice president",
//     "architect", // usually 5+ years
//     "manager",
// ];

// Replace the simple SENIORITY_BLOCKLIST with a smarter check

const SENIORITY_BLOCKLIST = [
    "sr.",
    "sr ",
    "lead ",
    "principal",
    "staff engineer",
    "head of",
    "director",
    "vp ",
    "vice president",
    "architect",
    "manager",
];

// "Senior" gets its own check — only block if it's a title-level word,
// not an internal band like "Senior Associate" or "Senior Consultant"
const SENIOR_ROLE_PATTERNS = [
    /^senior\s/i,              // starts with "Senior ..."
    /senior\s+(devops|sre|cloud|platform|infrastructure|site\s+reliability|engineer\b)/i,
];

function passesSeniorityFilter(job: NormalizedJob): string | null {
    const title = job.title.toLowerCase();

    // Check blocklist words
    const blocked = SENIORITY_BLOCKLIST.find((kw) => title.includes(kw));
    if (blocked) return `Title contains seniority keyword: "${blocked}"`;

    // Check senior-specific patterns
    const seniorMatch = SENIOR_ROLE_PATTERNS.find((pattern) => pattern.test(job.title));
    if (seniorMatch) return `Title matches senior role pattern`;

    return null;
}           
/**
 * Location must contain at least one of these.
 * LinkedIn sometimes shows "India" as "Bengaluru, Karnataka, India" — substring match handles it.
 */
const LOCATION_ALLOWLIST = ["india",
    "remote",
    "anywhere",
    "anywhere",
    "worldwide",
    "metropolitan region",
    "bengaluru",
    "bangalore",
    "hyderabad",
    "pune",
    "chennai",
    "mumbai",
    "delhi",
    "gurugram",
    "noida",
    "worldwide"];

// ─── Individual rule functions ────────────────────────────────────────────────

function passesRoleFilter(job: NormalizedJob): string | null {
    const title = job.title.toLowerCase();
    const matches = ROLE_KEYWORDS.some((kw) => title.includes(kw));
    return matches ? null : `Title "${job.title}" doesn't match role keywords`;
}

// function passesSeniorityFilter(job: NormalizedJob): string | null {
//     return passesSeniorityFilter(job);
// }

function passesLocationFilter(job: NormalizedJob): string | null {
    const location = job.location.toLowerCase();
    const matches = LOCATION_ALLOWLIST.some((kw) => location.includes(kw));
    return matches ? null : `Location "${job.location}" not in allowlist`;
}

// ─── Main filter function ─────────────────────────────────────────────────────

const RULES: Array<(job: NormalizedJob) => string | null> = [
    passesRoleFilter,
    passesSeniorityFilter,
    passesLocationFilter,
];

export function filterJobs(jobs: NormalizedJob[]): FilterResult {
    const passed: NormalizedJob[] = [];
    const rejected: FilterResult["rejected"] = [];

    for (const job of jobs) {
        let rejectionReason: string | null = null;

        for (const rule of RULES) {
            const result = rule(job);
            if (result !== null) {
                rejectionReason = result;
                break; // first failing rule wins
            }
        }

        if (rejectionReason === null) {
            passed.push(job);
        } else {
            rejected.push({ job, reason: rejectionReason });
        }
    }

    return { passed, rejected };
}