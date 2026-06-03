/**
 * AI Ranking Engine — Phase 4
 *
 * Scores each job 0–100 based on fit with Vaibhav's profile.
 * Uses Gemini or local Ollama for AI scoring.
 *
 * Design decisions:
 * 1. Batch jobs into groups of 5 — one API call per batch, not per job
 *    Cheaper, faster, and gives the LLM comparative context
 * 2. Deterministic rules first — AI only scores what passes the filter
 * 3. Score is advisory, not authoritative — final decision is yours
 * 4. Jobs with no description get scored on title+company only (lower confidence)
 *
 * Scoring priorities (in order):
 *   1. AWS stack match
 *   2. Entry-level friendly
 *   3. Startup company
 *   4. Remote/Bangalore/Pune location
 *   5. Kubernetes mentioned
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface JobToRank {
    id: string;
    title: string;
    company: string;
    location: string;
    description: string;
    url: string;
}

export interface RankedJob extends JobToRank {
    score: number;        // 0–100
    confidence: "high" | "low"; // low = no JD available
    reasons: string[];    // why this score
    redFlags: string[];   // things to watch out for
    action: "apply" | "consider" | "skip";
}

interface LLMScoreResult {
    id: string;
    score: number;
    reasons: string[];
    redFlags: string[];
    action: "apply" | "consider" | "skip";
}

function readPositiveIntEnv(name: string, fallback: number): number {
    const raw = process.env[name]?.trim();
    if (!raw) return fallback;

    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

type AIProvider = "gemini" | "ollama";

function getAIProvider(): AIProvider {
    const provider = process.env.AI_PROVIDER?.trim().toLowerCase() || "gemini";
    if (provider === "gemini" || provider === "ollama") return provider;

    throw new Error(`Unsupported AI_PROVIDER "${provider}". Use "gemini" or "ollama".`);
}

const JOB_TRACKER_HEADERS = [
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
] as const;

const JOB_TRACKER_HEADER_LINE = JOB_TRACKER_HEADERS.join(",");

// ─── Candidate Profile ────────────────────────────────────────────────────────
// This is the context the LLM uses to score jobs.
// Update this as your skills grow.

const CANDIDATE_PROFILE = `
## Candidate Profile

**Name:** Vaibhav
**Target:** Entry-level DevOps Engineer / Cloud Engineer / SRE
**Experience:** 0 years formal employment, strong self-taught portfolio

**Certifications:**
- AWS Solutions Architect Associate (SAA-C03) — cleared Feb 2026, first attempt

**Core Skills (strong):**
- AWS: EC2, EKS, S3, VPC, ALB, NAT Gateway, IAM, CloudWatch
- Containers: Docker, Kubernetes (real EKS deployment with eksctl)
- IaC: Terraform
- CI/CD: GitHub Actions (monorepo with path-based workflows)
- Monitoring: Prometheus, Grafana
- Languages: TypeScript, Python (basics), Bash

**Portfolio Projects:**
1. Resume Builder on AWS EKS — React/Node/MongoDB, Terraform, ALB, GitHub Actions CI/CD,
   private networking, MongoDB Atlas whitelisting. Full production deployment.
2. RAG Knowledge App — Next.js 14, PostgreSQL + pgvector, Gemini 2.5 Flash,
   hybrid search (cosine + BM25), deployed on AWS EC2 via Docker Compose.

**Location:** Currently Raipur, open to Bangalore/Pune on offer. Remote preferred.
**Target companies:** Startups (Series A–C), product companies, not pure service/body-shop firms
**Target salary:** Entry-level market rate (not a filter, just context)

## Scoring Priorities (in order)
1. AWS stack match — does the JD mention AWS services Vaibhav knows?
2. Entry-level friendly — 0–2 years experience required, no "5+ years" hidden in JD
3. Startup/product company — not TCS/Infosys/Wipro/HCL body shops
4. Location match — Remote, Bangalore, Pune, or pan-India
5. Kubernetes mentioned — bonus signal for platform/cloud-native roles
`;

// ─── Gemini API call ──────────────────────────────────────────────────────────

async function callGemini(prompt: string): Promise<string> {
    const apiKey = (process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY)?.trim();
    if (!apiKey) {
        throw new Error(
            "GEMINI_API_KEY not set. Add it to your .env file:\nGEMINI_API_KEY=your_google_ai_studio_api_key"
        );
    }
    const model = process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash";
    const maxOutputTokens = readPositiveIntEnv("GEMINI_MAX_OUTPUT_TOKENS", 2000);
    const timeoutMs = readPositiveIntEnv("GEMINI_TIMEOUT_MS", 90000);

    const body = JSON.stringify({
        contents: [
            {
                parts: [
                    {
                        text: prompt,
                    },
                ],
            },
        ],
        generationConfig: {
            maxOutputTokens,
            temperature: 0.2,
            responseMimeType: "application/json",
        },
    });

    // Native HTTPS — no extra dependencies
    const { request } = await import("https");

    return new Promise((resolve, reject) => {
        const req = request(
            {
                hostname: "generativelanguage.googleapis.com",
                path: `/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-goog-api-key": apiKey,
                    "Content-Length": Buffer.byteLength(body),
                },
            },
            (res) => {
                let data = "";
                res.on("data", (chunk) => (data += chunk));
                res.on("end", () => {
                    if (res.statusCode && res.statusCode >= 400) {
                        reject(new Error(`Gemini API error ${res.statusCode}: ${data}`));
                        return;
                    }
                    try {
                        const parsed = JSON.parse(data);
                        const text = parsed.candidates?.[0]?.content?.parts
                            ?.map((part: { text?: string }) => part.text ?? "")
                            .join("") ?? "";
                        if (!text.trim()) {
                            reject(new Error(`Gemini API returned no text: ${data.slice(0, 200)}`));
                            return;
                        }
                        resolve(text);
                    } catch {
                        reject(new Error(`Failed to parse API response: ${data.slice(0, 200)}`));
                    }
                });
            }
        );
        req.on("error", reject);
        req.setTimeout(timeoutMs, () => {
            req.destroy();
            reject(new Error(`Gemini API timeout after ${timeoutMs}ms`));
        });
        req.write(body);
        req.end();
    });
}

async function callOllama(prompt: string): Promise<string> {
    const model = process.env.OLLAMA_MODEL?.trim() || "llama3.1:8b";
    const baseUrl = process.env.OLLAMA_BASE_URL?.trim() || "http://localhost:11434";
    const maxOutputTokens = readPositiveIntEnv("OLLAMA_NUM_PREDICT", 2000);
    const timeoutMs = readPositiveIntEnv("OLLAMA_TIMEOUT_MS", 120000);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/generate`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model,
                prompt,
                stream: false,
                format: "json",
                options: {
                    temperature: 0.2,
                    num_predict: maxOutputTokens,
                },
            }),
            signal: controller.signal,
        });

        const data = await response.text();
        if (!response.ok) {
            throw new Error(`Ollama API error ${response.status}: ${data}`);
        }

        try {
            const parsed = JSON.parse(data);
            const text = parsed.response ?? "";
            if (!text.trim()) {
                throw new Error(`Ollama API returned no text: ${data.slice(0, 200)}`);
            }
            return text;
        } catch {
            throw new Error(`Failed to parse Ollama response: ${data.slice(0, 200)}`);
        }
    } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
            throw new Error(`Ollama API timeout after ${timeoutMs}ms`);
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

async function callLLM(prompt: string): Promise<string> {
    const provider = getAIProvider();
    return provider === "ollama" ? callOllama(prompt) : callGemini(prompt);
}

async function callLLMWithRetry(prompt: string): Promise<string> {
    const provider = getAIProvider();
    const attempts = readPositiveIntEnv(`${provider.toUpperCase()}_RETRY_ATTEMPTS`, 2);
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await callLLM(prompt);
        } catch (error) {
            lastError = error;
            if (attempt === attempts) break;

            const delayMs = readPositiveIntEnv(`${provider.toUpperCase()}_RETRY_DELAY_MS`, 10000) * attempt;
            console.warn(`     ${provider} call failed (${String(error)}). Retrying in ${Math.round(delayMs / 1000)}s...`);
            await sleep(delayMs);
        }
    }

    throw lastError;
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

function buildScoringPrompt(jobs: JobToRank[]): string {
    const jobsText = jobs
        .map(
            (job, i) => `
### Job ${i + 1} (id: ${job.id})
**Title:** ${job.title}
**Company:** ${job.company}
**Location:** ${job.location}
**Description:** ${job.description.length > 0
                    ? job.description.slice(0, 800) // cap at 800 chars to control token usage
                    : "No description available — score on title and company only."
                }
`
        )
        .join("\n---\n");

    return `
You are a job-fit scoring assistant. Score each job for the candidate below.

${CANDIDATE_PROFILE}

---

## Jobs to Score

${jobsText}

---

## Instructions

Score each job 0–100 based on fit with the candidate profile and priorities.

Scoring guide:
- 80–100: Strong match. Apply immediately.
- 60–79:  Good match. Worth applying.
- 40–59:  Partial match. Consider if application volume is low.
- 0–39:   Poor match. Skip.

For action:
- "apply"    → score >= 70
- "consider" → score 40–69
- "skip"     → score < 40

Rules:
- If JD says "5+ years" or "senior" anywhere, cap score at 35
- If company is TCS/Infosys/Wipro/HCL/Cognizant/Accenture, subtract 15 (body shops)
- If JD mentions AWS + Kubernetes together, add 10
- If role is purely development (React, Node, mobile), cap at 30
- Low confidence (no description): be conservative, max score 65

Respond ONLY with a valid JSON array. No explanation, no markdown, no preamble.
Format:
[
  {
    "id": "job_id_here",
    "score": 85,
    "reasons": ["AWS SAA-C03 directly mentioned", "0-2 years experience required", "Startup company"],
    "redFlags": ["Requires Jenkins which candidate hasn't used"],
    "action": "apply"
  }
]
`;
}

// ─── Parse LLM response ───────────────────────────────────────────────────────

function extractJsonCandidate(raw: string): string {
    const cleaned = raw
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();

    if (cleaned.startsWith("[") || cleaned.startsWith("{")) {
        return cleaned;
    }

    const arrayStart = cleaned.indexOf("[");
    const arrayEnd = cleaned.lastIndexOf("]");
    if (arrayStart !== -1 && arrayEnd > arrayStart) {
        return cleaned.slice(arrayStart, arrayEnd + 1);
    }

    const objectStart = cleaned.indexOf("{");
    const objectEnd = cleaned.lastIndexOf("}");
    if (objectStart !== -1 && objectEnd > objectStart) {
        return cleaned.slice(objectStart, objectEnd + 1);
    }

    return cleaned;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function normalizeAction(action: unknown, score: number): LLMScoreResult["action"] {
    if (action === "apply" || action === "consider" || action === "skip") {
        return action;
    }

    if (score >= 70) return "apply";
    if (score >= 40) return "consider";
    return "skip";
}

function normalizeStringList(value: unknown): string[] {
    if (Array.isArray(value)) {
        return value.map((item) => String(item)).filter((item) => item.trim().length > 0);
    }

    if (typeof value === "string" && value.trim().length > 0) {
        return [value.trim()];
    }

    return [];
}

function normalizeLLMScoreResults(parsed: unknown, jobs: JobToRank[]): LLMScoreResult[] {
    const source = Array.isArray(parsed)
        ? parsed
        : isRecord(parsed) && Array.isArray(parsed.results)
            ? parsed.results
            : isRecord(parsed) && Array.isArray(parsed.jobs)
                ? parsed.jobs
                : isRecord(parsed) && Array.isArray(parsed.scores)
                    ? parsed.scores
                    : isRecord(parsed)
                        ? [parsed]
                        : [];

    if (source.length === 0) {
        throw new Error("Response did not contain score objects");
    }

    return source
        .filter(isRecord)
        .map((item, index) => {
            const rawScore = Number(item.score);
            const score = Number.isFinite(rawScore)
                ? Math.max(0, Math.min(100, Math.round(rawScore)))
                : 50;

            return {
                id: typeof item.id === "string" && item.id.trim().length > 0
                    ? item.id.trim()
                    : jobs[index]?.id ?? "",
                score,
                reasons: normalizeStringList(item.reasons),
                redFlags: normalizeStringList(item.redFlags ?? item.red_flags),
                action: normalizeAction(item.action, score),
            };
        })
        .filter((result) => result.id.length > 0);
}

function parseLLMResponse(raw: string, jobs: JobToRank[]): LLMScoreResult[] {
    try {
        const parsed = JSON.parse(extractJsonCandidate(raw));
        const results = normalizeLLMScoreResults(parsed, jobs);
        if (results.length === 0) throw new Error("Response had no usable scores");
        return results;
    } catch (error) {
        console.warn("⚠️  LLM response parse failed — assigning default scores");
        console.warn("Parse error:", String(error));
        console.warn("Raw response:", raw.slice(0, 300));
        // Fallback: assign 50 to all jobs in batch
        return jobs.map((job) => ({
            id: job.id,
            score: 50,
            reasons: ["Parse error — manual review needed"],
            redFlags: [],
            action: "consider" as const,
        }));
    }
}

function hasExpectedJobTrackerHeader(headerCells: string[]): boolean {
    return JOB_TRACKER_HEADERS.every(
        (column, index) => headerCells[index]?.trim() === column
    );
}

function ensureJobTrackerHeader(lines: string[]): { lines: string[]; headerAdded: boolean } {
    const firstLine = lines[0];
    if (firstLine && hasExpectedJobTrackerHeader(parseCSVLine(firstLine))) {
        return { lines, headerAdded: false };
    }

    if (lines.length === 0 || (lines.length === 1 && lines[0]?.trim() === "")) {
        return { lines: [JOB_TRACKER_HEADER_LINE], headerAdded: true };
    }

    return { lines: [JOB_TRACKER_HEADER_LINE, ...lines], headerAdded: true };
}

function findCsvColumn(header: string[], column: string): number {
    return header.findIndex((cell) => cell.trim() === column);
}

/**
 * Reads job_tracker.csv and returns jobs where priority === 0 (unscored).
 * Used in rank-only mode when scrapers are disabled.
 */
export function loadUnscoredJobsFromCsv(): JobToRank[] {
    const csvPath = join(process.cwd(), "data", "job_tracker.csv");
    const content = readFileSync(csvPath, "utf-8");
    const rawLines = content.split("\n");
    const { lines, headerAdded } = ensureJobTrackerHeader(rawLines);
    if (headerAdded) {
        writeFileSync(csvPath, lines.join("\n"), "utf-8");
        console.log("🛠️ Added missing CSV header to data/job_tracker.csv");
    }

    const header = parseCSVLine(lines[0] ?? "");

    const idx = {
        id: findCsvColumn(header, "id"),
        title: findCsvColumn(header, "title"),
        company: findCsvColumn(header, "company"),
        location: findCsvColumn(header, "location"),
        url: findCsvColumn(header, "url"),
        description: findCsvColumn(header, "description"),
        priority: findCsvColumn(header, "priority"),
    };
    const {
        id: idIdx,
        title: titleIdx,
        company: companyIdx,
        location: locationIdx,
        url: urlIdx,
        description: descriptionIdx,
        priority: priorityIdx,
    } = idx;

    if (
        idIdx === -1 ||
        titleIdx === -1 ||
        companyIdx === -1 ||
        locationIdx === -1 ||
        urlIdx === -1 ||
        descriptionIdx === -1 ||
        priorityIdx === -1
    ) {
        console.warn("⚠️  CSV schema mismatch: expected id/title/company/location/url/description/priority columns");
        return [];
    }

    type JobWithPriority = JobToRank & { priority: number };

    const unscoredRows: JobWithPriority[] = lines
        .slice(1)
        .filter((line) => line.trim().length > 0)
        .map((line) => {
            // Handle quoted fields (description can contain commas)
            const cells = parseCSVLine(line);
            return {
                id: cells[idIdx]?.trim() ?? "",
                title: cells[titleIdx]?.trim() ?? "",
                company: cells[companyIdx]?.trim() ?? "",
                location: cells[locationIdx]?.trim() ?? "",
                url: cells[urlIdx]?.trim() ?? "",
                description: cells[descriptionIdx]?.trim() ?? "",
                priority: Number(cells[priorityIdx]?.trim() ?? "0"),
            };
        });

    return unscoredRows
        .filter((job) => job.priority === 0 && job.id.length > 0)
        .map(({ priority: _priority, ...job }) => job);
}

/**
 * Minimal CSV line parser that handles quoted fields.
 * Handles: "field with, comma" and "field with ""quotes"""
 */
function parseCSVLine(line: string): string[] {
    const cells: string[] = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            if (inQuotes && line[i + 1] === '"') {
                current += '"'; i++; // escaped quote
            } else {
                inQuotes = !inQuotes;
            }
        } else if (ch === "," && !inQuotes) {
            cells.push(current);
            current = "";
        } else {
            current += ch;
        }
    }
    cells.push(current);
    return cells;
}

// ─── Main ranking function ────────────────────────────────────────────────────

const BATCH_SIZE = readPositiveIntEnv("RANKING_BATCH_SIZE", 5); // jobs per API call
const BATCH_DELAY = readPositiveIntEnv("RANKING_BATCH_DELAY_MS", 15000); // ms between batches
const MAX_JOBS_PER_RUN = readPositiveIntEnv("RANKING_MAX_JOBS_PER_RUN", 25);

export async function rankJobs(jobs: JobToRank[]): Promise<RankedJob[]> {
    const jobsToRank = jobs.slice(0, MAX_JOBS_PER_RUN);
    const provider = getAIProvider();

    console.log(`\n🤖 AI Ranking Engine`);
    console.log(`   Provider     : ${provider}`);
    console.log(`   Jobs to rank : ${jobsToRank.length}${jobs.length > jobsToRank.length ? ` of ${jobs.length}` : ""}`);
    console.log(`   Batch size   : ${BATCH_SIZE}`);
    console.log(`   Batch delay  : ${BATCH_DELAY}ms`);
    console.log(`   API calls    : ${Math.ceil(jobsToRank.length / BATCH_SIZE)}\n`);

    if (jobs.length > jobsToRank.length) {
        console.log(`   Limiting this run to ${jobsToRank.length} jobs to avoid quota bursts.`);
        console.log(`   Remaining unscored jobs will be picked up next run.\n`);
    }

    const ranked: RankedJob[] = [];

    // Split into batches
    for (let i = 0; i < jobsToRank.length; i += BATCH_SIZE) {
        const batch = jobsToRank.slice(i, i + BATCH_SIZE);
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(jobsToRank.length / BATCH_SIZE);

        console.log(`  📦 Batch ${batchNum}/${totalBatches}: scoring ${batch.length} jobs...`);

        const prompt = buildScoringPrompt(batch);
        const raw = await callLLMWithRetry(prompt);
        const results = parseLLMResponse(raw, batch);

        // Merge scores back into job objects
        for (const job of batch) {
            const result = results.find((r) => r.id === job.id);
            const hasDescription = job.description.length > 50;

            ranked.push({
                ...job,
                score: result?.score ?? 50,
                confidence: hasDescription ? "high" : "low",
                reasons: result?.reasons ?? [],
                redFlags: result?.redFlags ?? [],
                action: result?.action ?? "consider",
            });
        }

        // Log batch results
        const batchScores = results.map((r) => `${r.score}`).join(", ");
        console.log(`     Scores: [${batchScores}]`);

        // Delay between batches
        if (i + BATCH_SIZE < jobsToRank.length) {
            console.log(`     Waiting ${Math.round(BATCH_DELAY / 1000)}s to stay under quota...`);
            await sleep(BATCH_DELAY);
        }
    }

    // Sort by score descending
    ranked.sort((a, b) => b.score - a.score);

    return ranked;
}

// ─── CSV update ───────────────────────────────────────────────────────────────

/**
 * Updates the priority column in job_tracker.csv with AI scores.
 * Reads the file, updates matching rows by id, writes back.
 */
export function updateCsvWithScores(rankedJobs: RankedJob[]): void {
    const csvPath = join(process.cwd(), "data", "job_tracker.csv");

    const content = readFileSync(csvPath, "utf-8");
    const rawLines = content.split("\n");
    const { lines, headerAdded } = ensureJobTrackerHeader(rawLines);
    if (headerAdded) {
        writeFileSync(csvPath, lines.join("\n"), "utf-8");
        console.log("🛠️ Added missing CSV header to data/job_tracker.csv");
    }

    const header = parseCSVLine(lines[0] ?? "");

    // Find column indices
    const idIdx = findCsvColumn(header, "id");
    const priorityIdx = findCsvColumn(header, "priority");
    const notesIdx = findCsvColumn(header, "notes");

    if (idIdx === -1 || priorityIdx === -1) {
        console.warn("⚠️  Could not find id or priority columns in CSV");
        return;
    }

    // Build score lookup
    const scoreMap = new Map(rankedJobs.map((j) => [j.id, j]));

    const updatedLines = lines.map((line, i) => {
        if (i === 0 || !line.trim()) return line; // skip header and empty lines
        const cells = parseCSVLine(line);
        const id = cells[idIdx]?.trim();
        if (!id) return line;
        const job = scoreMap.get(id);

        if (!job) return line;

        // Update priority with AI score
        while (cells.length <= priorityIdx) cells.push("");
        cells[priorityIdx] = String(job.score);

        // Update notes with action + top reason (if notes column is empty)
        if (notesIdx !== -1) {
            while (cells.length <= notesIdx) cells.push("");
            const existingNotes = cells[notesIdx]?.trim() ?? "";
            if (existingNotes === "") {
                const note = `${job.action.toUpperCase()}: ${job.reasons[0] ?? ""}`;
                cells[notesIdx] = note;
            }
        }

        return cells.map(escapeCsvCell).join(",");
    });

    writeFileSync(csvPath, updatedLines.join("\n"), "utf-8");
}
function escapeCsvCell(value: string): string {
    if (value.includes(",") || value.includes("\"") || value.includes("\n")) {
        return `"${value.replace(/"/g, "\"\"")}"`;
    }
    return value;
}
