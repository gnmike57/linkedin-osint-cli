import { describe, expect, it } from 'vitest';
import { NameMutator, cleanName, splitName, hyphenVariants } from '../src/osint/names.js';

// Ground truth captured from the original Python implementation
// (legacy/python/linkedin2username-master) via a verified execution dump.

const S = (arr: string[]) => new Set(arr);

describe('cleanName', () => {
  it('normalizes accents, emoji, and credentials', () => {
    expect(cleanName('  🙂Ànèôõö    ßï🙂  ')).toBe('aneooo ssi');
    expect(cleanName('Dr. Hannibal Lecter, PhD.')).toBe('hannibal lecter');
    expect(cleanName('Mr. Fancy Pants MD, PhD, MBA')).toBe('fancy pants');
    expect(cleanName('Mr. Cert Dude (OSCP, OSCE)')).toBe('cert dude');
  });
});

describe('splitName', () => {
  it('handles 2-word, 3-word, and hyphenated names', () => {
    expect(splitName('madonna wayne gacey')).toEqual({
      first: 'madonna',
      second: 'wayne',
      last: 'gacey',
    });
    expect(splitName('twiggy ramirez')).toEqual({
      first: 'twiggy',
      second: '',
      last: 'ramirez',
    });
    expect(splitName('brian warner is marilyn manson')).toEqual({
      first: 'brian',
      second: 'marilyn',
      last: 'manson',
    });
    // Hyphens within a name segment are preserved (not treated as separators)
    expect(splitName('jean-charles martin')).toEqual({
      first: 'jean-charles',
      second: '',
      last: 'martin',
    });
    expect(splitName('john davidson-smith')).toEqual({
      first: 'john',
      second: '',
      last: 'davidson-smith',
    });
    expect(splitName('john-paul smith-robinson')).toEqual({
      first: 'john-paul',
      second: '',
      last: 'smith-robinson',
    });
  });

  it('returns null without a first+last pair', () => {
    expect(splitName('madonna')).toBeNull();
    expect(splitName('')).toBeNull();
  });
});

describe('hyphenVariants', () => {
  it('expands hyphenated parts', () => {
    expect(hyphenVariants('smith')).toEqual(['smith']);
    expect(hyphenVariants('davidson-smith')).toEqual(['davidson-smith', 'davidson', 'smith']);
    expect(hyphenVariants('a-b-c')).toEqual(['a-b-c', 'a', 'b', 'c']);
  });
});

describe('NameMutator', () => {
  it('mutates "John Smith"', () => {
    const m = new NameMutator('John Smith');
    expect(m.fLast()).toEqual(S(['jsmith']));
    expect(m.fDotLast()).toEqual(S(['j.smith']));
    expect(m.lastF()).toEqual(S(['smithj']));
    expect(m.firstDotLast()).toEqual(S(['john.smith']));
    expect(m.firstL()).toEqual(S(['johns']));
    expect(m.first()).toEqual(S(['john']));
  });

  it('mutates "John Davidson-Smith" (hyphenated last)', () => {
    const m = new NameMutator('John Davidson-Smith');
    expect(m.fLast()).toEqual(S(['jdavidson-smith', 'jdavidson', 'jsmith']));
    expect(m.fDotLast()).toEqual(S(['j.davidson-smith', 'j.davidson', 'j.smith']));
    expect(m.lastF()).toEqual(S(['davidson-smithj', 'davidsonj', 'smithj']));
    expect(m.firstDotLast()).toEqual(S(['john.davidson-smith', 'john.davidson', 'john.smith']));
    expect(m.firstL()).toEqual(S(['johnd', 'johns']));
    expect(m.first()).toEqual(S(['john']));
  });

  it('mutates "John-Paul Smith-Robinson" (hyphenated first and last)', () => {
    const m = new NameMutator('John-Paul Smith-Robinson');
    expect(m.fLast()).toEqual(S(['jsmith-robinson', 'jsmith', 'jrobinson']));
    expect(m.fDotLast()).toEqual(S(['j.smith-robinson', 'j.smith', 'j.robinson']));
    expect(m.lastF()).toEqual(S(['smith-robinsonj', 'smithj', 'robinsonj']));
    expect(m.firstDotLast()).toEqual(
      S(['john-paul.smith-robinson', 'john-paul.smith', 'john-paul.robinson']),
    );
    expect(m.firstL()).toEqual(S(['john-pauls', 'john-paulr']));
    expect(m.first()).toEqual(S(['john-paul']));
  });

  it('mutates "José Gonzáles" (accented)', () => {
    const m = new NameMutator('José Gonzáles');
    expect(m.fLast()).toEqual(S(['jgonzales']));
    expect(m.first()).toEqual(S(['jose']));
  });

  it('mutates "🙂 Emoji Folks 🙂" (emoji stripped)', () => {
    const m = new NameMutator('🙂 Emoji Folks 🙂');
    expect(m.fLast()).toEqual(S(['efolks']));
    expect(m.fDotLast()).toEqual(S(['e.folks']));
    expect(m.lastF()).toEqual(S(['folkse']));
    expect(m.firstL()).toEqual(S(['emojif']));
    expect(m.first()).toEqual(S(['emoji']));
  });

  it('mutates "Jean-Charles Martin" (compound first preserved)', () => {
    const m = new NameMutator('Jean-Charles Martin');
    expect(m.fLast()).toEqual(S(['jmartin']));
    expect(m.firstDotLast()).toEqual(S(['jean-charles.martin']));
    expect(m.firstL()).toEqual(S(['jean-charlesm']));
    expect(m.first()).toEqual(S(['jean-charles']));
  });

  it('mutates 3-word names using the middle name', () => {
    const m = new NameMutator('Madonna Wayne Gacey');
    expect(m.fLast()).toEqual(S(['mgacey', 'mwayne']));
    expect(m.fDotLast()).toEqual(S(['m.gacey', 'm.wayne']));
    expect(m.lastF()).toEqual(S(['gaceym', 'waynem']));
    expect(m.firstDotLast()).toEqual(S(['madonna.gacey', 'madonna.wayne']));
    expect(m.firstL()).toEqual(S(['madonnag', 'madonnaw']));
    expect(m.first()).toEqual(S(['madonna']));
  });

  it('produces empty sets for names without a last name', () => {
    const m = new NameMutator('Cher');
    expect(m.name).toBeNull();
    expect(m.fLast().size).toBe(0);
    expect(m.first().size).toBe(0);
  });
});
