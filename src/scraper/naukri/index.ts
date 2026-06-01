/**
 * Naukri Job Scraper
 *
 * Why Naukri over LinkedIn for JDs:
 * - Full job description visible without login
 * - Clean, stable HTML structure
 * - India-focused — better signal for our target market
 * - Less aggressive bot detection than LinkedIn
 *
 * Architecture:
 * 1. Load search results page → extract job cards (title, company, location, url)
 * 2. For each job card → visit detail page → extract full JD
 * 3. Return RawJob[] with description populated
 *
 * Naukri DOM structure (search results page):
 *   .srp-jobtuple-wrapper         → job card container
 *     .title                      → job title (anchor tag)
 *     .comp-name                  → company name
 *     .locWdth                    → location
 *     .expwdth                    → experience required
 *
 * Naukri DOM structure (job detail page):
 *   .styles_job-desc-container__txljR  → full JD container (new UI)
 *   .dang-inner-html                   → JD inner content
 *   #job_description                   → fallback
 */

import { chromium, type Page } from "playwright";
import { SCRAPER_CONFIG } from "../../../config/scraper.config.js";
import { buildNaukriSearchUrl, NAUKRI_SEARCHES, type NaukriSearchParams } from "./buildUrl.js";
import type { RawJob, ScrapeResult } from "../types.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const NAUKRI_CONFIG = {
    // Max job cards to collect per search keyword
    maxJobsPerSearch: 20,
    // Max detail pages to visit (JD fetching) — costs time, be conservative
    maxJdsToFetch: 15,
    // Delay between detail page visits — be respectful
    jdDelay: () => Math.floor(Math.random() * 1000) + 800, // 0.8–1.8s
    // Page load wait
    pageLoadWait: 3000,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

/**
 * Cleans raw text extracted from DOM:
 * - Collapses whitespace
 * - Removes zero-width chars
 * - Trims
 */
function cleanText(text: string | null): string {
    if (!text) return "";
    return text
        .replace(/[\u200B-\u200D\uFEFF]/g, "") // zero-width chars
        .replace(/\s+/g, " ")
        .trim();
}

// ─── Step 1: Scrape search results page ──────────────────────────────────────

/**
 * Extracts job cards from Naukri search results.
 * Returns title, company, location, url — NO description yet.
 */
async function scrapeSearchResults(
    page: Page,
    params: NaukriSearchParams,
    scrapedAt: string
): Promise<RawJob[]> {
    const url = buildNaukriSearchUrl(params);
    console.log(`\n  🔍 Searching: ${url}`);

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    // Naukri sometimes shows a bot challenge in headless mode
    // Wait longer and check if we actually got job cards
    await page.waitForTimeout(NAUKRI_CONFIG.pageLoadWait);

    // Check for bot wall — if title doesn't mention jobs, we're blocked
    const pageTitle = await page.title();
    console.log(`  📄 Page title: ${pageTitle}`);

    if (pageTitle.toLowerCase().includes("access denied") ||
        pageTitle.toLowerCase().includes("captcha") ||
        pageTitle === "") {
        console.warn("  ⚠️  Bot detection triggered — skipping this search");
        return [];
    }

    // Wait up to 8s for cards (longer than before)
    await page
        .waitForSelector(".srp-jobtuple-wrapper", { timeout: 8000 })
        .catch(() => console.warn("  ⚠️  Timeout waiting for cards"));

    // Extra wait for lazy-loaded content
    await page.waitForTimeout(1500);

    const jobs = await page.evaluate(
        ({ maxJobs, scrapedAt }: { maxJobs: number; scrapedAt: string }) => {
            const cards = Array.from(
                document.querySelectorAll(".srp-jobtuple-wrapper")
            ).slice(0, maxJobs);

            return cards.map((card) => {
                // Title + URL
                const titleEl =
                    card.querySelector("a.title") ??
                    card.querySelector(".title a") ??
                    card.querySelector("a[title]");

                const title = titleEl?.textContent?.trim() ?? null;
                const url = titleEl ? (titleEl as HTMLAnchorElement).href : null;

                // Company
                const company =
                    card.querySelector(".comp-name")?.textContent?.trim() ??
                    card.querySelector("a.comp-name")?.textContent?.trim() ??
                    null;

                // Location — Naukri shows multiple cities, grab all
                const location =
                    card.querySelector(".locWdth")?.textContent?.trim() ??
                    card.querySelector(".loc")?.textContent?.trim() ??
                    card.querySelector("[class*='location']")?.textContent?.trim() ??
                    null;

                return { title, company, location, url, description: null, scrapedAt };
            });
        },
        { maxJobs: NAUKRI_CONFIG.maxJobsPerSearch, scrapedAt }
    );

    const valid = jobs.filter((j) => j.title && j.url);
    console.log(`  ✅ Found ${valid.length} job cards`);
    return valid;
}

// ─── Step 2: Fetch JD from detail page ───────────────────────────────────────

/**
 * Visits a single job detail page and extracts the full description.
 *
 * Naukri has gone through multiple UI redesigns — we try multiple selectors
 * in order of likelihood and fall back gracefully.
 */
async function fetchJobDescription(page: Page, url: string): Promise<string> {
    try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
        await page.waitForTimeout(1500);

        const description = await page.evaluate(() => {
            // Try selectors in order — Naukri changes these periodically
            const selectors = [
                ".styles_job-desc-container__txljR", // 2024+ new UI
                ".dang-inner-html",                   // common inner container
                "#job_description",                   // old UI
                ".job-desc",                          // fallback
                "[class*='job-desc']",               // wildcard fallback
                ".description__text",                // another variant
            ];

            for (const sel of selectors) {
                const el = document.querySelector(sel);
                if (el && el.textContent && el.textContent.trim().length > 50) {
                    return el.textContent.trim();
                }
            }
            return "";
        });

        return cleanText(description);
    } catch {
        // Don't crash the whole run if one JD fetch fails
        return "";
    }
}

// ─── Step 3: Enrich jobs with JDs ────────────────────────────────────────────

/**
 * Takes job cards (no description) and fetches JDs for the top N.
 * We cap at maxJdsToFetch to avoid hammering Naukri.
 */
async function enrichWithDescriptions(
    page: Page,
    jobs: RawJob[]
): Promise<RawJob[]> {
    const toEnrich = jobs.slice(0, NAUKRI_CONFIG.maxJdsToFetch);
    const rest = jobs.slice(NAUKRI_CONFIG.maxJdsToFetch);

    console.log(
        `\n  📄 Fetching JDs for ${toEnrich.length} jobs (${rest.length} will have no description)...`
    );

    const enriched: RawJob[] = [];


    for (let i = 0; i < toEnrich.length; i++) {
        const job = toEnrich[i];
        if (!job) continue;
        if (!job.url) {
            enriched.push(job);
            continue;
        }

        const delay = NAUKRI_CONFIG.jdDelay();
        process.stdout.write(
            `  [${String(i + 1).padStart(2, "0")}/${toEnrich.length}] ${job.title?.slice(0, 40)}... `
        );

        await page.waitForTimeout(delay);
        const description = await fetchJobDescription(page, job.url);

        process.stdout.write(
            description.length > 0 ? `✅ (${description.length} chars)\n` : `⚠️  empty\n`
        );

        enriched.push({ ...job, description: description || null });
    }

    // Jobs we didn't fetch JDs for — return as-is with null description
    return [...enriched, ...rest];
}

// ─── Main scraper function ────────────────────────────────────────────────────

export async function scrapeNaukriJobs(): Promise<ScrapeResult> {
    const runAt = new Date().toISOString();
    const scrapedAt = runAt;

    console.log("\n🚀 PJSS Scraper — Naukri");
    console.log("━".repeat(50));
    console.log(`📅 Started : ${runAt}`);
    console.log(`🔍 Searches: ${NAUKRI_SEARCHES.length} keywords`);
    console.log(`📄 Max jobs : ${NAUKRI_CONFIG.maxJobsPerSearch} per keyword`);
    console.log(`📝 Max JDs  : ${NAUKRI_CONFIG.maxJdsToFetch} per keyword\n`);

    const browser = await chromium.launch({
        headless: SCRAPER_CONFIG.browser.naukriHeadless,
        slowMo: SCRAPER_CONFIG.browser.slowMo,
    });

    const context = await browser.newContext({
        userAgent:
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        viewport: { width: 1280, height: 800 },
        // Makes Playwright look less like a bot to Naukri
        extraHTTPHeaders: {
            "Accept-Language": "en-IN,en;q=0.9",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
    });

    const page = await context.newPage();

    // Block images and media — we only need text
    await page.route(
        "**/*.{png,jpg,jpeg,gif,svg,ico,woff,woff2,mp4,webm}",
        (route) => route.abort()
    );

    let allJobs: RawJob[] = [];

    try {
        for (const searchParams of NAUKRI_SEARCHES) {
            console.log(`\n📌 Keyword: "${searchParams.keyword}"`);

            // Step 1: Get job cards from search results
            const cards = await scrapeSearchResults(page, searchParams, scrapedAt);

            // Step 2: Fetch full JDs for each card
            const enriched = await enrichWithDescriptions(page, cards);

            allJobs.push(...enriched);

            const withJd = enriched.filter((j) => j.description && j.description.length > 0).length;
            console.log(`  📊 ${enriched.length} jobs, ${withJd} with full JD`);
        }

        // Dedup across all keyword searches
        allJobs = dedup(allJobs);

        console.log("\n━".repeat(50));
        console.log(`✅ Naukri scraping complete`);
        console.log(`   Total jobs (deduped) : ${allJobs.length}`);
        console.log(
            `   With descriptions   : ${allJobs.filter((j) => j.description && j.description.length > 0).length}`
        );
        console.log(
            `   Without descriptions: ${allJobs.filter((j) => !j.description || j.description.length === 0).length}`
        );
    } catch (error) {
        console.error("❌ Naukri scraping failed:", error);
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
        searchUrl: "https://www.naukri.com (multiple searches)",
    };
}