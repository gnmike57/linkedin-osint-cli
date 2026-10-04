/* ANSI color helpers — chalk-free, TTY- and NO_COLOR-aware. */

const enabled =
  Boolean(process.stdout.isTTY) &&
  !process.env.NO_COLOR &&
  process.env.NODE_DISABLE_COLORS !== '1';

export type ColorName =
  | 'gray'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan'
  | 'white'
  | 'bold'
  | 'dim'
  | 'inverse';

const CODES: Record<ColorName, [string, string]> = {
  gray: ['90', '39'],
  red: ['31', '39'],
  green: ['32', '39'],
  yellow: ['33', '39'],
  blue: ['34', '39'],
  magenta: ['35', '39'],
  cyan: ['96', '39'],
  white: ['97', '39'],
  bold: ['1', '22'],
  dim: ['2', '22'],
  inverse: ['7', '27'],
};

export function paint(name: ColorName, text: string): string {
  if (!enabled || !text) return text;
  const [open, close] = CODES[name];
  return `[${open}m${text}[${close}m`;
}

export const c = {
  gray: (s: string) => paint('gray', s),
  red: (s: string) => paint('red', s),
  green: (s: string) => paint('green', s),
  yellow: (s: string) => paint('yellow', s),
  blue: (s: string) => paint('blue', s),
  magenta: (s: string) => paint('magenta', s),
  cyan: (s: string) => paint('cyan', s),
  white: (s: string) => paint('white', s),
  bold: (s: string) => paint('bold', s),
  dim: (s: string) => paint('dim', s),
  inverse: (s: string) => paint('inverse', s),
};

export const CHECK = c.green('✔');
export const CROSS = c.red('✖');
export const ARROW = c.cyan('➜');
export const DOT = c.gray('·');
