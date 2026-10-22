import type { Config } from './config.js';
import { ACTIVE_STATES, type Db } from './db.js';
import { replyText } from './orchestrator.js';
import { type ResearchItem, researchItems } from './research.js';

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

/** `/approve a1 [--take|--changes]`, `/reject p8 reason…`, `/retry #14`, `/take 12`, one per line, anywhere in a text. */
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
  desk?: string;               // where command links open their issue
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

/** `/approve a3 (owner/repo)` → the repo and the command text without it; null when the title is not one. */
export function parseCommandTitle(title: string): { repo: string; text: string } | null {
  const m = /^\s*(\/.+?)\s*\(([\w.-]+\/[\w.-]+)\)\s*$/.exec(title);
  return m ? { repo: m[2], text: m[1] } : null;
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

  // Nothing here waits for a decision: the bot acts on its own. This is what it could not get through.
  const stuck: string[] = [];
  for (const i of db.issuesInState('skipped').filter((i) => i.repo === repo && db.get(`handed-back:${i.id}`) && !i.skip_reason?.startsWith('rejected by human'))) {
    stuck.push(`- ${iss(i.number)} stopped: ${esc((i.skip_reason ?? '').slice(0, 140))}`);
  }
  for (const p of db.openPrsWithIssue().filter((p) => p.repo === repo && p.mergeable === 'CONFLICTING' && db.get(`rebase-tried:${p.issue_id}`) && !db.pendingActionFor(p.issue_id))) {
    stuck.push(`- ${pr(p.number)} conflicts with the base and the rebase did not get through`);
  }
  const blocked = db.blockedIssues(repo);
  if (blocked.length) stuck.push(`- gate broken on base: ${esc(blocked[0].blocked!)}`);
  if (stuck.length) L.push('### Stuck', '', ...stuck, '');

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
  L.push(...researchSection(db, repo));
  return L.join('\n');
}

/** First sentence of a finding, cut at a word near `max`. */
const brief = (s: string, max = 180) => {
  const one = esc(s).split(/(?<=[.!?])\s/)[0]!;
  return one.length <= max ? one : `${one.slice(0, max).replace(/\s+\S*$/, '')}…`;
};

/**
 * The research list, like a roadmap: one checkbox per item, open ones first, nothing hidden.
 * Tick an item here and the next run marks it done. Only GitHub's limit on an issue body can
 * leave out the oldest done items.
 */
export function researchSection(db: Db, repo: string, room = 50_000): string[] {
  const items = researchItems(db, repo);
  if (!items.length) return [];
  const run = db.get(`researched:${repo}`);
  const last = run ? JSON.parse(run) as { at: string; added: number; planned?: number; skipped?: number } : null;
  const open = items.filter((i) => !i.done).length;
  const link = (n: number) => `[#${n}](https://github.com/${repo}/issues/${n})`;
  const line = (i: ResearchItem) => {
    const url = i.evidence.find((e) => /^https:\/\//.test(e));
    const n = i.issue ?? (i.proposal ? db.proposal(i.proposal).issue_number : null);
    const tail = [
      n ? `→ ${link(n)}` : i.proposal ? `→ p${i.proposal}` : '',
      url ? `[source](${url.split(/\s/)[0]})` : '',
      i.done && i.note ? esc(i.note).slice(0, 80) : '',
      i.found_at.slice(5, 10).split('-').reverse().join('/'),
    ].filter(Boolean).join(' · ');
    return `- [${i.done ? 'x' : ' '}] r${i.id} **${esc(i.title)}**: ${brief(i.detail)} · ${tail}`;
  };
  const lines = [...items.filter((i) => !i.done), ...items.filter((i) => i.done).reverse()].map(line);
  let size = 0;
  const shown = lines.filter((l) => (size += l.length + 1) <= room);
  const L = ['### Research', '',
    `_${open} open · ${items.length - open} done${last ? ` · last run ${last.at.replace('T', ' ').slice(0, 16)} UTC: ${last.skipped ? 'only ticked done items (too many open)' : `${last.added} new, ${last.planned ?? 0} issue(s) opened`}` : ''}. Tick what is done._`, '',
    ...shown];
  if (shown.length < lines.length) L.push(`- … ${lines.length - shown.length} older done item(s) not shown (issue size limit)`);
  L.push('');
  return L;
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
