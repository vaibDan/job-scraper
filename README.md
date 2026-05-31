# 🔍 PJSS — Personal Job Search System

A deterministic, modular job search pipeline for DevOps/Cloud/SRE roles.

## Philosophy

> Deterministic systems over AI. Structured data over raw text. Speed over magic.

AI is used **only** for ranking (Phase 4) — everything else is pure logic.

## Architecture

```
LinkedIn → Scraper → Parser → Filter → Ranker (AI) → CSV → Actions
```

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Copy env file
cp .env.example .env

# 3. Set your Chrome path (check with: ls /opt/pw-browsers/)
# Edit .env: CHROME_PATH=/opt/pw-browsers/chromium-XXXX/chrome-linux/chrome
```

## Running

```bash
# Run the full pipeline
npm run scrape

# Debug selectors (opens visual browser)
npx ts-node src/scraper/debug.ts
```

## Phases

| Phase | Status | What it does |
|-------|--------|--------------|
| 1 | ✅ Done | Playwright scraper — extracts raw job listings |
| 2 | 🔜 Next | Rule-based filtering — roles, location, experience |
| 3 | 🔜 | CSV storage with dedup |
| 4 | 🔜 | AI ranking (LLM scores 0–100) |
| 5 | 🔜 | Action output — top 5 + next steps |

## Troubleshooting

**Selectors not working?** LinkedIn periodically changes CSS classes.
```bash
npx ts-node src/scraper/debug.ts
```
This opens a visual browser and prints all candidate selectors.

**Chrome not found?**
```bash
ls /opt/pw-browsers/    # find the right version directory
# Update CHROME_PATH in .env and config/scraper.config.ts
```

## Folder Structure

```
job-system/
├── src/
│   ├── scraper/
│   │   ├── index.ts      # Main scraper — Playwright logic
│   │   ├── buildUrl.ts   # URL builder — testable, no browser needed
│   │   ├── debug.ts      # DOM inspector — run when selectors break
│   │   └── types.ts      # Shared types for entire pipeline
│   └── main.ts           # Orchestrator — calls each phase in sequence
├── config/
│   └── scraper.config.ts # All tunable parameters
├── data/                 # job_tracker.csv lives here (Phase 3)
├── .env.example
└── README.md
```
