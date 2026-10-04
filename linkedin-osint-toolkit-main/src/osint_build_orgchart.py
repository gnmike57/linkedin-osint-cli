#!/usr/bin/env python3
"""
Build Organization Chart Data
==============================

Creates hierarchical org chart from:
1. LinkedIn CSV data (scraped profiles)
2. Profile images from HTML parsing
3. Division structure from osint_classify_rules.py
4. Role-based hierarchy classification from osint_classify_rules.py

Usage:
    python osint_build_orgchart.py <input_csv> -o <output_json>

Output: JSON ready for org_chart_viewer.html
"""

import csv
import json
import os
import re
import sys
from datetime import datetime

# Import the authoritative classifier
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from osint_classify_rules import (
    classify_title,
    classify_role_level,
    classify_division,
    HIERARCHY_LEVELS,
    DIVISION_KEYWORDS,
    get_hierarchy_order,
)
from osint_auth import logger, setup_logging


# Division display colors for visualization
DIVISION_COLORS = {
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


def get_division_color(division_name):
    """Get display color for a division."""
    return DIVISION_COLORS.get(division_name, '#95a5a6')


def clean_title(title):
    """Remove company name suffix from title for better classification."""
    if not title:
        return ''
    patterns = [
        r'\s*at\s+[\w\s]+(?:company|corp|inc|ltd).*$',
        r'\s*@\s+[\w\s]+(?:company|corp|inc|ltd).*$',
        r'\s*\|\s+[\w\s]+(?:company|corp|inc|ltd).*$',
        r',?\s+[\w\s]+(?:company|corp|inc|ltd).*$',
    ]
    clean = title
    for pattern in patterns:
        clean = re.sub(pattern, '', clean, flags=re.IGNORECASE)
    return clean.strip()


def normalize_name(name):
    """Normalize name for matching."""
    if not name:
        return ''
    name = re.sub(r'[^\w\s]', '', name.lower())
    name = re.sub(r'\s+', ' ', name).strip()
    return name


def load_linkedin_csv(csv_path):
    """Load LinkedIn profiles from CSV, deduplicating by name."""
    profiles = []
    seen_names = {}

    with open(csv_path, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            profile = {
                'name': row.get('name', '').strip(),
                'title': row.get('title', '').strip(),
                'profile_url': row.get('profile_url', '').strip(),
                'profile_image_url': row.get('profile_image_url', '').strip(),
                'connection_degree': row.get('connection_degree', '').strip(),
                'mutual_connections': row.get('mutual_connections', '').strip(),
                'action_state': row.get('action_state', '').strip()
            }
            if profile['name']:
                norm_name = normalize_name(profile['name'])
                if norm_name in seen_names:
                    existing = seen_names[norm_name]
                    if 'ACoAAA' in existing['profile_url'] and 'ACoAAA' not in profile['profile_url']:
                        seen_names[norm_name] = profile
                    elif not existing.get('profile_image_url') and profile.get('profile_image_url'):
                        seen_names[norm_name] = profile
                else:
                    seen_names[norm_name] = profile

    profiles = list(seen_names.values())

    with_images = sum(1 for p in profiles if p.get('profile_image_url'))
    if with_images > 0:
        print(f"    CSV contains {with_images} profiles with images")

    return profiles


def load_parsed_json(json_path):
    """Load parsed profiles from JSON (with images)."""
    with open(json_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    if isinstance(data, dict) and 'profiles' in data:
        return data['profiles']
    elif isinstance(data, list):
        return data
    return []


def merge_profile_images(profiles, parsed_profiles):
    """Merge profile images from parsed HTML into main profiles."""
    image_lookup = {}
    for p in parsed_profiles:
        if p.get('profile_image_url'):
            norm = normalize_name(p.get('name', ''))
            if norm:
                image_lookup[norm] = p['profile_image_url']

    merged_count = 0
    for profile in profiles:
        norm = normalize_name(profile['name'])
        if norm in image_lookup:
            profile['profile_image_url'] = image_lookup[norm]
            merged_count += 1

    return merged_count


def build_hierarchical_data(profiles, use_ai=False):
    """Build hierarchical org chart data using osint_classify_rules.

    Args:
        profiles: List of profile dicts from CSV/JSON.
        use_ai: If True, enhance classification with Groq AI after keyword rules.
    """
    # Get all unique divisions and hierarchy levels
    all_divisions = list(DIVISION_KEYWORDS.keys()) + ['General']
    hierarchy_order = get_hierarchy_order()

    # Classify each profile with keyword rules
    for profile in profiles:
        title = clean_title(profile['title'])
        result = classify_title(title)

        profile['role_level'] = result['role_level']
        profile['role_weight'] = result['role_weight']
        profile['division_name'] = result['division']
        profile['division_color'] = get_division_color(result['division'])

    # Optional: AI enhancement pass (batch mode for efficiency)
    if use_ai:
        try:
            from osint_classify_ai import enhance_classifications_batch, is_available
            if is_available():
                profiles = enhance_classifications_batch(profiles)
                # Recalculate weights and colors for any AI-promoted results
                for profile in profiles:
                    if profile.get('ai_promoted_level') or profile.get('ai_promoted_division'):
                        profile['role_weight'] = HIERARCHY_LEVELS.get(profile['role_level'],
                                                                       HIERARCHY_LEVELS.get('Staff', 5))
                        profile['division_color'] = get_division_color(profile['division_name'])
            else:
                print("[AI] GROQ_API_KEY not set -- skipping AI enhancement")
        except Exception as e:
            print(f"[AI] Warning: AI enhancement failed ({e}), using keyword results only")

    # Group by division and level
    divisions_data = {}
    for div_name in all_divisions:
        divisions_data[div_name] = {
            'id': div_name.lower().replace(' ', '_').replace('&', 'and'),
            'name': div_name,
            'color': get_division_color(div_name),
            'levels': {level: [] for level in hierarchy_order}
        }

    for profile in profiles:
        div_name = profile['division_name']
        role_level = profile['role_level']
        if div_name not in divisions_data:
            div_name = 'General'
        divisions_data[div_name]['levels'][role_level].append(profile)

    # Sort people within each level by name
    for div_name, div_data in divisions_data.items():
        for level_name, people in div_data['levels'].items():
            people.sort(key=lambda p: p['name'].lower())

    # Convert to list and filter empty divisions
    result = []
    for div_name in all_divisions:
        div_data = divisions_data[div_name]
        total_people = sum(len(people) for people in div_data['levels'].values())
        if total_people == 0:
            continue

        # Build levels list (only non-empty)
        levels_list = []
        for level_name in hierarchy_order:
            people = div_data['levels'][level_name]
            if people:
                levels_list.append({
                    'level': HIERARCHY_LEVELS[level_name],
                    'name': level_name,
                    'people': people
                })

        result.append({
            'id': div_data['id'],
            'name': div_data['name'],
            'color': div_data['color'],
            'total_people': total_people,
            'levels': levels_list
        })

    # Sort: Executive Leadership first, then by total people descending
    result.sort(key=lambda d: (0 if 'executive' in d['id'] else 1, -d['total_people']))

    return result


def main():
    import argparse
    from dotenv import load_dotenv
    load_dotenv()

    parser = argparse.ArgumentParser(description='Build org chart data from LinkedIn CSV')
    parser.add_argument('input_csv', nargs='?', default=None,
                        help='Input CSV file with LinkedIn profiles')
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    parser.add_argument('-o', '--output', default=f'output/org_chart_data_{timestamp}.json',
                        help='Output JSON file path')
    parser.add_argument('--parsed-dir', default='output',
                        help='Directory with parsed profile images')
    parser.add_argument('-v', '--verbose', action='store_true',
                        help='Enable verbose/debug logging')
    parser.add_argument('--use-ai', action='store_true',
                        help='Use Groq AI to enhance classification (requires GROQ_API_KEY in .env)')
    args = parser.parse_args()
    setup_logging(verbose=args.verbose)

    # If no input provided, look for most recent CSV in default directory
    linkedin_csv = args.input_csv
    if not linkedin_csv:
        csv_dir = 'output'
        if os.path.exists(csv_dir):
            csv_files = [f for f in os.listdir(csv_dir) if f.endswith('.csv')]
            if csv_files:
                csv_files.sort(reverse=True)
                linkedin_csv = os.path.join(csv_dir, csv_files[0])

    if not linkedin_csv:
        print("[-] No input CSV specified and no CSV found in output/")
        print("Usage: python osint_build_orgchart.py <input_csv>")
        return

    parsed_json_dir = args.parsed_dir
    output_path = args.output

    print("=" * 60)
    print("BUILD ORG CHART DATA")
    print("=" * 60)

    # 1. Load main LinkedIn CSV
    print("\n[1] Loading LinkedIn CSV...")
    if not os.path.exists(linkedin_csv):
        print(f"[-] File not found: {linkedin_csv}")
        return

    profiles = load_linkedin_csv(linkedin_csv)
    print(f"    Loaded {len(profiles)} profiles")

    # 2. Merge profile images from parsed HTML
    print("\n[2] Merging profile images...")
    total_images = 0

    if os.path.exists(parsed_json_dir):
        for filename in os.listdir(parsed_json_dir):
            if filename.endswith('.json'):
                json_path = os.path.join(parsed_json_dir, filename)
                parsed = load_parsed_json(json_path)
                count = merge_profile_images(profiles, parsed)
                if count > 0:
                    print(f"    Merged {count} images from {filename}")
                    total_images += count

    profiles_with_images = sum(1 for p in profiles if p.get('profile_image_url'))
    print(f"    Total profiles with images: {profiles_with_images}")

    # 3. Build hierarchical data
    print("\n[3] Building hierarchical structure...")
    divisions = []
    try:
        divisions = build_hierarchical_data(profiles, use_ai=getattr(args, 'use_ai', False))
    except KeyboardInterrupt:
        print("\n[!] Interrupted during classification — saving partial results...")
    except Exception as e:
        print(f"\n[!] Error during classification: {e}")
        import traceback
        traceback.print_exc()

    if divisions:
        print(f"    Created {len(divisions)} divisions:")
        for div in divisions:
            print(f"      - {div['name']}: {div['total_people']} people")
            for lv in div['levels']:
                print(f"          {lv['name']}: {len(lv['people'])}")

    # 4. Save output (even if partial)
    if not divisions:
        print("\n[-] No divisions built. Nothing to save.")
        return

    print("\n[4] Saving output...")
    os.makedirs(os.path.dirname(output_path) if os.path.dirname(output_path) else '.', exist_ok=True)

    output = {
        'generated_at': datetime.now().isoformat(),
        'total_people': len(profiles),
        'total_with_images': profiles_with_images,
        'total_divisions': len(divisions),
        'divisions': divisions
    }

    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    print(f"\n[+] Saved to: {output_path}")
    print(f"    Total: {len(profiles)} people")
    print(f"    With images: {profiles_with_images}")
    print(f"    Divisions: {len(divisions)}")

    print("\n" + "=" * 60)
    print("TO GET MORE PROFILE IMAGES:")
    print("=" * 60)
    print("""
1. Run the pipeline with an authenticated browser session:
   python src/osint_pipeline.py <company> -e your@email.com -p yourpassword

2. Or re-run this script to merge images from parsed JSON:
   python src/osint_build_orgchart.py <input_csv> -o output/org_chart_data_TIMESTAMP.json
""")


if __name__ == '__main__':
    main()
