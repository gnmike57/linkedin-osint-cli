import { describe, expect, it } from 'vitest';
import {
  classifyTitle,
  classifyRoleLevel,
  classifyDivision,
  cleanTitle,
  getHierarchyOrder,
  getDivisionNames,
  RULES,
} from '../src/osint/classify.js';

// Every case below is a verified row of the original Python engine's
// self-test table (75/75 accuracy) captured at consolidation time.
const CASES: Array<[string, string, string]> = [
  // [title, expected role_level, expected division]
  ['CEO', 'Executive', 'General'],
  ['Chief Technology Officer', 'Executive', 'IT Infrastructure'],
  ['Deputy CEO', 'Executive', 'General'],
  ['Chief of Staff', 'Executive', 'General'],
  ['Founder & CEO', 'Executive', 'General'],
  ['Co-Founder', 'Executive', 'General'],
  ['Chief Actuary', 'Executive', 'General'],
  ['Digital Executive | Big Data | AI | Cloud', 'Executive', 'Data & AI'],
  ['Entrepreneur', 'Executive', 'General'],
  ['EVP Chief Procurement Officer', 'VP', 'Operations'],
  ['SVP Technology Division', 'VP', 'IT Infrastructure'],
  ['VP, Head of Software Engineering', 'VP', 'Software Development'],
  ['Vice President of Engineering', 'VP', 'Software Development'],
  ['Senior Director', 'Director', 'General'],
  ['Director of Cyber Technologies', 'Director', 'Cyber Security'],
  ['Managing Director', 'Director', 'General'],
  ['Head of Cyber Security Solutions', 'Head', 'Software Development'],
  ['Head of Data', 'Head', 'General'],
  ['Deputy Head of IT', 'Head', 'General'],
  ['Chapter Lead', 'Head', 'General'],
  ['Senior Manager, Cyber Security', 'Manager', 'Cyber Security'],
  ['Department Manager', 'Manager', 'General'],
  ['Group Manager', 'Manager', 'General'],
  ['Project Manager', 'Manager', 'Project Management'],
  ['Product Manager', 'Manager', 'Product'],
  ['Supervisor', 'Manager', 'General'],
  ['Team Leader', 'Lead', 'General'],
  ['Tech Lead', 'Lead', 'General'],
  ['Agile Coach', 'Lead', 'Project Management'],
  ['Technology Leader', 'Lead', 'IT Infrastructure'],
  ['Government Cybersecurity Guidance Lead', 'Lead', 'Cyber Security'],
  ['Cloud Delivery Lead', 'Lead', 'Operations'],
  ['Senior Software Engineer', 'Senior', 'Software Development'],
  ['Principal Engineer', 'Senior', 'General'],
  ['Staff Engineer', 'Senior', 'General'],
  ['Senior Consultant at Israel Government ICT Authority', 'Senior', 'Strategy'],
  ['Security Architect', 'Specialist', 'Cyber Security'],
  ['Cybersecurity Expert', 'Specialist', 'Cyber Security'],
  ['Information Security Specialist', 'Specialist', 'Cyber Security'],
  ['Data Scientist', 'Specialist', 'Data & AI'],
  ['Product Owner', 'Specialist', 'Product'],
  ['Scrum Master', 'Specialist', 'Project Management'],
  ['UX Designer', 'Specialist', 'Product'],
  ['Actuary', 'Specialist', 'Finance'],
  ['Attorney', 'Specialist', 'Legal & Compliance'],
  ['Recruiter', 'Specialist', 'HR'],
  ['HRBP', 'Specialist', 'HR'],
  ['Account Manager', 'Specialist', 'Sales'],
  ['AI Creator', 'Specialist', 'Data & AI'],
  ['Cyber Security & Incident Response', 'Specialist', 'Cyber Security'],
  ['Author / Product and Strategy Professional / Entrepreneur', 'Executive', 'Strategy'],
  ['Cyber Awareness | Strategic Communication', 'Specialist', 'Strategy'],
  ['Software Engineer', 'Mid-Level', 'Software Development'],
  ['SOC Analyst', 'Mid-Level', 'Cyber Security'],
  ['DevOps Engineer', 'Mid-Level', 'IT Infrastructure'],
  ['System Administrator', 'Mid-Level', 'IT Infrastructure'],
  ['Technician', 'Mid-Level', 'General'],
  ['Banker', 'Mid-Level', 'Finance'],
  ['Auditor', 'Mid-Level', 'Finance'],
  ['Pilot', 'Mid-Level', 'Operations'],
  ['Penetration Tester', 'Mid-Level', 'Cyber Security'],
  ['Cyber Security Resercher', 'Mid-Level', 'Cyber Security'],
  ['Human Resources Management', 'Mid-Level', 'HR'],
  ['Software & Automation Dev | C#, Python, JS', 'Mid-Level', 'Software Development'],
  ['Product Manger at Some Company', 'Manager', 'Product'],
  ['PMO', 'Manager', 'Project Management'],
  ['Hosting Services at Israeli E-Government - gov.il', 'Mid-Level', 'IT Infrastructure'],
  ['Junior Developer', 'Junior', 'Software Development'],
  ['Associate Analyst', 'Junior', 'General'],
  ['Assistant', 'Junior', 'General'],
  ['Intern', 'Entry', 'General'],
  ['Student', 'Entry', 'Education'],
  ['Trainee', 'Entry', 'General'],
  ['Looking for new opportunity', 'Staff', 'General'],
  ['Solved', 'Staff', 'General'],
];

describe('classifyTitle (verified against the Python engine, 75/75)', () => {
  it.each(CASES)('%s', (title, expectedLevel, expectedDivision) => {
    const result = classifyTitle(title);
    expect(result.role_level).toBe(expectedLevel);
    expect(result.division).toBe(expectedDivision);
  });
});

describe('classifyRoleLevel extras', () => {
  it('junior modifiers suppress mid-level pattern matches', () => {
    // "Software Engineer" alone is Mid-Level, but the junior modifier wins.
    expect(classifyRoleLevel('Junior Software Engineer')[0]).toBe('Junior');
    expect(classifyRoleLevel('Associate Data Analyst')[0]).toBe('Junior');
  });

  it('weights decide among multiple matches (Director beats Manager)', () => {
    expect(classifyRoleLevel('Marketing Manager and Sales Director')[0]).toBe('Director');
  });

  it('empty titles fall back to Staff', () => {
    expect(classifyRoleLevel('')).toEqual(['Staff', 5]);
  });
});

describe('classifyDivision extras', () => {
  it('empty or junk titles return General', () => {
    expect(classifyDivision('')).toBe('General');
    expect(classifyDivision('Looking for new opportunity')).toBe('General');
  });

  it('short keywords match on word boundaries only', () => {
    // "it" must not match inside "iterator"
    expect(classifyDivision('Chief Iterator Wrangler')).toBe('General');
  });
});

describe('cleanTitle', () => {
  it('strips "at Company" suffixes', () => {
    expect(cleanTitle('Senior Consultant at Israel Government ICT Authority')).toBe(
      'Senior Consultant',
    );
  });

  it('filters junk and company-name-only entries', () => {
    expect(cleanTitle('Looking for new opportunity')).toBe('');
    expect(cleanTitle('Bank Hapoalim')).toBe('');
  });
});

describe('taxonomy helpers', () => {
  it('orders hierarchy levels by weight', () => {
    const order = getHierarchyOrder();
    expect(order[0]).toBe('Executive');
    expect(order[order.length - 1]).toBe('Staff');
    expect(order).toHaveLength(12);
  });

  it('exposes 20 divisions from the JSON', () => {
    expect(getDivisionNames()).toHaveLength(20);
    expect(getDivisionNames()).toContain('Cyber Security');
  });

  it('reports rule metadata', () => {
    expect(RULES.meta.version).toBe('1.0');
    expect(RULES.hierarchy_patterns.length).toBe(28);
    expect(Object.keys(RULES.title_overrides).length).toBe(287);
  });
});
