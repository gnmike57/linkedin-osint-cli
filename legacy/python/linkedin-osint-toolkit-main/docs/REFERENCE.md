# Reference Tables

Quick reference for role classification, LinkedIn geo codes, and industry categories used by the toolkit.

---

## Role Classification

The `osint_classify_rules.py` module classifies job titles into hierarchy levels and divisions. All patterns, keywords, and overrides are loaded at runtime from `src/classification_rules.json` (learned from ~30K real profiles). To tune classification, edit the JSON file directly.

### Hierarchy Levels

| Level      | Weight | Examples                          |
|------------|--------|-----------------------------------|
| Executive  | 100    | CEO, CTO, CFO, CISO, Founder      |
| VP         | 90     | VP, Vice President, EVP, SVP      |
| Director   | 80     | Director, Managing Director       |
| Head       | 70     | Head of X, Department Head        |
| Manager    | 60     | Manager, Supervisor               |
| Lead       | 50     | Team Lead, Tech Lead              |
| Senior     | 45     | Senior X, Principal               |
| Specialist | 40     | Architect, Expert, Consultant     |
| Mid-Level  | 30     | Engineer, Developer, Analyst      |
| Junior     | 20     | Junior, Associate                 |
| Entry      | 10     | Intern, Student, Trainee          |
| Staff      | 5      | Uncategorized                     |

### Divisions

The classifier assigns titles to one of 18 division categories:

- Cyber Security
- IT Infrastructure
- Software Development
- Data & AI
- R&D
- Product
- Project Management
- Operations
- Finance
- HR
- Marketing
- Sales
- Legal & Compliance
- Customer Service
- Strategy
- Intelligence
- Military/Defense
- General

---

## LinkedIn Geo Codes

The toolkit ships with 51 built-in geo codes. Run `--list-geo-codes` to print the full table:

```bash
python src/osint_discover.py --list-geo-codes
```

Common codes for quick reference:

| Region         | Geo Code   |
|----------------|------------|
| USA            | 103644278  |
| UK             | 101165590  |
| Germany        | 101282230  |
| France         | 105015875  |
| Canada         | 101174742  |
| Australia      | 101452733  |
| Israel         | 101620260  |
| India          | 102713980  |
| Netherlands    | 102890719  |
| Singapore      | 102454443  |
| UAE            | 104305776  |
| Japan          | 101355337  |
| Brazil         | 106057199  |
| South Korea    | 105149562  |
| Switzerland    | 106693272  |

To find geo codes for regions not in the built-in table, use LinkedIn's company search in your browser, apply a location filter, and extract the code from the URL parameter `companyHqGeo=%5B%22<CODE>%22%5D`.

---

## Industry Classification

The `osint_discover.py` module normalizes LinkedIn industry strings into standard categories for filtering and analysis.

Use `--list-industries` to see all available categories from the CLI.

| Category          | Keywords                                           |
|-------------------|---------------------------------------------------|
| Technology        | software, technology, tech, IT services            |
| Cybersecurity     | cyber, security, infosec, defense                  |
| Telecommunications| telecom, ISP, internet, mobile, wireless           |
| Cloud/SaaS        | cloud, saas, platform, hosting                     |
| Banking           | bank, banking, financial services                  |
| Insurance         | insurance, insurtech                               |
| Fintech           | fintech, payment, crypto, blockchain               |
| Government        | government, public sector, ministry                |
| Defense           | defense, defence, military, aerospace              |
| Intelligence      | intelligence, national security                    |
| Manufacturing     | manufacturing, industrial, factory                 |
| Energy            | energy, oil, gas, utilities, power                 |
| Transportation    | transportation, logistics, shipping, aviation      |
| Healthcare        | health, medical, hospital, pharma, biotech         |
| Consulting        | consulting, advisory, professional services        |
| Legal             | legal, law firm, attorney                          |
| Education         | education, university, school, training            |
| Retail            | retail, e-commerce, consumer, wholesale            |
| Media             | media, entertainment, broadcast, publishing        |
