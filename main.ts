// main.ts is mend, the CLI SPEC.md specifies: it does all of SPEC.md, sections 1 to 10 — the command line, the
// output and exit codes, safe paths, format detection, line matching at three tiers (section 5), unified diffs
// (section 6), SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9) and the
// all-or-nothing write (section 10). Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, in patch order: [old path, new path]. */
  readonly moves: Array<[string, string]> = [];
  recordMove(oldPath: string, newPath: string): void {
    this.moves.push([oldPath, newPath]);
  }
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** Leading spaces and tabs of a line. */
function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function stripTrail(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function stripBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Tier comparison of one line (SPEC.md section 5). */
function lineEq(tier: number, a: string, b: string): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** 0-based positions where O occurs in lines at one tier, at or after `from`. */
function occurrences(lines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  for (let i = Math.max(0, from); i + o.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < o.length; k++) {
      if (!lineEq(tier, lines[i + k]!, o[k]!)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which O occurs, with its positions. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The first line at or after `from` equal to `line` at the first tier where one is, or -1. */
function findSingleLine(lines: string[], line: string, strict: boolean, from = 0): number {
  const found = findTier(lines, [line], strict, from);
  return found === null ? -1 : found.occ[0]!;
}

/** A file's lines, its line break and whether it ends with one (SPEC.md section 3). */
function splitFile(text: string): { br: string; lines: string[]; final: boolean } {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(br: string, lines: string[], final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

/** One body line of a unified hunk or a V4A chunk. */
type BodyItem =
  | { kind: 'ctx'; text: string; blank: boolean }
  | { kind: 'old'; text: string }
  | { kind: 'new'; text: string }
  | { kind: 'bslash'; text: string };

/** Split body items into old lines O and new lines N (SPEC.md section 5). */
function buildN(items: BodyItem[]): { O: string[]; N: Array<{ text: string; ctx: boolean; oPos: number }> } {
  const O: string[] = [];
  const N: Array<{ text: string; ctx: boolean; oPos: number }> = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      O.push(it.text);
      N.push({ text: it.text, ctx: true, oPos: O.length - 1 });
    } else if (it.kind === 'old') {
      O.push(it.text);
    } else if (it.kind === 'new') {
      N.push({ text: it.text, ctx: false, oPos: -1 });
    }
  }
  return { O, N };
}

/**
 * Replace the k matched lines at `at` with N. A context line is written as the file's own matched
 * line; at tier 2 every other line of N is re-indented from O's first line to the file's first
 * matched line. Section 5.
 */
function replaceAt(F: string[], at: number, O: string[], N: Array<{ text: string; ctx: boolean; oPos: number }>, tier: number): string[] {
  const out = F.slice(0, at);
  const P = O.length > 0 ? leadingWs(O[0]!) : '';
  const Fws = O.length > 0 ? leadingWs(F[at]!) : '';
  for (const n of N) {
    if (n.ctx) {
      out.push(F[at + n.oPos]!);
    } else {
      let t = n.text;
      if (tier === 2 && t.trim() !== '' && t.startsWith(P)) t = Fws + t.slice(P.length);
      out.push(t);
    }
  }
  out.push(...F.slice(at + O.length));
  return out;
}

/** True when a `\` line follows the hunk's last context or `+` line (section 6). */
function hunkNoEol(items: BodyItem[]): boolean {
  let last = -1;
  for (let k = 0; k < items.length; k++) {
    if (items[k]!.kind === 'ctx' || items[k]!.kind === 'new') last = k;
  }
  if (last < 0) return false;
  return items[last + 1]?.kind === 'bslash';
}

/** Apply hunks in order to a file's text; throws Fail('no-match', path) on a hunk that finds nothing. */
function applyHunks(before: string, hunks: Array<{ a: number; items: BodyItem[] }>, strict: boolean, path: string): string {
  let { br, lines, final } = splitFile(before);
  let d = 0;
  for (const h of hunks) {
    const { O, N } = buildN(h.items);
    if (O.length > 0) {
      const found = findTier(lines, O, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let at = found.occ[0]!;
      let best = Math.abs(at - target);
      for (const p of found.occ) {
        const dist = Math.abs(p - target);
        if (dist < best) {
          best = dist;
          at = p;
        }
      }
      const touchesEnd = at + O.length === lines.length;
      lines = replaceAt(lines, at, O, N, found.tier);
      if (touchesEnd) final = !hunkNoEol(h.items);
      d += N.length - O.length;
    } else {
      const pos = Math.max(0, Math.min(h.a + d, lines.length));
      const atEnd = pos === lines.length;
      lines = [...lines.slice(0, pos), ...N.map((n) => n.text), ...lines.slice(pos)];
      if (atEnd) final = !hunkNoEol(h.items);
      d += N.length;
    }
  }
  return joinFile(br, lines, final);
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One hunk of a unified diff section. */
interface Hunk {
  /** The hunk's old start line, 1-based (A). */
  a: number;
  items: BodyItem[];
}

/** One section of a unified diff. */
interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  renameFrom?: string;
  renameTo?: string;
  diffOld?: string;
  diffNew?: string;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** A leading `a/` or `b/` is removed from a `---`/`+++` path (section 6). */
function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** The path of a `--- ` or `+++ ` line: after the four characters, up to the first tab, trimmed. */
function headerPath(line: string): string {
  const raw = line.slice(4);
  const tab = raw.indexOf('\t');
  return (tab >= 0 ? raw.slice(0, tab) : raw).trim();
}

/** A hunk's body: the lines after its header starting with ` `, `-`, `+`, `\`, or empty. */
function parseHunkBody(lines: string[], start: number): { items: BodyItem[]; next: number } {
  const items: BodyItem[] = [];
  let j = start;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') items.push({ kind: 'ctx', text: '', blank: true });
    else if (l.startsWith(' ')) items.push({ kind: 'ctx', text: l.slice(1), blank: l.trim() === '' });
    else if (l.startsWith('-')) items.push({ kind: 'old', text: l.slice(1) });
    else if (l.startsWith('+')) items.push({ kind: 'new', text: l.slice(1) });
    else if (l.startsWith('\\')) items.push({ kind: 'bslash', text: l });
    else break;
    j++;
  }
  while (items.length > 0) {
    const last = items[items.length - 1]!;
    if (last.kind === 'ctx' && last.text === '') items.pop();
    else break;
  }
  return { items, next: j };
}

/** Parse a unified diff into one edit per section (SPEC.md section 6). */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  let i = 0;
  const fresh = (): UniSection => {
    const s: UniSection = { oldPath: null, newPath: null, isCreate: false, isDelete: false, hunks: [] };
    sections.push(s);
    return s;
  };
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      inHeader = true;
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (inHeader && cur !== null && cur.oldPath !== null) cur = fresh();
      else if (!inHeader || cur === null) cur = fresh();
      cur!.oldPath = headerPath(l);
      cur!.newPath = headerPath(lines[i + 1]!);
      inHeader = true;
      i += 2;
      continue;
    }
    if (l.startsWith('--- ')) {
      if (inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const { items, next } = parseHunkBody(lines, i + 1);
      cur.hunks.push({ a: Number(m[1]!), items });
      inHeader = false;
      i = next;
      continue;
    }
    if (inHeader && cur !== null) {
      if (l.startsWith('rename from ')) cur.renameFrom = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) cur.renameTo = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) cur.isCreate = true;
      else if (l.startsWith('deleted file mode')) cur.isDelete = true;
      i++;
      continue;
    }
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict));
}

/** One unified diff section as an edit. */
function unifiedEdit(s: UniSection, strict: boolean): Edit {
  return (tree) => {
    let oldP: string | null = null;
    let newP: string | null = null;
    let haveOld = false;
    let haveNew = false;
    if (s.oldPath !== null) {
      haveOld = true;
      oldP = s.oldPath === '/dev/null' ? null : stripAB(s.oldPath);
    }
    if (s.newPath !== null) {
      haveNew = true;
      newP = s.newPath === '/dev/null' ? null : stripAB(s.newPath);
    }
    if (!haveOld && s.renameFrom !== undefined) {
      haveOld = true;
      oldP = s.renameFrom;
    }
    if (!haveNew && s.renameTo !== undefined) {
      haveNew = true;
      newP = s.renameTo;
    }
    if (!haveOld && s.diffOld !== undefined) oldP = s.diffOld;
    if (!haveNew && s.diffNew !== undefined) newP = s.diffNew;
    const isCreate = oldP === null || s.isCreate;
    const isDelete = newP === null || s.isDelete;
    if (isCreate) {
      const p = newP ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      for (const h of s.hunks) for (const it of h.items) if (it.kind === 'new') plus.push(it.text);
      let noEol = false;
      outer: for (let hi = s.hunks.length - 1; hi >= 0; hi--) {
        const items = s.hunks[hi]!.items;
        for (let k = items.length - 1; k >= 0; k--) {
          if (items[k]!.kind === 'new') {
            noEol = items[k + 1]?.kind === 'bslash';
            break outer;
          }
        }
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const p = oldP ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const oldPath = oldP!;
    const newPath = newP!;
    if (oldPath !== newPath) {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const content = applyHunks(before, s.hunks, strict, oldPath);
      tree.now.set(oldPath, null);
      tree.now.set(newPath, content);
      tree.recordMove(oldPath, newPath);
      return;
    }
    if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
    const before = tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath);
    tree.now.set(oldPath, applyHunks(before, s.hunks, strict, oldPath));
  };
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** Parse SEARCH/REPLACE blocks into edits (SPEC.md section 7). */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const s = lines[j]!;
      if (blank(s)) continue;
      if (s.trim().startsWith('```')) continue;
      path = s.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') throw new Exit2(`error: parse ${searchLine}`);
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchLine}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/** One SEARCH/REPLACE block as an edit. */
function srEdit(p: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (oldLines.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const { br, lines, final } = splitFile(before);
    const found = findTier(lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', p);
    if (found.occ.length > 1) throw new Fail('ambiguous', p);
    const N = newLines.map((t) => ({ text: t, ctx: false, oPos: -1 }));
    tree.now.set(p, joinFile(br, replaceAt(lines, found.occ[0]!, oldLines, N, found.tier), final));
  };
}

/** One chunk of a V4A Update File section. */
interface V4aChunk {
  /** The anchor line, or null when the chunk has none. */
  anchor: string | null;
  items: BodyItem[];
  /** True when `*** End of File` closed the chunk. */
  eof: boolean;
}

/** Drop blank body lines at the end of a section (section 8). */
function dropTrailingBlank(items: BodyItem[]): void {
  while (items.length > 0) {
    const last = items[items.length - 1]!;
    if (last.kind === 'ctx' && last.blank) items.pop();
    else break;
  }
}

/** Parse a V4A patch into edits (SPEC.md section 8). */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const p = l.slice('*** Add File: '.length).trim();
      const fileLines: Array<{ text: string; blank: boolean }> = [];
      i++;
      while (i < last && !isSectionStart(lines[i]!)) {
        const s = lines[i]!;
        if (s.startsWith('+')) fileLines.push({ text: s.slice(1), blank: false });
        else if (s === '') fileLines.push({ text: '', blank: true });
        else throw new Exit2(`error: parse ${i + 1}`);
        i++;
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1]!.blank) fileLines.pop();
      edits.push(v4aAddEdit(p, fileLines.map((x) => x.text)));
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const p = l.slice('*** Delete File: '.length).trim();
      edits.push(v4aDeleteEdit(p));
      i++;
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const p = l.slice('*** Update File: '.length).trim();
      const sectionLine = i + 1;
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      let firstChunk = true;
      let closedByEof = false;
      while (i < last) {
        const s = lines[i]!;
        if (s.startsWith('@@')) {
          const anchorText = s.slice(2).trim();
          cur = { anchor: anchorText === '' ? null : anchorText, items: [], eof: false };
          chunks.push(cur);
          firstChunk = false;
          closedByEof = false;
          i++;
          continue;
        }
        if (s.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          closedByEof = true;
          cur = null;
          i++;
          continue;
        }
        if (isSectionStart(s)) break;
        if (s === '' || s.startsWith(' ') || s.startsWith('-') || s.startsWith('+')) {
          if (cur === null) {
            if (!firstChunk || closedByEof) throw new Exit2(`error: parse ${i + 1}`);
            cur = { anchor: null, items: [], eof: false };
            chunks.push(cur);
            firstChunk = false;
          }
          if (s === '') cur.items.push({ kind: 'ctx', text: '', blank: true });
          else if (s.startsWith(' ')) cur.items.push({ kind: 'ctx', text: s.slice(1), blank: s.trim() === '' });
          else if (s.startsWith('-')) cur.items.push({ kind: 'old', text: s.slice(1) });
          else cur.items.push({ kind: 'new', text: s.slice(1) });
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (cur !== null) dropTrailingBlank(cur.items);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sectionLine}`);
      edits.push(v4aUpdateEdit(p, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function v4aAddEdit(p: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) !== null) throw new Fail('exists', p);
    tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(p: string): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) === null) throw new Fail('missing', p);
    tree.now.set(p, null);
  };
}

/** One V4A Update File section as an edit. */
function v4aUpdateEdit(p: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let { br, lines, final } = splitFile(before);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const at = findSingleLine(lines, chunk.anchor, strict, cursor);
        if (at < 0) throw new Fail('no-match', p);
        cursor = at + 1;
      }
      const { O, N } = buildN(chunk.items);
      if (O.length > 0) {
        const found = findTier(lines, O, strict, cursor);
        if (found === null) throw new Fail('no-match', p);
        let at = found.occ[0]!;
        if (chunk.eof) {
          const endOcc = found.occ.find((q) => q + O.length === lines.length);
          if (endOcc === undefined) throw new Fail('no-match', p);
          at = endOcc;
        }
        lines = replaceAt(lines, at, O, N, found.tier);
        cursor = at + N.length;
      } else {
        const pos = chunk.eof ? lines.length : cursor;
        lines = [...lines.slice(0, pos), ...N.map((n) => n.text), ...lines.slice(pos)];
        cursor = pos + N.length;
      }
    }
    const content = joinFile(br, lines, final);
    if (moveTo !== null) {
      tree.now.set(p, null);
      tree.now.set(moveTo, content);
      tree.recordMove(p, moveTo);
    } else {
      tree.now.set(p, content);
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const rows: Array<{ key: string; text: string }> = [];
  const movedOld = new Set<string>();
  const movedNew = new Set<string>();
  for (const [oldPath, newPath] of tree.moves) {
    if (
      tree.original(oldPath) !== null &&
      tree.get(oldPath) === null &&
      tree.original(newPath) === null &&
      tree.get(newPath) !== null
    ) {
      rows.push({ key: newPath, text: `R ${oldPath} -> ${newPath}` });
      movedOld.add(oldPath);
      movedNew.add(newPath);
    }
  }
  for (const p of [...tree.now.keys()].sort(byteOrder)) {
    if (movedOld.has(p) || movedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteOrder(a.key, b.key));
  const out = rows.map((r) => r.text);
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteOrder)) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
