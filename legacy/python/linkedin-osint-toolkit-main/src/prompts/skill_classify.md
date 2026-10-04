# Skill: Classification

You are performing **organizational classification** — placing people into a structured hierarchy and department taxonomy.

## Task Types

### Title-Only Classification (Medium Level)

Given a LinkedIn job title, classify it into exactly one hierarchy level and one department.

**Hierarchy Levels** (ordered by seniority):
Executive, VP, Director, Head, Manager, Lead, Senior, Specialist, Mid-Level, Junior, Entry, Staff

**Departments** (pick exactly one):
Cyber Security, IT Infrastructure, Software Development, Data & AI, R&D, Product Management, Project Management, Operations, Finance & Accounting, Human Resources, Marketing & Communications, Sales & Business Development, Legal & Compliance, Customer Service, Strategy & Consulting, Intelligence, Military/Defense, General

**Classification Rules:**
- "Staff" means you could not determine the hierarchy level — use it as a last resort.
- "General" means you could not determine the department — use it as a last resort.
- Compound titles (e.g., "VP of Engineering & CISO") → pick the highest seniority level and the most specific department.
- Regional/country titles (e.g., "Country Manager") → classify by seniority, not geography.
- Abbreviated titles (e.g., "SVP", "EVP", "CTO") → expand and classify accordingly.
- Military ranks → map to the closest corporate equivalent and use "Military/Defense" department.
- Board members, advisors, founders → classify as "Executive".

**Single title response format:**
```json
{"role_level": "...", "division": "...", "confidence": 0.0-1.0, "reasoning": "one sentence"}
```

**Batch titles response format:**
```json
[{"index": 1, "role_level": "...", "division": "...", "confidence": 0.0-1.0}, ...]
```

### Full Profile Classification (In-Depth Level)

Given a complete profile (title, about, experience history, education, skills), determine the most accurate classification.

**Additional signals to consider:**
- Career trajectory: 3+ director-level roles suggests current role is also director-level even if title is vague.
- Education: PhD/Masters in a specific field strengthens department classification.
- Skills: Domain-specific skills (e.g., "penetration testing", "SIEM") confirm department.
- About section: Self-described seniority and specialization.
- Seniority indicators: years of experience, team size, budget responsibility.

**Full profile response format:**
```json
{"role_level": "...", "division": "...", "confidence": 0.0-1.0, "reasoning": "2-3 sentences explaining why based on the full profile context"}
```

## Confidence Guidelines

| Confidence | Meaning |
|-----------|---------|
| 0.95-1.0 | Title explicitly states both level and department (e.g., "Director of Cyber Security") |
| 0.85-0.94 | Strong signal from title + one additional source (experience or skills) |
| 0.70-0.84 | Reasonable inference from available data, some ambiguity |
| 0.50-0.69 | Educated guess — data is sparse or conflicting |
| 0.0-0.49 | Very uncertain — insufficient data or highly ambiguous title |
