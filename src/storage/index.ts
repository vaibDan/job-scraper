/**
 * Storage Layer — Persist filtered jobs to CSV
 *
 * Design decisions:
 * 1. CSV over SQLite for now — opens in Excel/Sheets, zero setup, human-readable
 * 2. Dedup by job.id (MD5 hash of title+company+location) — same job scraped
 *    twice on different days won't create a duplicate row
 * 3. Append-only — we never overwrite rows, only add new ones
 * 4. Status field — tracks application state across runs
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "fs";
import { dirname, join } from "path";
import type { NormalizedJob } from "../scraper/types.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type JobStatus = "new" | "applied" | "interviewing" | "rejected" | "skip";

export interface StoredJob extends NormalizedJob {
    status: JobStatus;
    priority: number; // 0 = unranked, 1–5 set manually or by AI in Phase 4
    notes: string;
    firstSeenAt: string; // ISO — when we first scraped it
}

// ─── Config ───────────────────────────────────────────────────────────────────

const CSV_PATH = join(process.cwd(), "data", "job_tracker.csv");

const CSV_HEADERS: (keyof StoredJob)[] = [
    "id",
    "title",
    "company",
    "location",
    "url",
    "description",
    "status",
    "priority",
    "notes",
    "firstSeenAt",
    "scrapedAt",
];

const CSV_HEADER_LINE = CSV_HEADERS.join(",");

// ─── CSV helpers ──────────────────────────────────────────────────────────────

function escapeCell(value: string | number): string {
    const str = String(value);
    // Wrap in quotes if contains comma, quote, or newline
    if (str.includes(",") || str.includes('"') || str.includes("\n")) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}

function rowToLine(job: StoredJob): string {
    return CSV_HEADERS.map((key) => escapeCell(job[key])).join(",");
}

function hasExpectedHeader(line: string | undefined): boolean {
    if (!line) return false;
    const cols = line.split(",");
    return CSV_HEADERS.every((header, index) => cols[index]?.trim() === header);
}

function ensureCsvHeader(): void {
    if (!existsSync(CSV_PATH)) return;

    const content = readFileSync(CSV_PATH, "utf-8");
    const lines = content.split("\n");
    if (hasExpectedHeader(lines[0])) return;

    const normalizedLines =
        content.trim().length === 0
            ? [CSV_HEADER_LINE]
            : [CSV_HEADER_LINE, ...lines];
    writeFileSync(CSV_PATH, normalizedLines.join("\n"), "utf-8");
    console.log(`🛠️ Added missing CSV header to ${CSV_PATH}`);
}

// ─── Load existing IDs ────────────────────────────────────────────────────────

/**
 * Read the CSV and return the set of existing job IDs.
 * O(n) scan on startup — fine for hundreds of jobs, revisit at 10k+.
 */
function loadExistingIds(): Set<string> {
    if (!existsSync(CSV_PATH)) return new Set();

    const content = readFileSync(CSV_PATH, "utf-8");
    const lines = content.split("\n");
    const dataStartIndex = hasExpectedHeader(lines[0]) ? 1 : 0;

    // Skip header row (if present), extract first column (id)
    return new Set(
        lines
            .slice(dataStartIndex)
            .filter((line) => line.trim().length > 0)
            .map((line) => {
                // Parse first CSV field correctly (handles quoted fields with escaped quotes)
                const match = line.match(/^"((?:[^"]|"")*)"|([^,]*)/);
                if (!match) return "";
                const value =
                    match[1] !== undefined
                        ? match[1].replace(/""/g, '"')
                        : (match[2] || "");
                return value.trim();
            })
    );
}

// ─── Main storage function ────────────────────────────────────────────────────

export interface StorageResult {
    added: number;
    duplicates: number;
    totalInFile: number;
}

export function saveJobs(jobs: NormalizedJob[]): StorageResult {
    mkdirSync(dirname(CSV_PATH), { recursive: true });

    const isNewFile = !existsSync(CSV_PATH);

    // Write header if file doesn't exist yet
    if (isNewFile) {
        writeFileSync(CSV_PATH, CSV_HEADER_LINE + "\n", "utf-8");
        console.log(`📄 Created new file: ${CSV_PATH}`);
    } else {
        ensureCsvHeader();
    }
    const existingIds = loadExistingIds();

    let added = 0;
    let duplicates = 0;
    const now = new Date().toISOString();

    for (const job of jobs) {
        if (existingIds.has(job.id)) {
            duplicates++;
            continue;
        }

        const stored: StoredJob = {
            ...job,
            status: "new",
            priority: 0,
            notes: "",
            firstSeenAt: now,
        };

        appendFileSync(CSV_PATH, rowToLine(stored) + "\n", "utf-8");
        existingIds.add(job.id); // prevent dupes within same run
        added++;
    }

    // Count total data rows — read fresh after writes and ignore header if present
    const finalContent = readFileSync(CSV_PATH, "utf-8");
    const finalLines = finalContent.split("\n").filter((line) => line.trim().length > 0);
    const hasHeader = hasExpectedHeader(finalLines[0]);
    const totalInFile = hasHeader ? Math.max(0, finalLines.length - 1) : finalLines.length;

    return { added, duplicates, totalInFile };
}
