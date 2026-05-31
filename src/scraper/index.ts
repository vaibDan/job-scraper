/**
 * LinkedIn Job Scraper — Phase 1 Core
 *
 * Architecture decisions:
 * 1. headless: true in prod, false for debugging (flip in config)
 * 2. We scrape the PUBLIC LinkedIn jobs page — no login required for listings
 * 3. Each job card is scraped independently — one card failing doesn't crash the run
 * 4. We use page.evaluate() to run code inside the browser's JS context
 *    This is faster than Playwright's built-in locators for bulk extraction
 *
 * LinkedIn's DOM structure (as of 2025):
 *   ul.jobs-search__results-list > li > div.base-card
 *     .base-search-card__title     → job title
 *     .base-search-card__subtitle  → company name
 *     .job-search-card__location   → location
 *     a.base-card__full-link       → job URL
 */

import { chromium } from "playwright";
import { SCRAPER_CONFIG } from "../../config/scraper.config.js";
import { buildLinkedInSearchUrl } from "./buildUrl.js";
import type { RawJob, ScrapeResult } from "./types.js";

/**
 * Main scraper function.
 * Returns a ScrapeResult with raw (uncleaned) job data.
 * The parser layer handles cleaning — single responsibility.
 */
export async function scrapeLinkedInJobs(): Promise<ScrapeResult> {
  const searchUrl = buildLinkedInSearchUrl();
  const runAt = new Date().toISOString();
  const scrapedAt = runAt;

  console.log("\n🚀 PJSS Scraper — Phase 1");
  console.log("━".repeat(50));
  console.log(`🔍 Search URL: ${searchUrl}`);
  console.log(`📅 Run started: ${runAt}\n`);

  // Launch browser
  // headless: true = no visible window (for automation)
  // executablePath: use pre-installed Chromium, avoids download
  const browser = await chromium.launch({
    headless: SCRAPER_CONFIG.browser.headless,
    slowMo: SCRAPER_CONFIG.browser.slowMo,
  });

  console.log("✅ Browser launched");

  // Create a new browser context — like an incognito window
  // Contexts are isolated: cookies, cache, localStorage don't bleed between runs
  const context = await browser.newContext({
    // Pretend to be a real browser — LinkedIn checks user agents
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    // Set viewport — LinkedIn renders differently on mobile
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();

  // Block unnecessary resources to speed up scraping
  // Images, fonts, and media don't help us — skip them
  await page.route("**/*.{png,jpg,jpeg,gif,svg,ico,woff,woff2,mp4,webm}", (route) =>
    route.abort()
  );
  // Block LinkedIn analytics and tracking scripts
  await page.route("**/li/track**", (route) => route.abort());

  console.log("✅ Page configured (resource blocking enabled)");

  let jobs: RawJob[] = [];
  let totalFound = 0;

  try {
    // Navigate to the search URL
    console.log("🌐 Navigating to LinkedIn Jobs...");
    await page.goto(searchUrl, {
      // 'domcontentloaded' fires earlier than 'load' — LinkedIn's JS loads async
      // We'll wait manually after this for the cards to appear
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    // Wait for job cards to render
    // LinkedIn is a React SPA — DOM updates after initial load
    console.log(`⏳ Waiting ${SCRAPER_CONFIG.scraping.pageLoadWait}ms for cards to render...`);
    await page.waitForTimeout(SCRAPER_CONFIG.scraping.pageLoadWait);

    // Check if job cards are present
    // LinkedIn uses .base-card for each job listing
    const cardSelector = ".base-card";
    try {
      await page.waitForSelector(cardSelector, {
        timeout: SCRAPER_CONFIG.scraping.elementTimeout,
      });
      console.log("✅ Job cards detected in DOM");
    } catch {
      console.warn("⚠️  No job cards found — LinkedIn may have changed its DOM structure");
      console.warn("    Try: headless: false in config to debug visually");
    }

    // Count total cards available on the page
    totalFound = await page.locator(cardSelector).count();
    console.log(`📊 Total job cards on page: ${totalFound}`);

    // Extract data from all cards using page.evaluate()
    // page.evaluate() runs inside the browser's JS context — fast bulk extraction
    // We pass maxJobs as an argument (can't access Node.js vars directly in evaluate)
    const maxJobs = SCRAPER_CONFIG.scraping.maxJobs;

    console.log(`🔎 Extracting up to ${maxJobs} jobs...\n`);

    jobs = await page.evaluate(
      ({ maxJobs, scrapedAt }) => {
        // This code runs INSIDE the browser — DOM APIs are available here
        const cards = Array.from(document.querySelectorAll(".base-card")).slice(0, maxJobs);

        return cards.map((card): {
          title: string | null;
          company: string | null;
          location: string | null;
          url: string | null;
          description: string | null;
          scrapedAt: string;
        } => {
          // Helper: safely query an element and return its text
          const getText = (selector: string): string | null => {
            const el = card.querySelector(selector);
            return el ? el.textContent?.trim() ?? null : null;
          };

          // Job URL lives on the anchor tag wrapping the entire card
          const linkEl = card.querySelector("a.base-card__full-link");
          const rawUrl = linkEl ? (linkEl as HTMLAnchorElement).href : null;

          // LinkedIn URLs have tracking params — we'll clean those in the parser
          return {
            title: getText(".base-search-card__title"),
            company: getText(".base-search-card__subtitle"),
            location: getText(".job-search-card__location"),
            url: rawUrl,
            // Description is not available on the card — requires clicking into the job
            // We'll add this in Phase 2 (detail page scraping) if needed
            description: null,
            scrapedAt,
          };
        });
      },
      { maxJobs, scrapedAt }
    );

    // Log what we found
    console.log("━".repeat(50));
    console.log(`✅ Extraction complete — ${jobs.length} jobs extracted\n`);

    jobs.forEach((job, i) => {
      console.log(`[${String(i + 1).padStart(2, "0")}] ${job.title ?? "Unknown Title"}`);
      console.log(`     📍 ${job.company ?? "Unknown"} · ${job.location ?? "Unknown"}`);
      console.log(`     🔗 ${job.url ? job.url.substring(0, 70) + "..." : "No URL"}`);
      console.log();
    });
  } catch (error) {
    console.error("❌ Scraping failed:", error);
    throw error;
  } finally {
    // Always close the browser — even if scraping threw an error
    // Not closing = zombie browser processes that eat RAM
    await browser.close();
    console.log("✅ Browser closed");
  }

  return {
    jobs,
    totalFound,
    scrapedCount: jobs.length,
    runAt,
    searchUrl,
  };
}
