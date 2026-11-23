// mend — see SPEC.md. Node 22, standard library only.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) { this.line = line; }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) { this.code = code; this.path = path; }
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

class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try { if (statSync(p).isFile()) v = readFileSync(p, 'utf8'); } catch { v = null; }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

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

// ---------- file model (section 3) ----------
interface FileModel { br: string; lines: string[]; final: boolean; }
function splitFile(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}
function joinFile(lines: string[], br: string, final: boolean): string {
  return lines.length === 0 ? '' : lines.join(br) + (final ? br : '');
}

// ---------- matching (section 5) ----------
const rstrip = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0]!;
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rstrip(a) === rstrip(b);
  return stripBoth(a) === stripBoth(b);
}
function tiersTried(strict: boolean): number[] { return strict ? [0] : [0, 1, 2]; }
// occurrences of O in lines at a tier, positions >= from (and optionally ending at last line)
function occAt(lines: string[], O: string[], tier: number, from: number, eofOnly: boolean): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= lines.length; i++) {
    if (eofOnly && i + O.length !== lines.length) continue;
    let ok = true;
    for (let k = 0; k < O.length; k++) if (!lineEq(lines[i + k]!, O[k]!, tier)) { ok = false; break; }
    if (ok) out.push(i);
  }
  return out;
}
interface NLine { text: string; ctx: number; } // ctx: index into O if context line, else -1
// Build replacement lines for a match at pos.
function buildN(lines: string[], O: string[], N: NLine[], pos: number, tier: number): string[] {
  let F = ''; let P = '';
  if (tier === 2 && O.length > 0) { F = leadWs(lines[pos]!); P = leadWs(O[0]!); }
  return N.map((n) => {
    if (n.ctx >= 0) return lines[pos + n.ctx]!;
    if (tier === 2) {
      const t = n.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(P)) return F + t.slice(P.length);
    }
    return n.text;
  });
}
// Find (tier, occurrences) for O; null when no tier has one.
function findOcc(lines: string[], O: string[], strict: boolean, from: number, eofOnly: boolean): { tier: number; occ: number[] } | null {
  for (const tier of tiersTried(strict)) {
    const occ = occAt(lines, O, tier, from, eofOnly);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}
function checkSafe(p: string): void { if (!safe(p)) throw new Fail('unsafe', p); }
function mustExist(tree: Tree, p: string): string {
  checkSafe(p);
  const t = tree.get(p);
  if (t === null) throw new Fail('missing', p);
  return t;
}

// ---------- JSON (section 9) — from the starter ----------
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
      // Use the shared section-3 file model (splitFile/joinFile) instead of
      // re-deriving the break, lines and final-break flag inline: every other
      // format goes through these helpers, and a private copy here could
      // drift from them (e.g. for an empty file or a CRLF file whose final
      // break must stay exactly as it was, section 9).
      const fm = splitFile(before);
      const lines = [...fm.lines];
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(lines, fm.br, fm.final));
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
    try { v = JSON.parse(text); } catch { throw new Exit2(`error: parse ${first + 1}`); }
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
    try { e = jsonEdit(JSON.parse(l)); } catch { e = null; }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------- unified diffs (section 6) ----------
interface BodyLine { kind: string; text: string; noEol: boolean; }
interface Hunk { a: number; body: BodyLine[]; }
interface Section {
  diffOld: string | null; diffNew: string | null;
  oldPath: string | null; newPath: string | null; hasPair: boolean;
  renameFrom: string | null; renameTo: string | null;
  isNew: boolean; isDel: boolean; hunks: Hunk[];
}
function newSection(): Section {
  return { diffOld: null, diffNew: null, oldPath: null, newPath: null, hasPair: false, renameFrom: null, renameTo: null, isNew: false, isDel: false, hunks: [] };
}
function headPath(line: string): string {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.replace(/^ +| +$/g, '');
  if (t === '/dev/null') return t;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection();
      cur.diffOld = m[1]!; cur.diffNew = m[2]!;
      sections.push(cur);
      i += 1; continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && cur.hunks.length === 0 && !cur.hasPair) {
        cur.oldPath = headPath(line); cur.newPath = headPath(lines[i + 1]!); cur.hasPair = true;
      } else {
        cur = newSection();
        cur.oldPath = headPath(line); cur.newPath = headPath(lines[i + 1]!); cur.hasPair = true;
        sections.push(cur);
      }
      i += 2; continue;
    }
    if (line.startsWith('--- ') && cur !== null && cur.hunks.length === 0 && !cur.hasPair) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@($| .*)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1]!, 10);
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') { j += 1; continue; }
        break;
      }
      const raw = lines.slice(i + 1, j);
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      const body: BodyLine[] = [];
      for (const bl of raw) {
        if (bl.startsWith('\\')) { if (body.length > 0) body[body.length - 1]!.noEol = true; continue; }
        if (bl === '') body.push({ kind: ' ', text: '', noEol: false });
        else body.push({ kind: bl[0]!, text: bl.slice(1), noEol: false });
      }
      cur.hunks.push({ a, body });
      i = j; continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12);
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10);
      else if (line.startsWith('new file mode')) cur.isNew = true;
      else if (line.startsWith('deleted file mode')) cur.isDel = true;
    }
    i += 1;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict));
}

function unifiedEdit(s: Section, strict: boolean): Edit {
  const oldP = s.hasPair ? s.oldPath : (s.renameFrom ?? s.diffOld);
  const newP = s.hasPair ? s.newPath : (s.renameTo ?? s.diffNew);
  const creation = oldP === '/dev/null' || s.isNew;
  const deletion = !creation && (newP === '/dev/null' || s.isDel);
  return (tree) => {
    if (creation) {
      const np = newP ?? '';
      checkSafe(np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: BodyLine[] = [];
      for (const h of s.hunks) for (const b of h.body) if (b.kind === '+') plus.push(b);
      const texts = plus.map((b) => b.text);
      const fin = texts.length > 0 ? !plus[plus.length - 1]!.noEol : false;
      tree.now.set(np, joinFile(texts, '\n', fin));
      return;
    }
    if (deletion) {
      const op = oldP ?? '';
      checkSafe(op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const isMove = oldP !== null && newP !== null && oldP !== newP;
    const op = oldP ?? newP ?? '';
    const np = newP ?? oldP ?? '';
    if (isMove) {
      checkSafe(op); checkSafe(np);
      const before = tree.get(op);
      if (before === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const out = applyHunks(before, s.hunks, strict, op);
      tree.now.set(op, null);
      tree.now.set(np, out);
      tree.moves.push([op, np]);
      return;
    }
    const p = np;
    const before = mustExist(tree, p);
    const out = applyHunks(before, s.hunks, strict, p);
    tree.now.set(p, out);
  };
}

function applyHunks(before: string, hunks: Hunk[], strict: boolean, path: string): string {
  const fm = splitFile(before);
  const lines = [...fm.lines];
  let final = fm.final;
  let d = 0;
  for (const h of hunks) {
    const O: string[] = [];
    const N: NLine[] = [];
    for (const b of h.body) {
      if (b.kind === ' ') { O.push(b.text); N.push({ text: b.text, ctx: O.length - 1 }); }
      else if (b.kind === '-') O.push(b.text);
      else if (b.kind === '+') N.push({ text: b.text, ctx: -1 });
    }
    // last context-or-+ body line, for the no-eol rule
    let lastCP: BodyLine | null = null;
    for (const b of h.body) if (b.kind === ' ' || b.kind === '+') lastCP = b;
    if (O.length === 0) {
      const pos = Math.max(0, Math.min(h.a + d, lines.length));
      const atEnd = pos === lines.length;
      const texts = N.map((n) => n.text);
      lines.splice(pos, 0, ...texts);
      if (atEnd && texts.length > 0) final = !(lastCP !== null && lastCP.noEol);
      d += N.length;
      continue;
    }
    const found = findOcc(lines, O, strict, 0, false);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let pos = found.occ[0]!;
    for (const o of found.occ) if (Math.abs(o - target) < Math.abs(pos - target)) pos = o;
    const runsEnd = pos + O.length === lines.length;
    const built = buildN(lines, O, N, pos, found.tier);
    lines.splice(pos, O.length, ...built);
    if (runsEnd) final = !(lastCP !== null && lastCP.noEol);
    d += N.length - O.length;
  }
  return joinFile(lines, fm.br, final);
}

// ---------- SEARCH/REPLACE (section 7) ----------
function srEdits(lines: string[], strict: boolean): Edit[] {
  interface Block { path: string; oldL: string[]; newL: string[]; }
  const blocks: Block[] = [];
  let prevEnd = 0; // index just after previous REPLACE line
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i += 1; continue; }
    const searchLine = i;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) if (lines[j]!.trimEnd() === '=======') { eq = j; break; }
    let rep = -1;
    if (eq >= 0) for (let j = eq + 1; j < lines.length; j++) if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { rep = j; break; }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let path: string | null = null;
    for (let j = searchLine - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    blocks.push({ path, oldL: lines.slice(searchLine + 1, eq), newL: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => (tree: Tree) => {
    checkSafe(b.path);
    if (b.oldL.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, joinFile([...b.newL], '\n', b.newL.length > 0));
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const fm = splitFile(before);
    const lines = [...fm.lines];
    const found = findOcc(lines, b.oldL, strict, 0, false);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.occ.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.occ[0]!;
    const N: NLine[] = b.newL.map((t) => ({ text: t, ctx: -1 }));
    const built = buildN(lines, b.oldL, N, pos, found.tier);
    lines.splice(pos, b.oldL.length, ...built);
    tree.now.set(b.path, joinFile(lines, fm.br, fm.final));
  });
}

// ---------- V4A (section 8) ----------
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) if (!blank(lines[k]!)) { last = k; break; }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  interface VChunk { anchor: string | null; body: BodyLine[]; eof: boolean; }
  interface VSec { kind: string; path: string; startLine: number; moveTo: string | null; addLines: string[]; chunks: VChunk[]; }
  const secs: VSec[] = [];
  let idx = first + 1;
  const secStart = (l: string): { kind: string; path: string } | null => {
    if (l.startsWith('*** Add File: ')) return { kind: 'add', path: l.slice(14).replace(/^ +| +$/g, '') };
    if (l.startsWith('*** Delete File: ')) return { kind: 'del', path: l.slice(17).replace(/^ +| +$/g, '') };
    if (l.startsWith('*** Update File: ')) return { kind: 'upd', path: l.slice(17).replace(/^ +| +$/g, '') };
    return null;
  };
  while (idx < last) {
    const l = lines[idx]!;
    if (blank(l)) { idx += 1; continue; }
    const st = secStart(l);
    if (st === null) throw new Exit2(`error: parse ${idx + 1}`);
    const startLine = idx + 1;
    // collect section raw lines until next section or End Patch
    let j = idx + 1;
    const raw: { line: string; num: number }[] = [];
    while (j < last && secStart(lines[j]!) === null) { raw.push({ line: lines[j]!, num: j + 1 }); j += 1; }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.line)) raw.pop();
    const sec: VSec = { kind: st.kind, path: st.path, startLine, moveTo: null, addLines: [], chunks: [] };
    if (st.kind === 'add') {
      for (const r of raw) {
        if (r.line.startsWith('+')) sec.addLines.push(r.line.slice(1));
        else if (r.line === '') sec.addLines.push('');
        else throw new Exit2(`error: parse ${r.num}`);
      }
    } else if (st.kind === 'del') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.num}`);
    } else {
      let k = 0;
      if (k < raw.length && raw[k]!.line.startsWith('*** Move to: ')) {
        sec.moveTo = raw[k]!.line.slice(13).replace(/^ +| +$/g, '');
        k += 1;
      }
      let chunk: VChunk | null = null;
      for (; k < raw.length; k++) {
        const r = raw[k]!;
        const ln = r.line;
        if (ln.startsWith('@@')) {
          chunk = { anchor: ln.slice(2).replace(/^ +| +$/g, '') || null, body: [], eof: false };
          sec.chunks.push(chunk);
        } else if (ln === '*** End of File') {
          if (chunk === null) { chunk = { anchor: null, body: [], eof: false }; sec.chunks.push(chunk); }
          chunk.eof = true;
        } else if (ln === '' || ln[0] === ' ' || ln[0] === '-' || ln[0] === '+') {
          if (chunk === null) { chunk = { anchor: null, body: [], eof: false }; sec.chunks.push(chunk); }
          if (ln === '') chunk.body.push({ kind: ' ', text: '', noEol: false });
          else chunk.body.push({ kind: ln[0]!, text: ln.slice(1), noEol: false });
        } else {
          throw new Exit2(`error: parse ${r.num}`);
        }
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${startLine}`);
    }
    secs.push(sec);
    idx = j;
  }
  if (secs.length === 0) throw new Exit2('error: parse 1');
  return secs.map((s) => (tree: Tree) => {
    checkSafe(s.path);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, joinFile([...s.addLines], '\n', s.addLines.length > 0));
      return;
    }
    if (s.kind === 'del') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    // update
    if (s.moveTo !== null) checkSafe(s.moveTo);
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const fm = splitFile(before);
    const flines = [...fm.lines];
    let cursor = 0;
    for (const ch of s.chunks) {
      if (ch.anchor !== null) {
        let foundIdx = -1;
        for (const tier of tiersTried(strict)) {
          for (let k = cursor; k < flines.length; k++) if (lineEq(flines[k]!, ch.anchor, tier)) { foundIdx = k; break; }
          if (foundIdx >= 0) break;
        }
        if (foundIdx < 0) throw new Fail('no-match', s.path);
        cursor = foundIdx + 1;
      }
      const O: string[] = [];
      const N: NLine[] = [];
      for (const b of ch.body) {
        if (b.kind === ' ') { O.push(b.text); N.push({ text: b.text, ctx: O.length - 1 }); }
        else if (b.kind === '-') O.push(b.text);
        else if (b.kind === '+') N.push({ text: b.text, ctx: -1 });
      }
      if (O.length === 0) {
        const pos = ch.eof ? flines.length : Math.min(cursor, flines.length);
        flines.splice(pos, 0, ...N.map((n) => n.text));
        cursor = pos + N.length;
        continue;
      }
      const found = findOcc(flines, O, strict, cursor, ch.eof);
      if (found === null) throw new Fail('no-match', s.path);
      const pos = found.occ[0]!;
      const built = buildN(flines, O, N, pos, found.tier);
      flines.splice(pos, O.length, ...built);
      cursor = pos + built.length;
    }
    const out = joinFile(flines, fm.br, fm.final);
    if (s.moveTo !== null) {
      tree.now.set(s.path, null);
      tree.now.set(s.moveTo, out);
      tree.moves.push([s.path, s.moveTo]);
    } else {
      tree.now.set(s.path, out);
    }
  });
}

// ---------- run (sections 1, 2, 10) ----------
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
  try { text = readFileSync(file ?? 0, 'utf8'); } catch { if (file !== null) return { code: 2, out: ['error: no-patch'] }; }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves;
    tree.moves = [...tree.moves];
    try { edit(tree); } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // R lines for successful moves satisfying section 2 conditions
  const finalGet = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
  const suppressed = new Set<string>();
  interface Row { key: string; line: string; }
  const rows: Row[] = [];
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && finalGet(o) === null && tree.original(n) === null && finalGet(n) !== null && !suppressed.has(o) && !suppressed.has(n)) {
      rows.push({ key: n, line: `R ${o} -> ${n}` });
      suppressed.add(o); suppressed.add(n);
    }
  }
  for (const p of tree.now.keys()) {
    if (suppressed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, now); }
    }
  }
  const outLines = rows.map((r) => r.line);
  return { code: 0, out: [...outLines, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
