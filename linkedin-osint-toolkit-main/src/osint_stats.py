#!/usr/bin/env python3
"""
Keyword Statistics Analyzer
===========================

Analyze keyword match effectiveness across JSON data files.
Reports hierarchy and division distribution with unclassified samples.

Usage:
    python osint_stats.py output/company_data.json
    python osint_stats.py output/*.json
    python osint_stats.py -v output/data.json  # verbose mode
"""

import json
import os
import sys
import argparse
from pathlib import Path
from collections import defaultdict

# Import classifiers - ensure src/ directory is in path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from osint_classify_rules import classify_role_level, classify_division, HIERARCHY_LEVELS
from osint_auth import logger, setup_logging


def analyze_json(filepath: str) -> dict:
    """
    Analyze a JSON file and return classification statistics.

    Args:
        filepath: Path to JSON file containing people data

    Returns:
        Dictionary with:
        - total: Total number of people
        - hierarchy: Dict of {level: count}
        - division: Dict of {division: count}
        - unclassified_titles: List of titles that fell to Staff or General
    """
    with open(filepath, 'r', encoding='utf-8') as f:
        data = json.load(f)

    stats = {
        'total': 0,
        'hierarchy': defaultdict(int),
        'division': defaultdict(int),
        'unclassified_hierarchy': [],  # Staff-level titles
        'unclassified_division': [],    # General division titles
    }

    # Extract people from various JSON structures
    people = []
    if isinstance(data, list):
        # Direct list of people
        people = data
    elif isinstance(data, dict):
        if 'companies' in data:
            # Batch scrape format: {"companies": [{"people": [...]}]}
            for company in data['companies']:
                people.extend(company.get('people', []))
        elif 'divisions' in data:
            # Org chart data format (output of osint_build_orgchart.py)
            for division in data['divisions']:
                for level_group in division.get('levels', []):
                    people.extend(level_group.get('people', []))
        elif 'people' in data:
            # Single company format: {"people": [...]}
            people = data['people']
        else:
            # Try to find any list that looks like people
            for key, value in data.items():
                if isinstance(value, list) and value and isinstance(value[0], dict):
                    if 'name' in value[0] or 'title' in value[0]:
                        people = value
                        break

    for person in people:
        title = person.get('title', '')

        # Classify hierarchy level
        level, weight = classify_role_level(title)

        # Classify division
        division = classify_division(title)

        stats['total'] += 1
        stats['hierarchy'][level] += 1
        stats['division'][division] += 1

        # Track unclassified titles for analysis
        if level == 'Staff' and title:
            stats['unclassified_hierarchy'].append(title)
        if division == 'General' and title:
            stats['unclassified_division'].append(title)

    return stats


def print_report(stats: dict, filename: str, verbose: bool = False):
    """
    Print a formatted statistics report.

    Args:
        stats: Statistics dictionary from analyze_json()
        filename: Name of the analyzed file
        verbose: If True, show more unclassified samples
    """
    print(f"\n{'=' * 70}")
    print(f"FILE: {filename}")
    print(f"TOTAL PEOPLE: {stats['total']}")
    print(f"{'=' * 70}")

    if stats['total'] == 0:
        print("No people found in file.")
        return

    # Hierarchy distribution
    print("\nHIERARCHY DISTRIBUTION:")
    print("-" * 50)

    hierarchy_order = [
        'Executive', 'VP', 'Director', 'Head', 'Manager',
        'Lead', 'Senior', 'Specialist', 'Mid-Level',
        'Junior', 'Entry', 'Staff'
    ]

    for level in hierarchy_order:
        count = stats['hierarchy'].get(level, 0)
        pct = (count / stats['total'] * 100) if stats['total'] > 0 else 0
        bar = '#' * int(pct / 2)
        status = ""
        if level == 'Staff' and pct > 15:
            status = " <-- NEEDS WORK"
        print(f"  {level:12} {count:4} ({pct:5.1f}%) {bar}{status}")

    # Division distribution
    print("\nDIVISION DISTRIBUTION:")
    print("-" * 50)

    # Sort by count descending
    for div, count in sorted(stats['division'].items(),
                             key=lambda x: x[1], reverse=True):
        pct = (count / stats['total'] * 100) if stats['total'] > 0 else 0
        status = ""
        if div == 'General' and pct > 15:
            status = " <-- NEEDS WORK"
        print(f"  {div:25} {count:4} ({pct:5.1f}%){status}")

    # Show unclassified samples
    sample_size = 20 if verbose else 10

    unclassified_h = stats['unclassified_hierarchy'][:sample_size]
    if unclassified_h:
        print(f"\nSAMPLE UNCLASSIFIED HIERARCHY (Staff) - {len(stats['unclassified_hierarchy'])} total:")
        print("-" * 50)
        for title in unclassified_h:
            # Truncate long titles
            display = title[:65] + "..." if len(title) > 65 else title
            print(f"  - {display}")

    unclassified_d = stats['unclassified_division'][:sample_size]
    if unclassified_d:
        print(f"\nSAMPLE UNCLASSIFIED DIVISION (General) - {len(stats['unclassified_division'])} total:")
        print("-" * 50)
        for title in unclassified_d:
            display = title[:65] + "..." if len(title) > 65 else title
            print(f"  - {display}")


def print_summary(all_stats: list):
    """Print a summary across all analyzed files."""
    if len(all_stats) <= 1:
        return

    print(f"\n{'=' * 70}")
    print("AGGREGATE SUMMARY")
    print(f"{'=' * 70}")

    total_people = sum(s['total'] for s in all_stats)
    total_staff = sum(s['hierarchy'].get('Staff', 0) for s in all_stats)
    total_general = sum(s['division'].get('General', 0) for s in all_stats)

    print(f"Total files analyzed: {len(all_stats)}")
    print(f"Total people: {total_people}")

    if total_people > 0:
        staff_pct = (total_staff / total_people) * 100
        general_pct = (total_general / total_people) * 100
        print(f"Unclassified hierarchy (Staff): {total_staff} ({staff_pct:.1f}%)")
        print(f"Unclassified division (General): {total_general} ({general_pct:.1f}%)")

        # Classification effectiveness
        classified_h = 100 - staff_pct
        classified_d = 100 - general_pct
        print(f"\nClassification Effectiveness:")
        print(f"  Hierarchy: {classified_h:.1f}% classified")
        print(f"  Division:  {classified_d:.1f}% classified")


def main():
    parser = argparse.ArgumentParser(
        description="Analyze keyword match statistics across JSON data files",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    python osint_stats.py output/company_data.json
    python osint_stats.py output/*.json
    python osint_stats.py -v output/data.json  # verbose mode
        """
    )
    parser.add_argument(
        'files',
        nargs='*',
        default=['output/data.json'],
        help='JSON files to analyze (default: output/data.json)'
    )
    parser.add_argument(
        '-v', '--verbose',
        action='store_true',
        help='Show more unclassified samples'
    )
    parser.add_argument(
        '--debug',
        action='store_true',
        help='Enable debug logging'
    )

    args = parser.parse_args()
    setup_logging(verbose=args.debug)

    all_stats = []

    for filepath in args.files:
        path = Path(filepath)
        if not path.exists():
            print(f"[-] File not found: {filepath}")
            continue

        try:
            stats = analyze_json(filepath)
            all_stats.append(stats)
            print_report(stats, filepath, verbose=args.verbose)
        except json.JSONDecodeError as e:
            print(f"[-] Invalid JSON in {filepath}: {e}")
        except Exception as e:
            print(f"[-] Error processing {filepath}: {e}")

    # Print aggregate summary if multiple files
    print_summary(all_stats)


if __name__ == '__main__':
    main()
