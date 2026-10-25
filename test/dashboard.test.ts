import { describe, expect, it } from 'vitest';
import { DASHBOARD_MARK, dashboardChanged, parseCommands, parseCommandTitle, pendingItems, renderDashboard } from '../src/dashboard.js';
import { Db } from '../src/db.js';
import { addFindings, researchItems, tickClosed, tickedIds, updateItems } from '../src/research.js';

const cfg = { repos: [{ full_name: 'o/r', sources: [] }], limits: {}, budget: { max_cost_per_call_usd: 3 } } as never;

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
  it('lists research items like a roadmap: a checkbox each, open first, linked to their issue', () => {
    const db = new Db(':memory:');
    db.upsertRepo('o/r');
    expect(renderDashboard(db, cfg, { repo: 'o/r' })).not.toContain('### Research');
    addFindings(db, 'o/r', [{ title: 'Not in the MCP Registry', detail: 'Search returned 0. Publishing needs a server.json.', evidence: ['https://registry.example/x?q=1'] }], '2026-10-22T13:10:00Z');
    addFindings(db, 'o/r', [{ title: 'CCCD year 2300', detail: 'parseCitizenId accepts it.', evidence: ['src/id.ts:46'] }, { title: 'tlv counts UTF-16', detail: 'Not bytes.', evidence: [] }], '2026-10-22T13:12:00Z');
    const p = db.addProposal({ repo: 'o/r', kind: 'bug', title: 'tlv: count bytes', body: 'b', labels: '[]', rationale: 'r', evidence: '[]', covers_issue: null, covers_rm: null, run_id: null });
    db.updateProposal(p, { status: 'filed', issue_number: 120 });
    updateItems(db, 'o/r', [2], (i) => { i.done = true; i.note = '#95 fixed it'; });
    updateItems(db, 'o/r', [3], (i) => { i.proposal = p; });
    updateItems(db, 'o/r', [1], (i) => { i.issue = 69; });
    db.set('researched:o/r', JSON.stringify({ at: '2026-10-22T13:12:30Z', added: 2, planned: 1 }));
    const body = renderDashboard(db, cfg, { repo: 'o/r' });
    expect(body).toContain('_2 open · 1 done · last run 2026-10-22 13:12 UTC: 2 new, 1 issue(s) opened. Tick what is done._');
    expect(body).toContain([
      '- [ ] r1 **Not in the MCP Registry**: Search returned 0. · → [#69](https://github.com/o/r/issues/69) · [source](https://registry.example/x?q=1) · 22/10',
      '- [ ] r3 **tlv counts UTF-16**: Not bytes. · → [#120](https://github.com/o/r/issues/120) · 22/10',
      '- [x] r2 **CCCD year 2300**: parseCitizenId accepts it. · #95 fixed it · 22/10',
    ].join('\n'));
    expect(body).not.toContain('<details>');
  });
  it('reads the ticks on the dashboard and never adds the same title twice', () => {
    expect(tickedIds('- [x] r3 **a**\n- [ ] r4 **b**\n  - [X] r12 **c**\n- [x] p5 not research')).toEqual([3, 12]);
    const db = new Db(':memory:');
    expect(addFindings(db, 'o/r', [{ title: 'Same thing', detail: 'a', evidence: [] }], 't1')).toHaveLength(1);
    expect(addFindings(db, 'o/r', [{ title: 'same  THING!', detail: 'b', evidence: [] }, { title: 'Other', detail: 'c', evidence: [] }], 't2').map((i) => i.id)).toEqual([2]);
  });
  it('ticks items whose issue was closed', async () => {
    const db = new Db(':memory:');
    addFindings(db, 'o/r', [{ title: 'a', detail: '', evidence: [] }, { title: 'b', detail: '', evidence: [] }], 't');
    updateItems(db, 'o/r', [1], (i) => { i.issue = 7; });
    updateItems(db, 'o/r', [2], (i) => { i.issue = 8; });
    expect(await tickClosed(db, 'o/r', async (n) => n === 7)).toBe(1);
    expect(researchItems(db, 'o/r').map((i) => [i.done, i.note])).toEqual([[true, '#7 closed'], [false, '']]);
  });
  it('shows status only: open PRs, work in progress and what is stuck, no decisions', () => {
    const { db, a, p, d1, d2 } = populated();
    const body = renderDashboard(db, cfg, { repo: 'o/r', monthCostUsd: 1.25, monthLimitUsd: 50, now: Date.parse('2026-10-21T10:00:00Z') });
    expect(body.startsWith(`${DASHBOARD_MARK}\n<!-- maintainer-bot:repo o/r -->`)).toBe(true);
    expect(body).toContain('_Updated 2026-10-21 10:00 UTC · $1.25/$50 this month_');
    expect(body).not.toContain('Approve');
    expect(body).not.toContain('### To decide');
    // What publish carries out on its own.
    expect(pendingItems(db, 'o/r').map((i) => i.id)).toEqual([`p${p}`, `a${a}`, `d${d1}`, `d${d2}`]);
    expect(body).toContain('- [#20](https://github.com/o/r/pull/20) ❌ fix(x): thing · changes requested');
    expect(body).toContain('- [#2](https://github.com/o/r/issues/2) issue 2 · coded');
    expect(body).toContain('### Stuck\n\n- [#3](https://github.com/o/r/issues/3) stopped: coder gave up: needs a decision');
    expect(parseCommands(body)).toEqual([]);
  });
  it('lists a PR whose rebase gave up as stuck', () => {
    const { db } = populated();
    const issue = db.issueByNumber('o/r', 1)!.id;
    db.updatePr(issue, { mergeable: 'CONFLICTING' });
    db.set(`rebase-tried:${issue}`, 'abc');
    expect(renderDashboard(db, cfg, { repo: 'o/r' })).not.toContain('rebase did not get through'); // a fix is still pending
    db.setActionStatus(db.pendingActionFor(issue)!.id, 'rejected');
    expect(renderDashboard(db, cfg, { repo: 'o/r' })).toContain('- [#20](https://github.com/o/r/pull/20) conflicts with the base and the rebase did not get through');
  });
  it('warns about an expiring token and has no empty sections', () => {
    const db = new Db(':memory:');
    const body = renderDashboard(db, cfg, { repo: 'o/r', tokenExpiry: '2026-10-30', now: Date.parse('2026-10-21T00:00:00Z') });
    expect(body).not.toContain('### Open PRs');
    expect(body).not.toContain('### Stuck');
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

describe('parseCommandTitle', () => {
  it('reads the command and the repo from a command issue title', () => {
    expect(parseCommandTitle('/approve p4 (beiryu/vn-skills)')).toEqual({ repo: 'beiryu/vn-skills', text: '/approve p4' });
    expect(parseCommandTitle('/reject d2 not now (o/r)')).toEqual({ repo: 'o/r', text: '/reject d2 not now' });
    expect(parseCommandTitle('beiryu/vn-skills')).toBeNull();
    expect(parseCommands(parseCommandTitle('/approve d2 --take (o/r)')!.text)).toEqual([{ cmd: 'approve', id: 'd2', flag: 'take' }]);
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
    expect(parseCommands('/approve a1\n/approve d2 --take\n/approve D3 --request-changes\n/approve p4 --bogus\n/a p5')).toEqual([
      { cmd: 'approve', id: 'a1' },
      { cmd: 'approve', id: 'd2', flag: 'take' },
      { cmd: 'approve', id: 'd3', flag: 'changes' },
    ]);
  });
});
