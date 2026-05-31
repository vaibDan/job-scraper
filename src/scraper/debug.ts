/**
 * DOM Inspector — Run this when selectors stop working.
 *
 * LinkedIn periodically changes their CSS class names.
 * This script opens the page and dumps all candidate selectors
 * so you can quickly find the new ones.
 *
 * Usage:  npm run debug
 */

import { chromium } from "playwright";
import { SCRAPER_CONFIG } from "../../config/scraper.config.js";
import { buildLinkedInSearchUrl } from "./buildUrl.js";

async function debugSelectors(): Promise<void> {
  const url = buildLinkedInSearchUrl();
  console.log("🔬 DOM Inspector — finding job card selectors\n");
  console.log(`URL: ${url}\n`);

  const browser = await chromium.launch({
    headless: false, // VISUAL mode — you can see what's happening
    // executablePath: SCRAPER_CONFIG.browser.executablePath,
    slowMo: 500, // slow enough to watch
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(5000);

  // Dump all elements that look like they could be job cards
  const candidates = await page.evaluate(() => {
    const selectors = [
      ".base-card",
      ".job-search-card",
      "[data-entity-urn]",
      ".jobs-search__results-list li",
      ".scaffold-layout__list li",
    ];

    return selectors.map((sel) => ({
      selector: sel,
      count: document.querySelectorAll(sel).length,
      // Sample text from first match
      sample: document.querySelector(sel)?.textContent?.trim().slice(0, 100) ?? null,
    }));
  });

  console.log("📊 Selector candidates:");
  candidates.forEach((c) => {
    console.log(`  ${c.selector.padEnd(40)} → ${c.count} elements`);
    if (c.sample) console.log(`     Sample: "${c.sample}"`);
  });

  // Also dump page title and URL to confirm we're on the right page
  console.log(`\n📄 Page title: ${await page.title()}`);
  console.log(`📍 Final URL:  ${page.url()}`);

  // Keep browser open 10s so you can inspect manually
  console.log("\n⏸  Browser stays open for 10s — inspect DevTools if needed");
  await page.waitForTimeout(10000);

  await browser.close();
}

debugSelectors().catch(console.error);
