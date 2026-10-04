/**
 * Stub for @inquirer/prompts used in tests: this sandbox's npm registry serves
 * stub tarballs (LICENSE/README/package.json only, no dist/), so the real
 * package cannot be imported under vitest. Code paths that call these prompts
 * are exercised manually on the operator's machine where npm is healthy.
 */
async function answer() {
  return '';
}

export const input = answer;
export const password = answer;
export const confirm = async () => false;
export const select = answer;
export const checkbox = async () => [];
export const editor = answer;
export const expand = answer;
export const number = async () => 0;
export const rawlist = answer;
export const search = answer;
export default { input, password, confirm, select, checkbox, editor, expand, number, rawlist, search };
