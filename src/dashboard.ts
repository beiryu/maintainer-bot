import type { Config } from './config.js';
import { ACTIVE_STATES, type Db } from './db.js';
import { replyText } from './orchestrator.js';

// The inbox as a pinned GitHub issue, for a bot that runs on GitHub Actions. The bot alone
// writes it (its edits start no run); the maintainer decides by commenting /approve, /reject
// and the rest, and the bot answers each comment with what it did and the run log.

export const DASHBOARD_MARK = '<!-- maintainer-bot:dashboard -->';
export const DASHBOARD_TITLE = 'Maintainer Dashboard';

export type Command =
  | { cmd: 'approve'; id: string; flag?: 'take' | 'changes' }
  | { cmd: 'reject'; id: string; reason: string }
  | { cmd: 'retry'; number: number }
  | { cmd: 'take'; number: number };

/** `/approve a1 [--take|--changes]`, `/reject p8 reason…`, `/retry #14`, `/take 12`, one per line, anywhere in a comment. */
export function parseCommands(comment: string): Command[] {
  const out: Command[] = [];
  for (const line of comment.split('\n')) {
    const ap = /^\s*\/approve\s+([pad]\d+)\s*(--take|--changes|--request-changes)?\s*$/i.exec(line);
    if (ap) {
      const f = ap[2]?.toLowerCase();
      out.push({ cmd: 'approve', id: ap[1].toLowerCase(), ...(f ? { flag: f === '--take' ? 'take' : 'changes' } as const : {}) });
      continue;
    }
    let m = /^\s*\/reject\s+([pad]\d+)\s*(.*)$/i.exec(line);
    if (m) { out.push({ cmd: 'reject', id: m[1].toLowerCase(), reason: m[2].trim() }); continue; }
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
const details = (summary: string, body: string) => `  <details><summary>${summary}</summary>\n\n${demote(safe(body)).trim()}\n\n  </details>`;
const quote = (s: string) => safe(s).trim().split('\n').map((l) => `  > ${l}`).join('\n');
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

/** The dashboard body for one repo. Pure: reads the state only. One line per item; long text folded. */
export function renderDashboard(db: Db, cfg: Config, info: DashboardInfo): string {
  void cfg;
  const now = info.now ?? Date.now();
  const repo = info.repo;
  const iss = (n: number) => `[#${n}](https://github.com/${repo}/issues/${n})`;
  const pr = (n: number) => `[#${n}](https://github.com/${repo}/pull/${n})`;
  const cmd = (id: string) => `\`/approve ${id}\``;
  const cost = `$${(info.monthCostUsd ?? 0).toFixed(2)}${info.monthLimitUsd ? `/$${info.monthLimitUsd.toFixed(0)}` : ''}`;
  const L: string[] = [
    DASHBOARD_MARK, '',
    `_Updated ${new Date(now).toISOString().replace('T', ' ').slice(0, 16)} UTC${info.runUrl ? ` · [log](${info.runUrl})` : ''} · ${cost} this month_`, '',
  ];
  if (db.get('paused')) L.push('> ⏸ Paused — `/resume`', '');
  for (const n of info.notes ?? []) L.push(`> ${esc(n)}`, '');
  if (info.tokenExpiry) {
    const days = Math.round((new Date(info.tokenExpiry).getTime() - now) / 86_400_000);
    if (days <= 21) L.push(`> ⚠️ BOT_PAT ${days <= 0 ? 'has expired' : `expires in ${days} days`}`, '');
  }

  const todo: string[] = [];
  for (const p of db.proposals('pending', repo)) {
    const tracked = p.covers_issue ? ` (tracked: ${iss(p.covers_issue)})` : p.covers_rm ? ` (${p.covers_rm})` : '';
    todo.push(`- **p${p.id}** new issue: ${esc(p.title)}${tracked} → ${cmd(`p${p.id}`)}`);
    todo.push(details('details', `${p.rationale ? `${p.rationale}\n\n` : ''}${p.body}`));
  }
  for (const a of db.pendingActions()) {
    const i = db.issue(a.issue_id);
    if (i.repo !== repo) continue;
    const n = db.prForIssue(i.id)?.number ?? 0;
    const reply = replyText(a.message);
    const what = a.kind === 'rebase' ? 'rebase' : a.kind === 'fix' ? (reply ? 'fix + reply' : 'fix') : 'reply';
    todo.push(`- **a${a.id}** ${what} on ${pr(n)} → ${cmd(`a${a.id}`)}`);
    const parts = [reply ? quote(reply) : '', a.patch ? `\`\`\`diff\n${a.patch.slice(0, 6000)}${a.patch.length > 6000 ? '\n…' : ''}\n\`\`\`` : ''].filter(Boolean);
    if (parts.length) todo.push(details(a.patch ? `diff, ${diffLines(a.patch)} lines` : 'reply', parts.join('\n\n')));
  }
  for (const d of db.drafts('pending').filter((d) => d.repo === repo)) {
    const flag = d.target === 'pr' ? ' · `--changes` to request changes' : d.take ? ' · `--take` to also assign it' : '';
    todo.push(`- **d${d.id}** ${d.target === 'pr' ? 'review' : 'reply'} ${d.target === 'pr' ? pr(d.number) : iss(d.number)} @${d.author} → ${cmd(`d${d.id}`)}${flag}`);
    todo.push(details(esc(d.recommendation.split('\n')[0]).slice(0, 100), quote(d.message)));
  }
  for (const i of db.issuesInState('skipped').filter((i) => i.repo === repo && db.get(`handed-back:${i.id}`) && !i.skip_reason?.startsWith('rejected by human'))) {
    todo.push(`- ${iss(i.number)} stopped: ${esc((i.skip_reason ?? '').slice(0, 140))} → \`/retry #${i.number}\``);
  }
  const blocked = db.blockedIssues(repo);
  if (blocked.length) todo.push(`- gate broken on base: ${esc(blocked[0].blocked!)}`);
  L.push('### To decide', '', ...(todo.length ? todo : ['_Nothing._']), '');

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
  L.push('---', '`/approve <id>` · `/reject <id> why` · `/retry #N` · `/take N` · `/pause` · `/resume`');
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
    .replace(/BOT_PAT (has expired|expires in \d+ days)/g, '')
    .trim();
  return strip(before) !== strip(after);
}
