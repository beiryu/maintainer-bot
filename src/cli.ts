#!/usr/bin/env node
import { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runAudit } from './audit.js';
import { loadConfig, repoConfig } from './config.js';
import { doctor } from './doctor.js';
import { addRepo, listRepos, removeRepo } from './onboard.js';
import { refreshSnapshots, renderInbox } from './inbox.js';
import { Db } from './db.js';
import { issueDir } from './git.js';
import { expectUser } from './github.js';
import { approveFollowup, approveProposal, editInEditor, openPr, rejectProposal, runOnce, withLock, type Ctx } from './orchestrator.js';
import { approveDraft } from './outside.js';
import { sourceDigest } from './watch.js';

const program = new Command('maintainer-bot').option('-c, --config <path>', 'config file', 'config.yaml');

function ctx(runId: string | null = null): Ctx {
  const cfg = loadConfig(program.opts().config);
  expectUser(cfg.github_user);
  return { cfg, db: new Db(), runId };
}
const days = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

program.command('run')
  .description('one pass: follow up open PRs, audit (when due), pick up issues labelled for the bot, advance the pipeline, open PRs')
  .option('--dry', 'work on an issue without touching GitHub (no labels, no comments, no PR)')
  .option('--repo <owner/name>')
  .option('--issue <number>', 'work on this issue only (needs --repo)', Number)
  .option('--triage-only', 'score every open issue; no follow-ups, no audit, no code')
  .option('--no-audit', 'skip the audit this run')
  .option('--audit-only', 'only check sources and audit; no follow-ups, no code')
  .action(async (o) => {
    if (o.issue && !o.repo) throw new Error('--issue needs --repo');
    if (o.issue && o.triageOnly) throw new Error('--triage-only scores issues; it does not take --issue');
    const c = ctx(randomUUID());
    await withLock(() => runOnce(c, {
      dry: !!o.dry, repo: o.repo, issue: o.issue, triageOnly: !!o.triageOnly,
      audit: o.auditOnly ? 'only' : o.audit === false ? 'skip' : 'auto',
    }), c.cfg.lock_file);
  });

program.command('audit').description('check upstream sources and run the auditor now; proposals land in the inbox')
  .option('--repo <owner/name>')
  .action(async (o) => {
    const c = ctx(randomUUID());
    await withLock(async () => {
      for (const rc of c.cfg.repos) {
        if (o.repo && rc.full_name !== o.repo) continue;
        const { ensureMirror } = await import('./git.js');
        c.db.upsertRepo(rc.full_name);
        await ensureMirror(rc.full_name, rc.default_branch);
        const digest = await sourceDigest(c, rc, log);
        const added = await runAudit(c, rc, digest, log);
        for (const p of added) console.log(`  p${p.id}  [${p.kind}] ${p.title}`);
      }
      console.log(`\n${renderInbox(c.db, c.cfg)}`);
    }, c.cfg.lock_file);
  });

program.command('watch').description('check upstream sources only (no agents, no cost)')
  .option('--repo <owner/name>')
  .action(async (o) => {
    const c = ctx();
    for (const rc of c.cfg.repos) {
      if (o.repo && rc.full_name !== o.repo) continue;
      const { ensureMirror } = await import('./git.js');
      await ensureMirror(rc.full_name, rc.default_branch);
      const d = await sourceDigest(c, rc, log);
      console.log(d || `${rc.full_name}: no upstream changes`);
    }
  });

program.command('inbox').description('what needs you, how open PRs are doing, what the bot is working on')
  .option('--refresh', 'ask GitHub about every open PR first (no agents, no cost)')
  .action(async (o) => {
    const c = ctx();
    if (o.refresh) await refreshSnapshots(c.db, c.cfg);
    console.log(renderInbox(c.db, c.cfg));
  });

program.command('status').description('issues, PRs, proposals and pending actions')
  .option('--all', 'also show skipped, done and closed issues')
  .action((o) => {
  const { db } = ctx();
  if (db.get('paused')) console.log('** PAUSED **');
  const repos = db.repos();
  console.table(repos.map((r) => ({ repo: r.full_name, status: r.status, scanned: r.last_scanned, audited: db.get(`audited:${r.full_name}`) ?? null })));
  const all = db.allIssues();
  const issues = o.all ? all : all.filter((i) => !['skipped', 'done', 'closed'].includes(i.state));
  if (issues.length < all.length) console.log(`(${all.length - issues.length} skipped/done/closed issues hidden; --all shows them)`);
  const waiting = (i: { state: string }) => ['discovered', 'triaged'].includes(i.state);
  issues.sort((a, b) => Number(waiting(a)) - Number(waiting(b)) || (b.score ?? -1) - (a.score ?? -1));
  console.table(issues.slice(0, 30).map((i) => ({
    id: i.id, issue: `${i.repo}#${i.number}`, state: i.state, score: i.score, tries: i.attempts, dry: i.dry,
    note: (i.blocked ? `BLOCKED: ${i.blocked}` : i.skip_reason ?? i.title).slice(0, 60),
  })));
  const proposals = db.proposals('pending');
  if (proposals.length) console.table(proposals.map((p) => ({ proposal: `p${p.id}`, repo: p.repo, kind: p.kind, title: p.title.slice(0, 60) })));
  const actions = db.pendingActions();
  if (actions.length) console.table(actions.map((a) => ({ action: a.id, issue: a.issue_id, kind: a.kind, at: a.created_at })));
});

const isAction = (id: string) => /^a\d+$/i.test(id);
const isProposal = (id: string) => /^p\d+$/i.test(id);
const isDraft = (id: string) => /^d\d+$/i.test(id);
function showDraft(db: Db, id: number) {
  const d = db.draft(id);
  console.log(`d${d.id}  ${d.target === 'pr' ? 'review of PR' : 'triage of issue'} ${d.repo}#${d.number} by @${d.author}  (${d.status})`);
  console.log(`"${d.title}"\nhttps://github.com/${d.repo}/${d.target === 'pr' ? 'pull' : 'issues'}/${d.number}\n`);
  console.log(`recommendation: ${d.recommendation}`);
  console.log(`labels: +${JSON.parse(d.labels_add).join(', ') || '-'}  -${JSON.parse(d.labels_remove).join(', ') || '-'}${d.take ? '   (bot can take it: approve --take)' : ''}`);
  console.log(`\n--- draft to post\n${d.message}`);
}
const numId = (id: string) => Number(id.slice(1));
function showAction(db: Db, id: number) {
  const a = db.action(id);
  console.log(`${a.kind} for issue ${a.issue_id} (${a.status})\n\n${a.message}`);
  if (a.patch) console.log(`\n--- full new patch${a.base_sha ? ` (on ${a.base_sha.slice(0, 10)})` : ''}\n${a.patch}`);
}
function showProposal(db: Db, id: number) {
  const p = db.proposal(id);
  console.log(`p${p.id}  [${p.kind}] ${p.repo}  (${p.status}${p.issue_number ? `, issue #${p.issue_number}` : ''})\n`);
  console.log(`${p.title}\n\n${p.body}\n`);
  console.log(`labels: ${JSON.parse(p.labels).join(', ') || '(none)'}`);
  if (p.covers_issue || p.covers_rm) console.log(`already covered by: ${[p.covers_issue ? `#${p.covers_issue}` : '', p.covers_rm ?? ''].filter(Boolean).join(', ')}`);
  console.log(`rationale: ${p.rationale}\nevidence: ${JSON.parse(p.evidence).join(', ') || '(none)'}`);
  if (p.reject_reason) console.log(`rejected: ${p.reject_reason}`);
}

program.command('show <id>').description('an issue (triage, diff, PR draft, agent log), p<n> for a proposal, a<n> for a drafted action').action((id) => {
  const { db } = ctx();
  if (isAction(id)) return showAction(db, numId(id));
  if (isProposal(id)) return showProposal(db, numId(id));
  if (isDraft(id)) return showDraft(db, numId(id));
  const i = db.issue(Number(id));
  console.log(`${i.repo}#${i.number} ${i.title}\n${i.url}\nstate: ${i.state}  score: ${i.score}  attempts: ${i.attempts}`);
  if (i.blocked) console.log(`\nBLOCKED: ${i.blocked}`);
  if (i.triage_reason) console.log(`\ntriage: ${i.triage_reason}`);
  if (i.skip_reason) console.log(`\nskipped: ${i.skip_reason}`);
  if (i.summary) console.log(`\ncoder summary:\n${i.summary}`);
  if (i.feedback) console.log(`\nlast feedback to coder:\n${i.feedback}`);
  const patch = join(issueDir(i.repo, i.number), 'PATCH.diff');
  if (existsSync(patch)) console.log(`\n--- PATCH.diff\n${readFileSync(patch, 'utf8')}`);
  if (i.pr_title) console.log(`\n--- PR draft\n${i.pr_title}\n\n${i.pr_body}`);
  const pr = db.prForIssue(i.id);
  if (pr) console.log(`\n--- PR ${pr.url}  ${pr.state}  CI: ${pr.ci_state ?? '?'}  review: ${pr.review_decision ?? '?'}  mergeable: ${pr.mergeable ?? '?'}`);
  for (const a of db.pendingActions().filter((a) => a.issue_id === i.id)) {
    console.log(`\n--- drafted ${a.kind} (approve a${a.id} / reject a${a.id} / show a${a.id})\n${a.message.slice(0, 600)}`);
  }
  console.log('\n--- agent calls (newest first)');
  for (const c of db.lastCalls(i.id)) {
    console.log(`${c.started_at} ${c.agent} ok=${c.ok} $${(c.cost_usd ?? 0).toFixed(3)} ${Math.round(c.duration_ms / 1000)}s`);
    if (!c.ok) console.log(`   ${JSON.parse(c.result_json).error?.slice(0, 400)}`);
  }
});

/** `approve <id>`: p<n> files a proposal as an issue; a<n> sends a drafted reply/fix/rebase; a dry-run issue id opens its PR. */
async function approveAny(c: Ctx, id: string, o: { noEdit?: boolean; take?: boolean; requestChanges?: boolean }) {
  if (isAction(id)) return approveFollowup(c, numId(id));
  if (isDraft(id)) {
    const d = c.db.draft(numId(id));
    if (d.status !== 'pending') throw new Error(`draft d${d.id} is ${d.status}`);
    let message = d.message;
    if (!o.noEdit) {
      const file = join('data', 'drafts', `d${d.id}.md`);
      mkdirSync(join('data', 'drafts'), { recursive: true });
      if (!existsSync(file)) writeFileSync(file, `${d.message}\n`);
      console.log(`Opening ${file}: this is posted as is${d.target === 'pr' ? ' as a review comment' : ''}.`);
      editInEditor(file);
      message = readFileSync(file, 'utf8').trim();
    }
    return console.log(await approveDraft(c, d, message, { take: !!o.take, requestChanges: !!o.requestChanges }));
  }
  if (isProposal(id)) return console.log(await approveProposal(c, numId(id), { edit: !o.noEdit }));
  const i = c.db.issue(Number(id));
  if (i.state === 'reviewed' && i.dry) {
    c.db.update(i.id, { dry: 0 });
    const pr = await openPr(c, i.id);
    return console.log(`Opened ${pr.url}`);
  }
  const a = c.db.pendingActionFor(i.id);
  if (a) return approveFollowup(c, a.id);
  throw new Error(`issue ${id} is ${i.state}${i.blocked ? ` (blocked: ${i.blocked})` : ''}; nothing waits for your approval. \`maintainer-bot inbox\` lists what does.`);
}
program.command('approve <id>').description('p<n>: open the proposed issue; d<n>: post the triage reply / PR review drafted for someone else; a<n>: send a drafted reply/fix/rebase; <id> of a dry-run issue: open its PR')
  .option('--no-edit', 'post as written, without the editor')
  .option('--take', 'd<n> of an issue: also assign it to you, so the next run implements it')
  .option('--request-changes', 'd<n> of a PR: post the review as "request changes" instead of a comment')
  .action((id, o) => approveAny(ctx(), id, { noEdit: o.edit === false, take: !!o.take, requestChanges: !!o.requestChanges }));
program.command('reject <id> [reason...]').description('p<n>: drop a proposal (the reason is shown to the next audit); a<n>: discard a drafted action; <id>: drop an issue')
  .action((id, reason) => {
    const { db } = ctx();
    const why = (reason ?? []).join(' ');
    if (isAction(id)) return db.setActionStatus(numId(id), 'rejected');
    if (isDraft(id)) return db.setDraftStatus(numId(id), 'rejected');
    if (isProposal(id)) { rejectProposal(ctx(), numId(id), why); return; }
    db.skip(Number(id), `rejected by human: ${why || 'no reason'}`);
  });

program.command('take <number>').description('assign an open issue to you, so the next run implements it')
  .option('--repo <owner/name>', 'defaults to the only configured repo')
  .action(async (number, o) => {
    const c = ctx();
    const repo = o.repo ?? (c.cfg.repos.length === 1 ? c.cfg.repos[0].full_name : undefined);
    if (!repo) throw new Error('several repos are configured; pass --repo');
    const { assign } = await import('./github.js');
    await assign(repo, Number(number), c.cfg.github_user);
    const prev = c.db.issueByNumber(repo, Number(number));
    // Taken again after the bot stopped on it: let the next run start over.
    if (prev?.state === 'skipped') { c.db.update(prev.id, { state: 'discovered', skip_reason: null, attempts: 0, feedback: null, blocked: null }); c.db.set(`handed-back:${prev.id}`, null); }
    console.log(`${repo}#${number} assigned to ${c.cfg.github_user}; the next run works on it.`);
  });

program.command('pause').description('stop runs until resume').action(() => ctx().db.set('paused', '1'));
program.command('resume').action(() => ctx().db.set('paused', null));

const repo = program.command('repo').description('add, remove, list and check repositories');
repo.command('add <url>').description('read the repo, draft and test the config, write repos/<owner>__<name>.yaml after you confirm')
  .option('--yes', 'accept the proposal without asking')
  .action(async (url, o) => {
    const c = ctx('onboard');
    console.log(await addRepo(c, url, { configPath: program.opts().config, yes: !!o.yes }));
  });
repo.command('remove <name>').description('delete its config, records without an open PR, and work dirs')
  .option('--yes', 'do not ask')
  .action(async (name, o) => console.log(await removeRepo(ctx(), name, { configPath: program.opts().config, yes: !!o.yes })));
repo.command('list').description('configured repos with their state').action(() => { const c = ctx(); console.log(listRepos(c.cfg, c.db)); });
repo.command('pause <name>', { hidden: true }).action((name) => { const { db } = ctx(); db.upsertRepo(name); db.setRepoStatus(name, 'paused'); });
repo.command('resume <name>', { hidden: true }).action((name) => { const { db } = ctx(); db.upsertRepo(name); db.setRepoStatus(name, 'active'); });
repo.command('doctor <name>')
  .description('run the gate on the unpatched base; --fix lets an agent propose one that works here')
  .option('--fix', 'ask an agent for a working gate and write it to repos/<owner>__<name>.yaml after you confirm')
  .option('--yes', 'write the proposal without asking (for scripts)')
  .action(async (name, o) => {
    const c = ctx();
    console.log(await doctor(c, repoConfig(c.cfg, name), { fix: !!o.fix, yes: !!o.yes, configPath: program.opts().config }));
  });
program.command('cost').description('spend by agent over the last 7 and 30 days').action(() => {
  const { db } = ctx();
  for (const d of [7, 30]) {
    console.log(`\nlast ${d} days: $${db.costSince(days(d)).toFixed(2)}`);
    console.table(db.costByAgent(days(d)));
  }
});

program.parseAsync().catch((e) => {
  console.error(`error: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
