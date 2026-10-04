# Tool Definitions - Data Schemas

This document defines the input and output data schemas used by each AI function in the OSINT pipeline.

---

## 1. `score_companies` — Macro Level

### Input

```json
{
  "search_objective": "string — free text describing what the user is looking for",
  "companies": [
    {
      "name": "string — company name",
      "industry": "string — LinkedIn industry category",
      "location": "string — company HQ location",
      "summary": "string (optional) — brief company description, max 150 chars"
    }
  ]
}
```

### Output

```json
[
  {
    "index": "int — 1-based position in the input array",
    "score": "int — relevance score 0-100",
    "reasoning": "string — one sentence explaining the score"
  }
]
```

---

## 2. `enhance_classification` — Medium Level (Single)

### Input

```json
{
  "title": "string — LinkedIn job title"
}
```

### Output

```json
{
  "role_level": "string — one of the 12 hierarchy levels",
  "division": "string — one of the 18 departments",
  "confidence": "float — 0.0 to 1.0",
  "reasoning": "string — one sentence"
}
```

---

## 3. `enhance_classifications_batch` — Medium Level (Batch)

### Input

Numbered list of titles (plain text, one per line):
```
1. "Senior Cloud Security Architect"
2. "VP of Engineering"
3. "Junior Data Analyst"
```

### Output

```json
[
  {
    "index": "int — 1-based matching the input number",
    "role_level": "string — one of the 12 hierarchy levels",
    "division": "string — one of the 18 departments",
    "confidence": "float — 0.0 to 1.0"
  }
]
```

---

## 4. `deep_classify` — In-Depth Level

### Input

```json
{
  "title": "string — current LinkedIn job title",
  "about": "string (optional) — LinkedIn about/summary section, max 500 chars",
  "experience": [
    {
      "title": "string — role title",
      "company": "string — company name",
      "date_range": "string — e.g. '2020-Present'"
    }
  ],
  "education": [
    {
      "degree": "string — degree name",
      "school": "string — institution name",
      "date_range": "string — e.g. '2013-2015'"
    }
  ],
  "skills": ["string — skill name", "..."]
}
```

### Output

```json
{
  "role_level": "string — one of the 12 hierarchy levels",
  "division": "string — one of the 18 departments",
  "confidence": "float — 0.0 to 1.0",
  "reasoning": "string — 2-3 sentences explaining the classification based on full profile context"
}
```

---

## Taxonomy Reference

### Hierarchy Levels (12)

| Level | Weight | Description |
|-------|--------|-------------|
| Executive | 100 | C-suite, founders, board members |
| VP | 90 | Vice presidents, SVPs, EVPs |
| Director | 80 | Directors, senior directors |
| Head | 70 | Head of department/function |
| Manager | 60 | Managers, senior managers |
| Lead | 50 | Team leads, tech leads |
| Senior | 45 | Senior individual contributors |
| Specialist | 40 | Domain specialists |
| Mid-Level | 30 | Standard individual contributors |
| Junior | 20 | Junior roles |
| Entry | 10 | Interns, trainees, apprentices |
| Staff | 5 | Unclassifiable (fallback) |

### Departments (18)

Cyber Security, IT Infrastructure, Software Development, Data & AI, R&D, Product Management, Project Management, Operations, Finance & Accounting, Human Resources, Marketing & Communications, Sales & Business Development, Legal & Compliance, Customer Service, Strategy & Consulting, Intelligence, Military/Defense, General
