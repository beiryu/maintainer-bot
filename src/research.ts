import type { Db } from './db.js';

// Research findings as a running list, like a roadmap: every run adds what it found, nothing is
// overwritten. An item is ticked when it is done: the issue made from it was closed, the planner
// found it no longer holds, or the maintainer ticked it on the dashboard.

export interface ResearchItem {
  id: number;
  title: string;
  detail: string;
  evidence: string[];
  found_at: string;
  done: boolean;
  proposal: number | null; // p<n> the planner made from it (filed as an issue by the publish step)
  issue?: number | null;    // the open issue that already covered it, when there was one
  note: string;            // why it was ticked
}

const key = (repo: string) => `research-items:${repo}`;
const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function researchItems(db: Db, repo: string): ResearchItem[] {
  const raw = db.get(key(repo));
  return raw ? JSON.parse(raw) as ResearchItem[] : [];
}

export function saveResearchItems(db: Db, repo: string, items: ResearchItem[]): void {
  db.set(key(repo), JSON.stringify(items));
}

/** Appends findings whose title is not on the list yet; returns the ones added. */
export function addFindings(db: Db, repo: string,
  findings: { title: string; detail: string; evidence: string[] }[], at: string): ResearchItem[] {
  const items = researchItems(db, repo);
  const seen = new Set(items.map((i) => norm(i.title)));
  let next = items.reduce((m, i) => Math.max(m, i.id), 0) + 1;
  const added: ResearchItem[] = [];
  for (const f of findings) {
    if (!f.title.trim() || seen.has(norm(f.title))) continue;
    const item = { id: next++, title: f.title.trim(), detail: f.detail.trim(), evidence: f.evidence, found_at: at, done: false, proposal: null, note: '' };
    items.push(item); added.push(item); seen.add(norm(item.title));
  }
  saveResearchItems(db, repo, items);
  return added;
}

/** Applies a change to the items with these ids. */
export function updateItems(db: Db, repo: string, ids: number[], change: (i: ResearchItem) => void): void {
  const items = researchItems(db, repo);
  for (const i of items) if (ids.includes(i.id)) change(i);
  saveResearchItems(db, repo, items);
}

/** The list as agents read it: one block per item, open ones first. */
export function itemsForAgents(items: ResearchItem[], opts: { issueOf?: (proposal: number) => string | undefined } = {}): string {
  if (!items.length) return '(nothing yet)';
  const line = (i: ResearchItem) => {
    const state = i.done ? `done${i.note ? `: ${i.note}` : ''}` : i.issue ? `in work as #${i.issue}` : i.proposal ? `in work as ${opts.issueOf?.(i.proposal) ?? `p${i.proposal}`}` : 'open';
    return `r${i.id} [${i.found_at.slice(0, 10)} · ${state}] ${i.title}\n    ${i.detail.replace(/\s+/g, ' ')}${i.evidence.length ? `\n    evidence: ${i.evidence.join(' | ').slice(0, 1500)}` : ''}`;
  };
  return [...items.filter((i) => !i.done), ...items.filter((i) => i.done)].map(line).join('\n');
}

/** Ids the maintainer ticked on the dashboard (`- [x] r12 …`). */
export function tickedIds(body: string): number[] {
  return [...body.matchAll(/^\s*- \[[xX]\] (?:\*\*)?r(\d+)\b/gm)].map((m) => Number(m[1]));
}

/** Ticks items whose issue is closed; `closed(n)` says whether issue #n is closed. Returns how many. */
export async function tickClosed(db: Db, repo: string, closed: (n: number) => Promise<boolean>): Promise<number> {
  const ids: [number, number][] = [];
  for (const i of researchItems(db, repo).filter((i) => !i.done && (i.proposal || i.issue))) {
    const n = i.issue ?? (i.proposal ? db.proposal(i.proposal).issue_number : null);
    if (n && await closed(n)) ids.push([i.id, n]);
  }
  for (const [id, n] of ids) updateItems(db, repo, [id], (i) => { i.done = true; i.note = `#${n} closed`; });
  return ids.length;
}
