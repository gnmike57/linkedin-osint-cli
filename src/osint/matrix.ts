/**
 * Org chart HTML matrix generator (TypeScript port of osint_generate_html.py).
 *
 * Pure HTML/CSS matrix grid: rows = compressed hierarchy tiers, columns =
 * departments, cells = person avatars (image with initials fallback).
 * No chart library — renders instantly. Accepts either an org-chart JSON
 * (divisions format) or any people JSON/CSV (classified on the fly).
 */

import {
  classifyTitle,
  getHierarchyOrder,
  HIERARCHY_LEVELS,
} from './classify.js';
import { getDivisionColor, peopleFromJson, type Person } from './orgchart.js';

export const TIER_GROUPS = [
  { key: 'exec_vp', label: 'Executive / VP', levels: ['Executive', 'VP'] },
  { key: 'dir_head', label: 'Director / Head', levels: ['Director', 'Head'] },
  { key: 'mgr_lead', label: 'Manager / Lead', levels: ['Manager', 'Lead'] },
  { key: 'sr_spec', label: 'Senior / Specialist', levels: ['Senior', 'Specialist'] },
  { key: 'mid_jr', label: 'Mid / Junior', levels: ['Mid-Level', 'Junior'] },
  { key: 'entry_staff', label: 'Entry / Staff', levels: ['Entry', 'Staff'] },
] as const;

/** Hierarchy level colors (avatar fill when no image). */
export const LEVEL_COLORS: Record<string, string> = {
  Executive: '#c0392b',
  VP: '#d35400',
  Director: '#e67e22',
  Head: '#f39c12',
  Manager: '#27ae60',
  Lead: '#2980b9',
  Senior: '#8e44ad',
  Specialist: '#9b59b6',
  'Mid-Level': '#3498db',
  Junior: '#1abc9c',
  Entry: '#7f8c8d',
  Staff: '#95a5a6',
};

export interface MatrixPerson {
  name: string;
  title: string;
  level: string;
  department: string;
  profileUrl: string;
  imageUrl: string;
  initials: string;
}

function esc(text: string): string {
  return (text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Allow only http(s) URLs as href/src targets. */
function safeHttpUrl(value: string): string {
  return /^https?:\/\//i.test(value ?? '') ? value : '';
}

function initials(name: string): string {
  const parts = (name ?? '').trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  if (parts.length === 1 && parts[0]) return parts[0][0].toUpperCase();
  return '?';
}

/** Extract matrix people from an org-chart JSON or any people collection. */
export function collectMatrixPeople(data: unknown): MatrixPerson[] {
  const people: MatrixPerson[] = [];
  const obj = data as Record<string, unknown> | null;

  if (obj && typeof obj === 'object' && Array.isArray(obj.divisions)) {
    for (const division of obj.divisions as Array<Record<string, unknown>>) {
      for (const levelGroup of (division.levels as Array<Record<string, unknown>>) ?? []) {
        for (const p of (levelGroup.people as Array<Record<string, unknown>>) ?? []) {
          people.push({
            name: String(p.name ?? 'Unknown'),
            title: String(p.title ?? ''),
            level: String(p.role_level ?? levelGroup.name ?? 'Staff'),
            department: String(p.division_name ?? division.name ?? 'General'),
            profileUrl: String(p.profile_url ?? ''),
            imageUrl: String(p.profile_image_url ?? ''),
            initials: initials(String(p.name ?? '')),
          });
        }
      }
    }
    return people;
  }

  // Any people collection — classify on the fly
  const raw: Person[] = peopleFromJson(data);
  for (const p of raw) {
    const result = classifyTitle(p.title ?? '');
    people.push({
      name: p.name,
      title: p.title ?? '',
      level: result.role_level,
      department: result.division,
      profileUrl: p.profile_url ?? '',
      imageUrl: p.profile_image_url ?? '',
      initials: initials(p.name),
    });
  }
  return people;
}

/**
 * Build the complete HTML matrix document.
 * Returns the HTML string (the command layer writes it to disk).
 */
export function buildMatrixHtml(
  data: unknown,
  options: { rootLabel?: string } = {},
): string {
  const people = collectMatrixPeople(data);

  // Departments sorted by total people (largest first)
  const deptCounts = new Map<string, number>();
  for (const p of people) {
    deptCounts.set(p.department, (deptCounts.get(p.department) ?? 0) + 1);
  }
  const activeDepts = [...deptCounts.keys()].sort(
    (a, b) => deptCounts.get(b)! - deptCounts.get(a)!,
  );

  // Map each level to its tier group
  const levelToTier = new Map<string, string>();
  for (const tg of TIER_GROUPS) {
    for (const lv of tg.levels) levelToTier.set(lv, tg.key);
  }

  // matrix[tierKey][dept] = people
  const matrix = new Map<string, Map<string, MatrixPerson[]>>();
  for (const tg of TIER_GROUPS) {
    matrix.set(tg.key, new Map(activeDepts.map((d) => [d, [] as MatrixPerson[]])));
  }
  for (const person of people) {
    const tierKey = levelToTier.get(person.level) ?? 'entry_staff';
    const row = matrix.get(tierKey);
    if (row?.has(person.department)) row.get(person.department)!.push(person);
  }

  // Filter out completely empty tier groups
  const activeTiers = TIER_GROUPS.filter((tg) =>
    activeDepts.some((d) => (matrix.get(tg.key)?.get(d)?.length ?? 0) > 0),
  );

  // Stats
  const levelCounts = new Map<string, number>();
  for (const p of people) levelCounts.set(p.level, (levelCounts.get(p.level) ?? 0) + 1);
  const execCount =
    (levelCounts.get('Executive') ?? 0) + (levelCounts.get('VP') ?? 0);
  const mgmtCount =
    (levelCounts.get('Director') ?? 0) +
    (levelCounts.get('Head') ?? 0) +
    (levelCounts.get('Manager') ?? 0);

  const rootLabel = options.rootLabel ?? 'Organization';

  // Rows: one row per active tier
  const rowsHtml = activeTiers
    .map((tg) => {
      const cells = activeDepts
        .map((dept) => {
          const cellPeople = matrix.get(tg.key)?.get(dept) ?? [];
          if (cellPeople.length === 0) {
            return '<td class="cell empty"></td>';
          }
          const avatars = cellPeople
            .map((p) => {
              const titleAttr = esc(`${p.name} — ${p.title} (${p.level}, ${p.department})`);
              // Only http(s) URLs may become href/src targets — scraped data is
              // untrusted and a javascript:/data: payload here would run inside
              // the locally-opened HTML file.
              const imgUrl = safeHttpUrl(p.imageUrl);
              const linkUrl = safeHttpUrl(p.profileUrl);
              const img = imgUrl
                ? `<img src="${esc(imgUrl)}" alt="${esc(p.name)}" loading="lazy">`
                : `<span class="initials" style="background:${LEVEL_COLORS[p.level] ?? '#95a5a6'}">${esc(p.initials)}</span>`;
              const inner = `<span class="avatar" style="border-color:${getDivisionColor(p.department)}">${img}</span>`;
              return linkUrl
                ? `<a href="${esc(linkUrl)}" target="_blank" rel="noopener" title="${titleAttr}">${inner}</a>`
                : `<span title="${titleAttr}">${inner}</span>`;
            })
            .join('');
          const cellId = `${tg.key}_${esc(dept).replace(/[^a-zA-Z0-9_]/g, '_')}`;
          return (
            `<td class="cell">` +
            `<span class="count-badge" id="${cellId}_b" style="background:${getDivisionColor(dept)}" onclick="toggle('${cellId}')">${cellPeople.length}</span>` +
            `<span class="people" id="${cellId}_p">${avatars}</span>` +
            `</td>`
          );
        })
        .join('');
      return `<tr><th class="row-label">${esc(tg.label)}</th>${cells}</tr>`;
    })
    .join('\n');

  const colHeaders = activeDepts
    .map(
      (d) =>
        `<th class="col-label" style="border-top:3px solid ${getDivisionColor(d)}">${esc(d)}<span class="col-count">${deptCounts.get(d)}</span></th>`,
    )
    .join('');

  const html = renderPage({ rootLabel, people, activeDepts, rowsHtml, colHeaders, execCount, mgmtCount });
  return html;
}

/** Page shell + interaction script (kept separate from the data assembly). */
function renderPage(ctx: {
  rootLabel: string;
  people: MatrixPerson[];
  activeDepts: string[];
  rowsHtml: string;
  colHeaders: string;
  execCount: number;
  mgmtCount: number;
}): string {
  const doc = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(ctx.rootLabel)} — Organization Chart</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #0d1117; color: #c9d1d9;
         font-family: 'Segoe UI', system-ui, sans-serif; }
  .header { padding: 24px 32px 8px; }
  .header h1 { margin: 0 0 4px; font-size: 24px; color: #e6edf3; }
  .header-sub { color: #8b949e; font-size: 13px; margin-bottom: 16px; }
  .stats { display: flex; gap: 28px; flex-wrap: wrap; }
  .stat-num { font-size: 26px; font-weight: 700; color: #00d4ff; }
  .stat-label { font-size: 12px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.5px; }
  .controls { padding: 8px 32px 16px; display: flex; gap: 10px; }
  .controls input { flex: 0 1 320px; padding: 8px 12px; border-radius: 6px;
    border: 1px solid #30363d; background: #161b22; color: #e6edf3; }
  .controls button { padding: 8px 14px; border-radius: 6px; cursor: pointer;
    border: 1px solid #30363d; background: #21262d; color: #c9d1d9; }
  .controls button:hover { background: #30363d; }
  .matrix-wrap { overflow: auto; padding: 0 32px 40px; max-height: calc(100vh - 170px); }
  table { border-collapse: separate; border-spacing: 4px; min-width: 100%; }
  th { text-align: left; }
  .row-label { white-space: nowrap; color: #e6edf3; font-size: 13px; font-weight: 600; padding: 8px 12px; }
  .col-label { color: #e6edf3; font-size: 12px; font-weight: 600; padding: 8px 10px; vertical-align: bottom; }
  .col-count { display: block; color: #8b949e; font-weight: 400; }
  .cell { background: #161b22; border-radius: 8px; padding: 8px; min-width: 120px; height: 56px; vertical-align: top; }
  .cell.empty { background: transparent; }
  tbody tr:hover .cell:not(.empty) { background: #1c2129; }
  .count-badge { display: inline-flex; align-items: center; justify-content: center;
    width: 32px; height: 32px; border-radius: 50%; font-size: 13px; font-weight: 700;
    color: #fff; cursor: pointer; transition: transform 0.15s, box-shadow 0.15s; }
  .count-badge:hover { transform: scale(1.15); box-shadow: 0 0 10px rgba(0,212,255,0.4); }
  .people { display: none; flex-wrap: wrap; justify-content: center; gap: 2px; }
  .people.show { display: flex; }
  .avatar { display: inline-block; width: 38px; height: 38px; border-radius: 50%;
    border: 3px solid #555; overflow: hidden; vertical-align: middle;
    transition: transform 0.15s, box-shadow 0.15s; }
  .avatar:hover { transform: scale(1.3); box-shadow: 0 0 12px rgba(0,212,255,0.5); z-index: 10; }
  .avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .initials { width: 100%; height: 100%; display: flex; align-items: center;
    justify-content: center; font-size: 12px; font-weight: 700; color: #fff; }
  a { text-decoration: none; color: inherit; }
  .avatar.dimmed { opacity: 0.12; transform: scale(0.85); }
  .matrix-wrap::-webkit-scrollbar { width: 8px; height: 8px; }
  .matrix-wrap::-webkit-scrollbar-track { background: rgba(0,0,0,0.2); }
  .matrix-wrap::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 4px; }
</style>
</head>
<body>
  <div class="header">
    <h1>${esc(ctx.rootLabel)} — Organization Chart</h1>
    <div class="header-sub">Click a number to expand &mdash; hover avatars for details &mdash; click avatars to open LinkedIn</div>
    <div class="stats">
      <div class="stat"><div class="stat-num">${ctx.people.length}</div><div class="stat-label">People</div></div>
      <div class="stat"><div class="stat-num">${ctx.activeDepts.length}</div><div class="stat-label">Departments</div></div>
      <div class="stat"><div class="stat-num">${ctx.execCount}</div><div class="stat-label">Exec + VP</div></div>
      <div class="stat"><div class="stat-num">${ctx.mgmtCount}</div><div class="stat-label">Management</div></div>
    </div>
  </div>
  <div class="controls">
    <input type="text" id="searchBox" placeholder="Search by name or title..." oninput="doSearch()">
    <button onclick="expandAllCells()">Expand All</button>
    <button onclick="collapseAllCells()">Collapse All</button>
  </div>
  <div class="matrix-wrap">
    <table>
      <thead><tr><th class="corner"></th>${ctx.colHeaders}</tr></thead>
      <tbody>
${ctx.rowsHtml}
      </tbody>
    </table>
  </div>
  <script>
    function toggle(cid) {
      const badge = document.getElementById(cid + '_b');
      const people = document.getElementById(cid + '_p');
      if (!badge || !people) return;
      const isOpen = people.classList.contains('show');
      if (isOpen) { people.classList.remove('show'); badge.style.display = ''; }
      else { people.classList.add('show'); badge.style.display = 'none'; }
    }
    function expandAllCells() {
      document.querySelectorAll('.count-badge').forEach(b => b.style.display = 'none');
      document.querySelectorAll('.people').forEach(p => p.classList.add('show'));
    }
    function collapseAllCells() {
      document.querySelectorAll('.count-badge').forEach(b => b.style.display = '');
      document.querySelectorAll('.people').forEach(p => p.classList.remove('show'));
    }
    function doSearch() {
      const term = document.getElementById('searchBox').value.toLowerCase().trim();
      if (term) expandAllCells();
      document.querySelectorAll('.avatar').forEach(av => {
        const parent = av.closest('a') || av.closest('span');
        const tip = (parent && parent.getAttribute('title')) || '';
        if (!term || tip.toLowerCase().includes(term)) av.classList.remove('dimmed');
        else av.classList.add('dimmed');
      });
      if (!term) {
        document.querySelectorAll('.avatar').forEach(av => av.classList.remove('dimmed'));
      }
    }
  </script>
</body>
</html>
`;
  return doc;
}



