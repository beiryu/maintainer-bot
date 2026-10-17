import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runAgent } from './agent.js';
import { repoLabels } from './audit.js';
import type { RepoConfig } from './config.js';
import type { Draft } from './db.js';
import { AGENT_META, freshClone, git, mirrorDir, slug } from './git.js';
import * as gh from './github.js';
import { notify } from './notify.js';
import type { Ctx } from './orchestrator.js';
import { runInSandbox, tail } from './sandbox.js';

// Issues and PRs opened by other people. The bot drafts what the maintainer would post (a
// triage reply with labels, a PR review with a recommendation); nothing reaches GitHub until
// `approve d<n>`. Their issues are not worked on until the maintainer takes them.

const untrusted = (s: string) => s.replace(/<\/?untrusted/gi, '&lt;untrusted').slice(0, 20_000);

/** Someone else's: not the maintainer, and not the maintainer's own automation. */
export function isOutsider(author: string | undefined, me: string): boolean {
  return !!author && author.toLowerCase() !== me.toLowerCase();
}

async function ciLine(repo: string, n: number): Promise<string> {
  try {
    const s = await gh.prSnapshot(repo, n);
    const bad = s.checks.filter((c) => !['SUCCESS', 'NEUTRAL', 'SKIPPED', 'PENDING'].includes(c.conclusion)).map((c) => `${c.name}=${c.conclusion}`);
    return `${s.ci}${bad.length ? ` (${bad.join(', ')})` : ''}`;
  } catch { return 'unknown'; }
}

/** New issues from other people → one triage draft each. Seen once per issue. */
export async function triageOutsideIssues(ctx: Ctx, rc: RepoConfig, log: (m: string) => void): Promise<string[]> {
  const { cfg, db } = ctx;
  const me = await gh.currentUser();
  const issues = await gh.listOpenIssues(rc.full_name, [], 200);
  const fresh = issues.filter((i) => isOutsider(i.author?.login, me) && !db.get(`outside-issue:${rc.full_name}#${i.number}`))
    .slice(0, cfg.limits.max_triage_per_run);
  const labels = (await repoLabels(rc.full_name)).join(', ');
  const others = issues.map((i) => `#${i.number} ${i.title}`).join('\n');
  const events: string[] = [];
  for (const i of fresh) {
    log(`${rc.full_name}#${i.number}: triage (opened by @${i.author!.login})`);
    const comments = await gh.issueComments(rc.full_name, i.number);
    const r = await runAgent(ctx, {
      agent: 'maintainer-triage', issueId: null, workdir: mirrorDir(rc.full_name), readOnly: true,
      vars: {
        repo: rc.full_name, default_branch: rc.default_branch, number: String(i.number), author: i.author!.login,
        title: untrusted(i.title).replace(/"/g, "'"), issue_body: untrusted(i.body || '(empty)'),
        comments: untrusted(comments.map((c) => `@${c.author}: ${c.body}`).join('\n\n')) || '(none)',
        labels, open_issues: untrusted(others),
        repo_notes: rc.notes.trim() ? `Project conventions:\n${rc.notes.trim()}` : '',
      },
    });
    const id = db.addDraft({
      repo: rc.full_name, target: 'issue', number: i.number, title: i.title, author: i.author!.login, head_sha: null,
      message: r.reply, labels_add: JSON.stringify(r.labels_add), labels_remove: JSON.stringify(r.labels_remove),
      recommendation: r.recommendation + (r.duplicate_of ? ` #${r.duplicate_of}` : '') + (r.reason ? `: ${r.reason}` : ''),
      take: r.take ? 1 : 0,
    });
    db.set(`outside-issue:${rc.full_name}#${i.number}`, new Date().toISOString());
    await notify(cfg, `maintainer-bot: ${i.url} by @${i.author!.login} — ${r.recommendation}${r.take ? ' (bot can take it)' : ''}.\n`
      + `Inspect: \`maintainer-bot show d${id}\`  Send: \`maintainer-bot approve d${id}${r.take ? ' --take' : ''}\``);
    events.push(`${rc.full_name}#${i.number}: triage drafted (d${id}, ${r.recommendation})`);
  }
  return events;
}

/** Fetches a PR's head into a fresh clone; returns the dir and the diff against the base. */
async function checkoutPr(rc: RepoConfig, n: number, headSha: string): Promise<{ dir: string; diff: string }> {
  const mirror = mirrorDir(rc.full_name);
  await git(mirror, ['fetch', '-q', '--depth', '100', 'origin', `+refs/pull/${n}/head:refs/pr/${n}`, rc.default_branch]);
  const dir = join('work', slug(rc.full_name), `pr-${n}`);
  await freshClone(rc.full_name, headSha, dir);
  const base = await git(mirror, ['merge-base', `refs/pr/${n}`, `origin/${rc.default_branch}`]).catch(() => `origin/${rc.default_branch}`);
  const diff = await git(mirror, ['diff', base, headSha]);
  mkdirSync(join(dir, AGENT_META), { recursive: true });
  writeFileSync(join(dir, AGENT_META, 'PR.diff'), diff);
  return { dir, diff };
}

/** Open PRs from other people, once per head commit → gate in the sandbox → review draft. */
export async function reviewOutsidePrs(ctx: Ctx, rc: RepoConfig, log: (m: string) => void): Promise<string[]> {
  const { cfg, db } = ctx;
  const me = await gh.currentUser();
  const prs = (await gh.listOpenPrs(rc.full_name)).filter((p) => isOutsider(p.author, me) && !p.isDraft
    && db.get(`outside-pr:${rc.full_name}#${p.number}`) !== p.headSha && !db.pendingDraftFor(rc.full_name, 'pr', p.number));
  const labels = (await repoLabels(rc.full_name)).join(', ');
  const events: string[] = [];
  for (const p of prs.slice(0, cfg.limits.max_triage_per_run)) {
    log(`${rc.full_name} PR #${p.number}: review (by @${p.author})`);
    const { dir } = await checkoutPr(rc, p.number, p.headSha);
    // The PR's own code runs here: the sandbox has no credentials and the clone is throwaway.
    const steps: string[] = [];
    for (const cmd of rc.gate) {
      const r = await runInSandbox(cfg, dir, cmd);
      steps.push(`${r.exitCode === 0 ? '[ok]  ' : '[FAIL]'} ${cmd}${r.exitCode === 0 ? '' : `\n${tail(r.output, 15)}`}`);
      if (r.exitCode !== 0) break;
    }
    const linked = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/i.exec(p.body)?.[1];
    let linkedText = '(none)';
    if (linked) {
      try { const li = await gh.getIssue(rc.full_name, Number(linked)); linkedText = `#${li.number} ${li.title}\n${li.body ?? ''}`; } catch { /* keep none */ }
    }
    const r = await runAgent(ctx, {
      agent: 'pr-reviewer', issueId: null, workdir: dir, readOnly: true,
      vars: {
        repo: rc.full_name, default_branch: rc.default_branch, number: String(p.number), author: p.author,
        title: untrusted(p.title).replace(/"/g, "'"), pr_body: untrusted(p.body || '(empty)'),
        linked_issue: untrusted(linkedText), gate: steps.join('\n') || '(no gate configured)', ci: await ciLine(rc.full_name, p.number),
        labels, repo_notes: rc.notes.trim() ? `Project conventions:\n${rc.notes.trim()}` : '',
      },
    });
    const findings = r.findings.map((f) => `- ${f.path}${f.line ? `:${f.line}` : ''} — ${f.text}`).join('\n');
    const id = db.addDraft({
      repo: rc.full_name, target: 'pr', number: p.number, title: p.title, author: p.author, head_sha: p.headSha,
      message: r.reply, labels_add: JSON.stringify(r.labels_add), labels_remove: '[]',
      recommendation: `${r.recommendation}: ${r.summary}${findings ? `\n${findings}` : ''}`, take: 0,
    });
    db.set(`outside-pr:${rc.full_name}#${p.number}`, p.headSha);
    await notify(cfg, `maintainer-bot: ${p.url} by @${p.author} — recommend ${r.recommendation}. ${r.summary.slice(0, 300)}\n`
      + `Inspect: \`maintainer-bot show d${id}\`  Post review: \`maintainer-bot approve d${id}\``);
    events.push(`${rc.full_name} PR #${p.number}: review drafted (d${id}, ${r.recommendation})`);
  }
  return events;
}

/**
 * `approve d<n>`: posts the (edited) reply. Issue: comment + labels, and with `take` the
 * repo's ready label so the pipeline picks it up. PR: a review that comments or requests
 * changes, never an approval.
 */
export async function approveDraft(ctx: Ctx, d: Draft, message: string, opts: { take: boolean; requestChanges: boolean }) {
  const { cfg, db } = ctx;
  const rc = cfg.repos.find((r) => r.full_name === d.repo);
  if (!rc) throw new Error(`${d.repo} is not configured`);
  const existing = new Set(await repoLabels(d.repo));
  const add = [...JSON.parse(d.labels_add) as string[], ...(opts.take && rc.labels_lifecycle.ready ? [rc.labels_lifecycle.ready] : [])]
    .filter((l) => existing.has(l));
  const remove = (JSON.parse(d.labels_remove) as string[]).filter((l) => existing.has(l));
  if (d.target === 'issue') {
    if (message) await gh.commentOnIssue(d.repo, d.number, message);
  } else {
    if (!message) throw new Error('empty review; nothing posted');
    await gh.prReview(d.repo, d.number, message, opts.requestChanges ? 'request-changes' : 'comment');
  }
  await gh.removeLabels(d.repo, d.number, remove).catch(() => undefined);
  await gh.addLabels(d.repo, d.number, add).catch(() => undefined);
  db.setDraftStatus(d.id, 'done');
  return `${d.target === 'issue' ? 'Commented on' : opts.requestChanges ? 'Requested changes on' : 'Reviewed'} ${d.repo}#${d.number}`
    + `${add.length ? ` [+${add.join(', ')}]` : ''}${opts.take ? '; the next run works on it' : ''}`;
}
