import { describe, expect, it } from 'vitest';
import { DASHBOARD_MARK, dashboardChanged, parseCommands, parseTicks, renderDashboard } from '../src/dashboard.js';
import { Db } from '../src/db.js';

const cfg = { repos: [{ full_name: 'o/r', sources: [] }], limits: { max_in_flight_per_repo: 1 }, budget: { max_cost_per_call_usd: 3 } } as never;

function populated() {
  const db = new Db(':memory:');
  db.upsertRepo('o/r');
  for (const n of [1, 2, 3, 4]) db.insertDiscovered({ repo: 'o/r', number: n, title: `issue ${n}`, body: '', url: `u${n}` });
  const id = (n: number) => db.issueByNumber('o/r', n)!.id;
  db.transition(id(1), 'pr_open', { pr_title: 'fix(x): thing' }); db.insertPr(id(1), 'https://github.com/o/r/pull/20', 20);
  db.updatePr(id(1), { ci_state: 'failure', review_decision: 'CHANGES_REQUESTED' });
  const a = db.addAction(id(1), 'fix', 'Fixed the null case.\n\n<!-- maintainer-bot: your reply goes above this line -->\nfor you only', 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n');
  db.transition(id(2), 'coded');
  db.skip(id(3), 'coder gave up: needs a decision'); db.set(`handed-back:${id(3)}`, 'now');
  const p = db.addProposal({ repo: 'o/r', kind: 'gap', title: 'core: negative amounts unhandled', body: 'Body <!-- evil -->', labels: '[]', rationale: 'because', evidence: '[]', covers_issue: null, covers_rm: 'RM-013', run_id: null });
  const d1 = db.addDraft({ repo: 'o/r', target: 'issue', number: 31, title: 'crash on x', author: 'someone', head_sha: null, message: 'Thanks, can you share…', labels_add: '[]', labels_remove: '[]', recommendation: 'take: looks real', take: 1 });
  const d2 = db.addDraft({ repo: 'o/r', target: 'pr', number: 32, title: 'feat(core): y', author: 'other', head_sha: 'abc', message: 'Tests miss the error path.', labels_add: '[]', labels_remove: '[]', recommendation: 'changes: tests', take: 0 });
  return { db, a, p, d1, d2 };
}

describe('renderDashboard', () => {
  it('lists every decision as a checkbox with its id marker, and the rest as status', () => {
    const { db, a, p, d1, d2 } = populated();
    const body = renderDashboard(db, cfg, { repo: 'o/r', monthCostUsd: 1.25, monthLimitUsd: 50, now: Date.parse('2026-10-21T10:00:00Z') });
    expect(body.startsWith(DASHBOARD_MARK)).toBe(true);
    expect(body).toContain(`- [ ] **p${p}** · [gap] core: negative amounts unhandled _(đã có: RM-013)_`);
    expect(body).toContain(`<!-- mb:p${p} -->`);
    expect(body).toContain('Body <!- - evil -->'); // untrusted text cannot smuggle a marker
    expect(body).toContain(`<!-- mb:a${a} -->`);
    expect(body).toContain('> Fixed the null case.');
    expect(body).not.toContain('for you only');
    expect(body).toContain(`<!-- mb:d${d1} -->`);
    expect(body).toContain(`<!-- mb:d${d1}:take -->`);
    expect(body).toContain(`<!-- mb:d${d2}:changes -->`);
    expect(body).not.toContain(`<!-- mb:d${d2}:take -->`);
    expect(body).toContain('[PR #20](https://github.com/o/r/pull/20) "fix(x): thing" · CI ❌ · changes requested');
    expect(body).toContain('[#2](https://github.com/o/r/issues/2) "issue 2" · coded, lần 1');
    expect(body).toContain('[#3](https://github.com/o/r/issues/3) "issue 3": coder gave up: needs a decision');
    expect(body).toContain('Chi phí tháng này: $1.25 / 50');
    expect(body).toContain('Cập nhật 2026-10-21 10:00 UTC');
    // Everything the bot wrote renders unticked; only a person ticks.
    expect(parseTicks(body)).toEqual([]);
  });
  it('says so when nothing waits, and warns about an expiring token', () => {
    const db = new Db(':memory:');
    const body = renderDashboard(db, cfg, { repo: 'o/r', tokenExpiry: '2026-10-30', now: Date.parse('2026-10-21T00:00:00Z') });
    expect(body).toContain('_(không có gì)_');
    expect(body).toContain('BOT_PAT hết hạn sau 9 ngày');
  });
  it('ignores the timestamp when deciding whether to re-post', () => {
    const db = new Db(':memory:');
    const a = renderDashboard(db, cfg, { repo: 'o/r', now: Date.parse('2026-10-21T10:00:00Z') });
    const b = renderDashboard(db, cfg, { repo: 'o/r', now: Date.parse('2026-10-22T10:00:00Z') });
    expect(dashboardChanged(a, b)).toBe(false);
    expect(dashboardChanged(a, `${a}\n- new`)).toBe(true);
  });
});

describe('parseTicks', () => {
  it('returns ticked ids with their variant, in order, and ignores unticked ones', () => {
    const body = [
      '- [ ] **p7** · x <!-- mb:p7 -->',
      '- [x] **p8** · y <!-- mb:p8 -->',
      '- [X] **d2** · z <!-- mb:d2:take -->',
      '- [x] **d3** · w <!-- mb:d3:changes -->',
      '- [x] not a bot item',
      '  - [x] **a1** · indented <!-- mb:a1 -->',
    ].join('\n');
    expect(parseTicks(body)).toEqual([{ id: 'p8' }, { id: 'd2', flag: 'take' }, { id: 'd3', flag: 'changes' }, { id: 'a1' }]);
  });
});

describe('parseCommands', () => {
  it('reads reject, retry and take lines and nothing else', () => {
    expect(parseCommands('thanks\n/reject p8 not needed now\n/retry #14\n/take 12\n/unknown 1')).toEqual([
      { cmd: 'reject', id: 'p8', reason: 'not needed now' },
      { cmd: 'retry', number: 14 },
      { cmd: 'take', number: 12 },
    ]);
    expect(parseCommands('/reject A3')).toEqual([{ cmd: 'reject', id: 'a3', reason: '' }]);
  });
});
