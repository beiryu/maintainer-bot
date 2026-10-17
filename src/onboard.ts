import { existsSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parse, stringify } from 'yaml';
import { runAgent } from './agent.js';
import { type Config, type RepoConfig, RepoConfigSchema, repoFile, writeRepoConfig } from './config.js';
import { formatSteps, probeRepo } from './doctor.js';
import { ensureMirror, mirrorDir, slug } from './git.js';
import * as gh from './github.js';
import { editInEditor, type Ctx } from './orchestrator.js';

// `repo add`: mirror one of the user's own repos, let the scout agent draft the config from
// its docs, prove the gate runs here, show everything, and only then write the file.

/** The scout writes YAML-ish values; accept the obvious variants (notes as lines, lists as one string). */
export function normalizeScoutConfig(raw: Record<string, unknown>): Record<string, unknown> {
  const out = { ...raw };
  if (Array.isArray(out.notes)) out.notes = out.notes.map(String).join('\n');
  for (const k of ['labels', 'skip_labels', 'forbidden_paths', 'allowed_paths', 'gate', 'review_bots', 'pr_types', 'pr_scopes', 'audit_files']) {
    if (typeof out[k] === 'string') out[k] = [out[k]];
  }
  for (const k of ['focused_test', 'roadmap_file']) if (out[k] === null || out[k] === '') delete out[k];
  // Fields from the contributor-side scout that mean nothing here.
  for (const k of ['fork', 'claim_comment', 'require_assignment', 'max_issue_age_days', 'draft_replies', 'issue_labels_default', 'labels_lifecycle']) delete out[k];
  return out;
}

export function parseRepoArg(input: string): string {
  const m = /^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(input.trim());
  if (!m || m[1] === 'orgs') throw new Error(`not a GitHub repository: ${input}`);
  return `${m[1]}/${m[2]}`;
}

const WORK = (repo: string) => join('work', slug(repo));

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(question)).trim(); } finally { rl.close(); }
}

/** What the scout gets to read about the repo, gathered by plain code. */
export async function gatherFacts(repo: string, mirror: string): Promise<string> {
  const info = await gh.repoInfo(repo);
  const issues = await gh.listOpenIssues(repo, [], 200);
  const labels = new Map<string, number>();
  for (const i of issues) for (const l of i.labels) labels.set(l.name, (labels.get(l.name) ?? 0) + 1);
  const topLabels = [...labels].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([n, c]) => `${n} (${c})`).join(', ');
  let allLabels = '';
  try { allLabels = (await gh.ghJson<{ name: string }[]>(['label', 'list', '-R', repo, '--limit', '200', '--json', 'name'])).map((l) => l.name).join(', '); } catch { /* optional */ }
  const candidates = ['CONTRIBUTING.md', 'CONTRIBUTING', '.github/CONTRIBUTING.md', 'docs/CONTRIBUTING.md', 'AGENTS.md', 'CLAUDE.md',
    '.agents', '.github/PULL_REQUEST_TEMPLATE.md', '.github/pull_request_template.md', 'ROADMAP.md', 'SOURCES.md',
    'Makefile', 'go.mod', 'package.json', 'pnpm-workspace.yaml', 'pyproject.toml', 'Cargo.toml', 'commitlint.config.js', '.github/labels.yml'];
  const files = candidates.filter((f) => existsSync(join(mirror, f)));
  const wfDir = join(mirror, '.github', 'workflows');
  const workflows = existsSync(wfDir) ? readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f)) : [];
  return [
    `repo: ${repo}  language: ${info.language}  stars: ${info.stars}  default branch: ${info.defaultBranch}  archived: ${info.archived}`,
    `description: ${info.description}`,
    `license: ${info.license}`,
    `open issues (first ${issues.length}); labels in use: ${topLabels || 'none'}`,
    `all labels defined: ${allLabels || 'unknown'}`,
    `files present: ${files.join(', ') || 'none of the usual ones'}`,
    `workflows: ${workflows.join(', ') || 'none'}`,
  ].join('\n');
}

export async function addRepo(ctx: Ctx, input: string, opts: { configPath: string; yes: boolean }): Promise<string> {
  const { cfg, db } = ctx;
  const repo = parseRepoArg(input);
  if (cfg.repos.some((r) => r.full_name === repo)) throw new Error(`${repo} is already configured (${repoFile(repo, opts.configPath)})`);
  const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

  log(`${repo}: reading GitHub`);
  const info = await gh.repoInfo(repo);
  if (info.archived) throw new Error(`${repo} is archived`);
  log(`${repo}: mirroring ${info.defaultBranch}`);
  await ensureMirror(repo, info.defaultBranch);
  const mirror = mirrorDir(repo);
  const facts = await gatherFacts(repo, mirror);

  log(`${repo}: scout agent drafts the config`);
  const scout = await runAgent(ctx, {
    agent: 'scout', issueId: null, workdir: mirror, readOnly: true,
    vars: { repo, facts, github_user: cfg.github_user },
  });
  const draft = normalizeScoutConfig(scout.config);
  let rc: RepoConfig;
  try {
    rc = RepoConfigSchema.parse({ ...draft, full_name: repo, default_branch: (draft.default_branch as string | undefined) ?? info.defaultBranch });
  } catch (e) {
    throw new Error(`the scout's config does not fit the schema: ${(e as Error).message}\n\nits draft:\n${stringify(draft)}`);
  }

  // Prove the gate runs in the sandbox; let the doctor agent repair it, twice at most.
  let report = '';
  for (let round = 0; ; round++) {
    const p = await probeRepo(ctx, rc, log);
    report = `gate on ${rc.default_branch} @ ${p.sha.slice(0, 10)}, scope = ${p.sampleLine}\n${formatSteps(p.steps, p.focused, !p.focused)}`;
    const failed = [...p.steps, ...(p.focused ? [p.focused] : [])].filter((s) => !s.ok);
    if (!failed.length || round === 2) { if (failed.length) report += `\n  (${failed.length} step(s) still fail; fix by hand or with repo doctor --fix)`; break; }
    log(`${repo}: ${failed.length} gate step(s) fail on the base, asking the doctor agent (round ${round + 1})`);
    const fix = await runAgent(ctx, {
      agent: 'doctor', issueId: null, workdir: p.dir, readOnly: true,
      vars: { repo, gate_json: JSON.stringify(rc.gate, null, 1), focused_test: rc.focused_test, failures: failed.map((s) => `$ ${s.cmd}\n${s.excerpt}`).join('\n\n'), repo_notes: rc.notes.trim() },
    });
    rc = { ...rc, gate: fix.gate, focused_test: fix.focused_test, notes: fix.notes_append.trim() ? `${rc.notes.trimEnd()}\n${fix.notes_append.trim()}\n` : rc.notes };
  }

  const yaml = stringify(rc, { lineWidth: 0 });
  console.log(`\n${'='.repeat(78)}\n${scout.summary.trim()}\n`);
  if (scout.risks.length) console.log(`risks:\n${scout.risks.map((r) => `  - ${r}`).join('\n')}\n`);
  console.log(`${report}\n\n--- ${repoFile(repo, opts.configPath)}\n${yaml}`);

  let answer = opts.yes ? 'y' : '';
  while (!answer) {
    if (!process.stdin.isTTY) throw new Error('not a terminal; pass --yes to accept the proposal as is');
    answer = (await ask('write this config? [y]es / [n]o / [e]dit first: ')).toLowerCase();
    if (answer === 'e') {
      const tmp = join(WORK(repo), '_onboard.yaml');
      writeFileSync(tmp, yaml);
      editInEditor(tmp);
      try { rc = RepoConfigSchema.parse(parse(readFileSync(tmp, 'utf8'))); } catch (e) { console.log(`invalid: ${(e as Error).message}`); }
      answer = '';
    } else if (answer !== 'y' && answer !== 'n') answer = '';
  }
  if (answer === 'n') return 'nothing written';

  writeRepoConfig(rc, opts.configPath);
  db.upsertRepo(repo);
  db.setRepoStatus(repo, 'active');
  const steps = scout.manual_steps.length ? `\nby hand, before the first run:\n${scout.manual_steps.map((s) => `  - ${s}`).join('\n')}` : '';
  return `${repo} added (${repoFile(repo, opts.configPath)}).${steps}\n\nnext: maintainer-bot audit --repo ${repo}`;
}

export async function removeRepo(ctx: Ctx, input: string, opts: { configPath: string; yes: boolean }): Promise<string> {
  const { db } = ctx;
  const repo = parseRepoArg(input);
  const file = repoFile(repo, opts.configPath);
  const issues = db.issuesForRepo(repo);
  // Every PR the bot follows belongs to a configured repo: wait until they are merged or closed.
  const open = issues.map((i) => db.prForIssue(i.id)).filter((p) => p?.state === 'open');
  if (open.length) {
    throw new Error(`${repo} still has open PRs: ${open.map((p) => p!.url).join(' ')}\n`
      + 'Remove it once they are merged or closed (the bot keeps following them until then).');
  }
  const plan = [
    existsSync(file) ? `delete ${file}` : `(no ${file}; cleaning up what is left)`,
    `delete ${issues.length} issue record(s)`,
    `delete work/${slug(repo)} and the mirror`,
  ];
  console.log(plan.map((p) => `  - ${p}`).join('\n'));
  if (!opts.yes) {
    if (!process.stdin.isTTY) throw new Error('not a terminal; pass --yes');
    if (!/^y(es)?$/i.test(await ask('proceed? [y/N] '))) return 'nothing removed';
  }
  if (existsSync(file)) unlinkSync(file);
  for (const i of issues) db.deleteIssue(i.id);
  db.deleteRepo(repo);
  rmSync(WORK(repo), { recursive: true, force: true });
  rmSync(mirrorDir(repo), { recursive: true, force: true });
  return `${repo} removed.`;
}

export function listRepos(cfg: Config, db: Ctx['db']): string {
  const rows = cfg.repos.map((rc) => {
    const r = db.repo(rc.full_name);
    const blocked = db.blockedIssues(rc.full_name).length;
    const audited = db.get(`audited:${rc.full_name}`);
    return {
      repo: rc.full_name, status: r?.status ?? 'new',
      'in flight': db.inFlightCount(rc.full_name), 'open PRs': db.openPrCount(rc.full_name),
      proposals: db.proposals('pending', rc.full_name).length,
      gate: blocked ? `broken (${blocked} blocked)` : 'ok', audited: audited?.slice(0, 16) ?? '-',
    };
  });
  return rows.length ? rows.map((r) => Object.entries(r).map(([k, v]) => `${k}=${v}`).join('  ')).join('\n') : '(no repos; maintainer-bot repo add <url>)';
}
