import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import { type Config, parseConfig, repoConfig, RepoConfigSchema, repoOwner } from './config.js';
import { type Command, DASHBOARD_MARK, dashboardChanged, dashboardTitle, itemComment, parseCommands, pendingItems, renderDashboard, repoMark } from './dashboard.js';
import type { Db, StateJson } from './db.js';
import { ensureMirror } from './git.js';
import * as gh from './github.js';
import { approveFollowup, approveProposal, type Ctx, openPr, rejectProposal, replyText, runOnce } from './orchestrator.js';
import { approveDraft } from './outside.js';

// The bot on GitHub Actions. One workflow run = one pass, in two jobs:
//   agent    reads GitHub with the Actions token, runs agents and the gate, writes nothing but
//            the state file it hands over;
//   publish  holds the maintainer's token and no model credential: opens the PRs the agent
//            got ready, runs and answers the /commands on the dashboard, renders it,
//            saves the state on the `maintainer-bot/state` branch.
// The repo's `.github/maintainer-bot.yml` is the per-repo config plus a `bot:` block.

export const STATE_BRANCH = 'maintainer-bot/state';
const STATE_FILE = 'state.json';
const RUNTIME_ENV = { copilot: 'COPILOT_GITHUB_TOKEN', claude: 'ANTHROPIC_API_KEY' } as const;

const BotBlock = z.object({
  github_user: z.string().regex(/^[\w-]+$/).optional(),     // default: the repo's owner
  // Where the dashboard issue lives: this repo (default), or a private repo only the maintainer sees.
  dashboard_repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).optional(),
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

/** The repo that holds this repo's dashboard. */
export function deskRepo(file: string, repo: string): string {
  const raw = (parse(readFileSync(file, 'utf8')) ?? {}) as { bot?: unknown };
  return BotBlock.parse(raw.bot ?? {}).dashboard_repo ?? repo;
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

export interface PublishOpts { repo: string; desk?: string; draft: boolean; runUrl?: string }

/** The dashboard issue of a repo in the desk repo, by the number on record or by its marks; null when there is none yet. */
async function findDashboard(ctx: Ctx, repo: string, desk: string): Promise<{ number: number; body: string } | null> {
  const { db } = ctx;
  const key = `dashboard:${desk}:${repo}`;
  const known = db.get(key);
  if (known) {
    const i = await gh.getIssue(desk, Number(known));
    if (i.state === 'OPEN') return { number: i.number, body: i.body ?? '' };
  }
  const found = (await gh.findIssuesByBody(desk, 'maintainer-bot:dashboard'))
    .find((i) => i.body.includes(DASHBOARD_MARK) && (i.body.includes(repoMark(repo)) || (desk === repo && !i.body.includes('maintainer-bot:repo'))));
  if (found) { db.set(key, String(found.number)); return { number: found.number, body: found.body }; }
  return null;
}

/** The bot's own replies on the dashboard carry this, so they are never read back as commands. */
export const REPLY_MARK = '<!-- maintainer-bot:reply -->';

/** Carries out one command; returns what was done, in one line, or throws with why not. */
async function applyCommand(ctx: Ctx, repo: string, c: Command): Promise<string> {
  const { cfg, db } = ctx;
  if (c.cmd === 'approve') {
    const n = Number(c.id.slice(1));
    if (c.id.startsWith('p')) return approveProposal(ctx, n, { edit: false });
    if (c.id.startsWith('a')) return approveFollowup(ctx, n, { message: db.action(n).message });
    const d = db.draft(n);
    if (d.status !== 'pending') throw new Error(`d${n} is already ${d.status}`);
    return approveDraft(ctx, d, replyText(d.message), { take: c.flag === 'take', requestChanges: c.flag === 'changes' });
  }
  if (c.cmd === 'reject') {
    const n = Number(c.id.slice(1));
    if (c.id.startsWith('p')) rejectProposal(ctx, n, c.reason);
    else if (c.id.startsWith('a')) db.setActionStatus(n, 'rejected');
    else db.setDraftStatus(n, 'rejected');
    return `${c.id} rejected${c.reason ? `: ${c.reason}` : ''}`;
  }
  const issue = db.issueByNumber(repo, c.number);
  if (issue) {
    db.update(issue.id, { state: 'discovered', skip_reason: null, attempts: 0, feedback: null, blocked: null });
    db.set(`handed-back:${issue.id}`, null);
  }
  if (c.cmd === 'take') await gh.assign(repo, c.number, cfg.github_user);
  return `#${c.number} ${c.cmd === 'take' ? 'assigned to you; ' : ''}the bot works on it in the next run`;
}

/** One readable line for a failure: a git/gh command line is noise, its exit code and stderr are not. */
export function shortError(e: unknown): string {
  const msg = (e as Error).message ?? String(e);
  const cmd = /^Command failed with exit code (\d+): (git|gh)\b.*?\b(checkout|fetch|push|apply|clone|commit|api|pr|issue)\b/.exec(msg);
  const stderr = (e as { stderr?: string }).stderr?.trim().split('\n').pop();
  if (cmd) return `${cmd[2]} ${cmd[3]} failed (exit ${cmd[1]})${stderr ? `: ${stderr.slice(0, 160)}` : ''}`;
  return msg.split('\n')[0].slice(0, 200);
}

/** What the maintainer would write on an issue they had to put down: the reason, and how to resume. */
export function stopComment(reason: string, number: number, dashboard: string): string {
  const why = reason
    .replace(/^(coder gave up|error|triage: not feasible|Reviewer: no rework can fix this):\s*/i, '')
    .replace(/^Blocked:\s*/i, '')
    .replace(/\s+/g, ' ').trim().slice(0, 500);
  return `Pausing this one: ${why}${/[.!?]$/.test(why) ? '' : '.'}\n\n`
    + `Once that's in place, \`/retry #${number}\`${dashboard ? ` on ${dashboard}` : ''} picks it up again.`;
}

const label = (c: Command) => c.cmd === 'approve' || c.cmd === 'reject' ? `${c.cmd} ${c.id}${'flag' in c && c.flag ? ` --${c.flag}` : ''}` : `${c.cmd} #${c.number}`;

export async function ciPublish(ctx: Ctx, opts: PublishOpts): Promise<string[]> {
  const { cfg, db } = ctx;
  const { repo } = opts;
  const desk = opts.desk ?? repo;
  const rc = repoConfig(cfg, repo);
  const me = (await gh.currentUser()).toLowerCase();
  const notes: string[] = [];
  const log = (m: string) => { console.log(`${new Date().toISOString()} ${m}`); };
  db.upsertRepo(repo);
  await ensureMirror(repo, rc.default_branch);

  // 1. Commands in the maintainer's comments on the dashboard, each handled once (by comment
  // id, whatever event started this run), each answered with what was done and the run log.
  const dash = await findDashboard(ctx, repo, desk);
  let decided = false;
  if (dash) {
    const doneKey = `dashboard-last-comment:${desk}:${repo}`;
    const lastDone = Number(db.get(doneKey) ?? 0);
    const comments = await gh.issueComments(desk, dash.number);
    // First run on this dashboard: earlier comments are history, not orders.
    const fresh = lastDone ? comments.filter((c) => c.id > lastDone && c.author.toLowerCase() === me && !c.body.includes(REPLY_MARK) && !c.body.includes('maintainer-bot:item')) : [];
    for (const c of fresh) {
      // `/a all`: every pending item an agent can carry out; [needs you] proposals stay.
      const cmds = parseCommands(c.body).flatMap((cmd) => cmd.cmd === 'approve' && cmd.id === 'all'
        ? [
          ...db.proposals('pending', repo).filter((p) => !p.rationale.startsWith('[needs')).map((p) => ({ ...cmd, id: `p${p.id}` })),
          ...db.pendingActions().filter((a) => db.issue(a.issue_id).repo === repo).map((a) => ({ ...cmd, id: `a${a.id}` })),
          ...db.drafts('pending').filter((d) => d.repo === repo).map((d) => ({ ...cmd, id: `d${d.id}` })),
        ]
        : [cmd]);
      const pause = /^\s*\/pause\s*$/m.test(c.body), resume = /^\s*\/resume\s*$/m.test(c.body);
      if (!cmds.length && !pause && !resume) continue;
      decided = true;
      const results: string[] = [];
      for (const cmd of cmds) {
        try { results.push(`✅ ${label(cmd)}: ${await applyCommand(ctx, repo, cmd)}`); }
        catch (e) { results.push(`❌ ${label(cmd)}: ${shortError(e)}`); }
      }
      if (pause) { db.set('paused', '1'); results.push('⏸ paused: no agent runs until `/resume`'); }
      if (resume) { db.set('paused', null); results.push('▶️ resumed'); }
      for (const r of results) log(r);
      const reply = `${REPLY_MARK}\n${results.join('\n')}${opts.runUrl ? ` · [log](${opts.runUrl})` : ''}`;
      await gh.commentOnIssue(desk, dash.number, reply).catch((e) => log(`reply failed: ${(e as Error).message}`));
    }
    const newest = comments.at(-1)?.id ?? 0;
    db.set(doneKey, String(Math.max(lastDone, newest, 1)));
  }

  // 1b. Reactions on the item comments: 👍 approve, 👎 reject, 🚀 approve with the item's variant.
  // Reactions start no workflow; a frequent schedule brings the run that reads them.
  if (dash) {
    const itemKey = (id: string) => `item:${desk}:${repo}:${id}`;
    const pending = new Set(pendingItems(db, repo).map((it) => it.id));
    for (const k of db.allKeys(`item:${desk}:${repo}:`)) {
      const id = k.slice(`item:${desk}:${repo}:`.length);
      const commentId = Number(db.get(k));
      if (!pending.has(id)) continue;
      let reactions: { content: string; user: string }[];
      try { reactions = (await gh.commentReactions(desk, commentId)).filter((r) => r.user.toLowerCase() === me); }
      catch { continue; }
      const has = (c: string) => reactions.some((r) => r.content === c);
      const kind = id[0];
      const cmd: Command | null = has('-1') ? { cmd: 'reject', id, reason: '' }
        : has('rocket') && kind === 'd' ? { cmd: 'approve', id, flag: db.draft(Number(id.slice(1))).target === 'pr' ? 'changes' : 'take' }
        : has('+1') || has('rocket') ? { cmd: 'approve', id } : null;
      if (!cmd) continue;
      decided = true;
      let result: string;
      try { result = `✅ ${await applyCommand(ctx, repo, cmd)}`; } catch (e) { result = `❌ ${shortError(e)}`; }
      log(`${id}: ${result}`);
      await gh.editComment(desk, commentId, `~~${id}~~ ${result}${opts.runUrl ? ` · [log](${opts.runUrl})` : ''}`).catch(() => undefined);
      db.set(k, null);
    }
    // Items decided some other way (a text command): their comment says so; new items get one.
    for (const k of db.allKeys(`item:${desk}:${repo}:`)) {
      const id = k.slice(`item:${desk}:${repo}:`.length);
      if (pending.has(id)) continue;
      await gh.editComment(desk, Number(db.get(k)), `~~${id}~~ decided`).catch(() => undefined);
      db.set(k, null);
    }
    for (const it of pendingItems(db, repo)) {
      if (db.get(itemKey(it.id))) continue;
      try { db.set(itemKey(it.id), String(await gh.addComment(desk, dash.number, itemComment(it)))); }
      catch (e) { log(`${it.id}: item comment not posted: ${shortError(e)}`); }
    }
  }

  // 2a. Proposals the agent can implement, on a repo that does not want to approve each one.
  for (const p of db.proposals('pending', repo).filter((p) => db.get(`auto-approve:${p.id}`))) {
    try { log(`p${p.id}: ${await approveProposal(ctx, p.id, { edit: false })}`); }
    catch (e) { notes.push(`❌ p${p.id}: ${shortError(e)}`); }
    db.set(`auto-approve:${p.id}`, null);
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

  // 3. An issue the bot stopped on gets one comment saying why, in the maintainer's voice.
  for (const i of db.issuesInState('skipped').filter((i) => i.repo === repo && db.get(`handed-back:${i.id}`) && !db.get(`stop-noted:${i.id}`))) {
    if (i.skip_reason?.startsWith('rejected by human')) continue;
    try {
      // A private desk's issue would be a dead link for everyone else: name it only when it is public here.
      const where = desk === repo ? (dash ? `#${dash.number}` : 'the dashboard') : 'the dashboard';
      await gh.commentOnIssue(repo, i.number, stopComment(i.skip_reason ?? '', i.number, where));
      db.set(`stop-noted:${i.id}`, new Date().toISOString());
    } catch (e) { log(`#${i.number}: stop note not posted: ${(e as Error).message.split('\n')[0]}`); }
  }

  // 4. The dashboard.
  if (db.get('budget-exhausted')) notes.push(`⏸ This month's budget ($${cfg.budget.max_cost_per_month_usd}) is spent; no agent runs until next month.`);
  const body = renderDashboard(db, cfg, {
    repo, runUrl: opts.runUrl, notes, monthCostUsd: db.costSince(monthStart()),
    monthLimitUsd: cfg.budget.max_cost_per_month_usd || undefined, tokenExpiry: await gh.tokenExpiry(),
  });
  if (!dash) {
    const created = await gh.createIssue(desk, { title: dashboardTitle(repo, desk), body });
    db.set(`dashboard:${desk}:${repo}`, String(created.number));
    await gh.pinIssue(desk, created.number).catch(() => undefined);
    log(`dashboard #${created.number} created`);
  } else if (decided || dashboardChanged(dash.body, body)) {
    await gh.editIssueBody(desk, dash.number, body);
    log(`dashboard #${dash.number} updated`);
  }
  return notes;
}
