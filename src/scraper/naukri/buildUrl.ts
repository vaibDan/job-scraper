/**
 * Naukri URL Builder
 *
 * Naukri uses a clean slug-based URL structure:
 * https://www.naukri.com/{role}-jobs?experience={years}&location={city}
 *
 * No API keys, no login, fully public.
 */

export interface NaukriSearchParams {
    keyword: string;   // used in URL slug
    experience: number; // years (0 = fresher)
    location?: string;  // optional city filter
}

/**
 * Builds a Naukri search URL.
 *
 * Examples:
 *   devops-engineer → https://www.naukri.com/devops-engineer-jobs?experience=0
 *   cloud-engineer  → https://www.naukri.com/cloud-engineer-jobs?experience=0
 */
export function buildNaukriSearchUrl(params: NaukriSearchParams): string {
    const slug = params.keyword.toLowerCase().replace(/\s+/g, "-");
    const base = `https://www.naukri.com/${slug}-jobs`;

    const query = new URLSearchParams({
        experience: String(params.experience),
    });

    if (params.location) {
        query.set("location", params.location.toLowerCase());
    }

    return `${base}?${query.toString()}`;
}

/**
 * All search targets for PJSS.
 * We run one scrape per keyword and merge results.
 * Dedup in storage layer handles overlaps.
 */
export const NAUKRI_SEARCHES: NaukriSearchParams[] = [
    { keyword: "devops engineer", experience: 0 },
    { keyword: "cloud engineer", experience: 0 },
    { keyword: "site reliability engineer", experience: 0 },
    { keyword: "platform engineer", experience: 0 },
];