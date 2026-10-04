/**
 * Shared helpers for the osint command layer.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LinkedInError } from '../../core/errors.js';
import type { LinkedInClient } from '../../core/types.js';

/** Local timestamp used in output filenames (YYYYMMDD_HHMMSS). */
export function fileTimestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Ensure the output directory exists and write a file. Returns full path. */
export async function writeOutputFile(
  outDir: string,
  filename: string,
  content: string,
): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const path = join(outDir, filename);
  await writeFile(path, content, 'utf-8');
  return path;
}

export interface CompanyIdentity {
  companyId: string;
  staffCount: number;
  displayName?: string;
}

/**
 * Resolve the numeric LinkedIn company ID for a company slug.
 * Strategy 1: the organization/companies view endpoint (response contains
 * `urn:li:company:<id>` and usually `staffCount`).
 * Strategy 2: the public company page HTML (legacy `companyId` fields).
 * Throws COMPANY_ID_UNRESOLVED with guidance to pass --company-id.
 */
export async function resolveCompanyId(
  client: LinkedInClient,
  companySlug: string,
): Promise<CompanyIdentity> {
  try {
    const view = await client.get('/organization/companies', {
      decorationId: 'com.linkedin.voyager.deco.organization.web.WebFullCompanyMain-12',
      q: 'universalName',
      universalName: companySlug,
    });
    const raw = JSON.stringify(view);
    const urnMatch = raw.match(/urn:li:company:(\d+)/);
    const staffMatch =
      raw.match(/"staffCount"\s*:\s*"?(\d+)"?/) ??
      raw.match(/"employeeCount"\s*:\s*"?(\d+)"?/);
    const nameMatch = raw.match(/"displayName"\s*:\s*"([^"]{1,120})"/);
    if (urnMatch) {
      return {
        companyId: urnMatch[1],
        staffCount: staffMatch ? Number(staffMatch[1]) : 0,
        displayName: nameMatch?.[1],
      };
    }
  } catch {
    // Fall through to the HTML strategy
  }

  try {
    const page = await client.request({
      method: 'GET',
      path: `/company/${encodeURIComponent(companySlug)}/`,
      baseRequest: true,
    });
    const raw = typeof page === 'string' ? page : JSON.stringify(page);
    const idMatch =
      raw.match(/"companyId"\s*:\s*"?(\d+)"?/) ??
      raw.match(/companyI[dD]\\?["']?\s*[:=]\s*\\?["']?(\d+)/);
    if (idMatch) return { companyId: idMatch[1], staffCount: 0 };
  } catch {
    // Fall through to the error below
  }

  throw new LinkedInError(
    `Could not resolve the numeric company ID for "${companySlug}". ` +
      `Find it on the company page URL params and pass --company-id <numeric>.`,
    'COMPANY_ID_UNRESOLVED',
  );
}

/** Sleep helper for extra delays between loops. */
export function sleep(ms: number): Promise<void> {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
