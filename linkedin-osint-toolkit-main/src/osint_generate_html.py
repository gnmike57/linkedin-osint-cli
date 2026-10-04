#!/usr/bin/env python3
"""
Generate Organization Chart - HTML Matrix View
================================================

Creates a pure HTML/CSS matrix grid:
  Rows    = Compressed hierarchy tiers (Executive/VP, Director/Head, ...)
  Columns = Departments (Cyber Security, IT Infra, ...)
  Cells   = Person avatars (circular profile images with initials fallback)

No vis.js dependency -- renders instantly, never freezes.
"""

import json
import sys
import os
import html as html_mod

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from osint_classify_rules import classify_title, get_hierarchy_order, HIERARCHY_LEVELS
from osint_auth import logger, setup_logging


def classify(title):
    """Adapter: wraps osint_classify_rules.classify_title() to match old interface."""
    result = classify_title(title)
    return {
        'level': result['role_level'],
        'weight': result['role_weight'],
        'department': result['division'],
    }


# Hierarchy level colors (avatar fill)
LEVEL_COLORS = {
    'Executive': '#c0392b',
    'VP': '#d35400',
    'Director': '#e67e22',
    'Head': '#f39c12',
    'Manager': '#27ae60',
    'Lead': '#2980b9',
    'Senior': '#8e44ad',
    'Specialist': '#9b59b6',
    'Mid-Level': '#3498db',
    'Junior': '#1abc9c',
    'Entry': '#7f8c8d',
    'Staff': '#95a5a6',
}

# Department colors (avatar border + column header)
DEPT_COLORS = {
    'Cyber Security': '#e74c3c',
    'IT Infrastructure': '#3498db',
    'Software Development': '#9b59b6',
    'Data & AI': '#1abc9c',
    'R&D': '#673ab7',
    'Product': '#ff5722',
    'Project Management': '#00bcd4',
    'Operations': '#ff9800',
    'Finance': '#f39c12',
    'HR': '#e91e63',
    'Marketing': '#8bc34a',
    'Sales': '#4caf50',
    'Legal & Compliance': '#607d8b',
    'Customer Service': '#009688',
    'Strategy': '#795548',
    'Intelligence': '#f44336',
    'Military/Defense': '#455a64',
    'General': '#95a5a6',
}

# Compressed tier groups
TIER_GROUPS = [
    {'key': 'exec_vp',      'label': 'Executive / VP',       'levels': ['Executive', 'VP']},
    {'key': 'dir_head',     'label': 'Director / Head',      'levels': ['Director', 'Head']},
    {'key': 'mgr_lead',     'label': 'Manager / Lead',       'levels': ['Manager', 'Lead']},
    {'key': 'sr_spec',      'label': 'Senior / Specialist',  'levels': ['Senior', 'Specialist']},
    {'key': 'mid_jr',       'label': 'Mid / Junior',         'levels': ['Mid-Level', 'Junior']},
    {'key': 'entry_staff',  'label': 'Entry / Staff',        'levels': ['Entry', 'Staff']},
]


def _initials(name):
    """Get up to 2 initials from a name."""
    parts = name.strip().split()
    if len(parts) >= 2:
        return (parts[0][0] + parts[-1][0]).upper()
    elif parts:
        return parts[0][0].upper()
    return '?'


def _esc(text):
    """HTML-escape a string."""
    return html_mod.escape(text or '', quote=True)


def generate_org_chart(input_file: str, output_file: str,
                       company_filter: str = None, industry_filter: str = None,
                       company_name: str = None):
    """Generate HTML matrix org chart."""

    with open(input_file, 'r', encoding='utf-8') as f:
        data = json.load(f)

    # ------------------------------------------------------------------
    # Collect all people
    # ------------------------------------------------------------------
    all_people = []
    companies = set()

    if 'divisions' in data:
        for division in data['divisions']:
            for level_group in division.get('levels', []):
                for person in level_group.get('people', []):
                    all_people.append({
                        'name': person.get('name', 'Unknown'),
                        'title': person.get('title', ''),
                        'level': person.get('role_level', level_group.get('name', 'Staff')),
                        'department': person.get('division_name', division.get('name', 'General')),
                        'profileUrl': person.get('profile_url', ''),
                        'imageUrl': person.get('profile_image_url', ''),
                    })
    else:
        for company in data.get('companies', []):
            cname = company.get('company', 'Unknown')
            cindustry = company.get('industry', 'Unknown')
            companies.add(cname)
            if company_filter and cname != company_filter:
                continue
            if industry_filter and cindustry != industry_filter:
                continue
            for person in company.get('people', []):
                classification = classify(person.get('title', ''))
                all_people.append({
                    'name': person.get('name', 'Unknown'),
                    'title': person.get('title', ''),
                    'level': classification['level'],
                    'department': classification['department'],
                    'profileUrl': person.get('profileUrl', ''),
                    'imageUrl': person.get('profileImageUrl', ''),
                })

    # ------------------------------------------------------------------
    # Build matrix: tier_group -> department -> [people]
    # ------------------------------------------------------------------
    # Get active departments sorted by total people (largest first)
    dept_counts = {}
    for p in all_people:
        dept_counts[p['department']] = dept_counts.get(p['department'], 0) + 1

    active_depts = sorted(dept_counts.keys(), key=lambda d: dept_counts[d], reverse=True)

    # Map each person to their tier group
    level_to_tier = {}
    for tg in TIER_GROUPS:
        for lv in tg['levels']:
            level_to_tier[lv] = tg['key']

    matrix = {}  # {tier_key: {dept: [people]}}
    for tg in TIER_GROUPS:
        matrix[tg['key']] = {dept: [] for dept in active_depts}

    for person in all_people:
        tier_key = level_to_tier.get(person['level'], 'entry_staff')
        dept = person['department']
        if dept in matrix[tier_key]:
            matrix[tier_key][dept].append(person)

    # Filter out tier groups that are completely empty
    active_tiers = [tg for tg in TIER_GROUPS if any(matrix[tg['key']][d] for d in active_depts)]

    # ------------------------------------------------------------------
    # Stats
    # ------------------------------------------------------------------
    level_counts = {}
    for p in all_people:
        level_counts[p['level']] = level_counts.get(p['level'], 0) + 1

    exec_count = sum(level_counts.get(lv, 0) for lv in ['Executive', 'VP'])
    mgmt_count = sum(level_counts.get(lv, 0) for lv in ['Director', 'Head', 'Manager'])

    root_label = company_name or 'Organization'
    if not company_name and companies:
        root_label = ', '.join(sorted(companies))

    # ------------------------------------------------------------------
    # Build HTML
    # ------------------------------------------------------------------
    html = _build_html(root_label, active_tiers, active_depts, matrix,
                       len(all_people), len(active_depts), exec_count, mgmt_count)

    os.makedirs(os.path.dirname(output_file) or '.', exist_ok=True)
    with open(output_file, 'w', encoding='utf-8') as f:
        f.write(html)

    print(f"Generated: {output_file}")
    print(f"Total people: {len(all_people)}")
    print(f"Departments: {len(active_depts)}")

    return output_file


def _build_html(root_label, active_tiers, active_depts, matrix,
                total_people, total_depts, exec_count, mgmt_count):
    """Build the complete HTML page."""

    # --- Build table body ---
    # Each cell defaults to a count badge; clicking expands to show avatars.
    rows_html = ''
    cell_idx = 0
    for tg in active_tiers:
        tier_key = tg['key']
        tier_levels = tg['levels']
        tier_color = LEVEL_COLORS.get(tier_levels[0], '#95a5a6')

        cells_html = ''
        for dept in active_depts:
            people = matrix[tier_key][dept]
            if not people:
                cells_html += '<td class="cell empty"><span class="count-zero">&ndash;</span></td>\n'
                continue

            cell_idx += 1
            cid = f"c{cell_idx}"

            # Build avatar HTML (hidden by default)
            avatars = ''
            for p in sorted(people, key=lambda x: x['name'].lower()):
                name = _esc(p['name'])
                title = _esc(p['title'])
                level = _esc(p['level'])
                dept_name = _esc(p['department'])
                url = _esc(p.get('profileUrl', ''))
                img_url = p.get('imageUrl', '')
                initials = _initials(p['name'])
                lv_color = LEVEL_COLORS.get(p['level'], '#95a5a6')
                dp_color = DEPT_COLORS.get(p['department'], '#95a5a6')

                tooltip = f"{name}&#10;{title}&#10;{level} | {dept_name}"

                if url:
                    open_tag = f'<a href="{url}" target="_blank" rel="noopener" title="{tooltip}">'
                    close_tag = '</a>'
                else:
                    open_tag = f'<span title="{tooltip}">'
                    close_tag = '</span>'

                if img_url:
                    avatars += (
                        f'{open_tag}'
                        f'<div class="avatar" style="border-color:{dp_color}">'
                        f'<img src="{_esc(img_url)}" alt="{name}" '
                        f'onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'">'
                        f'<div class="initials" style="background:{lv_color};display:none">{initials}</div>'
                        f'</div>'
                        f'{close_tag}\n'
                    )
                else:
                    avatars += (
                        f'{open_tag}'
                        f'<div class="avatar" style="border-color:{dp_color}">'
                        f'<div class="initials" style="background:{lv_color}">{initials}</div>'
                        f'</div>'
                        f'{close_tag}\n'
                    )

            count = len(people)
            cells_html += (
                f'<td class="cell" onclick="toggle(\'{cid}\')">'
                f'<span class="count-badge" id="{cid}_b" style="background:{tier_color}">{count}</span>'
                f'<div class="people" id="{cid}_p">{avatars}</div>'
                f'</td>\n'
            )

        rows_html += (
            f'<tr>\n'
            f'<th class="row-header" style="background:{tier_color}">'
            f'{_esc(tg["label"])}</th>\n'
            f'{cells_html}'
            f'</tr>\n'
        )

    # --- Column headers ---
    col_headers = ''
    for dept in active_depts:
        dc = DEPT_COLORS.get(dept, '#95a5a6')
        count = sum(len(matrix[tg['key']][dept]) for tg in active_tiers)
        col_headers += (
            f'<th class="col-header" style="background:{dc}">'
            f'{_esc(dept)}<br><span class="col-count">{count}</span></th>\n'
        )

    return f'''<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{_esc(root_label)} - Organization Chart</title>
    <style>
        * {{ margin: 0; padding: 0; box-sizing: border-box; }}

        body {{
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #12162b;
            color: #fff;
            min-height: 100vh;
        }}

        .header {{
            background: rgba(0,0,0,0.4);
            padding: 14px 20px;
            text-align: center;
            border-bottom: 1px solid rgba(255,255,255,0.08);
        }}

        .header h1 {{
            font-size: 1.5em;
            margin-bottom: 4px;
            background: linear-gradient(90deg, #00d4ff, #7c3aed, #ff6b6b);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }}

        .header-sub {{
            font-size: 0.75em;
            color: #555;
            margin-bottom: 8px;
        }}

        .stats {{
            display: flex;
            justify-content: center;
            gap: 16px;
            flex-wrap: wrap;
        }}

        .stat {{
            text-align: center;
            background: rgba(255,255,255,0.05);
            padding: 4px 14px;
            border-radius: 6px;
        }}

        .stat-num {{
            font-size: 1.2em;
            font-weight: bold;
            color: #00d4ff;
        }}

        .stat-label {{
            font-size: 0.7em;
            color: #888;
        }}

        .controls {{
            display: flex;
            justify-content: center;
            align-items: center;
            gap: 8px;
            padding: 8px 15px;
            background: rgba(0,0,0,0.3);
            border-bottom: 1px solid rgba(255,255,255,0.06);
        }}

        .controls input, .controls button {{
            padding: 6px 12px;
            border: 1px solid rgba(255,255,255,0.2);
            border-radius: 6px;
            background: rgba(255,255,255,0.08);
            color: #fff;
            font-size: 12px;
        }}

        .controls button {{
            cursor: pointer;
            transition: background 0.15s;
        }}
        .controls button:hover {{ background: rgba(255,255,255,0.2); }}

        .controls input {{ width: 220px; }}
        .controls input::placeholder {{ color: #555; }}

        /* Matrix */
        .matrix-wrap {{
            overflow: auto;
            max-height: calc(100vh - 140px);
            padding: 0;
        }}

        table {{
            border-collapse: separate;
            border-spacing: 0;
            width: 100%;
        }}

        .col-header {{
            position: sticky;
            top: 0;
            z-index: 50;
            padding: 8px 6px;
            font-size: 0.72em;
            font-weight: 600;
            color: #fff;
            text-align: center;
            border-bottom: 2px solid rgba(0,0,0,0.3);
            word-wrap: break-word;
            overflow-wrap: break-word;
        }}

        .col-count {{
            font-weight: 400;
            font-size: 0.85em;
            opacity: 0.7;
        }}

        .corner {{
            position: sticky;
            top: 0;
            left: 0;
            z-index: 60;
            background: #12162b;
            width: 110px;
            min-width: 110px;
            max-width: 110px;
            border-bottom: 2px solid rgba(0,0,0,0.3);
            border-right: 2px solid rgba(0,0,0,0.3);
        }}

        .row-header {{
            position: sticky;
            left: 0;
            z-index: 40;
            padding: 8px 8px;
            font-size: 0.72em;
            font-weight: 600;
            color: #fff;
            white-space: nowrap;
            width: 110px;
            min-width: 110px;
            max-width: 110px;
            border-right: 2px solid rgba(0,0,0,0.3);
            vertical-align: middle;
            text-align: center;
        }}

        .cell {{
            padding: 6px;
            vertical-align: middle;
            text-align: center;
            border-bottom: 1px solid rgba(255,255,255,0.04);
            border-right: 1px solid rgba(255,255,255,0.03);
            cursor: pointer;
            transition: background 0.15s;
        }}

        .cell:hover {{
            background: rgba(255,255,255,0.05);
        }}

        .cell.empty {{
            background: rgba(0,0,0,0.08);
            cursor: default;
        }}

        .count-zero {{
            color: #333;
            font-size: 0.8em;
        }}

        /* Count badge (default collapsed state) */
        .count-badge {{
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 32px;
            height: 32px;
            border-radius: 50%;
            font-size: 13px;
            font-weight: 700;
            color: #fff;
            cursor: pointer;
            transition: transform 0.15s, box-shadow 0.15s;
        }}

        .count-badge:hover {{
            transform: scale(1.15);
            box-shadow: 0 0 10px rgba(0,212,255,0.4);
        }}

        /* Hidden people container (expanded state) */
        .people {{
            display: none;
            flex-wrap: wrap;
            justify-content: center;
            gap: 2px;
            margin-top: 4px;
        }}

        .people.show {{
            display: flex;
        }}

        /* Avatars */
        .avatar {{
            display: inline-block;
            width: 38px;
            height: 38px;
            border-radius: 50%;
            border: 3px solid #555;
            overflow: hidden;
            vertical-align: middle;
            position: relative;
            transition: transform 0.15s, box-shadow 0.15s;
        }}

        .avatar:hover {{
            transform: scale(1.3);
            box-shadow: 0 0 12px rgba(0,212,255,0.5);
            z-index: 10;
        }}

        .avatar img {{
            width: 100%;
            height: 100%;
            object-fit: cover;
            display: block;
        }}

        .initials {{
            width: 100%;
            height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 12px;
            font-weight: 700;
            color: #fff;
            letter-spacing: 0.5px;
        }}

        a {{ text-decoration: none; color: inherit; }}

        .avatar.dimmed {{
            opacity: 0.12;
            transform: scale(0.85);
        }}

        /* Scrollbar */
        .matrix-wrap::-webkit-scrollbar {{ width: 8px; height: 8px; }}
        .matrix-wrap::-webkit-scrollbar-track {{ background: rgba(0,0,0,0.2); }}
        .matrix-wrap::-webkit-scrollbar-thumb {{ background: rgba(255,255,255,0.12); border-radius: 4px; }}
        .matrix-wrap::-webkit-scrollbar-corner {{ background: rgba(0,0,0,0.2); }}

        tbody tr:hover .cell:not(.empty) {{
            background: rgba(255,255,255,0.04);
        }}
    </style>
</head>
<body>
    <div class="header">
        <h1>{_esc(root_label)} &mdash; Organization Chart</h1>
        <div class="header-sub">Click a number to expand &mdash; hover avatars for details &mdash; click avatars to open LinkedIn</div>
        <div class="stats">
            <div class="stat">
                <div class="stat-num">{total_people}</div>
                <div class="stat-label">People</div>
            </div>
            <div class="stat">
                <div class="stat-num">{total_depts}</div>
                <div class="stat-label">Departments</div>
            </div>
            <div class="stat">
                <div class="stat-num">{exec_count}</div>
                <div class="stat-label">Exec + VP</div>
            </div>
            <div class="stat">
                <div class="stat-num">{mgmt_count}</div>
                <div class="stat-label">Management</div>
            </div>
        </div>
    </div>

    <div class="controls">
        <input type="text" id="searchBox" placeholder="Search by name or title..." oninput="doSearch()">
        <button onclick="expandAllCells()">Expand All</button>
        <button onclick="collapseAllCells()">Collapse All</button>
    </div>

    <div class="matrix-wrap">
        <table>
            <thead>
                <tr>
                    <th class="corner"></th>
                    {col_headers}
                </tr>
            </thead>
            <tbody>
                {rows_html}
            </tbody>
        </table>
    </div>

    <script>
        function toggle(cid) {{
            const badge = document.getElementById(cid + '_b');
            const people = document.getElementById(cid + '_p');
            if (!badge || !people) return;
            const isOpen = people.classList.contains('show');
            if (isOpen) {{
                people.classList.remove('show');
                badge.style.display = '';
            }} else {{
                people.classList.add('show');
                badge.style.display = 'none';
            }}
        }}

        function expandAllCells() {{
            document.querySelectorAll('.count-badge').forEach(b => b.style.display = 'none');
            document.querySelectorAll('.people').forEach(p => p.classList.add('show'));
        }}

        function collapseAllCells() {{
            document.querySelectorAll('.count-badge').forEach(b => b.style.display = '');
            document.querySelectorAll('.people').forEach(p => p.classList.remove('show'));
        }}

        function doSearch() {{
            const term = document.getElementById('searchBox').value.toLowerCase().trim();
            if (term) expandAllCells();
            document.querySelectorAll('.avatar').forEach(av => {{
                const parent = av.closest('a') || av.closest('span');
                const tip = (parent && parent.getAttribute('title')) || '';
                if (!term || tip.toLowerCase().includes(term)) {{
                    av.classList.remove('dimmed');
                }} else {{
                    av.classList.add('dimmed');
                }}
            }});
            if (!term) {{
                document.querySelectorAll('.avatar').forEach(av => av.classList.remove('dimmed'));
            }}
        }}
    </script>
</body>
</html>
'''


if __name__ == '__main__':
    import argparse
    from datetime import datetime as _dt

    _timestamp = _dt.now().strftime('%Y%m%d_%H%M%S')

    parser = argparse.ArgumentParser(description='Generate org chart (HTML matrix)')
    parser.add_argument('input', help='Input JSON file with people data')
    parser.add_argument('-o', '--output', default=f'output/org_chart_{_timestamp}.html',
                        help='Output HTML file')
    parser.add_argument('-c', '--company', default=None,
                        help='Filter by company name')
    parser.add_argument('-i', '--industry', default=None,
                        help='Filter by company industry')
    parser.add_argument('-n', '--name', default=None,
                        help='Display name for root node')
    parser.add_argument('-v', '--verbose', action='store_true',
                        help='Enable verbose/debug logging')

    args = parser.parse_args()
    setup_logging(verbose=args.verbose)

    try:
        generate_org_chart(args.input, args.output, args.company, args.industry, args.name)
    except KeyboardInterrupt:
        print("\n[!] Interrupted by user.")
        if os.path.exists(args.output):
            print(f"[+] Partial output may have been written to: {args.output}")
        else:
            print("[*] No output file was written before interruption.")
    except Exception as e:
        print(f"\n[!] Error: {e}")
        import traceback
        traceback.print_exc()
