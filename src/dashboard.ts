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
  return m < 60 ? `${m} phút` : m < 48 * 60 ? `${Math.round(m / 60)} giờ` : `${Math.round(m / 1440)} ngày`;
};
// Text from agents, issues and PRs is untrusted: it must not be able to write a marker the parser would read.
const safe = (s: string) => s.replace(/<!--/g, '<!- -');
const esc = (s: string) => safe(s).replace(/\r?\n/g, ' ').trim();
const details = (summary: string, body: string) => `  <details><summary>${summary}</summary>\n\n${safe(body).trim()}\n\n  </details>`;
const quote = (s: string) => safe(s).trim().split('\n').map((l) => `  > ${l}`).join('\n');

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
  const lines: string[] = [DASHBOARD_MARK, ''];
  const issueUrl = (n: number) => `https://github.com/${repo}/issues/${n}`;
  const prUrl = (n: number) => `https://github.com/${repo}/pull/${n}`;

  if (db.get('paused')) lines.push('> **Đang tạm dừng.** Comment `/resume` để chạy lại.', '');
  for (const n of info.notes ?? []) lines.push(`> ${esc(n)}`, '');
  if (info.tokenExpiry) {
    const days = Math.round((new Date(info.tokenExpiry).getTime() - now) / 86_400_000);
    if (days <= 21) lines.push(`> ⚠️ **BOT_PAT hết hạn ${days <= 0 ? 'rồi' : `sau ${days} ngày`}** (${info.tokenExpiry}). Tạo token mới và cập nhật secret \`BOT_PAT\`.`, '');
  }

  // --- decisions
  lines.push('## Chờ bạn duyệt', '', 'Tick vào ô là duyệt. Từ chối: comment `/reject p8 lý do`.', '');
  let any = false;
  const proposals = db.proposals('pending', repo);
  if (proposals.length) {
    any = true;
    lines.push('**Đề xuất từ audit** → tick để tạo issue và giao cho bạn; bot sẽ tự làm.', '');
    for (const p of proposals) {
      const covered = p.covers_issue || p.covers_rm ? ` _(đã có: ${[p.covers_issue ? `#${p.covers_issue}` : '', p.covers_rm ?? ''].filter(Boolean).join(', ')})_` : '';
      lines.push(`- [ ] **p${p.id}** · [${p.kind}] ${esc(p.title)}${covered} · ${ago(p.created_at, now)} trước <!-- mb:p${p.id} -->`);
      if (p.rationale) lines.push(`  ${esc(p.rationale)}`);
      lines.push(details('nội dung issue', p.body));
    }
    lines.push('');
  }
  const actions = db.pendingActions().map((a) => ({ a, i: db.issue(a.issue_id) })).filter((x) => x.i.repo === repo);
  if (actions.length) {
    any = true;
    lines.push('**Bản sửa / trả lời cho PR của bot** → tick để đẩy lên.', '');
    for (const { a, i } of actions) {
      const pr = db.prForIssue(i.id);
      const what = a.kind === 'rebase' ? 'rebase' : a.kind === 'fix' ? 'commit sửa theo góp ý' : 'trả lời góp ý';
      lines.push(`- [ ] **a${a.id}** · ${what} cho [PR #${pr?.number ?? '?'}](${prUrl(pr?.number ?? 0)}) "${esc(i.pr_title ?? i.title)}" · ${ago(a.created_at, now)} trước <!-- mb:a${a.id} -->`);
      const reply = replyText(a.message);
      if (a.kind === 'rebase') lines.push(`  ${esc(a.message)}`);
      else if (reply) lines.push(details('trả lời sẽ đăng', quote(reply)));
      else lines.push('  _(chỉ push commit, không trả lời: góp ý đến từ bot/CI)_');
      if (a.patch) lines.push(details(`diff (${a.patch.split('\n').filter((l) => /^[-+](?![-+]{2})/.test(l)).length} dòng)`, `\`\`\`diff\n${a.patch.slice(0, 6000)}${a.patch.length > 6000 ? '\n… (cắt bớt)' : ''}\n\`\`\``));
    }
    lines.push('');
  }
  const drafts = db.drafts('pending').filter((d) => d.repo === repo);
  if (drafts.length) {
    any = true;
    lines.push('**Issue / PR của người khác** → tick để đăng câu trả lời hoặc review đã soạn.', '');
    for (const d of drafts) {
      const link = d.target === 'pr' ? `[PR #${d.number}](${prUrl(d.number)})` : `[#${d.number}](${issueUrl(d.number)})`;
      lines.push(`- [ ] **d${d.id}** · ${d.target === 'pr' ? 'review' : 'trả lời'} ${link} của @${d.author} "${esc(d.title)}" · ${ago(d.created_at, now)} trước <!-- mb:d${d.id} -->`);
      if (d.target === 'issue' && d.take) lines.push(`- [ ] **d${d.id}** · như trên, và giao issue cho bạn để bot làm <!-- mb:d${d.id}:take -->`);
      if (d.target === 'pr') lines.push(`- [ ] **d${d.id}** · như trên, đăng dạng "request changes" <!-- mb:d${d.id}:changes -->`);
      lines.push(`  → ${esc(d.recommendation.split('\n')[0])}`);
      lines.push(details('nội dung sẽ đăng', quote(d.message)));
    }
    lines.push('');
  }
  const stopped = db.issuesInState('skipped').filter((i) => i.repo === repo && db.get(`handed-back:${i.id}`) && !i.skip_reason?.startsWith('rejected by human'));
  if (stopped.length) {
    any = true;
    lines.push('**Bot dừng lại** → `/retry #N` để thử lại, hoặc bỏ assign để bot quên nó.', '');
    for (const i of stopped) lines.push(`- [#${i.number}](${issueUrl(i.number)}) "${esc(i.title)}": ${esc((i.skip_reason ?? '').slice(0, 300))}`);
    lines.push('');
  }
  const blocked = db.blockedIssues(repo);
  if (blocked.length) {
    any = true;
    lines.push(`**Gate hỏng trên nhánh gốc**: ${esc(blocked[0].blocked!)} → sửa gate trong \`.github/maintainer-bot.yml\`; lần chạy sau sẽ thử lại.`, '');
  }
  if (!any) lines.push('_(không có gì)_', '');

  // --- open PRs
  const prs = db.openPrsWithIssue().filter((p) => p.repo === repo);
  lines.push('## PR đang mở, chờ bạn merge', '');
  for (const p of prs) {
    const ci = p.ci_state === 'success' ? 'CI ✅' : p.ci_state === 'failure' ? 'CI ❌' : p.ci_state === 'pending' ? 'CI ⏳' : 'CI ·';
    const extra = [
      p.mergeable === 'CONFLICTING' ? 'conflict' : p.merge_state === 'BEHIND' ? 'tụt sau base' : '',
      p.review_decision === 'CHANGES_REQUESTED' ? 'changes requested' : p.review_decision === 'APPROVED' ? 'approved' : '',
    ].filter(Boolean).join(', ');
    lines.push(`- [PR #${p.number}](${prUrl(p.number)}) "${esc(p.pr_title ?? p.title)}" · ${ci}${extra ? ` · ${extra}` : ''} · mở ${ago(p.opened_at, now)} trước`);
  }
  if (!prs.length) lines.push('_(không có)_');
  lines.push('');

  // --- in progress and queue
  const working = db.allIssues().filter((i) => i.repo === repo && (ACTIVE_STATES as string[]).includes(i.state));
  lines.push('## Đang làm', '');
  for (const i of working) {
    lines.push(`- [#${i.number}](${issueUrl(i.number)}) "${esc(i.title)}" · ${i.blocked ? 'chờ sửa gate' : `${i.state}, lần ${i.attempts + 1}`}`);
  }
  if (!working.length) lines.push('_(không có; assign một issue cho bạn là bot bắt đầu)_');
  lines.push('');
  const queued = db.allIssues().filter((i) => i.repo === repo && i.state === 'triaged');
  if (queued.length) {
    lines.push('## Hàng chờ', '');
    for (const i of queued.slice(0, 12)) lines.push(`- [#${i.number}](${issueUrl(i.number)}) "${esc(i.title)}"`);
    lines.push('');
  }
  const src = db.sources(repo).filter((s) => s.digest);
  if (src.length) {
    lines.push('## Nguồn dữ liệu upstream đã đổi', '');
    for (const s of src) lines.push(`- **${s.name}**: ${esc(s.digest!.split('\n')[0])} · kiểm ${ago(s.checked_at, now)} trước`);
    lines.push('');
  }

  // --- footer
  const cost = info.monthCostUsd ?? 0;
  const budget = info.monthLimitUsd ? ` / ${info.monthLimitUsd.toFixed(0)}` : '';
  lines.push('---', '');
  lines.push(`Chi phí tháng này: $${cost.toFixed(2)}${budget}${cfg.budget.max_cost_per_call_usd ? ` (trần mỗi lần gọi agent $${cfg.budget.max_cost_per_call_usd})` : ''}.`
    + ` Cập nhật ${new Date(now).toISOString().replace('T', ' ').slice(0, 16)} UTC${info.runUrl ? ` · [log](${info.runUrl})` : ''}.`);
  lines.push('', 'Lệnh trong comment: `/reject p8 lý do` · `/retry #14` · `/take 12` (giao issue #12 cho bạn, bot làm).');
  return lines.join('\n');
}

/** True when the dashboard body changed in a way worth an edit (everything but the timestamp line). */
export function dashboardChanged(before: string, after: string): boolean {
  const strip = (s: string) => s.replace(/Cập nhật \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/g, '').trim();
  return strip(before) !== strip(after);
}
