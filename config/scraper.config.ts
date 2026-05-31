/**
 * Scraper Configuration
 * All tunable parameters in one place — change here, affects the whole system.
 */
import dotenv from "dotenv";
dotenv.config();

export const SCRAPER_CONFIG = {
  // LinkedIn search URL — constructed from base + params
  linkedin: {
    baseUrl: "https://www.linkedin.com/jobs/search/",
    // Query params for the initial search
    // These map to LinkedIn's URL params
    searchParams: {
      keywords: "DevOps Engineer OR Cloud Engineer OR SRE",
      location: "India",
      // f_E: Experience level — "1" = Internship, "2" = Entry level
      // We want entry-level so we pass "2"
      f_E: "2",
      // f_TPR: Time posted — "r604800" = past week (7 * 24 * 3600 seconds)
      f_TPR: "r604800",
      // f_WT: Work type — "2" = Remote, "3" = Hybrid, "1" = On-site
      // Leave empty to get all
    },
  },

  browser: {
    headless: true,
    // Use pre-installed Chromium (avoids download requirement)
    // Slow down actions by N ms — useful for debugging (set to 0 in prod)
    slowMo: 0,
  },

  scraping: {
    // How many job cards to extract per run (LinkedIn paginates at 25)
    // maxJobs: 25, 
    // Milliseconds to wait after page load before scraping
    // LinkedIn is JS-heavy — we need to wait for cards to render
    pageLoadWait: 3000,
    // Timeout for individual element queries (ms)
    elementTimeout: 10000,
    // Pagination
    maxPages: 3,           // 3 pages × 25 = up to 75 jobs
    pageDelay: () => Math.floor(Math.random() * 1500) + 1500, // 1.5–3s random delay
  },
} as const;
