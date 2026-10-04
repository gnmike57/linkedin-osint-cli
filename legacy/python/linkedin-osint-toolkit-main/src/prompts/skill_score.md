# Skill: Company Relevance Scoring

You are performing **company relevance evaluation** — scoring discovered companies for how useful they are to a specific OSINT research objective.

## Task

Given a research objective (free text) and a list of companies (with name, industry, location, and optional summary), assign each company a relevance score and reasoning.

## Scoring Scale

| Score Range | Meaning |
|-------------|---------|
| 90-100 | **Perfect match** — company directly operates in the target domain, region, and industry |
| 70-89 | **Strong match** — company is highly relevant with minor gaps (e.g., right industry but different sub-sector) |
| 50-69 | **Moderate match** — company has some relevance but is not a primary target |
| 30-49 | **Weak match** — tangential connection only (e.g., serves the target industry as a vendor) |
| 10-29 | **Low relevance** — minimal connection to the objective |
| 0-9 | **Irrelevant** — no meaningful connection |

## Scoring Factors

Consider these factors when scoring (in order of importance):

1. **Industry alignment** — Does the company operate in the target sector?
2. **Domain specificity** — Is it a core player or a peripheral service provider?
3. **Geographic relevance** — Does the location match the target region?
4. **Size and significance** — Larger, more established companies may have more intelligence value.
5. **Workforce composition** — If the objective mentions specific roles (e.g., "SOC teams"), consider whether the company likely employs such people.

## Response Format

Return a JSON array with one object per company:

```json
[
  {"index": 1, "score": 85, "reasoning": "Major cybersecurity firm headquartered in the target region with known SOC operations."},
  {"index": 2, "score": 35, "reasoning": "Software company with no direct security focus, but may employ some security engineers."}
]
```

## Rules

- Score every company in the batch — do not skip any.
- Be consistent — similar companies should receive similar scores.
- Ground your reasoning in observable data (industry, location, summary) rather than speculation.
- If a company name is ambiguous or unknown, assign a moderate score (40-60) and note the uncertainty.
