// ROADMAP.md as vn-skills writes it: one `### RM-NNN · scope: title` heading per item followed by
// `- key: value` lines (status, milestone, labels, size, agent, depends) and free text. Plain
// parsing, no model: the planner gets the parsed list and the raw text both.

export interface RoadmapItem {
  id: string;            // RM-012
  scope: string;         // vn-phone
  title: string;
  status: string;        // idea | planned | filed (#N) | done (#PR) | anything else verbatim
  issue: number | null;  // from `filed (#N)`
  milestone: string;
  size: string;
  agent: string;         // yes | no | ''
  labels: string[];
  depends: string[];
  text: string;          // the free text under the fields
}

const HEADING = /^###\s+(RM-\d+)\s*[·•:-]\s*(?:([\w.-]+):\s*)?(.+?)\s*$/;

export function parseRoadmap(text: string): RoadmapItem[] {
  const items: RoadmapItem[] = [];
  let cur: RoadmapItem | null = null;
  const lines = text.split('\n');
  for (const line of lines) {
    const h = HEADING.exec(line);
    if (h) {
      cur = { id: h[1], scope: h[2] ?? '', title: h[3], status: '', issue: null, milestone: '', size: '', agent: '', labels: [], depends: [], text: '' };
      items.push(cur);
      continue;
    }
    if (!cur) continue;
    if (/^##\s/.test(line) || /^---\s*$/.test(line)) { cur = null; continue; }
    const f = /^-\s+(status|milestone|labels|size|agent|depends):\s*(.*?)\s*$/.exec(line);
    if (f) {
      const v = f[2].replace(/\s+#.*$/, ''); // trailing "# comment"
      switch (f[1]) {
        case 'status': cur.status = v; cur.issue = Number(/filed\s*\(#(\d+)\)/.exec(v)?.[1] ?? NaN) || null; break;
        case 'milestone': cur.milestone = v; break;
        case 'size': cur.size = v; break;
        case 'agent': cur.agent = v; break;
        case 'labels': cur.labels = v.split(',').map((s) => s.trim()).filter(Boolean); break;
        case 'depends': cur.depends = v.split(',').map((s) => s.trim()).filter(Boolean); break;
      }
      continue;
    }
    cur.text += `${line}\n`;
  }
  for (const i of items) i.text = i.text.trim();
  return items;
}

/** `[RM-012] vn-phone: …` → RM-012; also matches a bare RM-012 anywhere in the title. */
export function rmIdFromTitle(title: string): string | null {
  return /\b(RM-\d{3,})\b/.exec(title)?.[1] ?? null;
}

/**
 * Rewrites the item's `- status:` line to `done (#pr)`. Throws when the item or its status line
 * is missing, so a PR never claims a roadmap edit it did not make.
 */
export function markDone(text: string, id: string, pr: number): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => HEADING.exec(l)?.[1] === id);
  if (start < 0) throw new Error(`${id} is not in the roadmap`);
  for (let i = start + 1; i < lines.length && !/^###?\s/.test(lines[i]); i++) {
    if (/^-\s+status:/.test(lines[i])) {
      lines[i] = `- status: done (#${pr})`;
      return lines.join('\n');
    }
  }
  throw new Error(`${id} has no status line`);
}

/** Short list for a prompt: one line per item. */
export function roadmapSummary(items: RoadmapItem[]): string {
  return items.map((i) => `${i.id} [${i.status || '?'}] ${i.scope ? `${i.scope}: ` : ''}${i.title}`
    + `${i.size ? `  size=${i.size}` : ''}${i.agent ? ` agent=${i.agent}` : ''}${i.depends.length ? ` depends=${i.depends.join(',')}` : ''}`).join('\n');
}
