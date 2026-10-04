/**
 * LinkedIn geo codes for company/people search region filters.
 * Ported from osint_discover.py GEO_CODES (51 regions). Additional codes can
 * be found via LinkedIn's company search URL parameter `companyHqGeo`.
 */

export const GEO_CODES: Record<string, string> = {
  Argentina: '100446943',
  Australia: '101452733',
  Austria: '103883259',
  Belgium: '100565514',
  Brazil: '106057199',
  Canada: '101174742',
  Chile: '104621616',
  China: '102890883',
  Colombia: '100876405',
  'Czech Republic': '104508036',
  Denmark: '104514075',
  Egypt: '106155005',
  Finland: '100456013',
  France: '105015875',
  Germany: '101282230',
  Greece: '104677530',
  'Hong Kong': '103291313',
  India: '102713980',
  Indonesia: '102478259',
  Ireland: '104738515',
  Israel: '101620260',
  Italy: '103350119',
  Japan: '101355337',
  Kenya: '100660959',
  Malaysia: '106808692',
  Mexico: '103323778',
  Netherlands: '102890719',
  'New Zealand': '105490917',
  Nigeria: '105365761',
  Norway: '103819153',
  Pakistan: '101022442',
  Peru: '102927786',
  Philippines: '103121230',
  Poland: '105072130',
  Portugal: '100364837',
  Romania: '106670623',
  'Saudi Arabia': '100459316',
  Singapore: '102454443',
  'South Africa': '104035573',
  'South Korea': '105149562',
  Spain: '105646813',
  Sweden: '105117694',
  Switzerland: '106693272',
  Taiwan: '104187078',
  Thailand: '105146118',
  Turkey: '102105699',
  UAE: '104305776',
  UK: '101165590',
  Ukraine: '102264497',
  USA: '103644278',
  Vietnam: '104195383',
};

/**
 * Resolve a `--geo` value: accepts a numeric code or a country/region name
 * (case-insensitive). Returns the numeric code or null if unknown.
 */
export function resolveGeo(input: string): string | null {
  const trimmed = input.trim();
  if (/^\d{6,12}$/.test(trimmed)) return trimmed;
  const byName = Object.entries(GEO_CODES).find(
    ([name]) => name.toLowerCase() === trimmed.toLowerCase(),
  );
  return byName ? byName[1] : null;
}

/** Print-friendly geo table (used by --help style output). */
export function listGeoCodes(): string {
  const lines: string[] = ['LinkedIn Geo Codes:', '='.repeat(45)];
  for (const [region, code] of Object.entries(GEO_CODES)) {
    lines.push(`  ${region.padEnd(25)} ${code}`);
  }
  lines.push(`\nTotal: ${Object.keys(GEO_CODES).length} regions`);
  lines.push('Tip: find more codes via LinkedIn search URL parameters.');
  return lines.join('\n');
}
