import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runAgent } from './agent.js';
import type { RepoConfig } from './config.js';
import type { Proposal } from './db.js';
import { freshClone, git, mirrorDir, slug } from './git.js';
import * as gh from './github.js';
import type { Ctx } from './orchestrator.js';
import { addFindings, itemsForAgents, type ResearchItem, researchItems, tickClosed, updateItems } from './research.js';
import { parseRoadmap, roadmapSummary } from './roadmap.js';

// The research job: what the project needs next, as a running list and as issues. Everything the
// agents get is gathered here by plain code.

const untrusted = (s: string, max = 40_000) => s.replace(/<\/?(untrusted|rules|roadmap|open_issues|open_prs|previous_proposals|research|known)/gi, '&lt;$1').slice(0, max);
// The research list grows without a cap; agents read it whole.
const LIST_MAX = 400_000;

/** `git ls-files` folded into "dir/ (n files)" lines, two levels deep, so the agent sees the shape without the noise. */
export function layoutSummary(paths: string[]): string {
  const counts = new Map<string, number>();
  for (const p of paths) {
    const parts = p.split('/');
    const key = parts.length <= 2 ? (parts.length === 1 ? '(root)' : `${parts[0]}/`) : `${parts[0]}/${parts[1]}/`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].sort().map(([k, n]) => `${k}  ${n} file${n === 1 ? '' : 's'}`).join('\n');
}

/** Number of `it(`/`test(` cases per test file. */
export function testCounts(root: string, paths: string[]): string {
  const out: string[] = [];
  for (const p of paths.filter((p) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) || /(^|\/)tests?\//.test(p) && /\.[cm]?[jt]sx?$/.test(p))) {
    const f = join(root, p);
    if (!existsSync(f) || statSync(f).size > 2_000_000) continue;
    const n = (readFileSync(f, 'utf8').match(/^\s*(it|test)(\.each\([^)]*\))?\s*\(/gm) ?? []).length;
    out.push(`${p}  ${n}`);
  }
  return out.join('\n') || '(no test files found)';
}

function readIf(root: string, rel: string, max = 30_000): string {
  const f = join(root, rel);
  return existsSync(f) ? readFileSync(f, 'utf8').slice(0, max) : '';
}

// The public surface: every src/index.ts (root or per package).
function exportsSummary(root: string, paths: string[]): string {
  const idx = paths.filter((p) => /(^|\/)src\/index\.[cm]?ts$/.test(p));
  return idx.map((p) => `--- ${p}\n${readIf(root, p, 8000)}`).join('\n\n') || '(no src/index.ts found)';
}

export async function gatherAuditContext(ctx: Ctx, rc: RepoConfig, sourceDigest: string): Promise<Record<string, string>> {
  const { db } = ctx;
  const root = mirrorDir(rc.full_name);
  const paths = (await git(root, ['ls-files'])).split('\n').filter(Boolean);
  const rules = rc.audit_files.map((f) => ({ f, text: readIf(root, f) })).filter((x) => x.text)
    .map((x) => `--- ${x.f}\n${x.text}`).join('\n\n');
  const roadmapText = rc.roadmap_file ? readIf(root, rc.roadmap_file, 60_000) : '';
  const roadmap = roadmapText
    ? `${roadmapSummary(parseRoadmap(roadmapText))}\n\n--- full text\n${roadmapText}`
    : '(no roadmap file)';
  const issues = await gh.listOpenIssues(rc.full_name, [], 200);
  const prs = await gh.listOpenPrs(rc.full_name);
  let commits = '';
  try {
    const rows = await gh.ghJson<any[]>(['api', `repos/${rc.full_name}/commits?sha=${rc.default_branch}&per_page=30`]);
    commits = rows.map((c) => `${c.sha.slice(0, 8)} ${c.commit.committer?.date?.slice(0, 16).replace('T', ' ') ?? ''} ${c.commit.message.split('\n')[0]}`).join('\n');
  } catch { commits = '(unavailable)'; }
  const previous = [...db.proposals('pending', rc.full_name), ...db.proposals('rejected', rc.full_name), ...db.proposals('filed', rc.full_name)]
    .slice(-60)
    .map((p) => `[${p.status}${p.issue_number ? ` as #${p.issue_number}` : ''}${p.reject_reason ? `: ${p.reject_reason}` : ''}] ${p.title}`)
    .join('\n');
  return {
    repo: rc.full_name, default_branch: rc.default_branch,
    repo_notes: rc.notes.trim() ? `Project-specific conventions (the maintainer wrote these; measure the repo against them too):\n${rc.notes.trim()}` : '',
    roadmap_file: rc.roadmap_file || '(none)',
    rules: untrusted(rules) || '(no rule files found)',
    roadmap: untrusted(roadmap),
    tree: layoutSummary(paths),
    exports: untrusted(exportsSummary(root, paths)),
    test_counts: testCounts(root, paths),
    open_issues: untrusted(issues.map((i) => `#${i.number} [${i.labels.map((l) => l.name).join(', ')}] ${i.title}\n    ${(i.body ?? '').replace(/\s+/g, ' ').slice(0, 240)}`).join('\n')) || '(none)',
    open_prs: untrusted(prs.map((p) => `#${p.number} by @${p.author} [${p.labels.join(', ')}] ${p.title}`).join('\n')) || '(none)',
    recent_commits: untrusted(commits),
    traction: untrusted(await gh.traction(rc.full_name, rc.packages)),
    source_digest: untrusted(sourceDigest) || '(no upstream changes detected, or no sources configured)',
    previous: untrusted(previous) || '(none)',
  };
}

const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * The research job, twice a day. In order:
 *   1. tick the list items whose issue was closed;
 *   2. three agents look at the project (web research, a newcomer's tryout, a code review) with
 *      the whole list in hand, and what they find that is not on it yet is added;
 *   3. the planner decides what to work on next and writes it as issues, as many as are worth
 *      doing. The publish step files them: assigned to the maintainer (so the audit runs work
 *      on them) unless only a person can do the work.
 * A step that fails is reported, not fatal.
 */
export async function runResearch(ctx: Ctx, rc: RepoConfig, sourceDigest = '', log: (m: string) => void = console.log): Promise<{ added: ResearchItem[]; planned: Proposal[] }> {
  const { db } = ctx;
  const repo = rc.full_name;
  log(`${repo}: research`);
  const ticked = await tickClosed(db, repo, async (n) => (await gh.getIssue(repo, n)).state !== 'OPEN');
  if (ticked) log(`${repo}: ${ticked} item(s) done, their issue closed`);

  const notes = rc.notes.trim() ? `Project conventions:\n${rc.notes.trim()}` : '';
  const a = await gatherAuditContext(ctx, rc, sourceDigest);
  const issueOf = (p: number) => { const n = db.proposal(p).issue_number; return n ? `#${n}` : undefined; };
  // Everything already known, so a run looks elsewhere instead of finding the same things again.
  const known = untrusted([
    `The research list so far (r<n>, with its state):\n${itemsForAgents(researchItems(db, repo), { issueOf })}`,
    `Open issues:\n${a.open_issues}`, `Open pull requests:\n${a.open_prs}`,
    `Issues already planned, with the owner's decision:\n${a.previous}`, `Recent commits:\n${a.recent_commits}`,
  ].join('\n\n'), LIST_MAX);
  const vars = { repo, default_branch: rc.default_branch, repo_notes: notes, traction: a.traction, known };
  const head = await git(mirrorDir(repo), ['rev-parse', 'HEAD']);
  const scratch = async (name: string) => {
    const dir = join('work', slug(repo), `_research-${name}`);
    await freshClone(repo, head, dir);
    return dir;
  };
  const added: ResearchItem[] = [];
  const step = async (agent: 'researcher' | 'tryout' | 'inspector', workdir: () => Promise<string>, readOnly: boolean) => {
    log(`${repo}: research step ${agent}`);
    try {
      const r = await runAgent(ctx, { agent, issueId: null, workdir: await workdir(), readOnly, vars });
      added.push(...addFindings(db, repo, r.findings, new Date().toISOString()));
    } catch (e) { log(`${repo}: ${agent} failed: ${(e as Error).message.split('\n')[0]}`); }
  };
  await step('researcher', async () => mirrorDir(repo), true);
  await step('tryout', () => scratch('tryout'), false);
  await step('inspector', () => scratch('inspector'), false);
  log(`${repo}: ${added.length} new item(s)`);

  const planned = await plan(ctx, rc, { ...a, research: untrusted(itemsForAgents(researchItems(db, repo), { issueOf }), LIST_MAX) }, log);
  db.set(`researched:${repo}`, JSON.stringify({ at: new Date().toISOString(), added: added.length, planned: planned.length }));
  return { added, planned };
}

/**
 * The planner: from the research list and the state of the repo, the issues to work on next.
 * Each becomes a proposal the publish step files right away; items are linked to it or ticked.
 */
async function plan(ctx: Ctx, rc: RepoConfig, vars: Record<string, string>, log: (m: string) => void): Promise<Proposal[]> {
  const { db } = ctx;
  const repo = rc.full_name;
  log(`${repo}: plan`);
  const r = await runAgent(ctx, { agent: 'planner', issueId: null, workdir: mirrorDir(repo), readOnly: true, vars });
  const known = new Set([...db.proposals('pending', repo), ...db.proposals('filed', repo), ...db.proposals('approved', repo)]
    .map((p) => norm(p.title)));
  const filed: Proposal[] = [];
  for (const p of r.issues) {
    if (known.has(norm(p.title))) { log(`  (already planned) ${p.title}`); continue; }
    const id = db.addProposal({
      repo, kind: p.kind, title: p.title.trim(), body: p.body, labels: JSON.stringify(p.labels),
      rationale: p.agent_suitable ? p.rationale : `[needs you] ${p.rationale}`, evidence: JSON.stringify(p.evidence),
      covers_issue: null, covers_rm: p.covers_rm, run_id: ctx.runId,
    });
    db.set(`auto-approve:${id}`, '1');
    filed.push(db.proposal(id));
    known.add(norm(p.title));
    if (p.findings.length) updateItems(db, repo, p.findings, (i) => { i.proposal = id; });
  }
  for (const x of r.covered) updateItems(db, repo, [x.id], (i) => { i.issue = x.issue; });
  for (const x of r.resolved) updateItems(db, repo, [x.id], (i) => { i.done = true; i.note = x.why; });
  if (r.summary) db.set(`plan-summary:${repo}`, r.summary.slice(0, 2000));
  log(`${repo}: ${filed.length} issue(s) to open`);
  return filed;
}

/** Labels the planner proposed, restricted to what the repo actually has; never process labels like `agent: …`. */
export async function labelsFor(rc: RepoConfig, proposed: string[]): Promise<string[]> {
  const existing = new Set(await repoLabels(rc.full_name));
  return [...new Set(proposed)].filter((l) => existing.has(l) && !/^agent\b/i.test(l));
}

let labelCache = new Map<string, string[]>();
export async function repoLabels(repo: string): Promise<string[]> {
  if (!labelCache.has(repo)) {
    const rows = await gh.ghJson<{ name: string }[]>(['label', 'list', '-R', repo, '--limit', '200', '--json', 'name']);
    labelCache.set(repo, rows.map((r) => r.name));
  }
  return labelCache.get(repo)!;
}
export const resetLabelCache = () => { labelCache = new Map(); };
