import { spawnSync } from 'node:child_process';
import { execa } from 'execa';
import { appendFileSync, closeSync, existsSync, openSync, readSync, mkdirSync, readFileSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { AgentError, fillTemplate, runAgent, safeTestVars } from './agent.js';
import { hoursSinceAudit, labelsFor, runAudit } from './audit.js';
import { type Config, repoConfig, type RepoConfig, repoOwner } from './config.js';
import type { Db, Issue, PendingAction, Pr, Proposal } from './db.js';
import { housekeeping } from './housekeeping.js';
import { cmd, needsYou } from './inbox.js';
import { runGate, hashTestFiles, focusedTestCommand, repairPathVars, staticChecks } from './gate.js';
import {
  agentDir, AGENT_META, applyPatch, ensureMirror, freshClone, git, issueDir, mirrorDir, parsePatch,
  prepareAgentWorkdir, readAgentFile,
} from './git.js';
import * as gh from './github.js';
import { notify } from './notify.js';
import { reviewOutsidePrs, triageOutsideIssues } from './outside.js';
import { markDone, rmIdFromTitle } from './roadmap.js';
import { runInSandbox, tail, workPath } from './sandbox.js';
import { sourceDigest } from './watch.js';

export interface Ctx { cfg: Config; db: Db; runId: string | null }

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);
const NOT_FEASIBLE = 'triage: not feasible';
const OWN_REPLY = '<!-- maintainer-bot: your reply goes above this line -->';

/** Keeps untrusted text from closing the tag it is wrapped in inside a prompt. */
const untrusted = (s: string) => s.replace(/<\/?untrusted/gi, '&lt;untrusted').slice(0, 20_000);

// ---------------------------------------------------------------- run lock & budget

export function withLock<T>(fn: () => Promise<T>, lock = 'data/run.lock'): Promise<T> {
  mkdirSync(dirname(lock), { recursive: true });
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, 'utf8'));
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch { /* stale */ }
    if (alive) throw new Error(`another run is in progress (pid ${pid}, lock ${lock})`);
  }
  writeFileSync(lock, String(process.pid));
  return fn().finally(() => rmSync(lock, { force: true }));
}

// ---------------------------------------------------------------- main loop

export interface RunOpts { dry: boolean; repo?: string; issue?: number; triageOnly?: boolean; audit?: 'auto' | 'skip' | 'only' }

export async function runOnce(ctx: Ctx, opts: RunOpts) {
  const { cfg, db } = ctx;
  if (db.get('paused')) return log('paused; `maintainer-bot resume` to continue');
  // Without the model credential every agent call would fail and skip its issue.
  if (!process.env[cfg.sandbox.auth_env]) {
    throw new Error(`${cfg.sandbox.auth_env} is not set; run \`source .env\` in this terminal first`);
  }
  // Docker's disk image grows on the host; running out corrupts every container's storage.
  // (A runner's disk is checked the same way: a clone or build that runs out of space fails late.)
  mkdirSync('work', { recursive: true });
  const fs = statfsSync('work');
  const freeGb = (fs.bavail * fs.bsize) / 2 ** 30;
  if (freeGb < cfg.limits.min_free_disk_gb) {
    throw new Error(`only ${freeGb.toFixed(1)} GB free on disk (need ${cfg.limits.min_free_disk_gb}); free some space first`);
  }

  const events: string[] = [];
  const heads = new Map<string, string>();
  const audit = opts.audit ?? 'auto';

  for (const rc of cfg.repos) {
    if (opts.repo && rc.full_name !== opts.repo) continue;
    db.upsertRepo(rc.full_name);
    if (db.repo(rc.full_name)!.status !== 'active') continue;
    log(`${rc.full_name}: refreshing mirror`);
    heads.set(rc.full_name, await ensureMirror(rc.full_name, rc.default_branch));
  }
  const active = (r: string) => db.repo(r)?.status === 'active' && heads.has(r);

  // 1. Follow-up on open PRs first.
  for (const pr of opts.triageOnly || audit === 'only' ? [] : db.openPrs()) {
    if (!active(pr.repo)) continue;
    try {
      const e = await followUp(ctx, pr.issue_id);
      if (e) events.push(e);
    } catch (e) {
      events.push(`follow-up on ${pr.url} failed: ${(e as Error).message}`);
    }
  }

  // Issues the bot stopped on that were closed some other way (fixed by hand, dropped) leave the inbox.
  for (const i of opts.triageOnly || audit === 'only' ? [] : db.issuesInState('skipped')) {
    if (!active(i.repo) || !db.get(`handed-back:${i.id}`)) continue;
    try {
      if ((await gh.getIssue(i.repo, i.number)).state !== 'OPEN') {
        db.transition(i.id, 'closed');
        events.push(`${i.url} closed on GitHub; dropped from the inbox`);
      }
    } catch { /* checked again next run */ }
  }

  // 2. Other people's new issues and PRs: draft a triage reply / review for the inbox.
  if (!opts.triageOnly && !opts.issue && audit !== 'only' && !opts.dry) {
    for (const rc of cfg.repos) {
      if (!active(rc.full_name) || (opts.repo && rc.full_name !== opts.repo)) continue;
      for (const step of [triageOutsideIssues, reviewOutsidePrs]) {
        try {
          events.push(...await step(ctx, rc, log));
        } catch (e) {
          events.push(`${rc.full_name}: ${step.name} failed: ${(e as Error).message.slice(0, 300)}`);
        }
      }
    }
  }

  // 3. Audit: what changed upstream, then what the repo is missing. Proposals wait in the inbox.
  if (!opts.triageOnly && !opts.issue && audit !== 'skip') {
    for (const rc of cfg.repos) {
      if (!active(rc.full_name) || (opts.repo && rc.full_name !== opts.repo)) continue;
      if (audit === 'auto' && hoursSinceAudit(db, rc.full_name) < cfg.limits.audit_interval_hours) continue;
      try {
        const digest = await sourceDigest(ctx, rc, log);
        const added = await runAudit(ctx, rc, digest, log);
        if (added.length) events.push(`${rc.full_name}: ${added.length} new proposal(s): ${added.map((p) => `p${p.id}`).join(', ')}`);
      } catch (e) {
        events.push(`${rc.full_name}: audit failed: ${(e as Error).message.slice(0, 300)}`);
      }
    }
  }

  // 4. Find work: a specific issue, or the open issues labelled for the bot.
  if (audit !== 'only') {
    if (opts.issue && opts.repo) {
      if (!active(opts.repo)) throw new Error(`${opts.repo} is not active`);
      const e = await targetIssue(ctx, repoConfig(cfg, opts.repo), opts.issue, opts.dry);
      if (e) events.push(e);
    } else {
      for (const rc of cfg.repos) {
        if (!active(rc.full_name) || (opts.repo && rc.full_name !== opts.repo)) continue;
        if (!opts.triageOnly && db.inFlightCount(rc.full_name) >= cfg.limits.max_in_flight_per_repo) continue;
        try {
          const e = await discoverAndTriage(ctx, rc, !!opts.triageOnly);
          if (e) events.push(e);
        } catch (e) {
          events.push(`${rc.full_name}: discovery failed: ${(e as Error).message}`);
        }
      }
    }
  }

  // 5. Advance in-progress issues.
  const candidates = opts.triageOnly || audit === 'only' ? [] : opts.issue && opts.repo
    ? [db.issueByNumber(opts.repo, opts.issue)].filter((i): i is Issue => !!i)
    : db.nextIssues(opts.repo);
  for (const issue of candidates) {
    if (!active(issue.repo)) continue;
    try {
      const e = await advance(ctx, issue.id);
      if (e) events.push(e);
    } catch (e) {
      db.skip(issue.id, `error: ${(e as Error).message}`);
      await handBack(ctx, db.issue(issue.id));
      events.push(`#${issue.number} skipped after error: ${(e as Error).message.slice(0, 300)}`);
    }
  }

  await housekeeping(cfg, db, log);
  const cost = ctx.runId ? db.costForRun(ctx.runId) : 0;
  const summary = [`maintainer-bot run finished ($${cost.toFixed(2)})`, ...events].join('\n• ');
  const todo = needsYou(db, cfg);
  if (events.length || todo.length) await notify(cfg, todo.length ? `${summary}\n\nCần bạn:\n${todo.join('\n')}` : summary);
  else log(summary);
}

// ---------------------------------------------------------------- discovery & triage

/**
 * Cheap ordering before spending triage credits: bug reports first, feature requests and
 * questions last. Triage still decides; this only picks which issues it sees first.
 */
export function triagePriority(issue: { title: string }): number {
  const t = issue.title.toLowerCase();
  if (/^\s*(\[?(feature|feat|enhancement|question|docs?|documentation)\b|feat\()/.test(t)) return 0;
  if (/\b(bug|fix|fails?|failing|crash|panic|hangs?|error|wrong|incorrect|silently|drops?|leaks?|broken|regression)\b/.test(t)) return 2;
  return 1;
}

async function discoverAndTriage(ctx: Ctx, rc: RepoConfig, triageOnly = false): Promise<string | null> {
  const { cfg, db } = ctx;

  // Already-triaged issues waiting for a free slot come first; re-check that they are still open.
  for (const t of triageOnly ? [] : db.issuesInState('triaged', rc.full_name).sort((a, b) => (b.score ?? 0) - (a.score ?? 0))) {
    const gi = await gh.getIssue(rc.full_name, t.number);
    const why = await unavailable(rc, gi);
    if (why) { db.skip(t.id, why); continue; }
    return promote(ctx, rc, t);
  }

  const issues = await gh.listOpenIssues(rc.full_name, rc.labels);
  db.markScanned(rc.full_name);
  const fresh: Issue[] = [];
  const passed: Record<string, number> = {};
  for (const gi of issues) {
    if (db.issueByNumber(rc.full_name, gi.number)) { passed['already seen'] = (passed['already seen'] ?? 0) + 1; continue; }
    const why = await unavailable(rc, gi);
    if (why) { passed[why] = (passed[why] ?? 0) + 1; continue; } // not recorded: it may become available later
    db.insertDiscovered({ repo: rc.full_name, number: gi.number, title: gi.title, body: gi.body ?? '', url: gi.url });
    fresh.push(db.issueByNumber(rc.full_name, gi.number)!);
  }
  log(`${rc.full_name}: ${issues.length} open issues, ${fresh.length} new candidates` +
    (Object.keys(passed).length ? ` (passed over: ${Object.entries(passed).map(([k, v]) => `${v} ${k}`).join(', ')})` : ''));

  let best: Issue | null = null;
  const scored: Issue[] = [];
  for (const issue of [...fresh, ...db.issuesInState('discovered', rc.full_name)]
    .filter((v, i, a) => a.findIndex((x) => x.id === v.id) === i)
    .sort((a, b) => triagePriority(b) - triagePriority(a) || b.number - a.number)
    .slice(0, triageOnly ? undefined : cfg.limits.max_triage_per_run)) { // --triage-only scores the whole queue
    if (!fresh.includes(issue)) {
      const why = await unavailable(rc, await gh.getIssue(rc.full_name, issue.number));
      if (why) { db.skip(issue.id, why); continue; }
    }
    const t = await triage(ctx, rc, issue);
    scored.push(t);
    if (t.state === 'triaged' && (!best || (t.score ?? 0) > (best.score ?? 0))) best = t;
  }
  if (triageOnly) {
    if (!scored.length) return `${rc.full_name}: nothing new to triage`;
    return `${rc.full_name}: triaged ${scored.length}:\n` + scored
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .map((t) => `  ${t.state === 'triaged' ? '      ' : '[no]  '}${(t.score ?? 0).toFixed(2)} #${t.number} (id ${t.id}) ${t.title.slice(0, 70)}`)
      .join('\n');
  }
  return best ? promote(ctx, rc, best) : null;
}

/**
 * Reason an issue is not for the bot, from what the issue itself says, or null. The maintainer
 * takes an issue the way any maintainer does, by assigning it to themselves; who opened it
 * does not matter once it is assigned.
 */
export function pickReason(rc: RepoConfig, gi: gh.GhIssue & { state?: string }, me: string): string | null {
  if (gi.state && gi.state !== 'OPEN') return 'issue closed';
  const names = gi.labels.map((l) => l.name);
  if (rc.labels.length && !rc.labels.some((l) => names.includes(l))) return 'no wanted label';
  const skip = rc.skip_labels.find((l) => names.includes(l));
  if (skip) return `label "${skip}"`;
  if (rc.pick === 'assigned' && !gi.assignees.some((a) => a.login.toLowerCase() === me.toLowerCase())) return 'not assigned to you';
  return null;
}

/** pickReason, plus an open PR already linked to the issue. */
export async function unavailable(rc: RepoConfig, gi: gh.GhIssue & { state?: string }): Promise<string | null> {
  const why = pickReason(rc, gi, await gh.currentUser());
  if (why) return why;
  if (await gh.linkedOpenPrCount(rc.full_name, gi.number) > 0) return 'has an open linked PR';
  return null;
}

async function triage(ctx: Ctx, rc: RepoConfig, issue: Issue): Promise<Issue> {
  const { db } = ctx;
  log(`#${issue.number}: triage`);
  try {
    const r = await runAgent(ctx, {
      agent: 'triage', issueId: issue.id, workdir: mirrorDir(rc.full_name), readOnly: true,
      vars: { ...issueVars(rc, issue) },
    });
    // The score only orders the queue; an issue is dropped only when the agent finds it
    // cannot be done here at all (needs a decision, real infrastructure, facts not in the repo).
    if (!r.feasible) {
      db.update(issue.id, { score: r.score, triage_reason: r.reason });
      const skipped = db.skip(issue.id, `${NOT_FEASIBLE}: ${r.reason}`);
      await handBack(ctx, skipped);
      return skipped;
    }
    return db.transition(issue.id, 'triaged', { score: r.score, triage_reason: r.reason });
  } catch (e) {
    if (e instanceof AgentError) return db.skip(issue.id, (e as Error).message);
    throw e;
  }
}

/** The issue body followed by the maintainer's comments, oldest first. */
export function withMaintainerComments(body: string, comments: { body: string; createdAt: string }[]): string {
  if (!comments.length) return body;
  return `${body.trimEnd()}\n\n${comments.map((c) => `--- maintainer comment (${c.createdAt.slice(0, 10)}):\n${c.body.trim()}`).join('\n\n')}`;
}

/** Takes the repo's pipeline slot. Nothing changes on GitHub: the issue is already assigned. */
async function promote(ctx: Ctx, rc: RepoConfig, issue: Issue): Promise<string | null> {
  // The body as it is now, plus what the maintainer added in comments (sources, decisions).
  const gi = await gh.getIssue(rc.full_name, issue.number);
  const notes = (await gh.issueComments(rc.full_name, issue.number))
    .filter((c) => c.author.toLowerCase() === ctx.cfg.github_user.toLowerCase());
  ctx.db.update(issue.id, { body: withMaintainerComments(gi.body ?? '', notes) });
  ctx.db.transition(issue.id, 'claimed');
  // What happens to it next (PR opened, skipped) is reported on its own; this alone is noise.
  log(`#${issue.number}: picked`);
  return null;
}

/** `run --issue N`: put one issue into the pipeline, skipping discovery. */
async function targetIssue(ctx: Ctx, rc: RepoConfig, number: number, dry: boolean): Promise<string | null> {
  const { db } = ctx;
  let issue = db.issueByNumber(rc.full_name, number);
  if (!issue) {
    const gi = await gh.getIssue(rc.full_name, number);
    const why = await unavailable(rc, gi);
    if (why) return `#${number}: not available (${why})`;
    db.insertDiscovered({ repo: rc.full_name, number, title: gi.title, body: gi.body ?? '', url: gi.url });
    issue = db.issueByNumber(rc.full_name, number)!;
  }
  if (issue.state === 'discovered') issue = await triage(ctx, rc, issue);
  // You picked this issue yourself: earlier verdicts inform, they do not decide.
  if (issue.state === 'skipped') {
    const why = await unavailable(rc, await gh.getIssue(rc.full_name, number));
    if (why) return `#${number}: not available (${why})`;
    log(`#${number}: working on it as asked (skipped earlier: ${issue.skip_reason?.slice(0, 160)})`);
    db.set(`handed-back:${issue.id}`, null);
    issue = db.transition(issue.id, 'triaged', { skip_reason: null, attempts: 0, feedback: null, blocked: null });
  }
  if (issue.blocked) {
    log(`#${number}: retrying as asked (was blocked: ${issue.blocked.slice(0, 160)})`);
    issue = db.update(issue.id, { blocked: null });
  }
  if (issue.state === 'triaged') {
    // A dry issue is worked on without touching GitHub; the PR is not opened at the end.
    if (dry) db.transition(issue.id, 'claimed', { dry: 1 });
    else return promote(ctx, rc, issue);
  }
  return null;
}

// ---------------------------------------------------------------- hand-back

/**
 * The bot could not finish an issue: tell the maintainer once (notification + inbox). Nothing
 * is posted on GitHub; the issue stays assigned and the maintainer decides what happens next.
 */
async function handBack(ctx: Ctx, issue: Issue) {
  const { cfg, db } = ctx;
  if (issue.dry || db.get(`handed-back:${issue.id}`)) return;
  db.set(`handed-back:${issue.id}`, new Date().toISOString());
  const why = (issue.blocked ?? issue.skip_reason ?? 'unknown').replace(/\s+/g, ' ').slice(0, 600);
  await notify(cfg, `maintainer-bot: ${issue.url} stopped: ${why}\n`
    + `Try again: \`maintainer-bot run --repo ${issue.repo} --issue ${issue.number}\`, or unassign it to drop it.`);
}

// ---------------------------------------------------------------- pipeline

function issueVars(rc: RepoConfig, issue: Issue): Record<string, string> {
  return {
    repo: rc.full_name, number: String(issue.number), title: untrusted(issue.title).replace(/"/g, "'"),
    issue_body: untrusted(issue.body || '(empty)'), default_branch: rc.default_branch,
    triage_reason: issue.triage_reason ?? '',
    repo_notes: rc.notes.trim() ? `Project-specific conventions you must follow:\n${rc.notes.trim()}` : '',
    forbidden_paths: rc.forbidden_paths.length ? rc.forbidden_paths.join(', ') : '(none)',
  };
}

async function advance(ctx: Ctx, id: number): Promise<string | null> {
  const { cfg, db } = ctx;
  for (;;) {
    const issue = db.issue(id);
    if (issue.blocked) return `#${issue.number} blocked: ${issue.blocked}`;
    const rc = repoConfig(cfg, issue.repo);
    log(`#${issue.number}: ${issue.state} (attempt ${issue.attempts})`);
    switch (issue.state) {
      case 'claimed': await reproduce(ctx, rc, issue); break;
      case 'reproduced': await code(ctx, rc, issue); break;
      case 'coded': await gate(ctx, rc, issue); break;
      case 'gated': await review(ctx, rc, issue); break;
      case 'reviewed': {
        await writePr(ctx, rc, issue);
        if (issue.dry) return `#${issue.number} ready (dry run: PR not opened; \`show ${id}\` has the diff and the draft)`;
        const pr = await openPr(ctx, id);
        await notify(cfg, `maintainer-bot: PR mở sẵn — ${pr.url} (${issue.repo}#${issue.number} "${db.issue(id).pr_title}")\n`
          + `Merge trên GitHub; \`maintainer-bot show ${id}\` để xem diff.`);
        return `#${issue.number}: PR opened ${pr.url}`;
      }
      case 'skipped': await handBack(ctx, issue); return `#${issue.number} skipped: ${issue.skip_reason}`;
      default: return null;
    }
  }
}

async function exportPatch(cfg: Config, issue: Issue): Promise<string> {
  if (!/^[0-9a-f]{40}$/.test(issue.base_sha ?? '')) throw new Error('missing base sha');
  const dir = agentDir(issue.repo, issue.number);
  // git runs inside the sandbox: the clone's .git is agent-writable, so the host never runs git in it.
  const r = await runInSandbox(cfg, dir,
    `G='git -c core.fsmonitor=false -c core.hooksPath=/dev/null'; $G add -A && $G diff --cached --binary ${issue.base_sha} > ${AGENT_META}/PATCH.diff`, 10);
  if (r.exitCode !== 0) throw new Error(`could not export patch: ${r.output}`);
  return readAgentFile(dir, `${AGENT_META}/PATCH.diff`);
}

async function reproduce(ctx: Ctx, rc: RepoConfig, issue: Issue) {
  const { cfg, db } = ctx;
  const base = await git(mirrorDir(rc.full_name), ['rev-parse', 'HEAD']);
  const dir = await prepareAgentWorkdir(issue.repo, issue.number, base);
  const r = await runAgent(ctx, {
    agent: 'reproducer', issueId: issue.id, workdir: dir,
    vars: {
      ...issueVars(rc, issue), focused_test: rc.focused_test,
      feedback: issue.feedback
        ? `Earlier attempts were rejected. If the feedback below criticises the test, write a better one:\n<feedback>\n${untrusted(issue.feedback)}\n</feedback>`
        : '',
    },
  });
  // The coder and reviewer read this: it often says why a test is impossible (e.g. nothing agreed to build yet).
  writeFileSync(join(issueDir(issue.repo, issue.number), 'REPRO_NOTES.txt'), r.notes);
  if (!r.reproduced || r.testFiles.length === 0 || !safeTestVars(r.testVars)) {
    // Not every issue is a bug a test can show; carry on without a regression test.
    log(`#${issue.number}: no regression test (${r.notes.slice(0, 160)})`);
    await prepareAgentWorkdir(issue.repo, issue.number, base); // drop anything the reproducer left
    rmSync(join(issueDir(issue.repo, issue.number), 'REPRO.diff'), { force: true });
    return db.transition(issue.id, 'reproduced', { base_sha: base, test_files: '[]', test_vars: '{}', test_hashes: '{}' });
  }

  const withBase = db.update(issue.id, {
    base_sha: base, test_files: JSON.stringify(r.testFiles), test_vars: JSON.stringify(repairPathVars(r.testVars, r.testFiles)),
  });
  const reproPatch = await exportPatch(cfg, withBase);
  const files = parsePatch(reproPatch).map((f) => f.path);
  const nonTest = files.filter((f) => !r.testFiles.includes(f));
  if (nonTest.length) return db.skip(issue.id, `reproducer changed non-test files: ${nonTest.join(', ')}`);
  if (!r.testFiles.every((f) => files.includes(f))) return db.skip(issue.id, 'reported test files are not in the diff');
  focusedTestCommand(rc, withBase); // throws on unfilled variables
  writeFileSync(join(issueDir(issue.repo, issue.number), 'REPRO.diff'), reproPatch);
  db.transition(issue.id, 'reproduced', { test_hashes: JSON.stringify(hashTestFiles(withBase)) });
}

function reproNotes(issue: Issue): string {
  const file = join(issueDir(issue.repo, issue.number), 'REPRO_NOTES.txt');
  const notes = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
  return notes ? `\nNotes from the agent that tried to reproduce it:\n<untrusted_notes>\n${untrusted(notes)}\n</untrusted_notes>` : '';
}

function testSection(rc: RepoConfig, issue: Issue): string {
  const files: string[] = JSON.parse(issue.test_files ?? '[]');
  if (!files.length) {
    return 'There is no regression or acceptance test for this issue yet: do what it asks, and add\n'
      + 'tests where the change has behaviour to test.' + reproNotes(issue);
  }
  return `A test that currently fails has already been written (for a feature: it fails because\n`
    + `the code does not exist yet):\n${files.map((f) => `- ${f}`).join('\n')}\n`
    + `Run it with: \`${focusedTestCommand(rc, issue)}\`\n\n`
    + 'Do not change or remove any line of that test: the change is judged by it passing\n'
    + 'unchanged. You may ADD test cases (in the same files or new ones) to cover new\n'
    + 'branches of your change.';
}

async function code(ctx: Ctx, rc: RepoConfig, issue: Issue) {
  const { db } = ctx;
  const feedback = issue.feedback
    ? `Previous attempts were rejected. Address ALL of this feedback, not only the latest:\n<feedback>\n${untrusted(issue.feedback)}\n</feedback>`
    : '';
  const r = await runAgent(ctx, {
    agent: 'coder', issueId: issue.id, workdir: agentDir(issue.repo, issue.number),
    vars: {
      ...issueVars(rc, issue), feedback,
      test_section: testSection(rc, issue),
    },
  });
  // Giving up is a judgement about the issue, not a slip: another paid attempt would read the same.
  // A wrong regression test is the reproducer's to fix, not a reason to drop the issue.
  if (!r.done && r.testWrong && JSON.parse(issue.test_files ?? '[]').length) {
    return retry(ctx, issue, `The coder found the regression test wrong (rewrite it):\n${r.summary}`, 'claimed');
  }
  if (!r.done) return db.skip(issue.id, `coder gave up: ${r.summary}`);
  db.transition(issue.id, 'coded', { summary: r.summary });
}

async function gate(ctx: Ctx, rc: RepoConfig, issue: Issue) {
  const vars = JSON.stringify(repairPathVars(JSON.parse(issue.test_vars ?? '{}'), JSON.parse(issue.test_files ?? '[]')));
  if (vars !== (issue.test_vars ?? '{}')) issue = ctx.db.update(issue.id, { test_vars: vars });
  const patch = await exportPatch(ctx.cfg, issue);
  const g = await runGate(ctx.cfg, rc, issue, patch, log);
  if (!g.ok && g.kind === 'environment') return blockOnEnvironment(ctx, issue, g.step ?? '', g.reason);
  if (!g.ok) return retry(ctx, issue, `CI gate failed: ${g.reason}`);
  // From here on the canonical patch is a host-owned copy outside the agent's tree.
  writeFileSync(join(issueDir(issue.repo, issue.number), 'PATCH.diff'), patch);
  ctx.db.transition(issue.id, 'gated');
}

async function reviewDir(issue: Issue): Promise<string> {
  const patch = readFileSync(join(issueDir(issue.repo, issue.number), 'PATCH.diff'), 'utf8');
  const dir = join(issueDir(issue.repo, issue.number), 'review');
  await freshClone(issue.repo, issue.base_sha!, dir);
  await applyPatch(dir, patch);
  mkdirSync(join(dir, AGENT_META), { recursive: true });
  writeFileSync(join(dir, AGENT_META, 'PATCH.diff'), patch);
  return dir;
}

function reviewTestStatus(issue: Issue): string {
  const files: string[] = JSON.parse(issue.test_files ?? '[]');
  if (!files.length) {
    return 'No test was written before the change (redoTest does not apply; tests the change\n'
      + 'adds are the coder\'s and are judged like the rest of the change).' + reproNotes(issue);
  }
  return `The test written before the change, failing on the base:\n${files.map((f) => `- ${f}`).join('\n')}`;
}

async function review(ctx: Ctx, rc: RepoConfig, issue: Issue) {
  const r = await runAgent(ctx, {
    agent: 'reviewer', issueId: issue.id, workdir: await reviewDir(issue), readOnly: true,
    vars: {
      ...issueVars(rc, issue),
      test_status: reviewTestStatus(issue),
      feedback: issue.feedback
        ? `Earlier rounds sent the change back with this feedback:\n<feedback>\n${untrusted(issue.feedback)}\n</feedback>`
        : '',
    },
  });
  if (r.verdict === 'reject') {
    const reasons = `- ${r.reasons.join('\n- ')}`;
    // Another attempt would read the same: e.g. the issue needs a decision first.
    if (!r.retryable) return ctx.db.skip(issue.id, `Reviewer: no rework can fix this:\n${reasons}`);
    // The coder may not touch the pre-written test, so test complaints go back to the reproducer.
    const redoTest = r.redoTest && JSON.parse(issue.test_files ?? '[]').length > 0;
    return retry(ctx, issue, `Reviewer rejected${redoTest ? ' (the test must be rewritten)' : ''}:\n${reasons}`,
      redoTest ? 'claimed' : 'reproduced');
  }
  ctx.db.transition(issue.id, 'reviewed');
}

/** Conventional Commits check mirroring the repo's PR lint, so a bad title never reaches GitHub. */
export function checkPrTitle(title: string, rc: RepoConfig): string | null {
  const m = /^(\w+)(?:\(([^)]+)\))?!?: \S/.exec(title.trim());
  if (!m) return 'not "type(scope): subject"';
  if (rc.pr_types.length && !rc.pr_types.includes(m[1])) return `type "${m[1]}" not in ${rc.pr_types.join('/')}`;
  if (rc.pr_scopes.length && m[2] && !rc.pr_scopes.includes(m[2])) return `scope "${m[2]}" not in ${rc.pr_scopes.join('/')}`;
  if (title.length > 100) return 'longer than 100 characters';
  return null;
}

async function writePr(ctx: Ctx, rc: RepoConfig, issue: Issue) {
  const dir = await reviewDir(issue);
  let r!: { title: string; body: string };
  let lint = '';
  // A title the repo's PR lint would reject is a wording slip, not a reason to drop reviewed work: ask once more.
  for (let round = 0; round < 2; round++) {
    r = await runAgent(ctx, {
      agent: 'pr-writer', issueId: issue.id, workdir: dir, readOnly: true,
      vars: { ...issueVars(rc, issue), summary: issue.summary ?? '', pr_rules: prRules(rc), feedback: lint },
    });
    const bad = checkPrTitle(r.title, rc);
    if (!bad) break;
    if (round === 1) throw new Error(`PR title "${r.title}" fails the repo's lint: ${bad}`);
    lint = `Your previous title "${r.title}" fails the repository's PR lint: ${bad}. Pick a type and scope from the allowed lists `
      + '(a new skill or package area without its own scope goes under the closest listed one, e.g. "skill").';
  }
  // The disclosure comes from what the runtime reported, never from an agent's own claim.
  const models = ctx.db.modelsForIssue(issue.id);
  const tool = models ? `${rc.agent_disclosure} (model${models.length > 1 ? 's' : ''}: ${models.join(', ')})` : rc.agent_disclosure;
  const body = rc.agent_disclosure
    ? `${r.body.trim()}\n\nAI disclosure: this change was drafted with ${tool}.\n`
    : `${r.body.trim()}\n`;
  ctx.db.update(issue.id, { pr_title: r.title.trim(), pr_body: body });
}

function prRules(rc: RepoConfig): string {
  const rules: string[] = [];
  if (rc.pr_types.length) rules.push(`The title must be a Conventional Commit "type(scope): subject" with type one of: ${rc.pr_types.join(', ')}.`);
  if (rc.pr_scopes.length) rules.push(`Allowed scopes (no others; a new area without its own scope uses the closest one, e.g. "skill"): ${rc.pr_scopes.join(', ')}.`);
  return rules.join('\n');
}

/**
 * A gate step that fails on the unpatched base says nothing about the change: the issue
 * keeps its state and attempts, is left out of `nextIssues` until `repo doctor` clears it,
 * and the human hears about it once.
 */
async function blockOnEnvironment(ctx: Ctx, issue: Issue, step: string, reason: string) {
  const why = `gate broken on base: ${step}`.slice(0, 500);
  ctx.db.update(issue.id, { blocked: why });
  log(`#${issue.number}: blocked (${why})`);
  await notify(ctx.cfg, `maintainer-bot: ${issue.repo} — ${why}\n${tail(reason, 20)}\n`
    + `Nothing wrong with the change; the step fails on the base too. Check the gate: \`maintainer-bot repo doctor ${issue.repo} --fix\``);
  return `#${issue.number} blocked: ${why}`;
}

function retry(ctx: Ctx, issue: Issue, feedback: string, from: 'claimed' | 'reproduced' = 'reproduced') {
  const attempts = issue.attempts + 1;
  if (attempts >= ctx.cfg.limits.max_attempts) {
    return ctx.db.skip(issue.id, `gave up after ${attempts} attempts; last: ${feedback}`);
  }
  log(`#${issue.number}: retry ${attempts}: ${feedback.slice(0, 200)}`);
  // Keep every rejection: a later gate failure must not hide what the reviewer asked for.
  const history = `${issue.feedback ? `${issue.feedback}\n\n` : ''}Attempt ${attempts}:\n${feedback}`;
  return ctx.db.transition(issue.id, from, { attempts, feedback: history.slice(-12_000) });
}

// ---------------------------------------------------------------- opening the PR

/** `feat/17-mcp-expose-lunar-tet` from the PR title's type, the issue number and its title. */
export function branchFor(rc: Pick<RepoConfig, 'branch_prefix' | 'branch_name'>, prTitle: string, number: number, issueTitle: string): string {
  const type = /^(\w+)(?:\([^)]*\))?!?:/.exec(prTitle.trim())?.[1]?.toLowerCase() ?? 'change';
  const slug = issueTitle.toLowerCase().replace(/\[rm-\d+\]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40).replace(/-$/, '');
  return rc.branch_prefix + fillTemplate(rc.branch_name, { type, number: String(number), slug });
}

/**
 * Pushes the gated patch as one signed commit on a branch of the repo itself and opens the
 * PR. When the issue is a roadmap item, a second commit marks it done in the roadmap, so the
 * squash-merge closes the loop. Idempotent: a branch or PR left by an earlier failure is reused.
 */
export async function openPr(ctx: Ctx, id: number): Promise<{ url: string; number: number }> {
  const { cfg, db } = ctx;
  const issue = db.issue(id);
  const rc = repoConfig(cfg, issue.repo);
  if (issue.state !== 'reviewed') throw new Error(`issue is ${issue.state}, not reviewed`);
  if (!issue.pr_title || !issue.pr_body) throw new Error('no PR draft');
  const gi = await gh.getIssue(issue.repo, issue.number);
  if (gi.state !== 'OPEN') throw new Error('the issue has been closed meanwhile');

  const dir = issueDir(issue.repo, issue.number);
  let patch = readFileSync(join(dir, 'PATCH.diff'), 'utf8');
  const fixed = staticChecks(patch, rc);
  if (!fixed.ok) throw new Error(fixed.reason);
  const title = issue.pr_title.trim();
  let body = issue.pr_body;

  // Push from a host-made clone; the agent never had access to this directory.
  const branch = branchFor(rc, title, issue.number, issue.title);
  const push = join(dir, 'push');
  await freshClone(issue.repo, issue.base_sha!, push);
  await git(push, ['checkout', '-b', branch]);
  await applyPatch(push, patch);
  const who = await gh.gitIdentity(signingKey(cfg));
  const closes = new RegExp(`\\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\\s+#${issue.number}\\b`, 'i').test(body);
  if (!closes) body = `${body.trim()}\n\nCloses #${issue.number}\n`;
  await git(push, [...who, 'commit', ...(rc.signoff ? ['--signoff'] : []), '-m', title, '-m', `Closes #${issue.number}`]);
  if (rc.after_commit.length) patch = await afterCommit(cfg, rc, push, issue.base_sha!, who);
  writeFileSync(join(dir, 'PATCH.diff'), patch);
  await git(push, ['remote', 'add', 'fork', `https://github.com/${rc.full_name}.git`]);

  const head = `${repoOwner(rc.full_name)}:${branch}`;
  const existing = await gh.openPrForHead(issue.repo, head);
  const remote = (await git(push, [...who, 'ls-remote', '--heads', 'fork', branch])).split(/\s+/)[0];
  if (!remote) {
    await git(push, [...who, 'push', '-u', 'fork', branch]);
  } else {
    await git(push, [...who, 'fetch', '--quiet', 'fork', branch]);
    const same = (await git(push, ['rev-parse', 'FETCH_HEAD^{tree}'])) === (await git(push, ['rev-parse', 'HEAD^{tree}']));
    if (same) {
      await git(push, ['reset', '--quiet', '--hard', 'FETCH_HEAD']);
    } else {
      if (existing) throw new Error(`${existing.url} already exists with different content; update it by hand`);
      await git(push, [...who, 'push', '-u', `--force-with-lease=${branch}:${remote}`, 'fork', branch]);
    }
  }

  const pr = existing ?? await gh.createPr({ repo: issue.repo, base: rc.default_branch, head, title, body });
  db.insertPr(id, pr.url, pr.number);
  db.transition(id, 'pr_open', { branch });

  // Roadmap bookkeeping rides on the same PR: the maintainer sees it in the diff, nothing else edits the file.
  const rm = rmIdFromTitle(issue.title);
  if (rm && rc.roadmap_file && existsSync(join(push, rc.roadmap_file))) {
    try {
      const text = readFileSync(join(push, rc.roadmap_file), 'utf8');
      writeFileSync(join(push, rc.roadmap_file), markDone(text, rm, pr.number));
      await git(push, ['add', rc.roadmap_file]);
      await git(push, [...who, 'commit', '-q', '-m', `docs(repo): mark ${rm} done (#${pr.number})`]);
      await git(push, [...who, 'push', 'fork', branch]);
      writeFileSync(join(dir, 'PATCH.diff'), `${await git(push, ['diff', '--binary', issue.base_sha!, 'HEAD'])}\n`);
    } catch (e) {
      log(`#${issue.number}: roadmap not updated (${(e as Error).message.split('\n')[0]})`);
    }
  }
  log(`#${issue.number}: opened ${pr.url}`);
  return pr;
}

// ---------------------------------------------------------------- proposals → issues

/** `approve p<id>`: the proposal becomes a GitHub issue and enters the pipeline on the next run. */
export async function approveProposal(ctx: Ctx, id: number, opts: { edit: boolean } = { edit: true }): Promise<string> {
  const { cfg, db } = ctx;
  const p = db.proposal(id);
  if (p.status !== 'pending') throw new Error(`proposal p${id} is ${p.status}`);
  const rc = repoConfig(cfg, p.repo);
  let title = p.title;
  let body = p.body;
  if (opts.edit) {
    const file = join('data', 'proposals', `p${id}.md`);
    mkdirSync(dirname(file), { recursive: true });
    if (!existsSync(file)) writeFileSync(file, `${title}\n\n${body}\n`);
    console.log(`Opening ${file}. The first line is the issue title.`);
    editInEditor(file);
    const [t, ...rest] = readFileSync(file, 'utf8').split('\n');
    title = t.trim();
    body = rest.join('\n').trim();
    if (!title || !body) throw new Error('empty title or body; nothing filed');
  }
  const labels = await labelsFor(rc, JSON.parse(p.labels));
  // Assigned to the maintainer: that is what makes it work for the next run.
  const created = await gh.createIssue(p.repo, { title, body, labels, assignees: [cfg.github_user] });
  db.insertDiscovered({ repo: p.repo, number: created.number, title, body, url: created.url });
  const issue = db.issueByNumber(p.repo, created.number)!;
  // The maintainer just approved it: no triage, straight into the pipeline.
  db.transition(issue.id, 'claimed', { score: 1, triage_reason: p.rationale });
  db.updateProposal(id, { status: 'filed', title, body, issue_number: created.number, issue_id: issue.id });
  return `Opened ${created.url}${labels.length ? ` [${labels.join(', ')}]` : ''}; the next run works on it.`;
}

export function rejectProposal(ctx: Ctx, id: number, reason: string): Proposal {
  const p = ctx.db.proposal(id);
  if (p.status !== 'pending') throw new Error(`proposal p${id} is ${p.status}`);
  return ctx.db.updateProposal(id, { status: 'rejected', reject_reason: reason || null });
}

// ---------------------------------------------------------------- follow-up

async function followUp(ctx: Ctx, issueId: number): Promise<string | null> {
  const { cfg, db } = ctx;
  const issue = db.issue(issueId);
  const pr = db.prForIssue(issueId)!;
  const rc = repoConfig(cfg, issue.repo);

  const snap = await gh.prSnapshot(issue.repo, pr.number);
  db.updatePr(issueId, {
    head_sha: snap.headSha, mergeable: snap.mergeable, merge_state: snap.mergeState, ci_state: snap.ci,
    review_decision: snap.reviewDecision, snapshot_at: new Date().toISOString(),
  });
  if (snap.state !== 'open') {
    db.updatePr(issueId, { state: snap.state });
    db.transition(issueId, snap.state === 'merged' ? 'done' : 'closed');
    if (snap.state === 'merged') {
      await notify(cfg, `🎉 maintainer-bot: ${pr.url} was merged.`);
    } else {
      const last = (await gh.prCommentsSince(issue.repo, pr.number, '1970-01-01T00:00:00Z', rc.review_bots)).slice(-3);
      await notify(cfg, `maintainer-bot: ${pr.url} was CLOSED without being merged.\n\n`
        + (last.map((c) => `@${c.author}: ${c.body.slice(0, 300)}`).join('\n\n') || '(no comments)'));
    }
    return `PR ${pr.url} ${snap.state}`;
  }
  if (!db.get(`issue-closed:${issueId}`)) {
    const gi = await gh.getIssue(issue.repo, issue.number);
    if (gi.state !== 'OPEN') {
      db.set(`issue-closed:${issueId}`, gi.state);
      await notify(cfg, `maintainer-bot: ${issue.url} was closed while ${pr.url} is still open. Check whether the PR is still wanted.`);
    }
  }
  if (issue.blocked) return `PR ${pr.url}: waiting for repo doctor (${issue.blocked})`;
  const pending = db.pendingActionFor(issueId);

  // 1. Conflicts with the base branch: rebase, gate, queue the push for approval.
  if (snap.mergeable === 'CONFLICTING') {
    if (pending) return `PR ${pr.url}: conflicts with ${rc.default_branch}, but a draft is still pending`;
    return prepareRebase(ctx, rc, issue, pr, 'conflict');
  }
  // Behind the base on your own repo: nobody's approval to lose, so rebase as soon as it is mergeable otherwise.
  if (snap.mergeState === 'BEHIND' && !pending && db.get(`behind-drafted:${issueId}`) !== snap.headSha) {
    db.set(`behind-drafted:${issueId}`, snap.headSha);
    return prepareRebase(ctx, rc, issue, pr, 'behind');
  }

  // 2. New review comments, and CI that failed on a commit not looked at yet.
  const comments = await gh.prCommentsSince(issue.repo, pr.number, pr.last_seen_at, rc.review_bots);
  const ciFailed = snap.ci === 'failure' && pr.ci_seen_sha !== snap.headSha;
  if (comments.length === 0 && !ciFailed) return null;
  if (pending) return `PR ${pr.url}: new activity, previous draft still pending`;

  const parts = comments.map((c) => `[${c.kind}] @${c.author}${c.path ? ` on ${c.path}:${c.line}` : ''}:\n${c.body}`);
  if (ciFailed) {
    let failed = await gh.failedCheckDetails(issue.repo, snap.headSha);
    if (!failed.length) {
      failed = snap.checks.filter((c) => !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(c.conclusion))
        .map((c) => ({ name: c.name, summary: `(no details${c.url ? `; ${c.url}` : ''})` }));
    }
    for (const f of failed) parts.push(`[ci] check "${f.name}" failed on the PR's latest commit:\n${f.summary}`);
  }
  const text = parts.join('\n\n');
  const patch = readFileSync(join(issueDir(issue.repo, issue.number), 'PATCH.diff'), 'utf8');
  const dir = await prepareAgentWorkdir(issue.repo, issue.number, issue.base_sha!);
  await applyPatch(dir, patch); // host applies before the agent touches the dir

  const r = await runAgent(ctx, {
    agent: 'followup', issueId, workdir: dir, vars: { ...issueVars(rc, issue), comments: untrusted(text) },
  });
  const seen = () => db.updatePr(issueId, {
    ...(comments.length ? { last_seen_at: comments[comments.length - 1].createdAt } : {}),
    ...(ciFailed ? { ci_seen_sha: snap.headSha } : {}),
  });

  if (r.action === 'wait') { seen(); return null; }
  if (r.action === 'human') {
    seen();
    await notify(cfg, `maintainer-bot: ${pr.url} needs you:\n${r.message.slice(0, 1500)}`);
    return `PR ${pr.url}: needs you (${r.message.split('\n')[0].slice(0, 120)})`;
  }
  if (r.action === 'close') {
    seen();
    await notify(cfg, `maintainer-bot: ${pr.url} — reviewer seems to reject the PR:\n${text.slice(0, 1500)}`);
    return `PR ${pr.url}: looks rejected`;
  }
  let newPatch: string | null = null;
  if (r.action === 'fix') {
    newPatch = await exportPatch(cfg, issue);
    const g = await runGate(cfg, rc, issue, newPatch, log);
    if (!g.ok && g.kind === 'environment') {
      await blockOnEnvironment(ctx, issue, g.step ?? '', g.reason);
      return `PR ${pr.url}: follow-up fix blocked by the environment`;
    }
    if (!g.ok) {
      seen();
      await notify(cfg, `maintainer-bot: ${pr.url} — drafted fix failed the gate (${g.reason.slice(0, 500)}). Handle manually.`);
      return `PR ${pr.url}: follow-up fix failed the gate`;
    }
  }
  seen();
  // A bot (or CI) needs no answer: a fix that only addresses those goes out as a commit alone.
  const botsOnly = comments.every((c) => gh.isBot(c.author));
  if (botsOnly && !newPatch) return null;
  const message = botsOnly
    ? `\n\n${OWN_REPLY}\nOnly bot comments or CI here, so no reply is needed: leave the space above empty to push the\n`
      + `commit without commenting. What the agent changed (for you only, never posted):\n\n${r.message}\n`
    : r.message;
  const actionId = db.addAction(issueId, newPatch ? 'fix' : 'reply', message, newPatch);
  const what = [comments.length ? 'review comments' : '', ciFailed ? 'failed CI' : ''].filter(Boolean).join(' and ');
  await notify(cfg, `maintainer-bot: ${pr.url} has new ${what}. Drafted ${newPatch ? 'a fix and ' : ''}${botsOnly ? 'no reply (bots/CI only)' : 'a reply'}.\n`
    + `Inspect: \`maintainer-bot show a${actionId}\`  Send: \`maintainer-bot ${cmd.followup(actionId)}\``);
  return `PR ${pr.url}: follow-up drafted`;
}

/**
 * The PR no longer merges: re-apply PATCH.diff on today's default branch (git 3-way first, the
 * follow-up agent on a real conflict), run the gate there, and queue a `rebase` action. The
 * push happens only after `approve`. One attempt per base commit.
 */
async function prepareRebase(ctx: Ctx, rc: RepoConfig, issue: Issue, pr: Pr, why: 'conflict' | 'behind'): Promise<string> {
  const { cfg, db } = ctx;
  const newBase = await git(mirrorDir(issue.repo), ['rev-parse', 'HEAD']);
  const key = `rebase-tried:${issue.id}`;
  if (why === 'conflict' && db.get(key) === newBase) return `PR ${pr.url}: conflicts with ${rc.default_branch}; the rebase attempt on this base needs your help`;
  if (why === 'conflict') db.set(key, newBase);
  const dir = issueDir(issue.repo, issue.number);
  const patch = readFileSync(join(dir, 'PATCH.diff'), 'utf8');
  const onNew = { ...issue, base_sha: newBase };
  const work = join(dir, 'rebase');
  await freshClone(issue.repo, newBase, work);
  let newPatch: string;
  let how: string;
  try {
    await applyPatch(work, patch, true);
    newPatch = `${await git(work, ['diff', '--cached', '--binary', 'HEAD'])}\n`;
    how = 'git re-applied it cleanly (3-way)';
  } catch (e) {
    log(`#${issue.number}: rebase conflict, asking the agent`);
    const agentWork = await prepareAgentWorkdir(issue.repo, issue.number, newBase);
    writeFileSync(join(agentWork, AGENT_META, 'PATCH.diff'), patch);
    const r = await runAgent(ctx, {
      agent: 'followup', issueId: issue.id, workdir: agentWork,
      vars: {
        ...issueVars(rc, issue),
        comments: `[system] The PR no longer applies on ${rc.default_branch}: ${String((e as Error).message).slice(0, 500)}\n`
          + `The PR's current diff is in ${workPath(cfg, agentWork)}/${AGENT_META}/PATCH.diff. Re-apply that same change, including its test, onto the code now in ${workPath(cfg, agentWork)}. Choose "fix".`,
      },
    });
    if (r.action !== 'fix') {
      await notify(cfg, `maintainer-bot: ${pr.url} conflicts with ${rc.default_branch} and the agent could not re-apply it:\n${r.message.slice(0, 800)}`);
      return `PR ${pr.url}: rebase needs you`;
    }
    newPatch = await exportPatch(cfg, onNew);
    how = `the agent re-applied it: ${r.message}`;
  }
  const g = await runGate(cfg, rc, onNew, newPatch, log, { rebase: true });
  if (!g.ok && g.kind === 'environment') {
    await blockOnEnvironment(ctx, issue, g.step ?? '', g.reason);
    return `PR ${pr.url}: rebase blocked by the environment`;
  }
  if (!g.ok) {
    await notify(cfg, `maintainer-bot: ${pr.url} — the rebased change fails the gate (${g.reason.slice(0, 600)}). Handle manually.`);
    return `PR ${pr.url}: rebased change fails the gate`;
  }
  const id = db.addAction(issue.id, 'rebase', `Rebase onto ${rc.default_branch} @ ${newBase.slice(0, 10)}: ${how}`, newPatch, newBase);
  await notify(cfg, (why === 'conflict'
    ? `maintainer-bot: ${pr.url} conflicts with ${rc.default_branch}. Rebased and gated; ${how.slice(0, 300)}\n`
    : `maintainer-bot: ${pr.url} is behind ${rc.default_branch}. Rebased and gated.\n`)
    + `Push it: \`maintainer-bot ${cmd.followup(id)}\`  Inspect: \`maintainer-bot show a${id}\``);
  return `PR ${pr.url}: rebase drafted`;
}

// ---------------------------------------------------------------- human-approved actions

export function editInEditor(path: string) {
  // Not `vi`: macOS vi runs Vim in compatible mode, which exits 1 after any error message
  // shown while editing (a mistyped command), even when the file was saved normally.
  const editor = process.env.VISUAL || process.env.EDITOR || 'vim';
  // $EDITOR may carry flags ("code -w"), so it goes through the shell; the path is quoted.
  const r = spawnSync(`${editor} '${path.replace(/'/g, `'\\''`)}'`, { stdio: 'inherit', shell: true });
  if (r.status === 0) return;
  process.stdout.write(`The editor exited with ${r.status}. Use ${path} as saved? [y/N] `);
  if (!/^y/i.test(readTtyLine())) {
    throw new Error(`nothing was posted. Your edits stay in ${path}; run the same command again to continue from them`);
  }
}

/** One line from the terminal, read synchronously (stdin may be a pipe under npm). */
function readTtyLine(): string {
  const fd = openSync('/dev/tty', 'r');
  try {
    const buf = Buffer.alloc(1);
    let line = '';
    while (readSync(fd, buf, 0, 1, null) === 1 && buf[0] !== 10) line += String.fromCharCode(buf[0]);
    return line.trim();
  } finally {
    closeSync(fd);
  }
}

export const stripComments = (text: string) =>
  text.replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n');

/** The SSH signing key from config, with ~ expanded; checked so a typo fails before anything is pushed. */
export function signingKey(cfg: Config): string | undefined {
  const k = cfg.commit_signing_key?.replace(/^~(?=\/)/, homedir());
  if (k && !existsSync(k)) throw new Error(`commit_signing_key ${k} does not exist`);
  return k;
}

/**
 * Runs the repo's `after_commit` commands on the commit just made in `push` and folds what they
 * change into it. They run in the sandbox on a separate full-history clone; the host only reads
 * back a diff (it never runs git in a tree a container wrote to). Returns the PR's full diff.
 */
export async function afterCommit(cfg: Config, rc: RepoConfig, push: string, base: string, who: string[]): Promise<string> {
  if (rc.after_commit.length) {
    log(`after_commit: ${rc.after_commit.join(' && ')}`);
    // Generators that read git dates need the whole history, which the mirror does not keep.
    await git(push, [...who, 'fetch', '-q', '--unshallow', `https://github.com/${rc.full_name}.git`, rc.default_branch]).catch(() => '');
    const gen = join(push, '..', 'after-commit');
    rmSync(gen, { recursive: true, force: true });
    await execa('git', ['-c', 'core.hooksPath=/dev/null', 'clone', '-q', '--no-hardlinks', `file://${resolve(push)}`, gen]);
    mkdirSync(join(gen, AGENT_META), { recursive: true });
    appendFileSync(join(gen, '.git', 'info', 'exclude'), `\n/${AGENT_META}/\n`);
    const r = await runInSandbox(cfg, gen, `git config --global --add safe.directory ${workPath(cfg, gen)}; ${rc.after_commit.join(' && ')} `
      + `&& git -c core.hooksPath=/dev/null add -A && git -c core.hooksPath=/dev/null diff --cached --binary HEAD > ${AGENT_META}/AFTER.diff`);
    if (r.exitCode !== 0) throw new Error(`after_commit failed; nothing pushed:\n${r.output}`);
    const extra = readAgentFile(gen, `${AGENT_META}/AFTER.diff`);
    if (extra.trim()) {
      const fixed = staticChecks(extra, { ...rc, allowed_paths: [] });
      if (!fixed.ok) throw new Error(`after_commit produced a change the gate rejects (${fixed.reason}); nothing pushed`);
      await applyPatch(push, extra);
      await git(push, [...who, 'commit', '-q', '--amend', '--no-edit']);
      log(`after_commit: folded ${parsePatch(extra).map((f) => f.path).join(', ')} into the commit`);
    }
  }
  return `${await git(push, ['diff', '--binary', base, 'HEAD'])}\n`;
}

/** Replaces the PR branch with one commit of the rebased patch; refuses if the branch moved since the bot last pushed it. */
async function approveRebase(ctx: Ctx, action: PendingAction, issue: Issue, pr: Pr) {
  const { cfg, db } = ctx;
  const rc = repoConfig(cfg, issue.repo);
  const fixed = staticChecks(action.patch!, rc);
  if (!fixed.ok) throw new Error(fixed.reason);
  const dir = issueDir(issue.repo, issue.number);
  const push = join(dir, 'push');
  const who = await gh.gitIdentity(signingKey(cfg));
  await freshClone(issue.repo, action.base_sha!, push);
  await git(push, ['checkout', '-q', '-B', issue.branch!]); // freshClone leaves HEAD detached; push needs the branch
  await git(push, ['remote', 'add', 'fork', `https://github.com/${rc.full_name}.git`]);
  await git(push, [...who, 'fetch', '--quiet', '--depth', '50', 'fork', issue.branch!]);
  const remoteSha = await git(push, ['rev-parse', 'FETCH_HEAD']);
  // The branch must still be exactly old base + PATCH.diff: never overwrite someone else's commit.
  await git(push, ['read-tree', '--reset', '-u', issue.base_sha!]);
  await applyPatch(push, readFileSync(join(dir, 'PATCH.diff'), 'utf8'));
  const unknown = await git(push, ['diff', '--cached', '--name-only', 'FETCH_HEAD']);
  if (unknown) {
    throw new Error(`the PR branch has changes the bot did not make (${unknown.split('\n').join(', ')}); `
      + `rebase by hand or run: maintainer-bot reject a${action.id}`);
  }
  await git(push, ['read-tree', '--reset', '-u', action.base_sha!]);
  await applyPatch(push, action.patch!);
  await git(push, [...who, 'commit', ...(rc.signoff ? ['--signoff'] : []), '-m', issue.pr_title ?? `Fix #${issue.number}`, '-m', `Closes #${issue.number}`]);
  const full = await afterCommit(cfg, rc, push, action.base_sha!, who);
  await git(push, [...who, 'push', `--force-with-lease=${issue.branch}:${remoteSha}`, 'fork', `HEAD:refs/heads/${issue.branch}`]);
  writeFileSync(join(dir, 'PATCH.diff'), full);
  db.update(issue.id, { base_sha: action.base_sha });
  db.updatePr(issue.id, { head_sha: await git(push, ['rev-parse', 'HEAD']), mergeable: 'UNKNOWN', ci_state: 'pending' });
  db.setActionStatus(action.id, 'done');
  console.log(`Rebased ${pr.url} onto ${action.base_sha!.slice(0, 10)} and force-pushed ${issue.branch}`);
}

export function followupCommitMessage(dir: string, draftTitle: string | null): string {
  const body = join(dir, 'PR_BODY.md');
  const title = existsSync(body) ? readFileSync(body, 'utf8').split('\n')[0] : draftTitle ?? '';
  const m = /^(\w+(?:\([^)]*\))?)!?:/.exec(title.trim());
  return m ? `${m[1]}: address review feedback` : 'Address review feedback';
}

export async function approveFollowup(ctx: Ctx, actionId: number) {
  const { cfg, db } = ctx;
  const action = db.action(actionId);
  if (action.status !== 'pending') throw new Error(`action is ${action.status}`);
  const issue = db.issue(action.issue_id);
  const pr = db.prForIssue(issue.id)!;
  const dir = issueDir(issue.repo, issue.number);
  if (action.kind === 'rebase') return approveRebase(ctx, action, issue, pr);

  const msgFile = join(dir, `REPLY_${actionId}.md`);
  writeFileSync(msgFile, action.message);
  editInEditor(msgFile);
  let message = readFileSync(msgFile, 'utf8');
  const cut = message.indexOf(OWN_REPLY);
  if (cut >= 0) message = message.slice(0, cut);
  message = message.trim();
  if (!message && !action.patch) throw new Error('empty reply; nothing sent');

  if (action.patch) {
    const rc = repoConfig(cfg, issue.repo);
    const fixed = staticChecks(action.patch, rc);
    if (!fixed.ok) throw new Error(fixed.reason);
    const push = join(dir, 'push');
    const who = await gh.gitIdentity(signingKey(cfg));
    // Build on what is on the branch now, and only if it is exactly the patch we last pushed:
    // a commit made elsewhere (e.g. "Commit suggestion" on GitHub) must not be overwritten.
    await git(push, [...who, 'fetch', '--quiet', 'fork', issue.branch!]);
    await git(push, ['reset', '--quiet', '--hard', 'FETCH_HEAD']);
    await git(push, ['read-tree', '--reset', '-u', issue.base_sha!]);
    await applyPatch(push, readFileSync(join(dir, 'PATCH.diff'), 'utf8'));
    const unknown = await git(push, ['diff', '--cached', '--name-only', 'FETCH_HEAD']);
    await git(push, ['reset', '--quiet', '--hard', 'FETCH_HEAD']);
    if (unknown) {
      throw new Error(`the PR branch has changes the bot did not make (${unknown.split('\n').join(', ')}); `
        + `apply the follow-up by hand or run: maintainer-bot reject a${actionId}`);
    }
    // Reset the tree to base, apply the full new patch: the commit holds exactly the delta.
    await git(push, ['read-tree', '--reset', '-u', issue.base_sha!]);
    await applyPatch(push, action.patch);
    await git(push, [...who, 'commit', ...(rc.signoff ? ['--signoff'] : []), '-m', followupCommitMessage(dir, issue.pr_title)]);
    const full = await afterCommit(cfg, rc, push, issue.base_sha!, who);
    await git(push, [...who, 'push', 'fork', `HEAD:refs/heads/${issue.branch}`]);
    writeFileSync(join(dir, 'PATCH.diff'), full);
  }
  if (message) await gh.commentOnIssue(issue.repo, pr.number, message);
  db.setActionStatus(actionId, 'done');
  console.log(`Follow-up sent on ${pr.url}:${action.patch ? ' commit pushed' : ''}${message ? ' reply posted' : ''}`);
}
