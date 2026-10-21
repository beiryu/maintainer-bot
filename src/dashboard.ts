import type { Config } from './config.js';
import { ACTIVE_STATES, type Db } from './db.js';
import { replyText } from './orchestrator.js';

// The inbox as a pinned GitHub issue, for a bot that runs on GitHub Actions. The bot alone
// writes it (its edits start no run); the maintainer decides by commenting /approve, /reject
// and the rest, and the bot answers each comment with what it did and the run log.

export const DASHBOARD_MARK = '<!-- maintainer-bot:dashboard -->';
/** Marks whose dashboard an issue is, so one private desk repo can hold the dashboards of many repos. */
export const repoMark = (repo: string) => `<!-- maintainer-bot:repo ${repo} -->`;
export const dashboardTitle = (repo: string, desk: string) => (desk === repo ? 'Maintainer Dashboard' : repo);

export type Command =
  | { cmd: 'approve'; id: string; flag?: 'take' | 'changes' }
  | { cmd: 'reject'; id: string; reason: string }
  | { cmd: 'retry'; number: number }
  | { cmd: 'take'; number: number };

/**
 * Commands, one per line, anywhere in a comment. Short forms for typing on a phone:
 * `/a p3 p4 a1` (several ids; `--take`/`--changes` apply to all of them), `/a all`,
 * `/r p5 reason`, plus `/approve`, `/reject`, `/retry #14`, `/take 12`.
 */
export function parseCommands(comment: string): Command[] {
  const out: Command[] = [];
  for (const line of comment.split('\n')) {
    const ap = /^\s*\/(?:a|approve)\s+(.+?)\s*$/i.exec(line);
    if (ap) {
      const words = ap[1].toLowerCase().split(/[\s,]+/);
      // An unknown option means a typo: better to do nothing than the wrong thing.
      if (words.some((w) => w.startsWith('--') && !/^--(take|changes|request-changes)$/.test(w))) continue;
      const f = words.find((w) => /^--(take|changes|request-changes)$/.test(w));
      const flag = f ? { flag: f === '--take' ? 'take' : 'changes' } as const : {};
      if (words.includes('all')) { out.push({ cmd: 'approve', id: 'all', ...flag }); continue; }
      for (const id of words.filter((w) => /^[pad]\d+$/.test(w))) out.push({ cmd: 'approve', id, ...flag });
      continue;
    }
    let m = /^\s*\/(?:r|reject)\s+((?:[pad]\d+[\s,]*)+)(.*)$/i.exec(line);
    if (m) {
      for (const id of m[1].toLowerCase().split(/[\s,]+/).filter(Boolean)) out.push({ cmd: 'reject', id, reason: m[2].trim() });
      continue;
    }
    m = /^\s*\/(retry|take)\s+#?(\d+)\s*$/i.exec(line);
    if (m) out.push({ cmd: m[1].toLowerCase() as 'retry' | 'take', number: Number(m[2]) });
  }
  return out;
}
// Text from agents, issues and PRs is untrusted: it must not be able to write a marker the parser would read.
const safe = (s: string) => s.replace(/<!--/g, '<!- -');
const esc = (s: string) => safe(s).replace(/\r?\n/g, ' ').trim();
// Headings inside a fold would render as big as the dashboard's own; bold lines read better there.
const demote = (s: string) => s.replace(/^#{1,6}\s+(.+?)\s*#*$/gm, '**$1**');
// Inside a list item every line must be indented, or the item ends and the fold renders empty.
const details = (summary: string, body: string) => {
  const inner = demote(safe(body)).trim().split('\n').map((l) => (l ? `  ${l}` : '')).join('\n');
  return `\n  <details><summary>${summary}</summary>\n\n${inner}\n\n  </details>\n`;
};
const quote = (s: string) => safe(s).trim().split('\n').map((l) => `> ${l}`).join('\n');
const diffLines = (patch: string) => patch.split('\n').filter((l) => /^[-+](?![-+]{2})/.test(l)).length;

export interface DashboardInfo {
  repo: string;
  runUrl?: string;
  monthCostUsd?: number;
  monthLimitUsd?: number;
  tokenExpiry?: string | null;
  notes?: string[];            // one-off lines for this render (an approval that failed, ...)
  now?: number;
}

/** A decision waiting for the maintainer: one line, its details, and whether 🚀 means something. */
export interface PendingItem { id: string; line: string; detail: string; rocket: string | null }

/** Every pending decision of a repo, in dashboard order. Pure. */
export function pendingItems(db: Db, repo: string): PendingItem[] {
  const iss = (n: number) => `[#${n}](https://github.com/${repo}/issues/${n})`;
  const pr = (n: number) => `[#${n}](https://github.com/${repo}/pull/${n})`;
  const out: PendingItem[] = [];
  for (const p of db.proposals('pending', repo)) {
    const tracked = p.covers_issue ? ` (tracked: ${iss(p.covers_issue)})` : p.covers_rm ? ` (${p.covers_rm})` : '';
    out.push({ id: `p${p.id}`, line: `**p${p.id}** new issue: ${esc(p.title)}${tracked}`,
      detail: details('details', `${p.rationale ? `${p.rationale}\n\n` : ''}${p.body}`), rocket: null });
  }
  for (const a of db.pendingActions()) {
    const i = db.issue(a.issue_id);
    if (i.repo !== repo) continue;
    const n = db.prForIssue(i.id)?.number ?? 0;
    const reply = replyText(a.message);
    const what = a.kind === 'rebase' ? 'rebase' : a.kind === 'fix' ? (reply ? 'fix + reply' : 'fix') : 'reply';
    const parts = [reply ? quote(reply) : '', a.patch ? `\`\`\`diff\n${a.patch.slice(0, 6000)}${a.patch.length > 6000 ? '\n…' : ''}\n\`\`\`` : ''].filter(Boolean);
    out.push({ id: `a${a.id}`, line: `**a${a.id}** ${what} on ${pr(n)}`,
      detail: parts.length ? details(a.patch ? `diff, ${diffLines(a.patch)} lines` : 'reply', parts.join('\n\n')) : '', rocket: null });
  }
  for (const d of db.drafts('pending').filter((d) => d.repo === repo)) {
    out.push({ id: `d${d.id}`, line: `**d${d.id}** ${d.target === 'pr' ? 'review' : 'reply'} ${d.target === 'pr' ? pr(d.number) : iss(d.number)} @${d.author}`,
      detail: details(esc(d.recommendation.split('\n')[0]).slice(0, 100), quote(d.message)),
      rocket: d.target === 'pr' ? 'post as "request changes"' : d.take ? 'also assign it to you so it gets implemented' : null });
  }
  return out;
}

/** The comment that stands for one pending item: react on it to decide. */
export function itemComment(it: PendingItem): string {
  const keys = `👍 approve · 👎 reject${it.rocket ? ` · 🚀 approve and ${it.rocket}` : ''}`;
  return `${itemMark(it.id)}\n${it.line}\n\n${keys}\n${it.detail}`;
}
export const itemMark = (id: string) => `<!-- maintainer-bot:item ${id} -->`;

/** The dashboard body for one repo. Pure: reads the state only. One line per item; long text folded. */
export function renderDashboard(db: Db, cfg: Config, info: DashboardInfo): string {
  void cfg;
  const now = info.now ?? Date.now();
  const repo = info.repo;
  const iss = (n: number) => `[#${n}](https://github.com/${repo}/issues/${n})`;
  const pr = (n: number) => `[#${n}](https://github.com/${repo}/pull/${n})`;
  const cost = `$${(info.monthCostUsd ?? 0).toFixed(2)}${info.monthLimitUsd ? `/$${info.monthLimitUsd.toFixed(0)}` : ''}`;
  const L: string[] = [
    DASHBOARD_MARK, repoMark(repo), '',
    `_Updated ${new Date(now).toISOString().replace('T', ' ').slice(0, 16)} UTC${info.runUrl ? ` · [log](${info.runUrl})` : ''} · ${cost} this month_`, '',
  ];
  if (db.get('paused')) L.push('> ⏸ Paused — `/resume`', '');
  for (const n of info.notes ?? []) L.push(`> ${esc(n)}`, '');
  if (info.tokenExpiry) {
    const days = Math.round((new Date(info.tokenExpiry).getTime() - now) / 86_400_000);
    if (days <= 21) L.push(`> ⚠️ MAINTAINER_TOKEN ${days <= 0 ? 'has expired' : `expires in ${days} days`}`, '');
  }

  const todo: string[] = pendingItems(db, repo).map((it) => `- ${it.line}`);
  for (const i of db.issuesInState('skipped').filter((i) => i.repo === repo && db.get(`handed-back:${i.id}`) && !i.skip_reason?.startsWith('rejected by human'))) {
    todo.push(`- ${iss(i.number)} stopped: ${esc((i.skip_reason ?? '').slice(0, 140))} → \`/retry #${i.number}\``);
  }
  const blocked = db.blockedIssues(repo);
  if (blocked.length) todo.push(`- gate broken on base: ${esc(blocked[0].blocked!)}`);
  L.push('### To decide', '', ...(todo.length ? ['React on the comments below: 👍 approve · 👎 reject · 🚀 approve with the variant shown.', '', ...todo] : ['_Nothing._']), '');

  const prs = db.openPrsWithIssue().filter((p) => p.repo === repo);
  if (prs.length) {
    L.push('### Open PRs', '');
    for (const p of prs) {
      const ci = p.ci_state === 'success' ? '✅' : p.ci_state === 'failure' ? '❌' : p.ci_state === 'pending' ? '⏳' : '·';
      const extra = p.mergeable === 'CONFLICTING' ? ' · conflict' : p.review_decision === 'CHANGES_REQUESTED' ? ' · changes requested' : '';
      L.push(`- ${pr(p.number)} ${ci} ${esc(p.pr_title ?? p.title)}${extra}`);
    }
    L.push('');
  }
  const working = db.allIssues().filter((i) => i.repo === repo && (ACTIVE_STATES as string[]).includes(i.state));
  const queued = db.allIssues().filter((i) => i.repo === repo && i.state === 'triaged');
  if (working.length || queued.length) {
    L.push('### Working on', '');
    for (const i of working) L.push(`- ${iss(i.number)} ${esc(i.title)} · ${i.blocked ? 'blocked' : i.state}`);
    for (const i of queued.slice(0, 10)) L.push(`- ${iss(i.number)} ${esc(i.title)} · queued`);
    L.push('');
  }
  const src = db.sources(repo).filter((s) => s.digest);
  if (src.length) {
    L.push('### Upstream changed', '');
    for (const s of src) L.push(`- **${s.name}**: ${esc(s.digest!.split('\n')[0])}`);
    L.push('');
  }
  L.push('---', '`/a p3 p4` · `/a all` · `/r p5 why` · `/retry #N` · `/take N` · `/pause` · `/resume`');
  return L.join('\n');
}

/**
 * True when the dashboard body changed in a way worth an edit: everything but the timestamp
 * and the relative times. (Each edit is an event that starts a run, which renders again: an
 * edit for "2 min ago" becoming "3 min ago" would never stop.)
 */
export function dashboardChanged(before: string, after: string): boolean {
  const strip = (s: string) => s
    .replace(/_Updated [^\n]*_/g, '')        // timestamp, run log link, spend: they change every run
    .replace(/\d+ (min|h|d) ago/g, '')
    .replace(/MAINTAINER_TOKEN (has expired|expires in \d+ days)/g, '')
    .trim();
  return strip(before) !== strip(after);
}
