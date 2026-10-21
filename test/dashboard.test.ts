import { describe, expect, it } from 'vitest';
import { DASHBOARD_MARK, dashboardChanged, parseCommands, renderDashboard } from '../src/dashboard.js';
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
  const p = db.addProposal({ repo: 'o/r', kind: 'gap', title: 'core: negative amounts unhandled', body: '## Problem\nBody <!-- evil -->', labels: '[]', rationale: 'because', evidence: '[]', covers_issue: null, covers_rm: 'RM-013', run_id: null });
  const d1 = db.addDraft({ repo: 'o/r', target: 'issue', number: 31, title: 'crash on x', author: 'someone', head_sha: null, message: 'Thanks, can you share…', labels_add: '[]', labels_remove: '[]', recommendation: 'take: looks real', take: 1 });
  const d2 = db.addDraft({ repo: 'o/r', target: 'pr', number: 32, title: 'feat(core): y', author: 'other', head_sha: 'abc', message: 'Tests miss the error path.', labels_add: '[]', labels_remove: '[]', recommendation: 'changes: tests', take: 0 });
  return { db, a, p, d1, d2 };
}

describe('renderDashboard', () => {
  it('lists every decision with the command that approves it, one line each, and the rest as status', () => {
    const { db, a, p, d1, d2 } = populated();
    const body = renderDashboard(db, cfg, { repo: 'o/r', monthCostUsd: 1.25, monthLimitUsd: 50, now: Date.parse('2026-10-21T10:00:00Z') });
    expect(body.startsWith(`${DASHBOARD_MARK}\n<!-- maintainer-bot:repo o/r -->`)).toBe(true);
    expect(body).toContain('_Updated 2026-10-21 10:00 UTC · $1.25/$50 this month_');
    expect(body).toContain(`- **p${p}** new issue: core: negative amounts unhandled (RM-013) → \`/approve p${p}\``);
    expect(body).toContain('  **Problem**\n  Body <!- - evil -->'); // headings demoted, indented into the item; no marker smuggled
    expect(body).toContain(`- **a${a}** fix + reply on [#20](https://github.com/o/r/pull/20) → \`/approve a${a}\``);
    expect(body).toContain('> Fixed the null case.');
    expect(body).not.toContain('for you only');
    expect(body).toContain(`- **d${d1}** reply [#31](https://github.com/o/r/issues/31) @someone → \`/approve d${d1}\` · \`--take\` to also assign it`);
    expect(body).toContain(`- **d${d2}** review [#32](https://github.com/o/r/pull/32) @other → \`/approve d${d2}\` · \`--changes\` to request changes`);
    expect(body).toContain('- [#20](https://github.com/o/r/pull/20) ❌ fix(x): thing · changes requested');
    expect(body).toContain('- [#2](https://github.com/o/r/issues/2) issue 2 · coded');
    expect(body).toContain('- [#3](https://github.com/o/r/issues/3) stopped: coder gave up: needs a decision → `/retry #3`');
    // Nothing the bot writes reads as a command.
    expect(parseCommands(body)).toEqual([]);
  });
  it('says so when nothing waits, and warns about an expiring token', () => {
    const db = new Db(':memory:');
    const body = renderDashboard(db, cfg, { repo: 'o/r', tokenExpiry: '2026-10-30', now: Date.parse('2026-10-21T00:00:00Z') });
    expect(body).toContain('_Nothing._');
    expect(body).not.toContain('### Open PRs');
    expect(body).toContain('MAINTAINER_TOKEN expires in 9 days');
  });
  it('ignores the timestamp when deciding whether to re-post', () => {
    const db = new Db(':memory:');
    const a = renderDashboard(db, cfg, { repo: 'o/r', now: Date.parse('2026-10-21T10:00:00Z') });
    const b = renderDashboard(db, cfg, { repo: 'o/r', now: Date.parse('2026-10-22T10:00:00Z') });
    expect(dashboardChanged(a, b)).toBe(false);
    expect(dashboardChanged(a.replace('_Updated', '_Updated x [run log](https://x/runs/1)'), a.replace('_Updated', '_Updated y [run log](https://x/runs/2)'))).toBe(false);
    expect(dashboardChanged(a, `${a}\n- new`)).toBe(true);
    expect(dashboardChanged('- [ ] **p1** x · proposed 2 min ago', '- [ ] **p1** x · proposed 3 min ago')).toBe(false);
    expect(dashboardChanged('- [ ] **p1** x · proposed 2 min ago', '- [ ] **p2** x · proposed 2 min ago')).toBe(true);
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
    expect(parseCommands('/approve a1\n/approve d2 --take\n/approve D3 --request-changes\n/approve p4 --bogus')).toEqual([
      { cmd: 'approve', id: 'a1' },
      { cmd: 'approve', id: 'd2', flag: 'take' },
      { cmd: 'approve', id: 'd3', flag: 'changes' },
    ]);
  });
});
