import { describe, expect, it } from 'vitest';
import { Db } from '../src/db.js';
import { isFeedback, type PrComment } from '../src/github.js';

function setup() {
  const db = new Db(':memory:');
  db.upsertRepo('o/r');
  for (const n of [1, 2, 3]) db.insertDiscovered({ repo: 'o/r', number: n, title: `t${n}`, body: '', url: '' });
  return db;
}

describe('Db', () => {
  it('ignores duplicate discoveries', () => {
    const db = setup();
    expect(db.insertDiscovered({ repo: 'o/r', number: 1, title: 'again', body: '', url: '' })).toBe(false);
    expect(db.issueByNumber('o/r', 1)!.title).toBe('t1');
  });

  it('picks active issues by score and counts in-flight ones', () => {
    const db = setup();
    const [a, b, c] = [1, 2, 3].map((n) => db.issueByNumber('o/r', n)!);
    db.transition(a.id, 'claimed', { score: 0.7 });
    db.transition(b.id, 'gated', { score: 0.9 });
    db.transition(c.id, 'reviewed', { score: 1 });
    expect(db.nextIssues().map((i) => i.number)).toEqual([3, 2, 1]);
    expect(db.inFlightCount('o/r')).toBe(3);
    db.setRepoStatus('o/r', 'paused');
    expect(db.nextIssues()).toEqual([]);
  });

  it('skips with a reason', () => {
    const db = setup();
    const i = db.skip(db.issueByNumber('o/r', 1)!.id, 'nope');
    expect([i.state, i.skip_reason]).toEqual(['skipped', 'nope']);
  });

  it('round-trips through JSON, dropping only old agent calls', () => {
    const db = setup();
    const a = db.issueByNumber('o/r', 1)!;
    db.transition(a.id, 'pr_open', { score: 0.7, branch: 'fix/1-x', test_files: '["t.ts"]' });
    db.insertPr(a.id, 'https://github.com/o/r/pull/9', 9);
    db.updatePr(a.id, { ci_state: 'failure' });
    db.addAction(a.id, 'fix', 'msg', 'diff --git a/x b/x', 'f'.repeat(40));
    const pid = db.addProposal({ repo: 'o/r', kind: 'gap', title: 'T', body: 'B', labels: '["x"]', rationale: '', evidence: '[]', covers_issue: null, covers_rm: null, run_id: null });
    db.setSource({ repo: 'o/r', name: 's', pinned: 'a', upstream: 'b', digest: 'changed' });
    db.set('paused', '1');
    const call = { issueId: a.id, agent: 'coder', durationMs: 1, inputTokens: 1, outputTokens: 1, ok: true, resultJson: '{}', runId: 'r' };
    db.recordCall({ ...call, startedAt: new Date().toISOString(), costUsd: 1 });
    db.recordCall({ ...call, startedAt: '2020-01-01T00:00:00.000Z', costUsd: 9 });

    const json = JSON.parse(JSON.stringify(db.exportJson()));
    const back = new Db(':memory:');
    back.importJson(json);
    expect(back.issue(a.id)).toEqual(db.issue(a.id));
    expect(back.prForIssue(a.id)).toEqual(db.prForIssue(a.id));
    expect(back.pendingActions()).toEqual(db.pendingActions());
    expect(back.proposal(pid)).toEqual(db.proposal(pid));
    expect(back.sources('o/r')).toEqual(db.sources('o/r'));
    expect(back.get('paused')).toBe('1');
    expect(back.costForRun('r')).toBe(1);
    expect(back.exportJson()).toEqual({ ...json, exported_at: expect.any(String) });
    // A second import replaces, never appends.
    back.importJson(json);
    expect(back.allIssues().length).toBe(3);
  });

  it('lists flag keys by prefix, treating % and _ literally', () => {
    const db = setup();
    db.set('item:d/k:o/r:p1', '11'); db.set('item:d/k:o/r:a2', '12'); db.set('item:d/k:o/rx:p1', '13'); db.set('item_x', '1');
    expect(db.allKeys('item:d/k:o/r:')).toEqual(['item:d/k:o/r:a2', 'item:d/k:o/r:p1']);
    expect(db.allKeys('item_')).toEqual(['item_x']);
  });

  it('sums cost per run and window', () => {
    const db = setup();
    const call = { issueId: null, agent: 'triage', durationMs: 1, inputTokens: 1, outputTokens: 1, ok: true, resultJson: '{}' };
    db.recordCall({ ...call, runId: 'r1', startedAt: new Date().toISOString(), costUsd: 1.5 });
    db.recordCall({ ...call, runId: 'r2', startedAt: new Date().toISOString(), costUsd: 0.5 });
    db.recordCall({ ...call, runId: 'r0', startedAt: '2020-01-01T00:00:00.000Z', costUsd: 9 });
    expect(db.costForRun('r1')).toBe(1.5);
    expect(db.costSince(new Date(Date.now() - 86_400_000).toISOString())).toBe(2);
  });
});

describe('triagePriority', () => {
  it('puts bug reports before feature requests', async () => {
    const { triagePriority } = await import('../src/orchestrator.js');
    expect(triagePriority({ title: 'review hangs on stalled LLM request' })).toBe(2);
    expect(triagePriority({ title: 'bug(session): list prints null' })).toBe(2);
    expect(triagePriority({ title: 'feat(rules): add POSIX shell rules' })).toBe(0);
    expect(triagePriority({ title: '[Feature Request] Support X' })).toBe(0);
    expect(triagePriority({ title: 'Make prompt contract configurable' })).toBe(1);
  });
});

describe('isFeedback', () => {
  const c = (author: string, kind: PrComment['kind'] = 'review-comment', createdAt = '2026-10-13T05:00:00Z'): PrComment =>
    ({ kind, author, body: 'x', createdAt });
  const since = '2026-10-13T04:00:00Z';
  it('keeps humans, drops me, old comments and unlisted bots', () => {
    expect(isFeedback(c('alice', 'comment'), 'beiryu', since, [])).toBe(true);
    expect(isFeedback(c('beiryu'), 'beiryu', since, [])).toBe(false);
    expect(isFeedback(c('alice', 'comment', '2026-10-13T03:00:00Z'), 'beiryu', since, [])).toBe(false);
    expect(isFeedback(c('github-actions[bot]'), 'beiryu', since, [])).toBe(false);
  });
  it('keeps only inline comments from listed review bots', () => {
    expect(isFeedback(c('github-actions[bot]'), 'beiryu', since, ['github-actions[bot]'])).toBe(true);
    expect(isFeedback(c('github-actions[bot]', 'comment'), 'beiryu', since, ['github-actions[bot]'])).toBe(false);
    expect(isFeedback(c('CLAassistant', 'comment'), 'beiryu', since, ['github-actions[bot]'])).toBe(false);
  });
});
