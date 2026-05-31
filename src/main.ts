import { scrapeLinkedInJobs } from "./scraper/index.js";
import { parseJobs } from "./parser/index.js";
import { filterJobs } from "./filters/index.js";
import { saveJobs } from "./storage/index.js";

async function main(): Promise<void> {
  try {
    // ── Phase 1: Scrape ──────────────────────────────────────────────
    const scrapeResult = await scrapeLinkedInJobs();

    // ── Phase 2a: Parse ──────────────────────────────────────────────
    const { normalized, skipped } = parseJobs(scrapeResult.jobs);

    console.log(`\n📦 Parser`);
    console.log(`   Input  : ${scrapeResult.jobs.length} raw jobs`);
    console.log(`   Output : ${normalized.length} normalized (${skipped} skipped — missing fields)`);

    // ── Phase 2b: Filter ─────────────────────────────────────────────
    const { passed, rejected } = filterJobs(normalized);

    console.log(`\n🔽 Filter`);
    console.log(`   Passed : ${passed.length}`);
    console.log(`   Rejected: ${rejected.length}`);

    if (rejected.length > 0) {
      console.log("\n   Rejected jobs:");
      rejected.forEach(({ job, reason }) => {
        console.log(`   ✗ ${job.title} @ ${job.company}`);
        console.log(`     → ${reason}`);
      });
    }

    // console.log("\n✅ Jobs that passed all filters:");
    // console.log("─".repeat(60));
    // passed.forEach((job, i) => {
    //   console.log(`[${String(i + 1).padStart(2, "0")}] ${job.title}`);
    //   console.log(`     🏢 ${job.company}`);
    //   console.log(`     📍 ${job.location}`);
    //   console.log(`     🔗 ${job.url}`);
    //   console.log(`     🆔 ${job.id}`);
    //   console.log();
    // });

    // ── Phase 3: Storage ─────────────────────────────────────────────
    const storageResult = saveJobs(passed);
    console.log(`\n💾 Storage`);
    console.log(`   Added      : ${storageResult.added} new jobs`);
    console.log(`   Duplicates : ${storageResult.duplicates} already in CSV`);
    console.log(`   Total in CSV: ${storageResult.totalInFile}`);

    // ── Summary ──────────────────────────────────────────────────────
    console.log("━".repeat(50));
    console.log("📋 Run Summary");
    console.log(`   Scraped  : ${scrapeResult.scrapedCount}`);
    console.log(`   Parsed   : ${normalized.length}`);
    console.log(`   Filtered : ${passed.length} jobs ready`);
    console.log("━".repeat(50));
    console.log("\n✅ Phase 3 complete. Next: Phase 4 (AI ranking)\n");

  } catch (error) {
    console.error("\n❌ PJSS run failed:", error);
    process.exit(1);
  }
}

main();