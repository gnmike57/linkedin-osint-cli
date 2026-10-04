#!/usr/bin/env python3
"""
Classification Scanner
======================

Scans a directory of LinkedIn company JSON files, classifies every title
using the current rules in classification_rules.json, and reports:

  - Hierarchy and division distributions with percentages
  - Top unclassified Staff titles (hierarchy) with frequency
  - Top unclassified General titles (division) with frequency
  - Suggested new title_overrides to add to classification_rules.json

Usage:
    python src/osint_scan.py results/
    python src/osint_scan.py results/ --suggest 50
    python src/osint_scan.py results/ --json-suggest overrides.json
"""

import argparse
import json
import os
import sys
from collections import Counter

# Ensure src/ is on the path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from osint_classify_rules import classify_title, clean_title, HIERARCHY_LEVELS


# Files that are aggregates / metadata, not per-company scraped data
SKIP_FILES = {
    "all_companies_people.json",
    "all_companies_classified.json",
    "ministry_data.json",
    "data.json",
    "hierarchy_data.json",
    "incd_org_chart_data.json",
    "org_chart_demo.json",
    "israel_ministries.json",
}

# Prefixes for timestamped aggregate files that should also be skipped
SKIP_PREFIXES = (
    "all_companies_people_",
    "all_companies_classified_",
    "org_chart_data_",
    "deep_dive_results_",
    "deep_dive_progress",
)


def load_titles(directory: str) -> list:
    """Load all titles from company JSON files in the given directory."""
    titles = []
    files_loaded = 0

    for fname in sorted(os.listdir(directory)):
        if not fname.endswith(".json"):
            continue
        if fname in SKIP_FILES:
            continue
        if fname.startswith(SKIP_PREFIXES):
            continue

        path = os.path.join(directory, fname)
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (json.JSONDecodeError, OSError):
            continue

        people = []
        if isinstance(data, dict) and "people" in data:
            people = data["people"]
        elif isinstance(data, list):
            people = data

        for p in people:
            if isinstance(p, dict) and "title" in p and p["title"]:
                titles.append(p["title"].strip())

        files_loaded += 1

    return titles, files_loaded


def classify_all(titles: list) -> dict:
    """Classify all titles and return detailed statistics."""
    hierarchy_counter = Counter()
    division_counter = Counter()
    staff_raw = []  # (raw_title, cleaned_title)
    general_raw = []

    for t in titles:
        result = classify_title(t)
        hierarchy_counter[result["role_level"]] += 1
        division_counter[result["division"]] += 1

        cleaned = clean_title(t)
        if result["role_level"] == "Staff" and cleaned:
            staff_raw.append(cleaned.lower())
        if result["division"] == "General" and cleaned:
            general_raw.append(cleaned.lower())

    return {
        "hierarchy": hierarchy_counter,
        "division": division_counter,
        "staff_titles": Counter(staff_raw),
        "general_titles": Counter(general_raw),
    }


def print_distribution(label: str, counter: Counter, total: int, order=None):
    """Print a distribution table."""
    print(f"\n{label}:")
    print("-" * 60)
    items = [(k, counter.get(k, 0)) for k in order] if order else counter.most_common()
    for name, count in items:
        pct = count / total * 100 if total else 0
        bar = "#" * int(pct / 2)
        print(f"  {name:<25} {count:5d} ({pct:5.1f}%) {bar}")


def print_unclassified(label: str, counter: Counter, limit: int):
    """Print top unclassified titles."""
    items = counter.most_common(limit)
    if not items:
        print(f"\n{label}: none")
        return
    print(f"\n{label} (top {limit}):")
    print("-" * 60)
    for title, count in items:
        print(f"  {count:4d}x  {title[:75]}")


def suggest_overrides(staff_titles: Counter, general_titles: Counter,
                      limit: int) -> list:
    """Generate suggested title_overrides for the most common unclassified."""
    suggestions = []

    # Suggest hierarchy overrides for Staff titles
    for title, count in staff_titles.most_common(limit):
        if count < 2:
            break
        suggestions.append({
            "title": title,
            "count": count,
            "issue": "Staff (no hierarchy match)",
            "suggested": {"level": "Mid-Level", "division": "???"},
        })

    # Suggest division overrides for General titles
    for title, count in general_titles.most_common(limit):
        if count < 2:
            break
        # Don't re-suggest what's already in Staff suggestions
        if title not in {s["title"] for s in suggestions}:
            suggestions.append({
                "title": title,
                "count": count,
                "issue": "General (no division match)",
                "suggested": {"level": "???", "division": "???"},
            })

    return suggestions[:limit]


def main():
    parser = argparse.ArgumentParser(
        description="Scan LinkedIn results and report classification statistics"
    )
    parser.add_argument(
        "directory",
        help="Directory containing company JSON files (e.g., results/)",
    )
    parser.add_argument(
        "--suggest",
        type=int,
        default=25,
        metavar="N",
        help="Show top N suggestions for new overrides (default: 25)",
    )
    parser.add_argument(
        "--json-suggest",
        metavar="FILE",
        help="Write suggested overrides as JSON to FILE",
    )
    args = parser.parse_args()

    if not os.path.isdir(args.directory):
        print(f"Error: {args.directory} is not a directory", file=sys.stderr)
        sys.exit(1)

    # Load titles
    print("=" * 70)
    print("CLASSIFICATION SCANNER")
    print("=" * 70)
    print(f"Scanning: {os.path.abspath(args.directory)}")

    try:
        titles, files_loaded = load_titles(args.directory)
        print(f"Files loaded: {files_loaded}")
        print(f"Total titles: {len(titles)}")
        print(f"Unique titles: {len(set(titles))}")

        if not titles:
            print("No titles found. Nothing to scan.")
            sys.exit(0)

        # Classify
        stats = classify_all(titles)
        total = len(titles)

        # Hierarchy distribution
        hierarchy_order = sorted(
            HIERARCHY_LEVELS.keys(),
            key=lambda x: HIERARCHY_LEVELS[x],
            reverse=True,
        )
        print_distribution("HIERARCHY DISTRIBUTION", stats["hierarchy"], total, hierarchy_order)

        # Division distribution
        print_distribution("DIVISION DISTRIBUTION", stats["division"], total)

        # Summary
        staff_count = stats["hierarchy"].get("Staff", 0)
        general_count = stats["division"].get("General", 0)
        staff_pct = staff_count / total * 100
        general_pct = general_count / total * 100

        print(f"\n{'=' * 70}")
        print(f"SUMMARY")
        print(f"{'=' * 70}")
        print(f"  Staff (unclassified hierarchy): {staff_count:5d} ({staff_pct:.1f}%)")
        print(f"  General (unclassified division): {general_count:5d} ({general_pct:.1f}%)")
        status_h = "OK" if staff_pct < 10 else "NEEDS WORK"
        status_d = "OK" if general_pct < 25 else "NEEDS WORK"
        print(f"  Hierarchy status: {status_h}")
        print(f"  Division status:  {status_d}")

        # Unclassified details
        print_unclassified(
            "UNCLASSIFIED HIERARCHY (Staff titles)",
            stats["staff_titles"],
            args.suggest,
        )
        print_unclassified(
            "UNCLASSIFIED DIVISION (General titles)",
            stats["general_titles"],
            args.suggest,
        )

        # Suggestions
        suggestions = suggest_overrides(
            stats["staff_titles"], stats["general_titles"], args.suggest
        )
        if suggestions:
            print(f"\n{'=' * 70}")
            print(f"SUGGESTED OVERRIDES FOR classification_rules.json")
            print(f"{'=' * 70}")
            print(f"Add these to the \"title_overrides\" section:\n")
            for s in suggestions:
                title = s["title"]
                count = s["count"]
                issue = s["issue"]
                suggested = s["suggested"]
                print(f'    "{title}": {{"level": "{suggested["level"]}", "division": "{suggested["division"]}"}},  // {count}x {issue}')

        # JSON output
        if args.json_suggest:
            output = {
                "scan_directory": os.path.abspath(args.directory),
                "total_titles": total,
                "files_loaded": files_loaded,
                "staff_pct": round(staff_pct, 1),
                "general_pct": round(general_pct, 1),
                "hierarchy_distribution": dict(stats["hierarchy"].most_common()),
                "division_distribution": dict(stats["division"].most_common()),
                "suggestions": suggestions,
            }
            with open(args.json_suggest, "w", encoding="utf-8") as f:
                json.dump(output, f, indent=2, ensure_ascii=False)
            print(f"\n[+] Suggestions written to: {args.json_suggest}")

        print()

    except KeyboardInterrupt:
        print("\n\n[!] Interrupted by user — saving partial results...")
        # Try to write JSON suggestions if requested and we have partial data
        if args.json_suggest and 'suggestions' in dir() and suggestions:
            try:
                partial_output = {
                    "scan_directory": os.path.abspath(args.directory),
                    "partial": True,
                    "suggestions": suggestions,
                }
                with open(args.json_suggest, "w", encoding="utf-8") as f:
                    json.dump(partial_output, f, indent=2, ensure_ascii=False)
                print(f"[+] Partial suggestions written to: {args.json_suggest}")
            except Exception:
                pass
        print()


if __name__ == "__main__":
    main()
