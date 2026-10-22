import type { Db } from './db.js';

// Research findings as a running list, like a roadmap: every run adds what it found, nothing is
// overwritten. An item is ticked when it is done: the auditor resolved it (its issue was
// closed, it no longer holds) or the maintainer ticked it on the dashboard.

export type ResearchSource = 'web' | 'tryout' | 'code';
export interface ResearchItem {
  id: number;
  source: ResearchSource;
  title: string;
  detail: string;
  evidence: string[];
  found_at: string;
  done: boolean;
  proposal: number | null; // p<n> the auditor made from it
  note: string;            // why it was ticked
}

export const SOURCE_LABEL: Record<ResearchSource, string> = { web: 'Web', tryout: 'Newcomer tryout', code: 'Code' };

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
export function addFindings(db: Db, repo: string, source: ResearchSource,
  findings: { title: string; detail: string; evidence: string[] }[], at: string): ResearchItem[] {
  const items = researchItems(db, repo);
  const seen = new Set(items.map((i) => norm(i.title)));
  let next = items.reduce((m, i) => Math.max(m, i.id), 0) + 1;
  const added: ResearchItem[] = [];
  for (const f of findings) {
    if (!f.title.trim() || seen.has(norm(f.title))) continue;
    const item = { id: next++, source, title: f.title.trim(), detail: f.detail.trim(), evidence: f.evidence, found_at: at, done: false, proposal: null, note: '' };
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
export function itemsForAgents(items: ResearchItem[], opts: { since?: string } = {}): string {
  if (!items.length) return '(nothing yet)';
  const line = (i: ResearchItem) => {
    const state = i.done ? `done${i.note ? `: ${i.note}` : ''}` : i.proposal ? `proposed as p${i.proposal}` : 'open';
    const fresh = opts.since && !i.done && i.found_at > opts.since ? ' · NEW since the last audit' : '';
    return `r${i.id} [${SOURCE_LABEL[i.source]} · ${i.found_at.slice(0, 10)} · ${state}${fresh}] ${i.title}\n    ${i.detail.replace(/\s+/g, ' ')}${i.evidence.length ? `\n    evidence: ${i.evidence.join(' | ').slice(0, 1500)}` : ''}`;
  };
  return [...items.filter((i) => !i.done), ...items.filter((i) => i.done)].map(line).join('\n');
}

/** Ids the maintainer ticked on the dashboard (`- [x] r12 …`). */
export function tickedIds(body: string): number[] {
  return [...body.matchAll(/^\s*- \[[xX]\] (?:\*\*)?r(\d+)\b/gm)].map((m) => Number(m[1]));
}
