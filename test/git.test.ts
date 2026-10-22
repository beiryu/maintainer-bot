import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { filterPatch, git, mergeConflicts, parsePatch, readAgentFile } from '../src/git.js';

const block = (path: string, body = '@@ -1 +1 @@\n-a\n+b\n', extra = '') =>
  `diff --git a/${path} b/${path}\n${extra}index 1..2 100644\n--- a/${path}\n+++ b/${path}\n${body}`;

describe('parsePatch', () => {
  it('splits files and counts lines', () => {
    const files = parsePatch(block('src/A.java') + block('test/ATest.java', '@@ -1 +1,2 @@\n a\n+b\n+c\n'));
    expect(files.map((f) => [f.path, f.added, f.removed])).toEqual([['src/A.java', 1, 1], ['test/ATest.java', 2, 0]]);
  });
  it.each([
    ['.git/hooks/pre-push'],
    ['sub/.git/config'],
    ['../outside'],
    ['.oss-bot/PATCH.diff'],
  ])('rejects forbidden path %s', (p) => {
    expect(() => parsePatch(block(p))).toThrow(/forbidden path/);
  });
  it('rejects renames into .git', () => {
    expect(() => parsePatch(block('a.txt', '', 'similarity index 100%\nrename from a.txt\nrename to .git/hooks/x\n'))).toThrow();
  });
  it('rejects symlinks', () => {
    const p = 'diff --git a/link b/link\nnew file mode 120000\nindex 0..1\n--- /dev/null\n+++ b/link\n@@ -0,0 +1 @@\n+/etc/passwd\n';
    expect(() => parsePatch(p)).toThrow(/symlink/);
  });
  it('rejects quoted paths', () => {
    expect(() => parsePatch('diff --git "a/x y" "b/x y"\n')).toThrow(/unsupported/);
  });
  it('filters to selected files', () => {
    const patch = block('src/A.java') + block('test/ATest.java');
    expect(parsePatch(filterPatch(patch, (p) => p.startsWith('test/'))).map((f) => f.path)).toEqual(['test/ATest.java']);
  });
});

describe('readAgentFile', () => {
  const root = mkdtempSync(join(tmpdir(), 'oss-bot-'));
  const outside = mkdtempSync(join(tmpdir(), 'oss-bot-outside-'));
  writeFileSync(join(outside, 'secret'), 'top secret');
  mkdirSync(join(root, 'dir'));
  writeFileSync(join(root, 'dir', 'ok.txt'), 'fine');
  symlinkSync(join(outside, 'secret'), join(root, 'link'));
  symlinkSync(outside, join(root, 'dirlink'));

  it('reads regular files inside the root', () => {
    expect(readAgentFile(root, 'dir/ok.txt')).toBe('fine');
  });
  it('refuses a symlinked file', () => {
    expect(() => readAgentFile(root, 'link')).toThrow();
  });
  it('refuses a file behind a symlinked directory', () => {
    expect(() => readAgentFile(root, 'dirlink/secret')).toThrow();
  });
  it('refuses ../ escapes', () => {
    expect(() => readAgentFile(join(root, 'dir'), '../dir/../../' + outside.split('/').pop() + '/secret')).toThrow();
  });
});

describe('freshClone', () => {
  it('fetches a base the shallow mirror does not have', async () => {
    const { execaSync } = await import('execa');
    const { mkdtempSync, writeFileSync, mkdirSync: mk } = await import('node:fs');
    const { freshClone, mirrorDir, git } = await import('../src/git.js');
    const run = (cwd: string, args: string[]) => execaSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@x', '-c', 'commit.gpgsign=false', ...args], { cwd }).stdout.trim();
    const origin = mkdtempSync(join(tmpdir(), 'origin-'));
    run(origin, ['init', '-q', '-b', 'main']);
    writeFileSync(join(origin, 'a'), '1\n'); run(origin, ['add', '-A']); run(origin, ['commit', '-qm', 'one']);
    const old = run(origin, ['rev-parse', 'HEAD']);
    writeFileSync(join(origin, 'a'), '2\n'); run(origin, ['commit', '-qam', 'two']);
    run(origin, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
    const repo = `t/fc${Date.now()}`;
    const mirror = mirrorDir(repo);
    mk(join(mirror, '..'), { recursive: true });
    execaSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', '--depth', '1', `file://${origin}`, mirror]);
    expect(() => run(mirror, ['cat-file', '-e', `${old}^{commit}`])).toThrow();
    const dest = mkdtempSync(join(tmpdir(), 'dest-'));
    await freshClone(repo, old, join(dest, 'c'));
    expect(await git(join(dest, 'c'), ['rev-parse', 'HEAD'])).toBe(old);
    const { rmSync } = await import('node:fs');
    rmSync(mirror, { recursive: true, force: true });
  });
});

describe('mergeConflicts', () => {
  // base: a.txt = 1..5; main changes line 1, the PR changes line 1 differently or line 5.
  const repo = async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oss-bot-merge-'));
    const commit = async (content: string, msg: string) => {
      writeFileSync(join(dir, 'a.txt'), content);
      await git(dir, ['add', '-A']);
      await git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', msg]);
      return git(dir, ['rev-parse', 'HEAD']);
    };
    await git(dir, ['init', '-q']);
    const base = await commit('1\n2\n3\n4\n5\n', 'base');
    const main = await commit('one\n2\n3\n4\n5\n', 'main');
    await git(dir, ['checkout', '-q', base]);
    const clash = await commit('uno\n2\n3\n4\n5\n', 'clash');
    await git(dir, ['checkout', '-q', base]);
    const clean = await commit('1\n2\n3\n4\nfive\n', 'clean');
    return { dir, base, main, clash, clean };
  };
  it('names the files that conflict with the target', async () => {
    const r = await repo();
    expect(await mergeConflicts(r.dir, r.base, r.main, r.clash)).toEqual(['a.txt']);
  });
  it('is empty when the change merges, or is already on the target', async () => {
    const r = await repo();
    expect(await mergeConflicts(r.dir, r.base, r.main, r.clean)).toEqual([]);
    expect(await mergeConflicts(r.dir, r.main, r.main, r.clash)).toEqual([]);
  });
});
