import { describe, expect, it } from 'vitest';
import { Db } from '../src/db.js';
import { summarizeChecks } from '../src/github.js';
import { needsYou, renderInbox } from '../src/inbox.js';

const cfg = { repos: [{ full_name: 'o/r', sources: [] }], limits: { max_in_flight_per_repo: 1 } } as never;

describe('summarizeChecks', () => {
  it('pending beats failure beats success', () => {
    expect(summarizeChecks([])).toBe('none');
    expect(summarizeChecks([{ name: 'a', conclusion: 'SUCCESS', url: null }, { name: 'b', conclusion: 'NEUTRAL', url: null }])).toBe('success');
    expect(summarizeChecks([{ name: 'a', conclusion: 'SUCCESS', url: null }, { name: 'b', conclusion: 'FAILURE', url: null }])).toBe('failure');
    expect(summarizeChecks([{ name: 'a', conclusion: 'FAILURE', url: null }, { name: 'b', conclusion: 'PENDING', url: null }])).toBe('pending');
  });
});

describe('inbox', () => {
  it('lists every decision with the command to type', () => {
    const db = new Db(':memory:');
    db.upsertRepo('o/r');
    for (const [repo, n] of [['o/r', 1], ['o/r', 2], ['o/r', 3], ['o/r', 4]] as const) {
      db.insertDiscovered({ repo, number: n, title: `issue ${n}`, body: '', url: `u${n}` });
    }
    const id = (n: number) => db.issueByNumber('o/r', n)!.id;
    db.transition(id(1), 'reviewed', { pr_title: 'fix(x): thing', dry: 1 });
    db.transition(id(2), 'pr_open'); db.insertPr(id(2), 'https://github.com/o/r/pull/20', 20);
    db.updatePr(id(2), { ci_state: 'failure', review_decision: 'CHANGES_REQUESTED', mergeable: 'CONFLICTING' });
    const a = db.addAction(id(2), 'rebase', 'Rebase onto main @ abc: git re-applied it cleanly', 'diff', 'abc');
    db.transition(id(3), 'coded'); db.update(id(3), { blocked: 'gate broken on base: go test ./x' });
    db.transition(id(4), 'claimed');
    const p = db.addProposal({ repo: 'o/r', kind: 'gap', title: 'core: negative amounts unhandled', body: 'b', labels: '["type: bug"]', rationale: 'because', evidence: '[]', covers_issue: null, covers_rm: 'RM-013', run_id: null });

    const d = db.addDraft({ repo: 'o/r', target: 'pr', number: 31, title: 'feat(core): x', author: 'someone', head_sha: 'abc', message: 'thanks', labels_add: '[]', labels_remove: '[]', recommendation: 'changes: tests miss the error path', take: 0 });
    const todo = needsYou(db, cfg);
    expect(todo.some((l) => l.includes(`approve d${d} `) && l.includes('PR #31 @someone') && l.includes('→ changes: tests miss'))).toBe(true);
    expect(todo.some((l) => l.includes(`approve p${p} `) && l.includes('negative amounts') && l.includes('RM-013'))).toBe(true);
    expect(todo.some((l) => l.includes(`approve ${id(1)} `) && l.includes('fix(x): thing'))).toBe(true);
    expect(todo.some((l) => l.includes(`approve a${a} `) && l.includes('rebase'))).toBe(true);
    expect(todo.some((l) => l.includes('repo doctor o/r --fix'))).toBe(true);

    const text = renderInbox(db, cfg);
    expect(text).toContain('CI ✗');
    expect(text).toContain('CONFLICT');
    expect(text).toContain('CHANGES REQUESTED');
    expect(text).toContain('BLOCKED: gate broken');
    expect(text).toContain('claimed (attempt 0)');
  });
  it('is empty when nothing waits', () => {
    const db = new Db(':memory:');
    expect(needsYou(db, cfg)).toEqual([]);
    expect(renderInbox(db, cfg)).toContain('CẦN BẠN\n  (không có)');
  });
});

describe('proposals', () => {
  it('move pending → rejected/filed and keep the reason', () => {
    const db = new Db(':memory:');
    db.upsertRepo('o/r');
    const a = db.addProposal({ repo: 'o/r', kind: 'docs', title: 'a', body: 'b', labels: '[]', rationale: '', evidence: '[]', covers_issue: null, covers_rm: null, run_id: 'r' });
    const b = db.addProposal({ repo: 'o/r', kind: 'test', title: 'b', body: 'b', labels: '[]', rationale: '', evidence: '[]', covers_issue: 4, covers_rm: null, run_id: 'r' });
    expect(db.proposals('pending', 'o/r').map((p) => p.id)).toEqual([a, b]);
    db.updateProposal(a, { status: 'rejected', reject_reason: 'already fine' });
    db.updateProposal(b, { status: 'filed', issue_number: 9 });
    expect(db.proposals('pending')).toEqual([]);
    expect(db.proposal(a).reject_reason).toBe('already fine');
    expect(db.proposal(b).issue_number).toBe(9);
  });
});

describe('outside contributions', () => {
  it('tells the maintainer apart from everyone else, case-insensitively', async () => {
    const { isOutsider } = await import('../src/outside.js');
    expect(isOutsider('someone', 'beiryu')).toBe(true);
    expect(isOutsider('Beiryu', 'beiryu')).toBe(false);
    expect(isOutsider(undefined, 'beiryu')).toBe(false);
  });
  it('keeps one pending draft per issue or PR until it is sent or dropped', () => {
    const db = new Db(':memory:');
    const base = { repo: 'o/r', target: 'issue' as const, number: 5, title: 't', author: 'x', head_sha: null, message: 'm', labels_add: '["type: bug"]', labels_remove: '[]', recommendation: 'take', take: 1 };
    const id = db.addDraft(base);
    expect(db.pendingDraftFor('o/r', 'issue', 5)?.id).toBe(id);
    expect(db.pendingDraftFor('o/r', 'pr', 5)).toBeUndefined();
    db.setDraftStatus(id, 'done');
    expect(db.pendingDraftFor('o/r', 'issue', 5)).toBeUndefined();
    expect(db.drafts('done').map((d) => d.take)).toEqual([1]);
  });
});

describe('parseRepoArg', () => {
  it('accepts URLs and owner/name', async () => {
    const { parseRepoArg } = await import('../src/onboard.js');
    expect(parseRepoArg('https://github.com/beiryu/vn-skills')).toBe('beiryu/vn-skills');
    expect(parseRepoArg('https://github.com/beiryu/vn-skills.git/')).toBe('beiryu/vn-skills');
    expect(parseRepoArg('beiryu/vn-skills')).toBe('beiryu/vn-skills');
    expect(() => parseRepoArg('vn-skills')).toThrow();
  });
});

describe('normalizeScoutConfig', () => {
  it('joins notes given as lines, wraps single strings into lists, drops contributor-side keys', async () => {
    const { normalizeScoutConfig } = await import('../src/onboard.js');
    const n = normalizeScoutConfig({ notes: ['a', 'b'], skip_labels: 'wontfix', fork: 'me/x', claim_comment: '/assign', gate: ['x'], pr_scopes: 'core' });
    expect(n.notes).toBe('a\nb');
    expect(n.skip_labels).toEqual(['wontfix']);
    expect(n.pr_scopes).toEqual(['core']);
    expect('fork' in n).toBe(false);
    expect('claim_comment' in n).toBe(false);
    expect(n.gate).toEqual(['x']);
  });
});

describe('repo remove', () => {
  it('refuses while the repo has an open PR, and deletes everything once it has none', async () => {
    const { removeRepo } = await import('../src/onboard.js');
    const db = new Db(':memory:');
    db.upsertRepo('o/r');
    db.insertDiscovered({ repo: 'o/r', number: 1, title: 't', body: '', url: 'u' });
    const id = db.issueByNumber('o/r', 1)!.id;
    db.insertPr(id, 'https://github.com/o/r/pull/7', 7);
    db.recordCall({ runId: 'r', issueId: id, agent: 'coder', startedAt: 'x', durationMs: 1, inputTokens: null, outputTokens: null, costUsd: 0.5, ok: true, resultJson: '{}' });
    const ctx = { cfg: {} as never, db, runId: null };
    const opts = { configPath: '/nonexistent/config.yaml', yes: true };
    await expect(removeRepo(ctx, 'o/r', opts)).rejects.toThrow(/still has open PRs: https:\/\/github.com\/o\/r\/pull\/7/);
    db.updatePr(id, { state: 'merged' });
    await removeRepo(ctx, 'o/r', opts);
    expect(db.issuesForRepo('o/r')).toEqual([]);
    expect(db.repo('o/r')).toBeUndefined();
    expect(db.costSince('')).toBe(0.5); // spend history survives
  });
});
