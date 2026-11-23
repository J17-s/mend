// main.ts is mend, the CLI SPEC.md specifies (MIT). It implements all of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection (sections 1 to 4), line matching at three tiers (section 5), unified
// diffs (section 6), SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9) and the
// all-or-nothing write (section 10). Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are.

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
  readonly moves: [string, string][] = [];
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

// ---------- lines and matching (SPEC.md sections 3 and 5) ----------

interface FileLines {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBreak ? f.br : '');
}

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWS = (s: string): string => /^[ \t]*/.exec(s)![0]!;

function matchLine(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

function matchAt(lines: string[], O: string[], i: number, tier: number): boolean {
  for (let k = 0; k < O.length; k += 1) if (!matchLine(lines[i + k]!, O[k]!, tier)) return false;
  return true;
}

/** Occurrences of O in lines at the first tier that has any, at or after `from`; `mustEnd` pins the match's end. */
function findOccurrences(lines: string[], O: string[], strict: boolean, from = 0, mustEnd?: number): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions: number[] = [];
    for (let i = from; i + O.length <= lines.length; i += 1) {
      if (mustEnd !== undefined && i + O.length !== mustEnd) continue;
      if (matchAt(lines, O, i, tier)) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** One line of a hunk or chunk body: context, old or new; `backslash` records a following `\` line. */
interface Item {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  backslash: boolean;
  fromEmpty: boolean;
}

const item = (kind: Item['kind'], text: string, fromEmpty = false): Item => ({ kind, text, backslash: false, fromEmpty });

/** Splice items into lines at pos: context lines come out as the file's own matched lines; at tier 2 the added
 *  lines are re-indented from O's first line's indent to the file's first matched line's indent. */
function applyItems(lines: string[], items: Item[], pos: number, tier: number): string[] {
  const O = items.filter((it) => it.kind !== 'add');
  const F = O.length > 0 ? leadingWS(lines[pos]!) : '';
  const P = O.length > 0 ? leadingWS(O[0]!.text) : '';
  const out: string[] = [];
  let oi = 0;
  for (const it of items) {
    if (it.kind === 'ctx') {
      out.push(lines[pos + oi]!);
      oi += 1;
    } else if (it.kind === 'del') {
      oi += 1;
    } else {
      let t = it.text;
      if (tier === 2 && t.trim() !== '' && t.startsWith(P)) t = F + t.slice(P.length);
      out.push(t);
    }
  }
  return [...lines.slice(0, pos), ...out, ...lines.slice(pos + O.length)];
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

// ---------- unified diffs (SPEC.md section 6) ----------

interface Hunk {
  A: number;
  items: Item[];
}

interface Section {
  gitOld?: string;
  gitNew?: string;
  hdrOld?: string | null;
  hdrNew?: string | null;
  renameFrom?: string;
  renameTo?: string;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function parseGitLine(l: string, idx: number): [string, string] {
  const rest = l.slice('diff --git '.length);
  const at = rest.startsWith('a/') ? rest.indexOf(' b/', 2) : -1;
  if (at < 0) throw new Exit2(`error: parse ${idx + 1}`);
  const x = rest.slice(2, at);
  const y = rest.slice(at + 3);
  if (x === '' || y === '') throw new Exit2(`error: parse ${idx + 1}`);
  return [x, y];
}

/** The path a `--- `/`+++ ` line names: after the four characters, up to a tab, spaces removed; null for /dev/null. */
function parseDashPath(l: string): string | null {
  let t = l.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

function parseSection(lines: string[], start: number): [Section, number] {
  const sec: Section = { newFile: false, deletedFile: false, hunks: [] };
  let i = start;
  let sawPair = false;
  // The header: everything before the first hunk.
  while (i < lines.length) {
    const l = lines[i]!;
    if (i !== start && l.startsWith('diff --git ')) break;
    if (l.startsWith('diff --git')) {
      if (i !== start) break;
      const [x, y] = parseGitLine(l, i);
      sec.gitOld = x;
      sec.gitNew = y;
      i += 1;
      continue;
    }
    if (l.startsWith('--- ')) {
      if (sawPair) break;
      const nxt = lines[i + 1];
      if (nxt === undefined || !nxt.startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
      sec.hdrOld = parseDashPath(l);
      sec.hdrNew = parseDashPath(nxt);
      sawPair = true;
      i += 2;
      continue;
    }
    if (l.startsWith('+++ ')) {
      i += 1;
      continue;
    }
    if (l.startsWith('rename from ')) {
      sec.renameFrom = l.slice('rename from '.length).trim();
      i += 1;
      continue;
    }
    if (l.startsWith('rename to ')) {
      sec.renameTo = l.slice('rename to '.length).trim();
      i += 1;
      continue;
    }
    if (l.startsWith('new file mode')) {
      sec.newFile = true;
      i += 1;
      continue;
    }
    if (l.startsWith('deleted file mode')) {
      sec.deletedFile = true;
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) break;
    i += 1;
  }
  // The hunks; any other line here is ignored prose.
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const A = parseInt(m[1]!, 10);
      i += 1;
      const items: Item[] = [];
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '') {
          items.push(item('ctx', '', true));
          i += 1;
          continue;
        }
        const c = b[0]!;
        if (c === ' ') items.push(item('ctx', b.slice(1)));
        else if (c === '-') items.push(item('del', b.slice(1)));
        else if (c === '+') items.push(item('add', b.slice(1)));
        else if (c === '\\') {
          if (items.length > 0) items[items.length - 1]!.backslash = true;
          i += 1;
          continue;
        } else break;
        i += 1;
      }
      while (items.length > 0 && items[items.length - 1]!.fromEmpty) items.pop();
      sec.hunks.push({ A, items });
      continue;
    }
    i += 1;
  }
  return [sec, i];
}

/** The last context or `+` line of a hunk body: the one a following `\` line would take the final break from. */
function lastCtxOrAdd(items: Item[]): Item | null {
  for (let k = items.length - 1; k >= 0; k -= 1) if (items[k]!.kind !== 'del') return items[k]!;
  return null;
}

/** Apply a section's hunks in order to a file's lines; a hunk that finds nothing fails the section. */
function applyHunks(f: FileLines, hunks: Hunk[], strict: boolean, path: string): FileLines {
  let lines = f.lines;
  let finalBreak = f.finalBreak;
  let d = 0;
  for (const h of hunks) {
    const items = h.items;
    if (items.length === 0) continue;
    const O = items.filter((it) => it.kind !== 'add').map((it) => it.text);
    const nLen = items.filter((it) => it.kind !== 'del').length;
    if (O.length === 0) {
      const adds = items.filter((it) => it.kind === 'add').map((it) => it.text);
      const at = Math.max(0, Math.min(h.A + d, lines.length));
      const atEnd = at === lines.length;
      lines = [...lines.slice(0, at), ...adds, ...lines.slice(at)];
      if (atEnd) {
        const last = lastCtxOrAdd(items);
        finalBreak = !(last !== null && last.backslash);
      }
      d += adds.length;
      continue;
    }
    const found = findOccurrences(lines, O, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.A - 1 + d;
    let pos = found.positions[0]!;
    for (const p of found.positions) if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
    const runsToEnd = pos + O.length === lines.length;
    lines = applyItems(lines, items, pos, found.tier);
    if (runsToEnd) {
      const last = lastCtxOrAdd(items);
      finalBreak = !(last !== null && last.backslash);
    }
    d += nLen - O.length;
  }
  return { lines, br: f.br, finalBreak };
}

function sectionEdit(sec: Section, strict: boolean): Edit {
  const oldPath = sec.hdrOld !== undefined ? sec.hdrOld : sec.renameFrom !== undefined ? sec.renameFrom : sec.gitOld;
  const newPath = sec.hdrNew !== undefined ? sec.hdrNew : sec.renameTo !== undefined ? sec.renameTo : sec.gitNew;
  const isCreate = oldPath === null || sec.newFile;
  const isDelete = !isCreate && (newPath === null || sec.deletedFile);
  if (isCreate && typeof newPath !== 'string') throw new Exit2('error: parse 1');
  if (isDelete && typeof oldPath !== 'string') throw new Exit2('error: parse 1');
  if (!isCreate && !isDelete && typeof oldPath !== 'string' && typeof newPath !== 'string') throw new Exit2('error: parse 1');
  return (tree) => {
    if (typeof oldPath === 'string' && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (typeof newPath === 'string' && newPath !== oldPath && !safe(newPath)) throw new Fail('unsafe', newPath);
    if (isCreate) {
      const target = newPath as string;
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const addLines: string[] = [];
      let lastBs = false;
      for (const h of sec.hunks) {
        for (const it of h.items) {
          if (it.kind === 'add') {
            addLines.push(it.text);
            lastBs = it.backslash;
          }
        }
      }
      tree.now.set(target, addLines.length === 0 ? '' : addLines.join('\n') + (lastBs ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const target = oldPath as string;
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
      return;
    }
    if (typeof oldPath === 'string' && typeof newPath === 'string' && oldPath !== newPath) {
      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      tree.now.set(newPath, joinFile(applyHunks(splitFile(before), sec.hunks, strict, oldPath)));
      tree.now.set(oldPath, null);
      tree.moves.push([oldPath, newPath]);
      return;
    }
    const target = (oldPath ?? newPath) as string;
    const before = tree.get(target);
    if (before === null) throw new Fail('missing', target);
    tree.now.set(target, joinFile(applyHunks(splitFile(before), sec.hunks, strict, target)));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
      const [sec, ni] = parseSection(lines, i);
      edits.push(sectionEdit(sec, strict));
      i = ni;
    } else if (l.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i += 1;
    }
  }
  return edits;
}

// ---------- SEARCH/REPLACE blocks (SPEC.md section 7) ----------

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const found = findOccurrences(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const items = [...oldLines.map((t) => item('del', t)), ...newLines.map((t) => item('add', t))];
    const out = applyItems(f.lines, items, found.positions[0]!, found.tier);
    tree.now.set(path, joinFile({ lines: out, br: f.br, finalBreak: f.finalBreak }));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    edits.push(srEdit(path, lines.slice(searchIdx + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

// ---------- V4A patches (SPEC.md section 8) ----------

interface Chunk {
  anchor: string | null;
  items: Item[];
  eof: boolean;
}

type VSection =
  | { kind: 'add'; path: string; content: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: Chunk[] };

/** Apply an Update File section's chunks in order, the cursor moving past each anchor and each chunk's output. */
function applyChunks(f: FileLines, chunks: Chunk[], strict: boolean, path: string): FileLines {
  let lines = f.lines;
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      const tiers = strict ? [0] : [0, 1, 2];
      let at = -1;
      for (const tier of tiers) {
        for (let k = cursor; k < lines.length; k += 1) {
          if (matchLine(lines[k]!, ch.anchor, tier)) {
            at = k;
            break;
          }
        }
        if (at >= 0) break;
      }
      if (at < 0) throw new Fail('no-match', path);
      cursor = at + 1;
    }
    const O = ch.items.filter((it) => it.kind !== 'add').map((it) => it.text);
    if (O.length === 0) {
      const adds = ch.items.filter((it) => it.kind === 'add').map((it) => it.text);
      const at = ch.eof ? lines.length : Math.min(cursor, lines.length);
      lines = [...lines.slice(0, at), ...adds, ...lines.slice(at)];
      cursor = at + adds.length;
      continue;
    }
    const found = findOccurrences(lines, O, strict, cursor, ch.eof ? lines.length : undefined);
    if (found === null) throw new Fail('no-match', path);
    const pos = found.positions[0]!;
    lines = applyItems(lines, ch.items, pos, found.tier);
    cursor = pos + ch.items.filter((it) => it.kind !== 'del').length;
  }
  return { lines, br: f.br, finalBreak: f.finalBreak };
}

function v4aEdit(s: VSection, strict: boolean): Edit {
  return (tree) => {
    if (s.kind === 'add') {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, s.content.length === 0 ? '' : s.content.join('\n') + '\n');
      return;
    }
    if (s.kind === 'delete') {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const text = joinFile(applyChunks(splitFile(before), s.chunks, strict, s.path));
    if (s.moveTo !== null) {
      tree.now.set(s.moveTo, text);
      tree.now.set(s.path, null);
      tree.moves.push([s.path, s.moveTo]);
    } else {
      tree.now.set(s.path, text);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const fb = lines.findIndex((l) => !blank(l));
  if (fb < 0) throw new Exit2('error: parse 1');
  if (lines[fb]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${fb + 1}`);
  let lb = lines.length - 1;
  while (lb >= 0 && blank(lines[lb]!)) lb -= 1;
  if (lb < 0 || lines[lb]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const ADD = '*** Add File: ';
  const DEL = '*** Delete File: ';
  const UPD = '*** Update File: ';
  const MOV = '*** Move to: ';
  const isHeader = (l: string): boolean => l.startsWith(ADD) || l.startsWith(DEL) || l.startsWith(UPD);
  const sections: VSection[] = [];
  let i = fb + 1;
  while (i < lb) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (!isHeader(l)) throw new Exit2(`error: parse ${i + 1}`);
    const headerIdx = i;
    let j = i + 1;
    const raw: { text: string; num: number }[] = [];
    while (j < lb && !isHeader(lines[j]!)) {
      raw.push({ text: lines[j]!, num: j + 1 });
      j += 1;
    }
    while (raw.length > 0 && raw[raw.length - 1]!.text.trim() === '') raw.pop();
    if (l.startsWith(ADD)) {
      const content: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) content.push(r.text.slice(1));
        else if (r.text === '') content.push('');
        else throw new Exit2(`error: parse ${r.num}`);
      }
      sections.push({ kind: 'add', path: l.slice(ADD.length).trim(), content });
    } else if (l.startsWith(DEL)) {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.num}`);
      sections.push({ kind: 'delete', path: l.slice(DEL.length).trim() });
    } else {
      let moveTo: string | null = null;
      let k = 0;
      if (raw.length > 0 && raw[0]!.text.startsWith(MOV)) {
        moveTo = raw[0]!.text.slice(MOV.length).trim();
        k = 1;
      }
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      for (; k < raw.length; k += 1) {
        const r = raw[k]!;
        const t = r.text;
        if (t.startsWith('@@')) {
          const anchor = t.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, items: [], eof: false };
          chunks.push(cur);
        } else if (t.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${r.num}`);
          cur.eof = true;
          cur = null;
        } else if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${r.num}`);
            cur = { anchor: null, items: [], eof: false };
            chunks.push(cur);
          }
          cur.items.push(t === '' ? item('ctx', '', true) : item(t[0] === ' ' ? 'ctx' : t[0] === '-' ? 'del' : 'add', t.slice(1)));
        } else {
          throw new Exit2(`error: parse ${r.num}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerIdx + 1}`);
      sections.push({ kind: 'update', path: l.slice(UPD.length).trim(), moveTo, chunks });
    }
    i = j;
  }
  return sections.map((s) => v4aEdit(s, strict));
}

// ---------- JSON edits (SPEC.md section 9) ----------

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
      const f = splitFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      const lines = [...f.lines];
      lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile({ lines, br: f.br, finalBreak: f.finalBreak }));
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

// ---------- the run (SPEC.md sections 1, 2 and 10) ----------

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
            ? srEdits(lines, strict)
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
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // The changed paths, in byte order; a successful move replaces its pair's D and A lines with one R line,
  // sorted by the new path.
  const rows: { key: string; line: string }[] = [];
  const consumed = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (consumed.has(o) || consumed.has(n)) continue;
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) {
      rows.push({ key: n, line: `R ${o} -> ${n}` });
      consumed.add(o);
      consumed.add(n);
    }
  }
  for (const p of tree.now.keys()) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
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
  const out = rows.map((r) => r.line);
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
