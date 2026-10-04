/**
 * Industry classification — normalizes raw LinkedIn industry strings into
 * standard categories. Ported from osint_discover.py INDUSTRY_CATEGORIES.
 */

export const INDUSTRY_CATEGORIES: Record<string, string[]> = {
  // Technology
  Technology: ['software', 'technology', 'tech', 'it services', 'computer', 'information technology'],
  Cybersecurity: ['cyber', 'security', 'infosec', 'defense', 'defence'],
  Telecommunications: ['telecom', 'isp', 'internet', 'mobile', 'wireless', 'communications'],
  'Cloud/SaaS': ['cloud', 'saas', 'platform', 'hosting'],

  // Finance
  Banking: ['bank', 'banking', 'financial services'],
  Insurance: ['insurance', 'insurtech'],
  Fintech: ['fintech', 'payment', 'crypto', 'blockchain'],

  // Government & Defense
  Government: ['government', 'public sector', 'ministry', 'municipal', 'federal', 'state'],
  Defense: ['defense', 'defence', 'military', 'aerospace'],
  Intelligence: ['intelligence', 'national security'],

  // Industry
  Manufacturing: ['manufacturing', 'industrial', 'factory', 'production'],
  Energy: ['energy', 'oil', 'gas', 'utilities', 'power', 'renewable'],
  Transportation: ['transportation', 'logistics', 'shipping', 'freight', 'aviation'],

  // Services
  Healthcare: ['health', 'medical', 'hospital', 'pharma', 'biotech', 'life sciences'],
  Consulting: ['consulting', 'advisory', 'professional services', 'management consulting'],
  Legal: ['legal', 'law firm', 'attorney', 'law practice'],
  Education: ['education', 'university', 'school', 'training', 'e-learning'],
  Retail: ['retail', 'e-commerce', 'consumer', 'wholesale'],
  Media: ['media', 'entertainment', 'broadcast', 'publishing', 'news'],

  // Catch-all
  Other: [],
};

/** Normalize a raw LinkedIn industry string to a standard category name. */
export function classifyIndustry(rawIndustry: string | undefined | null): string {
  if (!rawIndustry || rawIndustry === 'Unknown') return 'Unknown';
  const rawLower = rawIndustry.toLowerCase();
  for (const [category, keywords] of Object.entries(INDUSTRY_CATEGORIES)) {
    for (const keyword of keywords) {
      if (rawLower.includes(keyword)) return category;
    }
  }
  return 'Other';
}

/** Load target cities for location validation (one per line, # comments). */
export function loadTargetCities(citiesText: string): string[] {
  return citiesText
    .split(/\r?\n/)
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

/** Check a company location string against configured target cities. */
export function validateTargetLocation(location: string, targetCities: string[]): boolean {
  if (targetCities.length === 0) return true; // No validation if none configured
  const lower = (location ?? '').toLowerCase();
  return targetCities.some((city) => lower.includes(city));
}
