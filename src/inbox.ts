import type { Config } from './config.js';
import { ACTIVE_STATES, type Db } from './db.js';
import * as gh from './github.js';

// One screen for the human: what needs a decision, how every open PR is doing, what the bot
// is working on. Reads the DB only; `refreshSnapshots` is the one call that talks to GitHub.

const ago = (iso: string | null) => {
  if (!iso) return '?';
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};
const short = (repo: string) => repo.split('/')[1];
const pad = (s: string, n: number) => s.padEnd(n);

/** The command the human types for each pending decision. One place to change when the CLI does. */
export const cmd = {
  proposal: (id: number) => `approve p${id}`,
  draft: (id: number) => `approve d${id}`,
  pr: (id: number) => `approve ${id}`,
  followup: (id: number) => `approve a${id}`,
  doctor: (repo: string) => `repo doctor ${repo} --fix`,
};

/** Lines for the "needs you" block; empty when nothing waits on the human. */
export function needsYou(db: Db, cfg: Config): string[] {
  const out: string[] = [];
  for (const p of db.proposals('pending')) {
    const covered = p.covers_issue || p.covers_rm
      ? `  (đã có: ${[p.covers_issue ? `#${p.covers_issue}` : '', p.covers_rm ?? ''].filter(Boolean).join(', ')})` : '';
    out.push(`  ${pad(cmd.proposal(p.id), 14)} ${pad(`[${p.kind}]`, 13)} ${short(p.repo)}  "${p.title.slice(0, 60)}"${covered}  (${ago(p.created_at)})`
      + (p.rationale ? `\n${' '.repeat(29)}${p.rationale.slice(0, 110)}` : ''));
  }
  for (const d of db.drafts('pending')) {
    const what = d.target === 'pr' ? `PR #${d.number}` : `#${d.number}`;
    out.push(`  ${pad(cmd.draft(d.id), 14)} ${pad(d.target === 'pr' ? 'review' : 'triage', 13)} ${short(d.repo)} ${what} @${d.author}  "${d.title.slice(0, 45)}"  (${ago(d.created_at)})`
      + `\n${' '.repeat(29)}→ ${d.recommendation.split('\n')[0].slice(0, 100)}${d.take ? '  (thêm --take để bot làm)' : ''}`);
  }
  for (const i of db.allIssues().filter((i) => i.state === 'reviewed' && i.dry)) {
    out.push(`  ${pad(cmd.pr(i.id), 14)} ${pad('PR (dry)', 13)} ${short(i.repo)}#${i.number}  "${(i.pr_title ?? i.title).slice(0, 50)}"  (${ago(i.updated_at)})`);
  }
  for (const a of db.pendingActions()) {
    const i = db.issue(a.issue_id);
    const pr = db.prForIssue(i.id);
    const gist = a.kind === 'rebase' ? a.message.split('\n')[0] : a.kind === 'fix' ? 'fix for review comments' : 'reply to review comments';
    out.push(`  ${pad(cmd.followup(a.id), 14)} ${pad(a.kind, 13)} ${short(i.repo)}#${pr?.number ?? i.number}  ${gist.slice(0, 60)}  (${ago(a.created_at)})`);
  }
  const blockedRepos = new Map<string, string>();
  for (const i of db.blockedIssues()) if (!blockedRepos.has(i.repo)) blockedRepos.set(i.repo, i.blocked!);
  for (const [repo, why] of blockedRepos) out.push(`  ⚠ ${short(repo)}: ${why.slice(0, 70)}  → ${cmd.doctor(repo)}`);
  return out;
}

export function renderInbox(db: Db, cfg: Config): string {
  const sections: string[] = [];
  if (db.get('paused')) sections.push('** PAUSED ** (maintainer-bot resume)');

  const todo = needsYou(db, cfg);
  sections.push(`CẦN BẠN${todo.length ? '   (gõ: npm run -s maintainer-bot -- <lệnh>)' : ''}\n${todo.join('\n') || '  (không có)'}`);

  const prs = db.openPrsWithIssue();
  const prLines = prs.map((p) => {
    const ci = p.ci_state === 'success' ? 'CI ✓' : p.ci_state === 'failure' ? 'CI ✗' : p.ci_state === 'pending' ? 'CI …'
      : p.ci_state === 'awaiting_approval' ? 'CI ⏸' : p.ci_state ? 'CI –' : 'CI ?';
    const extra = [
      p.mergeable === 'CONFLICTING' ? 'CONFLICT' : p.merge_state === 'BEHIND' ? 'tụt sau base' : '',
      p.review_decision === 'CHANGES_REQUESTED' ? 'CHANGES REQUESTED' : '',
      p.blocked ? 'gate hỏng' : '',
    ].filter(Boolean).join('  ');
    return `  ${pad(`${short(p.repo)}#${p.number}`, 22)} ${pad(ago(p.opened_at), 4)} ${pad(ci, 5)} ${pad('chờ bạn merge', 16)} ${extra}`.trimEnd()
      + `  (cập nhật ${ago(p.snapshot_at)} trước)`;
  });
  sections.push(`PR ĐANG MỞ\n${prLines.join('\n') || '  (không có)'}`);

  const working = db.allIssues().filter((i) => (ACTIVE_STATES as string[]).includes(i.state));
  const workLines = working.map((i) => {
    const note = i.blocked ? `BLOCKED: ${i.blocked.slice(0, 60)}` : `${i.state} (attempt ${i.attempts})${i.dry ? '  [dry]' : ''}`;
    return `  ${pad(`${short(i.repo)}#${i.number}`, 22)} ${note}  ${i.title.slice(0, 50)}`;
  });
  sections.push(`ĐANG LÀM\n${workLines.join('\n') || '  (không có)'}`);

  // Scored and waiting for their repo's slot; the best per repo is taken first.
  const queued = db.allIssues().filter((i) => i.state === 'triaged').sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const queueLines = queued.slice(0, 12).map((i) => {
    const full = db.inFlightCount(i.repo) >= cfg.limits.max_in_flight_per_repo ? `  (chờ: repo đã có ${cfg.limits.max_in_flight_per_repo} issue đang làm)` : '';
    return `  ${pad(`${short(i.repo)}#${i.number}`, 22)} ${(i.score ?? 0).toFixed(2)}  ${i.title.slice(0, 50)}${full}`;
  });
  if (queued.length > queueLines.length) queueLines.push(`  … và ${queued.length - queueLines.length} issue khác (status --all)`);
  sections.push(`HÀNG CHỜ\n${queueLines.join('\n') || '  (không có)'}`);

  const src = cfg.repos.flatMap((rc) => db.sources(rc.full_name).filter((s) => s.digest));
  if (src.length) {
    sections.push(`NGUỒN DỮ LIỆU ĐỔI\n${src.map((s) => `  ${pad(`${short(s.repo)}/${s.name}`, 30)} ${s.digest!.split('\n')[0].slice(0, 90)}  (${ago(s.checked_at)})`).join('\n')}`);
  }
  return sections.join('\n\n');
}

/** Re-reads every open PR from GitHub. No agents, no cost. */
export async function refreshSnapshots(db: Db, cfg: Config) {
  void cfg;
  for (const p of db.openPrsWithIssue()) {
    const s = await gh.prSnapshot(p.repo, p.number);
    db.updatePr(p.issue_id, {
      head_sha: s.headSha, mergeable: s.mergeable, merge_state: s.mergeState, ci_state: s.ci, review_decision: s.reviewDecision,
      snapshot_at: new Date().toISOString(), ...(s.state !== 'open' ? { state: s.state } : {}),
    });
    if (s.state !== 'open') db.transition(p.issue_id, s.state === 'merged' ? 'done' : 'closed');
  }
}
