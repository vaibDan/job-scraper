/**
 * URL Builder for LinkedIn Jobs search.
 *
 * Why a separate module? Because URL construction is pure logic —
 * no browser needed, fully testable, and easy to swap out for other
 * job boards (Naukri, Wellfound) later without touching the scraper.
 */

import { SCRAPER_CONFIG } from "../../config/scraper.config.js";

/**
 * Builds the LinkedIn Jobs search URL with all our filters baked in.
 *
 * LinkedIn's search URL structure:
 * https://www.linkedin.com/jobs/search/?keywords=...&location=...&f_E=2&f_TPR=r604800
 *
 * We use URLSearchParams so special chars (spaces, OR) get encoded correctly.
 */
export function buildLinkedInSearchUrl(): string {
  const { baseUrl, searchParams } = SCRAPER_CONFIG.linkedin;

  const params = new URLSearchParams({
    keywords: searchParams.keywords,
    location: searchParams.location,
    f_E: searchParams.f_E, // Entry level
    f_TPR: searchParams.f_TPR, // Past week
    // Sort by date (most recent first) — "DD" = date descending
    sortBy: "DD",
  });

  return `${baseUrl}?${params.toString()}`;
}
