/**
 * PJSS Orchestrator
 *
 * Pipeline:
 *   LinkedIn scraper  ─┐
 *                      ├─→ merge → parse → filter → storage
 *   Naukri scraper   ─┘
 */

import { scrapeLinkedInJobs } from "./scraper/index.js";
import { scrapeNaukriJobs } from "./scraper/naukri/index.js";
import { parseJobs } from "./parser/index.js";
import { filterJobs } from "./filters/index.js";
import { saveJobs } from "./storage/index.js";

// Control which scrapers run — flip to false to skip one
const RUN_LINKEDIN = false;
const RUN_NAUKRI = true;

async function main(): Promise<void> {
  try {
    const allRaw = [];

    // ── Scrape ───────────────────────────────────────────────────────────
    if (RUN_LINKEDIN) {
      const result = await scrapeLinkedInJobs();
      allRaw.push(...result.jobs);
      console.log(`📌 LinkedIn: ${result.scrapedCount} raw jobs\n`);
    }

    if (RUN_NAUKRI) {
      const result = await scrapeNaukriJobs();
      allRaw.push(...result.jobs);
      console.log(`📌 Naukri: ${result.scrapedCount} raw jobs\n`);
    }

    console.log(`📦 Total raw: ${allRaw.length} jobs from all sources\n`);

    // ── Parse ────────────────────────────────────────────────────────────
    const { normalized, skipped } = parseJobs(allRaw);
    console.log(`📦 Parser`);
    console.log(`   Input  : ${allRaw.length}`);
    console.log(`   Output : ${normalized.length} (${skipped} skipped)\n`);

    // ── Filter ───────────────────────────────────────────────────────────
    const { passed, rejected } = filterJobs(normalized);
    console.log(`🔽 Filter`);
    console.log(`   Passed  : ${passed.length}`);
    console.log(`   Rejected: ${rejected.length}`);

    if (rejected.length > 0) {
      console.log("\n   Rejected:");
      rejected.forEach(({ job, reason }) => {
        console.log(`   ✗ ${job.title} @ ${job.company}`);
        console.log(`     → ${reason}`);
      });
    }

    // ── Storage ──────────────────────────────────────────────────────────
    const storageResult = saveJobs(passed);
    console.log(`\n💾 Storage`);
    console.log(`   Added       : ${storageResult.added} new jobs`);
    console.log(`   Duplicates  : ${storageResult.duplicates} already in CSV`);
    console.log(`   Total in CSV: ${storageResult.totalInFile}`);

    // ── Summary ──────────────────────────────────────────────────────────
    const withJd = passed.filter((j) => j.description && j.description.length > 0).length;
    console.log("\n" + "━".repeat(50));
    console.log(`📋 Run Summary`);
    console.log(`   New jobs saved : ${storageResult.added}`);
    console.log(`   With full JD   : ${withJd}`);
    console.log(`   Total tracked  : ${storageResult.totalInFile}`);
    console.log("━".repeat(50));
    console.log("\n✅ Done. Open data/job_tracker.csv to review.\n");

  } catch (error) {
    console.error("\n❌ PJSS run failed:", error);
    process.exit(1);
  }
}

main();