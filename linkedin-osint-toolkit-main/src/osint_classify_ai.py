#!/usr/bin/env python3
"""
AI Enhancer - Optional Groq LLM Integration
=============================================

Provides optional AI-powered enhancement for classification and scoring
across all OSINT pipeline levels. Uses Groq API with Llama models.

This module is NEVER required -- all functions gracefully return input
unchanged if the API key is missing or calls fail.

Public API:
    is_available()                          -> bool
    score_companies(companies, objective)   -> companies (with ai_* fields)
    enhance_classification(person)          -> person (with ai_* fields)
    deep_classify(person)                   -> person (with ai_* fields)
    enhance_classifications_batch(people)   -> people (with ai_* fields)

Requires:
    GROQ_API_KEY environment variable set (via .env or export)
"""

import os
import json
import time
import logging
from pathlib import Path

logger = logging.getLogger("linkedin_osint")

# ---------------------------------------------------------------------------
# Prompt loader (reads markdown files from src/prompts/)
# ---------------------------------------------------------------------------
_PROMPTS_DIR = Path(__file__).parent / "prompts"
_prompt_cache: dict = {}


def _load_prompt(filename: str) -> str:
    """Load a prompt markdown file from src/prompts/. Results are cached."""
    if filename in _prompt_cache:
        return _prompt_cache[filename]

    path = _PROMPTS_DIR / filename
    try:
        text = path.read_text(encoding="utf-8").strip()
        _prompt_cache[filename] = text
        return text
    except FileNotFoundError:
        logger.warning(f"Prompt file not found: {path}")
        return ""
    except Exception as e:
        logger.warning(f"Failed to load prompt {filename}: {e}")
        return ""


def _build_system_prompt(skill_file: str, extra: str = "") -> str:
    """Build a composite system prompt from system_prompt.md + a skill file.

    Loads prompt markdown files from src/prompts/ and joins them with the
    optional extra context (e.g. taxonomy lists). Prompt files are expected
    to always be present alongside this module.
    """
    base = _load_prompt("system_prompt.md")
    skill = _load_prompt(skill_file)
    parts = [p for p in [base, skill, extra] if p]
    return "\n\n---\n\n".join(parts) if parts else ""

# ---------------------------------------------------------------------------
# Groq client (lazy init)
# ---------------------------------------------------------------------------
_client = None
_MODEL = "llama-3.3-70b-versatile"
_RATE_DELAY = 0.5  # seconds between API calls (free tier safe)

# Classification constants (keep in sync with osint_classify_rules.py)
HIERARCHY_LEVELS_LIST = [
    "Executive", "VP", "Director", "Head", "Manager", "Lead",
    "Senior", "Specialist", "Mid-Level", "Junior", "Entry", "Staff"
]

DIVISIONS_LIST = [
    "Cyber Security", "IT Infrastructure", "Software Development",
    "Data & AI", "R&D", "Product Management", "Project Management",
    "Operations", "Finance & Accounting", "Human Resources",
    "Marketing & Communications", "Sales & Business Development",
    "Legal & Compliance", "Customer Service", "Strategy & Consulting",
    "Intelligence", "Military/Defense", "General"
]


def _get_client():
    """Lazy-initialize the Groq client. Returns None if unavailable."""
    global _client
    if _client is not None:
        return _client

    api_key = os.environ.get("GROQ_API_KEY", "").strip()
    if not api_key:
        return None

    try:
        from groq import Groq
        _client = Groq(api_key=api_key)
        return _client
    except ImportError:
        logger.warning("groq package not installed. Run: pip install groq")
        return None
    except Exception as e:
        logger.warning(f"Failed to initialize Groq client: {e}")
        return None


def is_available() -> bool:
    """Check if AI enhancement is available (API key set + SDK installed)."""
    return _get_client() is not None


def _chat(system_prompt: str, user_prompt: str, temperature: float = 0.1) -> str:
    """Send a chat completion request to Groq. Returns response text or empty string."""
    client = _get_client()
    if not client:
        return ""

    try:
        time.sleep(_RATE_DELAY)
        response = client.chat.completions.create(
            model=_MODEL,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=temperature,
            max_tokens=1024,
        )
        return response.choices[0].message.content.strip()
    except Exception as e:
        logger.warning(f"Groq API call failed: {e}")
        return ""


def _parse_json_response(text: str) -> dict:
    """Extract JSON from an LLM response (handles markdown code fences)."""
    if not text:
        return {}
    # Strip markdown code fences
    cleaned = text.strip()
    if cleaned.startswith("```"):
        lines = cleaned.split("\n")
        # Remove first and last lines (fences)
        lines = [l for l in lines if not l.strip().startswith("```")]
        cleaned = "\n".join(lines)
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        # Try to find JSON object in the text
        start = cleaned.find("{")
        end = cleaned.rfind("}") + 1
        if start >= 0 and end > start:
            try:
                return json.loads(cleaned[start:end])
            except json.JSONDecodeError:
                pass
    return {}


# ============================================================================
# MACRO LEVEL: Company Relevance Scoring
# ============================================================================

def score_companies(companies: list, search_objective: str) -> list:
    """Score discovered companies for relevance to a search objective.

    Adds 'ai_relevance_score' (0-100) and 'ai_reasoning' to each company.
    Returns companies sorted by score descending.

    Args:
        companies: List of company dicts with 'name', 'industry', 'location', etc.
        search_objective: Free text describing what the user is looking for.

    Returns:
        Same list with ai_* fields added, sorted by relevance.
    """
    if not companies or not search_objective:
        return companies

    if not is_available():
        logger.info("AI not available -- skipping company scoring")
        return companies

    print(f"[AI] Scoring {len(companies)} companies for relevance...")

    system_prompt = _build_system_prompt("skill_score.md")

    # Batch companies (up to 15 per request to stay within token limits)
    batch_size = 15
    for i in range(0, len(companies), batch_size):
        batch = companies[i:i + batch_size]
        companies_text = "\n".join(
            f"- {j+1}. \"{c.get('name', 'Unknown')}\" | Industry: {c.get('industry', 'Unknown')} | "
            f"Location: {c.get('location', 'Unknown')} | Summary: {c.get('summary', 'N/A')[:150]}"
            for j, c in enumerate(batch)
        )

        user_prompt = (
            f"Search objective: \"{search_objective}\"\n\n"
            f"Companies to evaluate:\n{companies_text}\n\n"
            f"Return a JSON array with one object per company, each having: "
            f"\"index\" (1-based), \"score\" (0-100), \"reasoning\" (one sentence)."
        )

        response = _chat(system_prompt, user_prompt)
        parsed = _parse_json_response(response)

        # Handle both array and dict with array
        scores = []
        if isinstance(parsed, list):
            scores = parsed
        elif isinstance(parsed, dict):
            for key in ["companies", "results", "scores"]:
                if key in parsed and isinstance(parsed[key], list):
                    scores = parsed[key]
                    break

        # Apply scores to companies
        for score_item in scores:
            idx = score_item.get("index", 0) - 1
            if 0 <= idx < len(batch):
                batch[idx]["ai_relevance_score"] = min(100, max(0, int(score_item.get("score", 0))))
                batch[idx]["ai_reasoning"] = score_item.get("reasoning", "")

        # Fill missing scores
        for c in batch:
            if "ai_relevance_score" not in c:
                c["ai_relevance_score"] = 0
                c["ai_reasoning"] = "Could not evaluate"

        scored = sum(1 for c in batch if c.get("ai_relevance_score", 0) > 0)
        print(f"    [AI] Batch {i // batch_size + 1}: scored {scored}/{len(batch)} companies")

    # Sort by AI score descending
    companies.sort(key=lambda c: c.get("ai_relevance_score", 0), reverse=True)
    return companies


# ============================================================================
# MEDIUM LEVEL: Title Classification Enhancement
# ============================================================================

def enhance_classification(person: dict) -> dict:
    """Enhance a single person's classification using AI.

    Adds ai_role_level, ai_division, ai_confidence, ai_reasoning.
    Only overrides keyword result if AI confidence > 0.8 AND keyword
    result was low-confidence (Staff or General).

    Args:
        person: Dict with at minimum 'title', and optionally existing
                'role_level' and 'division_name' from keyword classifier.
    """
    title = person.get("title", "")
    if not title or not is_available():
        return person

    taxonomy_extra = (
        f"Hierarchy levels (pick one): {', '.join(HIERARCHY_LEVELS_LIST)}\n"
        f"Departments (pick one): {', '.join(DIVISIONS_LIST)}"
    )
    system_prompt = _build_system_prompt("skill_classify.md", taxonomy_extra)

    user_prompt = (
        f"Job title: \"{title}\"\n\n"
        f"Return JSON: {{\"role_level\": \"...\", \"division\": \"...\", "
        f"\"confidence\": 0.0-1.0, \"reasoning\": \"one sentence\"}}"
    )

    response = _chat(system_prompt, user_prompt)
    result = _parse_json_response(response)

    if result:
        ai_level = result.get("role_level", "")
        ai_division = result.get("division", "")
        ai_conf = float(result.get("confidence", 0))
        ai_reason = result.get("reasoning", "")

        # Validate against known values
        if ai_level in HIERARCHY_LEVELS_LIST:
            person["ai_role_level"] = ai_level
        if ai_division in DIVISIONS_LIST:
            person["ai_division"] = ai_division
        person["ai_confidence"] = round(ai_conf, 2)
        person["ai_reasoning"] = ai_reason

        # Promote AI result if confident and keyword was low-confidence
        kw_level = person.get("role_level", "Staff")
        kw_div = person.get("division_name", "General")
        if ai_conf >= 0.8:
            if kw_level in ("Staff", "Mid-Level") and ai_level in HIERARCHY_LEVELS_LIST:
                person["role_level"] = ai_level
                person["ai_promoted_level"] = True
            if kw_div == "General" and ai_division in DIVISIONS_LIST:
                person["division_name"] = ai_division
                person["ai_promoted_division"] = True

    return person


def enhance_classifications_batch(people: list) -> list:
    """Enhance classifications for a batch of people using fewer API calls.

    Batches up to 10 titles per request to reduce API calls.
    """
    if not people or not is_available():
        return people

    print(f"[AI] Enhancing classification for {len(people)} people...")

    taxonomy_extra = (
        f"Hierarchy levels: {', '.join(HIERARCHY_LEVELS_LIST)}\n"
        f"Departments: {', '.join(DIVISIONS_LIST)}"
    )
    system_prompt = _build_system_prompt("skill_classify.md", taxonomy_extra)

    batch_size = 10
    total_enhanced = 0

    for i in range(0, len(people), batch_size):
        batch = people[i:i + batch_size]
        titles_text = "\n".join(
            f"{j+1}. \"{p.get('title', 'Unknown')}\""
            for j, p in enumerate(batch)
        )

        user_prompt = (
            f"Classify these titles:\n{titles_text}\n\n"
            f"Return a JSON array with one object per title: "
            f"[{{\"index\": 1, \"role_level\": \"...\", \"division\": \"...\", "
            f"\"confidence\": 0.0-1.0}}]"
        )

        response = _chat(system_prompt, user_prompt)
        parsed = _parse_json_response(response)

        results = []
        if isinstance(parsed, list):
            results = parsed
        elif isinstance(parsed, dict):
            for key in ["results", "classifications", "titles"]:
                if key in parsed and isinstance(parsed[key], list):
                    results = parsed[key]
                    break

        for item in results:
            idx = item.get("index", 0) - 1
            if 0 <= idx < len(batch):
                person = batch[idx]
                ai_level = item.get("role_level", "")
                ai_division = item.get("division", "")
                ai_conf = float(item.get("confidence", 0))

                if ai_level in HIERARCHY_LEVELS_LIST:
                    person["ai_role_level"] = ai_level
                if ai_division in DIVISIONS_LIST:
                    person["ai_division"] = ai_division
                person["ai_confidence"] = round(ai_conf, 2)

                # Promote if confident and keyword was weak
                kw_level = person.get("role_level", "Staff")
                kw_div = person.get("division_name", "General")
                if ai_conf >= 0.8:
                    if kw_level in ("Staff", "Mid-Level") and ai_level in HIERARCHY_LEVELS_LIST:
                        person["role_level"] = ai_level
                        person["ai_promoted_level"] = True
                    if kw_div == "General" and ai_division in DIVISIONS_LIST:
                        person["division_name"] = ai_division
                        person["ai_promoted_division"] = True

                total_enhanced += 1

        print(f"    [AI] Batch {i // batch_size + 1}: "
              f"enhanced {min(len(results), len(batch))}/{len(batch)} titles")

    print(f"[AI] Total enhanced: {total_enhanced}/{len(people)}")
    return people


# ============================================================================
# IN-DEPTH LEVEL: Full Profile Deep Classification
# ============================================================================

def deep_classify(person: dict) -> dict:
    """Classify a person using their full profile (about, experience, education).

    This provides much higher confidence than title-only classification because
    it uses the complete career context.

    Args:
        person: Dict with 'title' and optionally 'about', 'experience',
                'education', 'skills' (from osint_scrape_profiles.py).
    """
    if not is_available():
        return person

    title = person.get("title", person.get("original_title", ""))
    about = person.get("about", "")
    experience = person.get("experience", [])
    education = person.get("education", [])
    skills = person.get("skills", [])

    # Build context from available data
    context_parts = []
    if title:
        context_parts.append(f"Current title: {title}")
    if about:
        context_parts.append(f"About: {about[:500]}")
    if experience:
        exp_text = "; ".join(
            f"{e.get('title', '')} at {e.get('company', '')} ({e.get('date_range', '')})"
            for e in experience[:5]
        )
        context_parts.append(f"Experience: {exp_text}")
    if education:
        edu_text = "; ".join(
            f"{e.get('degree', '')} at {e.get('school', '')} ({e.get('date_range', '')})"
            for e in education[:3]
        )
        context_parts.append(f"Education: {edu_text}")
    if skills:
        context_parts.append(f"Skills: {', '.join(skills[:15])}")

    if not context_parts:
        return person

    taxonomy_extra = (
        f"Hierarchy levels: {', '.join(HIERARCHY_LEVELS_LIST)}\n"
        f"Departments: {', '.join(DIVISIONS_LIST)}"
    )
    system_prompt = _build_system_prompt("skill_classify.md", taxonomy_extra)

    user_prompt = (
        f"Full profile:\n" + "\n".join(context_parts) + "\n\n"
        f"Return JSON: {{\"role_level\": \"...\", \"division\": \"...\", "
        f"\"confidence\": 0.0-1.0, \"reasoning\": \"2-3 sentences explaining "
        f"why based on the full profile context\"}}"
    )

    response = _chat(system_prompt, user_prompt)
    result = _parse_json_response(response)

    if result:
        ai_level = result.get("role_level", "")
        ai_division = result.get("division", "")
        ai_conf = float(result.get("confidence", 0))
        ai_reason = result.get("reasoning", "")

        if ai_level in HIERARCHY_LEVELS_LIST:
            person["ai_role_level"] = ai_level
        if ai_division in DIVISIONS_LIST:
            person["ai_division"] = ai_division
        person["ai_confidence"] = round(ai_conf, 2)
        person["ai_reasoning"] = ai_reason
        person["ai_deep_classified"] = True

        # Deep classification with full context: promote if confidence >= 0.7
        # (lower threshold than title-only because we have much more context)
        kw_level = person.get("role_level", person.get("original_role_level", "Staff"))
        kw_div = person.get("division_name", person.get("original_division", "General"))
        if ai_conf >= 0.7:
            if kw_level in ("Staff", "Mid-Level") and ai_level in HIERARCHY_LEVELS_LIST:
                person["role_level"] = ai_level
                person["ai_promoted_level"] = True
            if kw_div == "General" and ai_division in DIVISIONS_LIST:
                person["division_name"] = ai_division
                person["ai_promoted_division"] = True

    return person


# ============================================================================
# CLI self-test
# ============================================================================
if __name__ == "__main__":
    print("=" * 70)
    print("AI ENHANCER - Self Test")
    print("=" * 70)

    if not is_available():
        print("[-] GROQ_API_KEY not set or groq package not installed.")
        print("    Set it in .env or export GROQ_API_KEY=your_key")
        exit(1)

    print("[+] Groq client initialized successfully\n")

    # Test 1: Company scoring
    print("--- Test: Company Scoring ---")
    test_companies = [
        {"name": "CyberArk", "industry": "Computer and Network Security", "location": "Israel"},
        {"name": "Wix", "industry": "Software Development", "location": "Israel"},
        {"name": "Cafe Aroma", "industry": "Food & Beverages", "location": "Israel"},
    ]
    scored = score_companies(test_companies, "cybersecurity companies for defense research")
    for c in scored:
        print(f"  {c['name']}: score={c.get('ai_relevance_score', '?')}")
        print(f"    {c.get('ai_reasoning', '')}")

    # Test 2: Title classification
    print("\n--- Test: Title Classification ---")
    test_person = {"title": "Senior Cloud Security Architect", "role_level": "Staff", "division_name": "General"}
    enhanced = enhance_classification(test_person)
    print(f"  Title: {enhanced['title']}")
    print(f"  Keyword: {enhanced.get('role_level')} / {enhanced.get('division_name')}")
    print(f"  AI: {enhanced.get('ai_role_level')} / {enhanced.get('ai_division')} "
          f"(conf: {enhanced.get('ai_confidence')})")

    # Test 3: Deep classification
    print("\n--- Test: Deep Classification ---")
    test_deep = {
        "title": "Security Operations",
        "about": "15+ years in cybersecurity leadership. Built and led SOC teams across EMEA.",
        "experience": [
            {"title": "Head of Security Operations", "company": "Big Corp", "date_range": "2020-Present"},
            {"title": "SOC Manager", "company": "Medium Corp", "date_range": "2015-2020"},
        ],
        "education": [{"degree": "MSc Cyber Security", "school": "MIT", "date_range": "2013-2015"}],
        "skills": ["SIEM", "Incident Response", "Team Leadership", "Threat Hunting"],
        "role_level": "Mid-Level",
        "division_name": "General",
    }
    deep = deep_classify(test_deep)
    print(f"  Title: {deep['title']}")
    print(f"  AI Level: {deep.get('ai_role_level')} (was: Mid-Level)")
    print(f"  AI Division: {deep.get('ai_division')} (was: General)")
    print(f"  AI Confidence: {deep.get('ai_confidence')}")
    print(f"  AI Reasoning: {deep.get('ai_reasoning')}")

    print("\n[+] All tests complete")
