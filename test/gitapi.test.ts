import { execaSync } from 'execa';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commitFileChanges, pushViaApi, type RefApi } from '../src/gitapi.js';

const run = (cwd: string, args: string[]) => execaSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@x', '-c', 'commit.gpgsign=false', ...args], { cwd }).stdout.trim();

/** A repo with a base commit, then two commits: add+modify+binary, then delete+rename. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'gitapi-'));
  run(dir, ['init', '-q', '-b', 'main']);
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  writeFileSync(join(dir, 'old.txt'), 'old\n');
  run(dir, ['add', '-A']); run(dir, ['commit', '-qm', 'base']);
  const base = run(dir, ['rev-parse', 'HEAD']);
  writeFileSync(join(dir, 'a.txt'), 'a2\n');
  writeFileSync(join(dir, 'b.bin'), Buffer.from([0, 255, 1]));
  run(dir, ['add', '-A']); run(dir, ['commit', '-qm', 'feat(x): first\n\nCloses #7']);
  rmSync(join(dir, 'old.txt'));
  writeFileSync(join(dir, 'new.txt'), 'old\n');
  run(dir, ['add', '-A']); run(dir, ['commit', '-qm', 'docs(repo): mark RM-1 done (#9)']);
  return { dir, base };
}

describe('commitFileChanges', () => {
  it('lists additions with base64 contents and deletions, renames as both', async () => {
    const { dir } = repo();
    const first = await commitFileChanges(dir, 'HEAD~1');
    expect(first.deletions).toEqual([]);
    expect(first.additions).toEqual([
      { path: 'a.txt', contents: Buffer.from('a2\n').toString('base64') },
      { path: 'b.bin', contents: Buffer.from([0, 255, 1]).toString('base64') },
    ]);
    const second = await commitFileChanges(dir, 'HEAD');
    expect(second).toEqual({ additions: [{ path: 'new.txt', contents: Buffer.from('old\n').toString('base64') }], deletions: [{ path: 'old.txt' }] });
  });
});

describe('pushViaApi', () => {
  const fake = (sha: string | null) => {
    const calls: string[] = [];
    let n = 0;
    const api: RefApi = {
      refSha: async () => sha,
      createRef: async (_r, b, s) => { calls.push(`create ${b.replace(/tmp-\w+/, 'tmp')}@${s.slice(0, 4)}`); },
      forceRef: async (_r, b, s) => { calls.push(`force ${b}@${s.slice(0, 4)}`); },
      deleteRef: async (_r, b) => { calls.push(`delete ${b.replace(/tmp-\w+/, 'tmp')}`); },
      createCommitOnBranch: async (_r, b, head, m, f) => {
        calls.push(`commit ${b.replace(/tmp-\w+/, 'tmp')} on ${head.slice(0, 4)}: ${m.headline} | ${m.body} | +${f.additions.map((a) => a.path)} -${f.deletions.map((d) => d.path)}`);
        return `new${++n}`;
      },
    };
    return { api, calls };
  };

  it('creates the branch at base and replays each commit on the previous one', async () => {
    const { dir, base } = repo();
    const { api, calls } = fake(null);
    const tip = await pushViaApi('o/r', dir, 'feat/7-x', base, { expectedHead: null }, api);
    expect(tip).toBe('new2');
    expect(calls).toEqual([
      `create feat/7-x@${base.slice(0, 4)}`,
      `commit feat/7-x on ${base.slice(0, 4)}: feat(x): first | Closes #7 | +a.txt,b.bin -`,
      'commit feat/7-x on new1: docs(repo): mark RM-1 done (#9) |  | +new.txt -old.txt',
    ]);
  });

  it('builds on the given head without touching the ref', async () => {
    const { dir, base } = repo();
    const { api, calls } = fake('abcd');
    await pushViaApi('o/r', dir, 'b', base, { expectedHead: 'abcd' }, api);
    expect(calls[0]).toMatch(/^commit b on abcd:/);
    expect(calls).toHaveLength(2);
  });

  it('force builds the replacement on a scratch branch and moves the PR branch once, never to the base', async () => {
    const { dir, base } = repo();
    const same = fake('abcd');
    const tip = await pushViaApi('o/r', dir, 'b', base, { expectedHead: 'abcd', force: true }, same.api);
    expect(tip).toBe('new2');
    expect(same.calls[0]).toBe(`create maintainer-bot/tmp@${base.slice(0, 4)}`);
    expect(same.calls.filter((c) => c.startsWith('force'))).toEqual(['force b@new2']);
    expect(same.calls.at(-1)).toBe('delete maintainer-bot/tmp');
    const moved = fake('ffff');
    await expect(pushViaApi('o/r', dir, 'b', base, { expectedHead: 'abcd', force: true }, moved.api)).rejects.toThrow(/moved on GitHub/);
    expect(moved.calls).toEqual([]);
  });
});
