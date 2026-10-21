import type { Config } from './config.js';
import { ACTIVE_STATES, type Db } from './db.js';
import { replyText } from './orchestrator.js';

// The inbox as a pinned GitHub issue, for a bot that runs on GitHub Actions: every decision
// is a checkbox, ticking it is the approval; comments carry the few commands that are not
// a yes. The body is rendered from the state after each run and parsed on each edit.

export const DASHBOARD_MARK = '<!-- maintainer-bot:dashboard -->';
export const DASHBOARD_TITLE = 'Maintainer Dashboard';

/** One decision on the dashboard: its id (p7, a3, d2) and the variant ticked, if the item offers one. */
export interface Tick { id: string; flag?: 'take' | 'changes' }

/** Ids whose checkbox is ticked, in body order. */
export function parseTicks(body: string): Tick[] {
  const out: Tick[] = [];
  for (const m of body.matchAll(/^\s*- \[[xX]\] .*<!-- mb:([pad]\d+)(?::(take|changes))? -->/gm)) {
    out.push({ id: m[1], ...(m[2] ? { flag: m[2] as Tick['flag'] } : {}) });
  }
  return out;
}

export type Command =
  | { cmd: 'reject'; id: string; reason: string }
  | { cmd: 'retry'; number: number }
  | { cmd: 'take'; number: number };

/** `/reject p8 reason…`, `/retry #14`, `/take 12`, one per line, anywhere in a comment. */
export function parseCommands(comment: string): Command[] {
  const out: Command[] = [];
  for (const line of comment.split('\n')) {
    let m = /^\s*\/reject\s+([pad]\d+)\s*(.*)$/i.exec(line);
    if (m) { out.push({ cmd: 'reject', id: m[1].toLowerCase(), reason: m[2].trim() }); continue; }
    m = /^\s*\/(retry|take)\s+#?(\d+)\s*$/i.exec(line);
    if (m) out.push({ cmd: m[1].toLowerCase() as 'retry' | 'take', number: Number(m[2]) });
  }
  return out;
}

const ago = (iso: string | null, now: number) => {
  if (!iso) return '?';
  const m = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  return m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
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

/** The dashboard body for one repo. Pure: reads the state only. */
export function renderDashboard(db: Db, cfg: Config, info: DashboardInfo): string {
  const now = info.now ?? Date.now();
  const repo = info.repo;
  const issueUrl = (n: number) => `https://github.com/${repo}/issues/${n}`;
  const prUrl = (n: number) => `https://github.com/${repo}/pull/${n}`;
  const pr = (n: number) => `[PR #${n}](${prUrl(n)})`;
  const iss = (n: number) => `[#${n}](${issueUrl(n)})`;

  // --- header
  const cost = `$${(info.monthCostUsd ?? 0).toFixed(2)}${info.monthLimitUsd ? ` of $${info.monthLimitUsd.toFixed(0)}` : ''}`;
  const lines: string[] = [
    DASHBOARD_MARK, '',
    `# ${DASHBOARD_TITLE}`, '',
    `_Updated ${new Date(now).toISOString().replace('T', ' ').slice(0, 16)} UTC${info.runUrl ? ` · [run log](${info.runUrl})` : ''} · spent this month: ${cost}_`, '',
  ];
  if (db.get('paused')) lines.push('> ⏸ **Paused.** Comment `/resume` to continue.', '');
  for (const n of info.notes ?? []) lines.push(`> ${esc(n)}`, '');
  if (info.tokenExpiry) {
    const days = Math.round((new Date(info.tokenExpiry).getTime() - now) / 86_400_000);
    if (days <= 21) lines.push(`> ⚠️ **BOT_PAT ${days <= 0 ? 'has expired' : `expires in ${days} days`}** (${info.tokenExpiry}). Create a new token and update the \`BOT_PAT\` secret of the \`bot\` environment.`, '');
  }

  // --- 1. decisions
  lines.push('## 1. Needs your decision', '', 'Tick a box to approve. To decline, comment `/reject <id> reason`.', '');
  let any = false;
  const proposals = db.proposals('pending', repo);
  if (proposals.length) {
    any = true;
    lines.push('### Proposed issues (from the audit)', '', 'Ticking creates the issue and assigns it to you; the bot then implements it.', '');
    for (const p of proposals) {
      const covered = p.covers_issue || p.covers_rm ? ` · already tracked as ${[p.covers_issue ? iss(p.covers_issue) : '', p.covers_rm ?? ''].filter(Boolean).join(', ')}` : '';
      lines.push(`- [ ] **p${p.id}** \`${p.kind}\` ${esc(p.title)} <!-- mb:p${p.id} -->`);
      lines.push(`  proposed ${ago(p.created_at, now)}${covered}`);
      if (p.rationale) lines.push(`  **Why:** ${esc(p.rationale)}`);
      lines.push(details('Issue text', p.body));
    }
    lines.push('');
  }
  const actions = db.pendingActions().map((a) => ({ a, i: db.issue(a.issue_id) })).filter((x) => x.i.repo === repo);
  if (actions.length) {
    any = true;
    lines.push("### Drafted follow-ups on the bot's pull requests", '', 'Ticking pushes the commit and/or posts the reply.', '');
    for (const { a, i } of actions) {
      const n = db.prForIssue(i.id)?.number ?? 0;
      const reply = replyText(a.message);
      const what = a.kind === 'rebase' ? `rebase ${pr(n)} onto the current base`
        : a.kind === 'fix' ? `push a fix to ${pr(n)}${reply ? ' and reply' : ' (no reply: the feedback came from a bot or CI)'}`
        : `reply on ${pr(n)}`;
      lines.push(`- [ ] **a${a.id}** ${what} <!-- mb:a${a.id} -->`);
      lines.push(`  "${esc(i.pr_title ?? i.title)}" · drafted ${ago(a.created_at, now)}`);
      if (a.kind === 'rebase') lines.push(`  ${esc(a.message)}`);
      else if (reply) lines.push(details('Reply to post', quote(reply)));
      if (a.patch) lines.push(details(`Diff (${diffLines(a.patch)} lines)`, `\`\`\`diff\n${a.patch.slice(0, 6000)}${a.patch.length > 6000 ? '\n… (truncated)' : ''}\n\`\`\``));
    }
    lines.push('');
  }
  const drafts = db.drafts('pending').filter((d) => d.repo === repo);
  if (drafts.length) {
    any = true;
    lines.push("### Other people's issues and pull requests", '', 'Ticking posts the drafted reply or review as you.', '');
    for (const d of drafts) {
      const link = d.target === 'pr' ? pr(d.number) : iss(d.number);
      const what = d.target === 'pr' ? `review ${link}` : `reply on ${link}`;
      lines.push(`- [ ] **d${d.id}** ${what} by @${d.author} <!-- mb:d${d.id} -->`);
      if (d.target === 'issue' && d.take) lines.push(`- [ ] **d${d.id}** + take: same, and assign the issue to you so the bot implements it <!-- mb:d${d.id}:take -->`);
      if (d.target === 'pr') lines.push(`- [ ] **d${d.id}** + request changes: same, posted as "request changes" <!-- mb:d${d.id}:changes -->`);
      lines.push(`  "${esc(d.title)}" · drafted ${ago(d.created_at, now)}`);
      lines.push(`  **Recommendation:** ${esc(d.recommendation.split('\n')[0])}`);
      lines.push(details(d.target === 'pr' ? 'Review to post' : 'Reply to post', quote(d.message)));
    }
    lines.push('');
  }
  const stopped = db.issuesInState('skipped').filter((i) => i.repo === repo && db.get(`handed-back:${i.id}`) && !i.skip_reason?.startsWith('rejected by human'));
  if (stopped.length) {
    any = true;
    lines.push('### Stopped: the bot gave up', '', 'Comment `/retry #N` to try again, or unassign the issue to drop it.', '');
    for (const i of stopped) lines.push(`- ${iss(i.number)} "${esc(i.title)}"\n  ${esc((i.skip_reason ?? '').slice(0, 300))}`);
    lines.push('');
  }
  const blocked = db.blockedIssues(repo);
  if (blocked.length) {
    any = true;
    lines.push('### Gate broken on the base branch', '', `${esc(blocked[0].blocked!)}. Fix the gate in \`.github/maintainer-bot.yml\`; the next run retries.`, '');
  }
  if (!any) lines.push('_Nothing waiting._', '');

  // --- 2. open PRs
  const prs = db.openPrsWithIssue().filter((p) => p.repo === repo);
  lines.push('## 2. Open pull requests, waiting for your merge', '');
  for (const p of prs) {
    const ci = p.ci_state === 'success' ? 'CI passed' : p.ci_state === 'failure' ? 'CI failed' : p.ci_state === 'pending' ? 'CI running' : 'CI not reported';
    const extra = [
      p.mergeable === 'CONFLICTING' ? 'conflicts with base' : p.merge_state === 'BEHIND' ? 'behind base' : '',
      p.review_decision === 'CHANGES_REQUESTED' ? 'changes requested' : p.review_decision === 'APPROVED' ? 'approved' : '',
    ].filter(Boolean).join(' · ');
    lines.push(`- ${pr(p.number)} "${esc(p.pr_title ?? p.title)}" · ${ci}${extra ? ` · ${extra}` : ''} · opened ${ago(p.opened_at, now)}`);
  }
  if (!prs.length) lines.push('_None._');
  lines.push('');

  // --- 3. in progress, queue, sources
  const working = db.allIssues().filter((i) => i.repo === repo && (ACTIVE_STATES as string[]).includes(i.state));
  lines.push('## 3. In progress', '');
  for (const i of working) {
    lines.push(`- ${iss(i.number)} "${esc(i.title)}" · ${i.blocked ? 'waiting for the gate fix' : `${i.state}, attempt ${i.attempts + 1}`}`);
  }
  if (!working.length) lines.push('_None. Assign an issue to yourself and the bot starts on it._');
  lines.push('');
  const queued = db.allIssues().filter((i) => i.repo === repo && i.state === 'triaged');
  if (queued.length) {
    lines.push('## 4. Queued', '');
    for (const i of queued.slice(0, 12)) lines.push(`- ${iss(i.number)} "${esc(i.title)}"`);
    lines.push('');
  }
  const src = db.sources(repo).filter((s) => s.digest);
  if (src.length) {
    lines.push('## 5. Upstream data sources that changed', '');
    for (const s of src) lines.push(`- **${s.name}**: ${esc(s.digest!.split('\n')[0])} · checked ${ago(s.checked_at, now)}`);
    lines.push('');
  }

  // --- footer
  lines.push('---', '');
  lines.push('Commands, one per line in a comment: `/reject p2 reason` · `/retry #14` · `/take 12` (assign issue #12 to you; the bot implements it) · `/pause` · `/resume`.');
  lines.push(`Runs on every event and daily; each agent call is capped at $${cfg.budget.max_cost_per_call_usd}.`);
  return lines.join('\n');
}

/**
 * True when the dashboard body changed in a way worth an edit: everything but the timestamp
 * and the relative times. (Each edit is an event that starts a run, which renders again: an
 * edit for "2 min ago" becoming "3 min ago" would never stop.)
 */
export function dashboardChanged(before: string, after: string): boolean {
  const strip = (s: string) => s
    .replace(/Updated \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/g, '')
    .replace(/\d+ (min|h|d) ago/g, '')
    .replace(/BOT_PAT (has expired|expires in \d+ days)/g, '')
    .trim();
  return strip(before) !== strip(after);
}
