/**
 * PJSS Orchestrator
 *
 * Pipeline:
 *   LinkedIn scraper  ─┐
 *                      ├─→ merge → parse → filter → store → rank → report
 *   Naukri scraper   ─┘
 */

import "dotenv/config";
import { scrapeLinkedInJobs } from "./scraper/index.js";
import { scrapeNaukriJobs } from "./scraper/naukri/index.js";
import { parseJobs } from "./parser/index.js";
import { filterJobs } from "./filters/index.js";
import { saveJobs } from "./storage/index.js";
import { rankJobs, updateCsvWithScores, type JobToRank } from "./ranking/index.js";
import { loadUnscoredJobsFromCsv } from "./ranking/index.js";

const RUN_LINKEDIN = false;
const RUN_NAUKRI = false;
const RUN_RANKING = true; // set false to skip AI ranking (saves API cost)

async function main(): Promise<void> {
  try {
    // ── Scrape ───────────────────────────────────────────────────────────
    const allRaw = [];

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

    // ── Parse ────────────────────────────────────────────────────────────
    const { normalized, skipped } = parseJobs(allRaw);
    console.log(`📦 Parser: ${normalized.length} normalized (${skipped} skipped)\n`);

    // ── Filter ───────────────────────────────────────────────────────────
    const { passed, rejected } = filterJobs(normalized);
    console.log(`🔽 Filter: ${passed.length} passed, ${rejected.length} rejected`);

    if (rejected.length > 0) {
      rejected.forEach(({ job, reason }) => {
        console.log(`   ✗ ${job.title} @ ${job.company} → ${reason}`);
      });
    }
    console.log();

    // ── Storage ──────────────────────────────────────────────────────────
    const storageResult = saveJobs(passed);
    console.log(`💾 Storage: ${storageResult.added} new, ${storageResult.duplicates} dupes, ${storageResult.totalInFile} total\n`);

    // ── Ranking ──────────────────────────────────────────────────────────
    if (RUN_RANKING) {
      // Always rank unscored CSV rows. This covers:
      // - newly saved jobs from this run (priority = 0)
      // - older jobs that were saved before ranking worked
      // - rank-only runs with scrapers disabled
      console.log("📂 Loading unscored jobs from CSV...");
      const toRank: JobToRank[] = loadUnscoredJobsFromCsv();
      console.log(`   Found ${toRank.length} unscored jobs (priority = 0)\n`);

      if (toRank.length === 0) {
        console.log("⏭  No jobs to rank — all already scored or no new jobs\n");
      } else {
        const ranked = await rankJobs(toRank);
        updateCsvWithScores(ranked);

        // ── Report: Top 5 ──────────────────────────────────────────────
        const top5 = ranked.filter((j) => j.action === "apply").slice(0, 5);
        const consider = ranked.filter((j) => j.action === "consider").length;
        const skip = ranked.filter((j) => j.action === "skip").length;

        console.log("\n" + "━".repeat(60));
        console.log("🎯 TOP JOBS — APPLY NOW");
        console.log("━".repeat(60));

        if (top5.length === 0) {
          console.log("  No jobs hit apply threshold (≥70) this run.");
          console.log("  Check 'consider' jobs in the CSV.\n");
        } else {
          top5.forEach((job, i) => {
            console.log(`\n[${i + 1}] ${job.title} @ ${job.company}`);
            console.log(`    📍 ${job.location}`);
            console.log(`    ⭐ Score: ${job.score}/100 (${job.confidence} confidence)`);
            console.log(`    ✅ ${job.reasons.slice(0, 2).join(" · ")}`);
            if (job.redFlags.length > 0) console.log(`    ⚠️  ${job.redFlags[0]}`);
            console.log(`    🔗 ${job.url}`);
          });
        }

        console.log("\n" + "━".repeat(60));
        console.log(`📊 Ranking Summary`);
        console.log(`   Apply   : ${top5.length} jobs`);
        console.log(`   Consider: ${consider} jobs`);
        console.log(`   Skip    : ${skip} jobs`);
        console.log("━".repeat(60));
      }
    }

    console.log("\n✅ Done. Open data/job_tracker.csv sorted by priority column.\n");

  } catch (error) {
    console.error("\n❌ PJSS run failed:", error);
    process.exit(1);
  }
}

main();
