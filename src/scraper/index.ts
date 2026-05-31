/**
 * LinkedIn Job Scraper
 *
 * Strategy:
 * 1. Load the search page
 * 2. Scroll `maxPages` times to trigger lazy loading
 * 3. Extract ALL cards from final DOM state in one pass
 *
 * No XHR intercept, no artificial job cap, no complexity.
 */

import { chromium } from "playwright";
import { SCRAPER_CONFIG } from "../../config/scraper.config.js";
import { buildLinkedInSearchUrl } from "./buildUrl.js";
import type { RawJob, ScrapeResult } from "./types.js";

function dedup(jobs: RawJob[]): RawJob[] {
  const seen = new Set<string>();
  return jobs.filter((job) => {
    if (!job.url) return false;
    const key = job.url.split("?")[0];
    if (seen.has(key as string)) return false;
    seen.add(key as string);
    return true;
  });
}

export async function scrapeLinkedInJobs(): Promise<ScrapeResult> {
  const searchUrl = buildLinkedInSearchUrl();
  const runAt = new Date().toISOString();
  const scrapedAt = runAt;
  const { maxPages, pageDelay, pageLoadWait } = SCRAPER_CONFIG.scraping;

  console.log("\n🚀 PJSS Scraper — LinkedIn");
  console.log("━".repeat(50));
  console.log(`🔍 URL     : ${searchUrl}`);
  console.log(`📄 Scrolls : ${maxPages}`);
  console.log(`📅 Started : ${runAt}\n`);

  const browser = await chromium.launch({
    headless: SCRAPER_CONFIG.browser.headless,
    slowMo: SCRAPER_CONFIG.browser.slowMo,
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();

  // Block images, fonts, tracking — speeds up page load significantly
  await page.route(
    "**/*.{png,jpg,jpeg,gif,svg,ico,woff,woff2,mp4,webm}",
    (route) => route.abort()
  );
  await page.route("**/li/track**", (route) => route.abort());

  let allJobs: RawJob[] = [];

  try {
    // ── Step 1: Initial load ──────────────────────────────────────────────
    console.log("🌐 Loading page...");
    await page.goto(searchUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    // Wait for first batch of cards to render
    await page.waitForSelector(".base-card", {
      timeout: SCRAPER_CONFIG.scraping.elementTimeout,
    }).catch(() => console.warn("⚠️  No cards found on initial load"));

    await page.waitForTimeout(pageLoadWait);

    const initialCount = await page.locator(".base-card").count();
    console.log(`✅ Initial load: ${initialCount} cards in DOM`);

    // ── Step 2: Scroll to load more cards ────────────────────────────────
    for (let i = 1; i <= maxPages; i++) {
      const delay = pageDelay();
      console.log(`⏳ Scroll ${i}/${maxPages} — waiting ${delay}ms...`);
      await page.waitForTimeout(delay);

      const beforeCount = await page.locator(".base-card").count();

      // Scroll to bottom — triggers LinkedIn's lazy loader
      await page.evaluate(() =>
        window.scrollTo(0, document.body.scrollHeight)
      );

      // Wait for new cards to appear (up to 4s)
      await page.waitForFunction(
        (before: number) => document.querySelectorAll(".base-card").length > before,
        beforeCount,
        { timeout: 4000 }
      ).catch(() => null); // no new cards = end of results, not an error

      const afterCount = await page.locator(".base-card").count();

      if (afterCount > beforeCount) {
        console.log(`   ↳ ${afterCount - beforeCount} new cards loaded (total: ${afterCount})`);
      } else {
        console.log(`   ↳ No new cards — LinkedIn has no more results`);
        break;
      }
    }

    // ── Step 3: Extract all cards from final DOM state ────────────────────
    // Single pass after all scrolling is done
    const rawJobs = await page.evaluate((scrapedAt: string) => {
      return Array.from(document.querySelectorAll(".base-card")).map((card) => {
        const getText = (sel: string) =>
          card.querySelector(sel)?.textContent?.trim() ?? null;

        const linkEl = card.querySelector("a.base-card__full-link");

        return {
          title: getText(".base-search-card__title"),
          company: getText(".base-search-card__subtitle"),
          location: getText(".job-search-card__location"),
          url: linkEl ? (linkEl as HTMLAnchorElement).href : null,
          description: null as null,
          scrapedAt,
        };
      });
    }, scrapedAt);

    allJobs = dedup(rawJobs);

    console.log(`\n✅ Extraction complete: ${allJobs.length} jobs (deduped)`);

  } catch (error) {
    console.error("❌ Scraping failed:", error);
    throw error;
  } finally {
    await browser.close();
    console.log("✅ Browser closed\n");
  }

  return {
    jobs: allJobs,
    totalFound: allJobs.length,
    scrapedCount: allJobs.length,
    runAt,
    searchUrl,
  };
}