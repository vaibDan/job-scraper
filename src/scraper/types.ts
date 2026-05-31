/**
 * Core data types for the PJSS pipeline.
 *
 * Design note: We keep types in a shared file so every layer
 * (scraper, parser, filter, storage) speaks the same language.
 * TypeScript enforces this at compile time — no silent field mismatches.
 */

/**
 * Raw data as extracted directly from the LinkedIn DOM.
 * Fields may be missing/null — that's expected. The parser layer cleans this up.
 */
export interface RawJob {
  title: string | null;
  company: string | null;
  location: string | null;
  url: string | null;
  // LinkedIn doesn't always expose this on the card — may be null
  description: string | null;
  // ISO timestamp of when we scraped it — useful for dedup later
  scrapedAt: string;
}

/**
 * Cleaned, validated job after passing through the parser layer.
 * All required fields are guaranteed non-null.
 */
export interface NormalizedJob {
  id: string; // deterministic hash: company + title + location
  title: string;
  company: string;
  location: string;
  url: string;
  description: string; // empty string if unavailable (never null)
  scrapedAt: string;
}

/**
 * Scraper result — wraps the data with metadata about the run.
 * This is what scraper/index.ts returns to main.ts.
 */
export interface ScrapeResult {
  jobs: RawJob[];
  totalFound: number; // how many cards were on the page
  scrapedCount: number; // how many we actually extracted (may be less due to errors)
  runAt: string; // ISO timestamp
  searchUrl: string; // the URL we scraped — useful for debugging
}
