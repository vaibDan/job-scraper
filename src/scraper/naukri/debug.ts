// src/scraper/naukri/debug.ts
import { chromium } from "playwright";
import { SCRAPER_CONFIG } from "../../../config/scraper.config.js";

async function debugNaukri(): Promise<void> {
    const url = "https://www.naukri.com/devops-engineer-jobs?experience=0";
    console.log("🔬 Naukri DOM Inspector\n");

    const launchOptions = {
        headless: false, // visual — so you can also inspect manually
        ...(SCRAPER_CONFIG.browser.executablePath
            ? { executablePath: SCRAPER_CONFIG.browser.executablePath }
            : {}),
    };

    const browser = await chromium.launch(launchOptions);

    const context = await browser.newContext({
        userAgent:
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        viewport: { width: 1280, height: 800 },
    });

    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(4000);

    console.log(`📄 Title: ${await page.title()}`);
    console.log(`📍 URL:   ${page.url()}\n`);

    // Try every plausible selector
    const candidates = await page.evaluate(() => {
        const selectors = [
            ".srp-jobtuple-wrapper",
            ".jobTuple",
            ".job-tuple",
            ".cust-job-tuple",
            "[data-job-id]",
            "article.job-post",
            ".job_ad_container",
            ".list",
            "[class*='jobTuple']",
            "[class*='job-tuple']",
            "[class*='jobtuple']",
            "[class*='JobTuple']",
            "[class*='srpResultCard']",
            "[class*='job-card']",
            "[class*='jobCard']",
        ];

        return selectors.map((sel) => {
            const els = document.querySelectorAll(sel);
            const first = els[0];
            return {
                selector: sel,
                count: els.length,
                // Grab class names of first match to help identify it
                classes: first ? (first as HTMLElement).className.slice(0, 120) : null,
                // Sample text
                text: first ? first.textContent?.trim().slice(0, 100) : null,
            };
        });
    });

    console.log("📊 Selector results:");
    candidates.forEach((c) => {
        if (c.count > 0) {
            console.log(`\n  ✅ "${c.selector}" → ${c.count} elements`);
            console.log(`     classes: ${c.classes}`);
            console.log(`     text:    ${c.text}`);
        } else {
            console.log(`  ✗  "${c.selector}" → 0`);
        }
    });

    // Also dump a raw HTML sample of the job list area
    const rawHtml = await page.evaluate(() => {
        // Try to find the main job list container
        const containers = [
            document.querySelector("main"),
            document.querySelector("#listContainer"),
            document.querySelector(".list-container"),
            document.querySelector("[class*='list']"),
        ].filter(Boolean);

        return containers[0]?.innerHTML.slice(0, 2000) ?? document.body.innerHTML.slice(0, 2000);
    });

    console.log("\n📄 Raw HTML sample (first 2000 chars of main content):");
    console.log(rawHtml);

    console.log("\n⏸  Browser stays open 15s — inspect DevTools if needed");
    await page.waitForTimeout(15000);
    await browser.close();
}

debugNaukri().catch(console.error);