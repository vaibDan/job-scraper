/**
 * Parser Layer — RawJob[] → NormalizedJob[]
 *
 * Responsibilities:
 * 1. Reject jobs with missing critical fields (title, url)
 * 2. Clean LinkedIn tracking params from URLs
 * 3. Generate a deterministic ID for dedup (used in Phase 3)
 * 4. Guarantee no nulls exit this layer
 */

import type { RawJob } from "../scraper/types.js";
import type { NormalizedJob } from "../scraper/types.js";
import { createHash } from "crypto";

/**
 * Removes LinkedIn tracking query params from job URLs.
 * Raw URL looks like:
 *   https://www.linkedin.com/jobs/view/123456?refId=abc&trackingId=xyz&position=1
 * We only want:
 *   https://www.linkedin.com/jobs/view/123456
 */
function cleanUrl(rawUrl: string): string {
    try {
        const url = new URL(rawUrl);
        // LinkedIn tracking params — strip all of them
        ["refId", "trackingId", "position", "pageNum", "trk", "src"].forEach((p) =>
            url.searchParams.delete(p)
        );
        return url.toString();
    } catch {
        return rawUrl; // if URL is malformed, return as-is
    }
}

/**
 * Generates a stable ID for a job.
 * Same job scraped twice → same ID → enables dedup in CSV.
 *
 * We hash: lowercase(title + company + location)
 * NOT the URL — LinkedIn URLs contain job IDs that can change.
 */
function generateId(title: string, company: string, location: string): string {
    const raw = `${title}|${company}|${location}`.toLowerCase().trim();
    return createHash("md5").update(raw).digest("hex").slice(0, 12);
}

export function parseJobs(rawJobs: RawJob[]): {
    normalized: NormalizedJob[];
    skipped: number;
} {
    let skipped = 0;
    const normalized: NormalizedJob[] = [];

    for (const raw of rawJobs) {
        // Hard reject: title or URL missing = unusable
        if (!raw.title || !raw.url) {
            skipped++;
            continue;
        }

        const title = raw.title.trim();
        const company = (raw.company ?? "Unknown").trim();
        const location = (raw.location ?? "Unknown").trim();
        const url = cleanUrl(raw.url);

        normalized.push({
            id: generateId(title, company, location),
            title,
            company,
            location,
            url,
            description: raw.description ?? "",
            scrapedAt: raw.scrapedAt,
        });
    }

    return { normalized, skipped };
}