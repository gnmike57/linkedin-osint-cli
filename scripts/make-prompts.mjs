// Generates src/osint/prompts.ts by inlining the canonical prompt markdown
// files from src/osint/prompts/. Inlining keeps the prompts bundled in dist/
// for npm installs. Re-run after editing any prompt .md file:
//   node scripts/make-prompts.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const dir = 'src/osint/prompts';
const read = (f) => readFileSync(`${dir}/${f}`, 'utf8').trim();

const system = read('system_prompt.md');
const classify = read('skill_classify.md');
const score = read('skill_score.md');

const out = `/**
 * AI prompt definitions — inlined from src/osint/prompts/*.md (the canonical
 * source files, ported from the legacy toolkit). Inlining keeps them bundled
 * in dist/ for npm installs. Regenerate with: node scripts/make-prompts.mjs
 */

export const SYSTEM_PROMPT = ${JSON.stringify(system)};

export const SKILL_CLASSIFY_PROMPT = ${JSON.stringify(classify)};

export const SKILL_SCORE_PROMPT = ${JSON.stringify(score)};
`;

writeFileSync('src/osint/prompts.ts', out);
console.log(`prompts.ts written (${out.length} chars)`);
