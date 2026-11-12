/**
 * SyncTeX — bidirectional source↔PDF lookup.
 *
 * Forward: (sourceFile, line) → list of PDF rectangles.
 * Reverse: (page, x, y) → list of source locations.
 *
 * Coordinates are PDF points from the page's top-left. The parser implements
 * SyncTeX v1 records and transformations; selection uses nearest-line and
 * nearest-rectangle heuristics rather than the native parser's full ranking.
 */

import { strFromU8, gunzip } from './fflate-shim';

export interface SynctexForwardHit {
  page: number;
  /** PDF points (1/72 inch), measured from the top-left of the page. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SynctexReverseHit {
  file: string;
  line: number;
  column: number;
}

export interface SynctexLookup {
  forward(file: string, line: number, column?: number): SynctexForwardHit[];
  reverse(page: number, x: number, y: number): SynctexReverseHit[];
  /** All input files referenced in the synctex index. */
  files(): string[];
}

/** Parse a `.synctex.gz` (or already-decompressed `.synctex`) buffer. */
export async function createSynctex(bytes: Uint8Array): Promise<SynctexLookup> {
  const decompressed = isGzip(bytes) ? await gunzip(bytes) : bytes;
  const text = strFromU8(decompressed);
  const parsed = parseSynctex(text);
  const records = parsed.records;
  const normalize = (path: string) => {
    const parts: string[] = [];
    for (const part of path.replace(/\\/g, '/').split('/')) {
      if (!part || part === '.') continue;
      if (part === '..' && parts.length && parts[parts.length - 1] !== '..') parts.pop();
      else parts.push(part);
    }
    if (parts[0] === 'project') parts.shift();
    return parts.join('/');
  };
  return {
    forward(file, line, column) {
      if (!Number.isFinite(line) || line < 1) return [];
      const matching = records.filter((r) => normalize(r.file) === normalize(file));
      if (!matching.length) return [];
      const distance = matching.reduce((d, r) => Math.min(d, Math.abs(r.line - line)), Infinity);
      let nearest = matching.filter((r) => Math.abs(r.line - line) === distance);
      if (column !== undefined && nearest.some((r) => r.column > 0)) {
        const d = nearest.reduce((d, r) => Math.min(d, Math.abs(r.column - column)), Infinity);
        nearest = nearest.filter((r) => Math.abs(r.column - column) === d);
      }
      const seen = new Set<string>();
      return nearest
        .filter((r) => {
          const key = `${r.page}:${r.x}:${r.y}:${r.width}:${r.height}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .map(({ page, x, y, width, height }) => ({ page, x, y, width, height }));
    },
    reverse(page, x, y) {
      if (![page, x, y].every(Number.isFinite)) return [];
      const matching = records.filter((r) => r.page === page);
      const score = (r: RecordHit) => {
        const dx = Math.max(r.x - x, 0, x - r.x - r.width);
        const dy = Math.max(r.y - y, 0, y - r.y - r.height);
        return dx * dx + dy * dy;
      };
      matching.sort((a, b) => score(a) - score(b) || a.width * a.height - b.width * b.height);
      const best = matching[0];
      return best ? [{ file: best.file, line: best.line, column: best.column }] : [];
    },
    files: () => [...parsed.inputs.values()],
  };
}

function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}
interface RecordHit extends SynctexForwardHit, SynctexReverseHit {}
interface RawNode {
  tag: number;
  line: number;
  column: number;
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
}

/** SyncTeX v1 records; coordinate conversion follows the bundled reference parser. */
function parseSynctex(text: string): { inputs: Map<number, string>; records: RecordHit[] } {
  const inputs = new Map<number, string>();
  const raw: { page: number; node: RawNode }[] = [];
  let page = 0;
  let unit = 1;
  let magnification = 1000;
  let offsetX = 0;
  let offsetY = 0;
  let lastY = 0;
  let post = false;
  let postMag = 1;
  let postX: number | undefined;
  let postY: number | undefined;
  let form = 0;
  const forms = new Map<number, RawNode[]>();
  const refs: { page: number; owner: number; target: number; x: number; y: number }[] = [];
  const contexts: { page: number; form: number; boxes: RawNode[]; lastY: number }[] = [];
  const boxes: RawNode[] = [];
  const dimension = (value: string): number => {
    const m = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*(sp|pt|bp|in|cm|mm|pc|dd|cc|nd|nc)?$/.exec(value);
    if (!m) throw new Error(`Invalid SyncTeX dimension: ${value}`);
    const factors: Record<string, number> = {
      sp: 1,
      pt: 65536,
      bp: 65781.76,
      in: 72 * 65781.76,
      cm: (72 * 65781.76) / 2.54,
      mm: (72 * 65781.76) / 25.4,
      pc: 12 * 65536,
      dd: (1238 / 1157) * 65536,
      cc: (14856 / 1157) * 65536,
      nd: (685 / 642) * 65536,
      nc: (1370 / 107) * 65536,
    };
    return Number(m[1]) * factors[m[2] ?? 'sp']!;
  };
  for (const line of text.split(/\r?\n/)) {
    const input = /^Input:(\d+):(.*)$/.exec(line);
    if (input) {
      inputs.set(Number(input[1]), input[2]!);
      continue;
    }
    if (line === 'Post Scriptum:') {
      post = true;
      continue;
    }
    if (line.startsWith('Magnification:')) {
      const n = Number(line.slice(14));
      if (!(n > 0) || !Number.isFinite(n)) throw new Error('Invalid SyncTeX magnification');
      if (post) postMag = n;
      else magnification = n;
      continue;
    }
    if (line.startsWith('Unit:')) {
      unit = Number(line.slice(5));
      if (!(unit > 0) || !Number.isFinite(unit)) throw new Error('Invalid SyncTeX unit');
      continue;
    }
    if (line.startsWith('X Offset:') || line.startsWith('Y Offset:')) {
      const x = line[0] === 'X';
      const n = post ? dimension(line.slice(9).trim()) : Number(line.slice(9));
      if (!Number.isFinite(n)) throw new Error('Invalid SyncTeX offset');
      if (post) {
        if (x) postX = n;
        else postY = n;
      } else {
        if (x) offsetX = n;
        else offsetY = n;
      }
      continue;
    }
    if (line.startsWith('<')) {
      contexts.push({ page, form, boxes: [...boxes], lastY });
      form = Number(line.slice(1));
      forms.set(form, []);
      boxes.length = 0;
      lastY = 0;
      continue;
    }
    if (line.startsWith('>')) {
      const context = contexts.pop();
      if (context) {
        page = context.page;
        form = context.form;
        boxes.splice(0, boxes.length, ...context.boxes);
        lastY = context.lastY;
      }
      continue;
    }
    if (line.startsWith('{')) {
      page = Number(line.slice(1));
      boxes.length = 0;
      lastY = 0;
      continue;
    }
    if (line.startsWith('}')) {
      page = 0;
      continue;
    }
    if (line === ')' || line === ']') {
      boxes.pop();
      continue;
    }
    if (!page && !form) continue;
    const ref = /^f(\d+):(-?\d+),(-?\d+|=)$/.exec(line);
    if (ref) {
      const y = ref[3] === '=' ? lastY : Number(ref[3]);
      lastY = y;
      refs.push({ page, owner: form, target: Number(ref[1]), x: Number(ref[2]), y });
      continue;
    }
    const m =
      /^([[(vhxkg$])(\d+),(\d+)(?:,(-?\d+))?:(-?\d+),(-?\d+|=)(?::(-?\d+)(?:,(-?\d+),(-?\d+))?)?$/.exec(
        line,
      );
    if (!m) continue;
    const parent = boxes[boxes.length - 1];
    const baseline = m[6] === '=' ? lastY : Number(m[6]);
    lastY = baseline;
    const node: RawNode = {
      tag: Number(m[2]),
      line: Number(m[3]),
      column: Number(m[4] ?? 0),
      x: Number(m[5]),
      y: baseline,
      width: Number(m[7] ?? 0),
      height: m[8] === undefined ? (parent?.height ?? 0) : Number(m[8]),
      depth: m[9] === undefined ? (parent?.depth ?? 0) : Number(m[9]),
    };
    if ([node.x, node.y, node.width, node.height, node.depth].every(Number.isFinite))
      form ? forms.get(form)!.push(node) : raw.push({ page, node });
    if (m[1] === '(' || m[1] === '[') boxes.push(node);
  }
  const expand = (target: number, page: number, x: number, y: number, seen: Set<number>) => {
    if (seen.has(target) || seen.size > 32) throw new Error('Cyclic or deeply nested SyncTeX form');
    const nodes = forms.get(target);
    if (!nodes?.length) return;
    const visited = new Set(seen);
    visited.add(target);
    const dy = y - nodes[0]!.height;
    for (const node of nodes) {
      if (raw.length >= 1_000_000) throw new Error('SyncTeX record limit exceeded');
      raw.push({ page, node: { ...node, x: node.x + x, y: node.y + dy } });
    }
    for (const ref of refs)
      if (ref.owner === target) expand(ref.target, page, x + ref.x, dy + ref.y, visited);
  };
  for (const ref of refs) if (!ref.owner) expand(ref.target, ref.page, ref.x, ref.y, new Set());
  const scale = (((unit / 65781.76) * magnification) / 1000) * postMag;
  const xOffset = postX === undefined ? (offsetX * unit) / 65781.76 : postX / 65781.76;
  const yOffset = postY === undefined ? (offsetY * unit) / 65781.76 : postY / 65781.76;
  const records: RecordHit[] = [];
  for (const { page, node: n } of raw) {
    const file = inputs.get(n.tag);
    if (!file || n.line < 1) continue;
    const x1 = n.x * scale + xOffset;
    const x2 = (n.x + n.width) * scale + xOffset;
    records.push({
      file,
      page,
      line: n.line,
      column: n.column,
      x: Math.min(x1, x2),
      y: (n.y - n.height) * scale + yOffset,
      width: Math.abs(x2 - x1),
      height: Math.max(0, (n.height + n.depth) * scale),
    });
  }
  return { inputs, records };
}
