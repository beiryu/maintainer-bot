import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type AgentResult, runAgent } from './agent.js';
import type { RepoConfig } from './config.js';
import type { Proposal } from './db.js';
import { freshClone, git, mirrorDir, slug } from './git.js';
import * as gh from './github.js';
import type { Ctx } from './orchestrator.js';
import { parseRoadmap, roadmapSummary } from './roadmap.js';

// The auditor reads the repo and proposes issues. Everything it gets is gathered here by
// plain code; it decides nothing on its own, and the human decides on every proposal.

const untrusted = (s: string) => s.replace(/<\/?(untrusted|rules|roadmap|open_issues|open_prs|previous_proposals|research|tryout|inspection|known)/gi, '&lt;$1').slice(0, 40_000);

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

type Findings = AgentResult<'researcher'>;
const renderFindings = (f: Findings | null, what: string) => !f ? `(${what} did not run)`
  : `${f.summary}\n\n${f.findings.map((x) => `- ${x.title}: ${x.detail}${x.evidence.length ? `\n  evidence: ${x.evidence.join(' | ').slice(0, 1500)}` : ''}`).join('\n') || '(no findings)'}`;

/** What the last research run found, as the auditor reads it. */
interface Research { at: string; research: string; tryout: string; inspection: string }

/**
 * The research job: three agents look at the project before the auditor does. Research outside
 * the repo (web), try it as a newcomer, inspect the code. A step that fails is reported, not
 * fatal. The findings are kept in the state for the next audit.
 */
export async function runResearch(ctx: Ctx, rc: RepoConfig, log: (m: string) => void = console.log): Promise<Research> {
  log(`${rc.full_name}: research`);
  const notes = rc.notes.trim() ? `Project conventions:\n${rc.notes.trim()}` : '';
  const a = await gatherAuditContext(ctx, rc, '');
  const base = { repo: rc.full_name, default_branch: rc.default_branch, repo_notes: notes, traction: a.traction };
  // What is already known, so a run looks elsewhere instead of finding the same things again.
  const saved = ctx.db.get(`research:${rc.full_name}`);
  const prev = saved ? JSON.parse(saved) as Research : null;
  const known = (last: string | undefined) => untrusted([
    prev ? `Your last run (${prev.at.slice(0, 16).replace('T', ' ')} UTC) found:\n${last}` : 'This is the first run.',
    `Open issues:\n${a.open_issues}`, `Open pull requests:\n${a.open_prs}`,
    `Proposals already made, with the owner's decision:\n${a.previous}`, `Recent commits:\n${a.recent_commits}`,
  ].join('\n\n'));
  const lastOf = { researcher: prev?.research, tryout: prev?.tryout, inspector: prev?.inspection };
  const head = await git(mirrorDir(rc.full_name), ['rev-parse', 'HEAD']);
  const scratch = async (name: string) => {
    const dir = join('work', slug(rc.full_name), `_audit-${name}`);
    await freshClone(rc.full_name, head, dir);
    return dir;
  };
  const step = async (agent: 'researcher' | 'tryout' | 'inspector', workdir: () => Promise<string>, readOnly: boolean) => {
    log(`${rc.full_name}: research step ${agent}`);
    try { return await runAgent(ctx, { agent, issueId: null, workdir: await workdir(), readOnly, vars: { ...base, known: known(lastOf[agent]) } }); }
    catch (e) { log(`${rc.full_name}: ${agent} failed: ${(e as Error).message.split('\n')[0]}`); return null; }
  };
  const research = await step('researcher', async () => mirrorDir(rc.full_name), true);
  const tryout = await step('tryout', () => scratch('tryout'), false);
  const inspection = await step('inspector', () => scratch('inspector'), false);
  const r: Research = {
    at: new Date().toISOString(),
    research: renderFindings(research, 'research'),
    tryout: renderFindings(tryout, 'the newcomer tryout'),
    inspection: renderFindings(inspection, 'the code inspection'),
  };
  ctx.db.set(`research:${rc.full_name}`, JSON.stringify(r));
  const n = [research, tryout, inspection].reduce((k, f) => k + (f?.findings.length ?? 0), 0);
  log(`${rc.full_name}: research done, ${n} finding(s)`);
  return r;
}

/**
 * Runs the auditor once for a repo and stores its proposals. It reads the last research run's
 * findings, whenever that was. Proposals whose title matches a pending/filed one are skipped.
 */
export async function runAudit(ctx: Ctx, rc: RepoConfig, sourceDigest = '', log: (m: string) => void = console.log): Promise<Proposal[]> {
  const { db } = ctx;
  log(`${rc.full_name}: audit`);
  const vars = await gatherAuditContext(ctx, rc, sourceDigest);
  const last = db.get(`audited:${rc.full_name}`);
  const saved = db.get(`research:${rc.full_name}`);
  if (saved) {
    const r = JSON.parse(saved) as Research;
    const when = `(from the research run of ${r.at.slice(0, 16).replace('T', ' ')} UTC)\n`;
    vars.research = untrusted(when + r.research);
    vars.tryout = untrusted(when + r.tryout);
    vars.inspection = untrusted(when + r.inspection);
    vars.since = !last ? 'This is the first audit.'
      : r.at > last ? `The research is new since the last audit (${last.slice(0, 16).replace('T', ' ')} UTC).`
      : `The last audit (${last.slice(0, 16).replace('T', ' ')} UTC) already read this research: only what changed since then is new.`;
  } else {
    vars.research = vars.tryout = vars.inspection = '(no research run yet)';
    vars.since = last ? `The last audit was at ${last.slice(0, 16).replace('T', ' ')} UTC.` : 'This is the first audit.';
  }
  const r = await runAgent(ctx, { agent: 'auditor', issueId: null, workdir: mirrorDir(rc.full_name), readOnly: true, vars });
  const known = new Set([...db.proposals('pending', rc.full_name), ...db.proposals('filed', rc.full_name), ...db.proposals('approved', rc.full_name)]
    .map((p) => norm(p.title)));
  const added: Proposal[] = [];
  for (const p of r.proposals) {
    if (known.has(norm(p.title))) { log(`  (already proposed) ${p.title}`); continue; }
    const id = db.addProposal({
      repo: rc.full_name, kind: p.kind, title: p.title.trim(), body: p.body, labels: JSON.stringify(p.labels),
      rationale: p.rationale, evidence: JSON.stringify(p.evidence), covers_issue: p.covers_issue, covers_rm: p.covers_rm,
      run_id: ctx.runId,
    });
    if (!p.agent_suitable) db.updateProposal(id, { rationale: `[needs you] ${p.rationale}` });
    else if (rc.auto_approve && !p.covers_issue) db.set(`auto-approve:${id}`, '1');
    added.push(db.proposal(id));
    known.add(norm(p.title));
  }
  db.set(`audited:${rc.full_name}`, new Date().toISOString());
  if (r.summary) db.set(`audit-summary:${rc.full_name}`, r.summary.slice(0, 2000));
  log(`${rc.full_name}: ${added.length} new proposal(s) of ${r.proposals.length}`);
  return added;
}

/** Labels the auditor proposed, restricted to what the repo actually has; never process labels like `agent: …`. */
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
