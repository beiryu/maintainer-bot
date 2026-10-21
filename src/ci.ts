import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import { type Config, parseConfig, repoConfig, RepoConfigSchema, repoOwner } from './config.js';
import { DASHBOARD_MARK, DASHBOARD_TITLE, dashboardChanged, parseCommands, parseTicks, renderDashboard, type Tick } from './dashboard.js';
import type { Db, StateJson } from './db.js';
import { ensureMirror } from './git.js';
import * as gh from './github.js';
import { approveFollowup, approveProposal, type Ctx, openPr, rejectProposal, replyText, runOnce } from './orchestrator.js';
import { approveDraft } from './outside.js';

// The bot on GitHub Actions. One workflow run = one pass, in two jobs:
//   agent    reads GitHub with the Actions token, runs agents and the gate, writes nothing but
//            the state file it hands over;
//   publish  holds the maintainer's token and no model credential: opens the PRs the agent
//            got ready, carries out what was ticked on the dashboard, renders the dashboard,
//            saves the state on the `maintainer-bot/state` branch.
// The repo's `.github/maintainer-bot.yml` is the per-repo config plus a `bot:` block.

export const STATE_BRANCH = 'maintainer-bot/state';
const STATE_FILE = 'state.json';
const RUNTIME_ENV = { copilot: 'COPILOT_GITHUB_TOKEN', claude: 'ANTHROPIC_API_KEY' } as const;

const BotBlock = z.object({
  github_user: z.string().regex(/^[\w-]+$/).optional(),     // default: the repo's owner
  runtime: z.enum(['copilot', 'claude']).default('copilot'),
  auth_env: z.enum(['COPILOT_GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']).optional(),
  model: z.string().optional(),
  // Toolchains the job installs before the gate runs: node@22, pnpm@12.11.2, go@1.24, uv.
  setup: z.array(z.string()).default([]),
  budget: z.object({ max_cost_per_call_usd: z.number().optional(), max_cost_per_month_usd: z.number().optional() }).default({}),
  limits: z.object({
    max_attempts: z.number().optional(), max_triage_per_run: z.number().optional(), audit_interval_hours: z.number().optional(),
  }).default({}),
  agent_timeout_min: z.number().optional(),
  gate_timeout_min: z.number().optional(),
});

/** The whole Config for one repo, from its `.github/maintainer-bot.yml`. */
export function ciConfig(file: string, repo: string): Config {
  const raw = (parse(readFileSync(file, 'utf8')) ?? {}) as Record<string, unknown>;
  const { bot: botRaw, ...rest } = raw;
  const bot = BotBlock.parse(botRaw ?? {});
  const rc = RepoConfigSchema.parse({ ...rest, full_name: repo });
  return parseConfig({
    github_user: bot.github_user ?? repoOwner(repo),
    push_via: 'api',
    repos: [rc],
    limits: { min_free_disk_gb: 2, ...bot.limits },
    budget: bot.budget,
    sandbox: {
      mode: 'runner', runtime: bot.runtime, auth_env: bot.auth_env ?? RUNTIME_ENV[bot.runtime], model: bot.model,
      agent_timeout_min: bot.agent_timeout_min, gate_timeout_min: bot.gate_timeout_min,
    },
    notify: {},
  });
}

/** `name=value` lines for $GITHUB_OUTPUT: what the workflow must install before the bot runs. */
export function setupOutputs(file: string): string {
  const raw = (parse(readFileSync(file, 'utf8')) ?? {}) as { bot?: unknown };
  const bot = BotBlock.parse(raw.bot ?? {});
  const want = (name: string) => bot.setup.find((s) => s === name || s.startsWith(`${name}@`));
  const version = (spec: string | undefined, fallback: string) => spec?.split('@')[1] ?? fallback;
  return [
    `runtime=${bot.runtime}`,
    `auth_env=${bot.auth_env ?? RUNTIME_ENV[bot.runtime]}`,
    `node=${version(want('node'), '22')}`,
    `pnpm=${want('pnpm') ?? ''}`,
    `go=${want('go') ? version(want('go'), 'stable') : ''}`,
    `uv=${want('uv') ? 'true' : ''}`,
  ].join('\n');
}

// ---------------------------------------------------------------- state on a branch

export async function pullState(repo: string): Promise<{ json: StateJson | null; head: string | null }> {
  const head = await gh.refSha(repo, STATE_BRANCH);
  if (!head) return { json: null, head: null };
  return { json: JSON.parse(await gh.fileAtRef(repo, STATE_FILE, STATE_BRANCH)) as StateJson, head };
}

const sameState = (a: StateJson | null, b: StateJson) => !!a && JSON.stringify({ ...a, exported_at: '' }) === JSON.stringify({ ...b, exported_at: '' });

/** Saves the state as one commit on the state branch (created as an orphan the first time). Returns the new head, or null when nothing changed. */
export async function pushState(repo: string, json: StateJson, previous: { json: StateJson | null; head: string | null }): Promise<string | null> {
  if (sameState(previous.json, json)) return null;
  const text = `${JSON.stringify(json, null, 1)}\n`;
  const message = `state: ${json.exported_at}`;
  if (previous.head) {
    return gh.createCommitOnBranch(repo, STATE_BRANCH, previous.head, { headline: message, body: '' },
      { additions: [{ path: STATE_FILE, contents: Buffer.from(text).toString('base64') }], deletions: [] });
  }
  // An orphan branch: tree → parentless commit → ref. Only this first commit is unsigned.
  const tree = await gh.ghPost<{ sha: string }>(`repos/${repo}/git/trees`, { tree: [{ path: STATE_FILE, mode: '100644', type: 'blob', content: text }] });
  const commit = await gh.ghPost<{ sha: string }>(`repos/${repo}/git/commits`, { message, tree: tree.sha, parents: [] });
  await gh.createRef(repo, STATE_BRANCH, commit.sha);
  return commit.sha;
}

// ---------------------------------------------------------------- agent job

const monthStart = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString(); };

/** One pass without write access: everything up to "PR ready", drafts and proposals into the state. */
export async function ciAgent(ctx: Ctx, opts: { repo: string; dry: boolean }) {
  const { cfg, db } = ctx;
  gh.assumeUser(cfg.github_user);
  db.upsertRepo(opts.repo);
  const limit = cfg.budget.max_cost_per_month_usd;
  if (limit && db.costSince(monthStart()) >= limit) {
    db.set('budget-exhausted', new Date().toISOString());
    console.log(`monthly budget of $${limit} reached ($${db.costSince(monthStart()).toFixed(2)} spent); no agent runs until next month`);
    return;
  }
  db.set('budget-exhausted', null);
  ctx.deferActions = true;
  await runOnce(ctx, { dry: opts.dry, repo: opts.repo, audit: 'auto' });
}

// ---------------------------------------------------------------- publish job

/** The parts of a GitHub event payload the publish step looks at. */
export interface EventPayload {
  action?: string;
  sender?: { login: string };
  issue?: { number: number; body: string | null };
  comment?: { body: string; user: { login: string } };
}

export interface PublishOpts { repo: string; eventName?: string; event?: EventPayload; draft: boolean; runUrl?: string }

async function dashboardIssue(ctx: Ctx, repo: string, body: string): Promise<{ number: number; body: string; created: boolean }> {
  const { db } = ctx;
  const known = db.get(`dashboard:${repo}`);
  if (known) {
    const i = await gh.getIssue(repo, Number(known));
    if (i.state === 'OPEN') return { number: i.number, body: i.body ?? '', created: false };
  }
  const found = (await gh.findIssuesByBody(repo, 'maintainer-bot:dashboard')).find((i) => i.body.includes(DASHBOARD_MARK));
  if (found) { db.set(`dashboard:${repo}`, String(found.number)); return { number: found.number, body: found.body, created: false }; }
  const created = await gh.createIssue(repo, { title: DASHBOARD_TITLE, body });
  db.set(`dashboard:${repo}`, String(created.number));
  await gh.pinIssue(repo, created.number).catch(() => undefined);
  return { number: created.number, body, created: true };
}

/** Carries out one ticked decision; the text returned is shown on the dashboard when it fails. */
async function applyTick(ctx: Ctx, t: Tick): Promise<void> {
  const { db } = ctx;
  const n = Number(t.id.slice(1));
  if (t.id.startsWith('p')) { await approveProposal(ctx, n, { edit: false }); return; }
  if (t.id.startsWith('a')) { await approveFollowup(ctx, n, { message: db.action(n).message }); return; }
  const d = db.draft(n);
  if (d.status !== 'pending') throw new Error(`d${n} is ${d.status}`);
  await approveDraft(ctx, d, replyText(d.message), { take: t.flag === 'take', requestChanges: t.flag === 'changes' });
}

function applyCommand(ctx: Ctx, repo: string, c: ReturnType<typeof parseCommands>[number]): string {
  const { cfg, db } = ctx;
  if (c.cmd === 'reject') {
    const n = Number(c.id.slice(1));
    if (c.id.startsWith('p')) rejectProposal(ctx, n, c.reason);
    else if (c.id.startsWith('a')) db.setActionStatus(n, 'rejected');
    else db.setDraftStatus(n, 'rejected');
    return `${c.id} rejected`;
  }
  const issue = db.issueByNumber(repo, c.number);
  if (issue) {
    db.update(issue.id, { state: 'discovered', skip_reason: null, attempts: 0, feedback: null, blocked: null });
    db.set(`handed-back:${issue.id}`, null);
  }
  if (c.cmd === 'take') void gh.assign(repo, c.number, cfg.github_user);
  return `#${c.number}: the next run works on it`;
}

export async function ciPublish(ctx: Ctx, opts: PublishOpts): Promise<string[]> {
  const { cfg, db } = ctx;
  const { repo } = opts;
  const rc = repoConfig(cfg, repo);
  const me = (await gh.currentUser()).toLowerCase();
  const notes: string[] = [];
  const log = (m: string) => { console.log(`${new Date().toISOString()} ${m}`); };
  db.upsertRepo(repo);
  await ensureMirror(repo, rc.default_branch);

  // 1. What the maintainer decided on the dashboard.
  const ev = opts.event;
  const onDashboard = !!ev?.issue?.body?.includes(DASHBOARD_MARK);
  const byMe = ev?.sender?.login?.toLowerCase() === me;
  let decided = false;
  if (onDashboard && byMe && opts.eventName === 'issues' && ev?.action === 'edited') {
    for (const t of parseTicks(ev!.issue!.body!)) {
      decided = true;
      try { await applyTick(ctx, t); log(`${t.id}${t.flag ? `:${t.flag}` : ''}: done`); }
      catch (e) { notes.push(`❌ ${t.id}: ${(e as Error).message.split('\n')[0].slice(0, 300)}`); log(`${t.id}: ${(e as Error).message}`); }
    }
  }
  if (onDashboard && byMe && opts.eventName === 'issue_comment' && ev?.action === 'created' && ev.comment?.user.login.toLowerCase() === me) {
    for (const c of parseCommands(ev.comment.body)) {
      decided = true;
      try { log(applyCommand(ctx, repo, c)); } catch (e) { notes.push(`❌ ${JSON.stringify(c)}: ${(e as Error).message.slice(0, 300)}`); }
    }
    if (/^\s*\/pause\s*$/m.test(ev.comment.body)) { db.set('paused', '1'); decided = true; }
    if (/^\s*\/resume\s*$/m.test(ev.comment.body)) { db.set('paused', null); decided = true; }
  }

  // 2. PRs the agent step got ready.
  for (const i of db.allIssues().filter((i) => i.repo === repo && i.state === 'reviewed' && !i.dry)) {
    try {
      const pr = await openPr(ctx, i.id, { draft: opts.draft });
      log(`#${i.number}: opened ${pr.url}`);
    } catch (e) {
      const why = (e as Error).message.split('\n')[0].slice(0, 300);
      db.skip(i.id, `PR could not be opened: ${why}`);
      db.set(`handed-back:${i.id}`, new Date().toISOString());
      notes.push(`❌ #${i.number}: PR not opened: ${why}`);
    }
  }

  // 3. The dashboard.
  if (db.get('budget-exhausted')) notes.push(`⏸ This month's budget ($${cfg.budget.max_cost_per_month_usd}) is spent; no agent runs until next month.`);
  const body = renderDashboard(db, cfg, {
    repo, runUrl: opts.runUrl, notes, monthCostUsd: db.costSince(monthStart()),
    monthLimitUsd: cfg.budget.max_cost_per_month_usd || undefined, tokenExpiry: await gh.tokenExpiry(),
  });
  const d = await dashboardIssue(ctx, repo, body);
  if (!d.created && (decided || dashboardChanged(d.body, body))) {
    await gh.editIssueBody(repo, d.number, body);
    log(`dashboard #${d.number} updated`);
  }
  return notes;
}
