import { describe, expect, it } from 'vitest';
import type { RepoConfig } from '../src/config.js';
import { repairPathVars, staticChecks } from '../src/gate.js';

const repo = { forbidden_paths: ['.github/', 'LICENSE', 'gradle/'], allowed_paths: [] as string[] } as RepoConfig;
const block = (path: string, added: string[] = ['+x']) =>
  `diff --git a/${path} b/${path}\nindex 1..2 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${added.join('\n')}\n`;

describe('staticChecks', () => {
  it('passes a small clean diff', () => {
    expect(staticChecks(block('core/A.java'), repo)).toEqual({ ok: true });
  });
  it('fails an empty diff', () => {
    expect(staticChecks('', repo).ok).toBe(false);
  });
  it('blocks forbidden paths by prefix and exact name, not by substring', () => {
    expect(staticChecks(block('.github/workflows/ci.yml'), repo).ok).toBe(false);
    expect(staticChecks(block('LICENSE'), repo).ok).toBe(false);
    expect(staticChecks(block('gradle/wrapper/x'), repo).ok).toBe(false);
    expect(staticChecks(block('docs/LICENSE-notes.md'), repo).ok).toBe(true);
    expect(staticChecks(block('core/gradle/x'), repo).ok).toBe(true);
  });
  it('keeps a patch inside allowed paths when they are set', () => {
    const scoped = { ...repo, allowed_paths: ['libs/python/agent/', 'libs/python/core'] } as RepoConfig;
    expect(staticChecks(block('libs/python/agent/x.py'), scoped).ok).toBe(true);
    expect(staticChecks(block('libs/python/core/tests/t.py'), scoped).ok).toBe(true);
    expect(staticChecks(block('libs/python/core-extra/x.py'), scoped).ok).toBe(false);
    expect(staticChecks(block('libs/cua-driver/rust/x.rs'), scoped)).toMatchObject({ ok: false, reason: /outside allowed paths/ });
  });
  it('catches secrets in added lines only', () => {
    expect(staticChecks(block('a', ['+key = "AKIAABCDEFGHIJKLMNOP"']), repo).ok).toBe(false);
    expect(staticChecks(block('a', ['+-----BEGIN RSA PRIVATE KEY-----']), repo).ok).toBe(false);
    expect(staticChecks(block('a', ['-old AKIAABCDEFGHIJKLMNOP']), repo).ok).toBe(true);
  });
  it('rejects patches that touch .git', () => {
    expect(staticChecks(block('.git/hooks/post-checkout'), repo)).toMatchObject({ ok: false, reason: /forbidden/ });
  });
});

describe('failureExcerpt', () => {
  it('keeps a go test failure buried in thousands of PASS lines', async () => {
    const { failureExcerpt } = await import('../src/sandbox.js');
    const pass = Array.from({ length: 3000 }, (_, i) => `--- PASS: TestX${i} (0.00s)`);
    const out = [...pass.slice(0, 1500), '--- FAIL: TestCodeSearch (0.01s)', '    code_search_test.go:42: want 0 matches, got exit 128',
      ...pass.slice(1500), 'FAIL\tgithub.com/x/internal/tool\t1.2s', 'make: *** [test] Error 1'].join('\n');
    const ex = failureExcerpt(out);
    expect(ex).toContain('--- FAIL: TestCodeSearch');
    expect(ex).toContain('code_search_test.go:42');
    expect(ex.split('\n').length).toBeLessThanOrEqual(205);
  });
});

describe('missingAddedLines', () => {
  const repro = 'diff --git a/x_test.go b/x_test.go\n--- a/x_test.go\n+++ b/x_test.go\n@@ -1,1 +1,3 @@\n package x\n+func TestA(t *testing.T) {\n+\tif f() != 1 { t.Fatal() }\n';
  it('allows the coder to add tests next to the reproducer test', async () => {
    const { missingAddedLines } = await import('../src/gate.js');
    const final = repro + '+func TestB(t *testing.T) {}\n';
    expect(missingAddedLines(repro, final)).toEqual([]);
  });
  it('flags an edited reproducer line', async () => {
    const { missingAddedLines } = await import('../src/gate.js');
    const final = repro.replace('f() != 1', 'f() != f()');
    expect(missingAddedLines(repro, final)).toHaveLength(1);
  });
});

describe('followupCommitMessage', () => {
  it('reuses the PR title prefix', async () => {
    const { followupCommitMessage } = await import('../src/orchestrator.js');
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'oss-bot-'));
    expect(followupCommitMessage(dir, 'Plain title')).toBe('Address review feedback');
    expect(followupCommitMessage(dir, 'feat!: big change')).toBe('feat: address review feedback');
    writeFileSync(join(dir, 'PR_BODY.md'), 'fix(tool): retry code_search as literal\n\nbody');
    expect(followupCommitMessage(dir, null)).toBe('fix(tool): address review feedback');
  });
});

describe('repairPathVars', () => {
  const files = ['app/cli/pkg/action/trace_test.go'];
  it('expands a sub-project-relative package path to the test file directory', () => {
    expect(repairPathVars({ pkg: 'pkg/action', test: 'TestX' }, files)).toEqual({ pkg: 'app/cli/pkg/action', test: 'TestX' });
    expect(repairPathVars({ pkg: './pkg/action' }, files)).toEqual({ pkg: './app/cli/pkg/action' });
  });
  it('leaves correct, ambiguous and test-name values alone', () => {
    expect(repairPathVars({ pkg: 'app/cli/pkg/action' }, files)).toEqual({ pkg: 'app/cli/pkg/action' });
    expect(repairPathVars({ pkg: 'action' }, [...files, 'x/action/a_test.go'])).toEqual({ pkg: 'action' });
    expect(repairPathVars({ test: 'action' }, files)).toEqual({ test: 'action' });
  });
});

describe('sandbox modes', () => {
  it('names the container mounts under docker and the real directories on a runner', async () => {
    const { outPath, workPath } = await import('../src/sandbox.js');
    const docker = { sandbox: { mode: 'docker' } } as Parameters<typeof workPath>[0];
    const runner = { sandbox: { mode: 'runner' } } as Parameters<typeof workPath>[0];
    expect([workPath(docker, 'work/x'), outPath(docker, 'data/o')]).toEqual(['/work', '/out']);
    expect(workPath(runner, 'work/x')).toMatch(/^\/.*\/work\/x$/);
    expect(outPath(runner, 'data/o')).toMatch(/^\/.*\/data\/o$/);
  });
});

describe('dependency rule', () => {
  it('lists what a patch adds per package.json, and checks it against the rest of the repo', async () => {
    const { addedDependencies, checkDependencies } = await import('../src/gate.js');
    expect(addedDependencies(
      { 'a/package.json': { dependencies: { x: '1' } } },
      { 'a/package.json': { dependencies: { x: '1', y: '^2' }, devDependencies: { z: '3' } }, 'b/package.json': { dependencies: { x: '1' } } },
    )).toEqual([
      { file: 'a/package.json', name: 'y', version: '^2' },
      { file: 'a/package.json', name: 'z', version: '3' },
      { file: 'b/package.json', name: 'x', version: '1' },
    ]);
    const { execaSync } = await import('execa');
    const { mkdtempSync, writeFileSync, mkdirSync: mk } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'deps-'));
    const run = (args: string[]) => execaSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@x', '-c', 'commit.gpgsign=false', ...args], { cwd: dir });
    run(['init', '-q', '-b', 'main']);
    mk(join(dir, 'cli')); mk(join(dir, 'mcp'));
    writeFileSync(join(dir, 'cli/package.json'), JSON.stringify({ dependencies: { jsqr: '^1.4.0' } }));
    writeFileSync(join(dir, 'mcp/package.json'), JSON.stringify({ dependencies: {} }));
    run(['add', '-A']); run(['commit', '-qm', 'base']);
    const base = run(['rev-parse', 'HEAD']).stdout.trim();
    writeFileSync(join(dir, 'mcp/package.json'), JSON.stringify({ dependencies: { jsqr: '^1.4.0', leftpad: '1' } }));
    const rc = (dependencies: 'none' | 'existing', allowed: string[] = []) => ({ dependencies, allowed_dependencies: allowed }) as never;
    expect((await checkDependencies(rc('none'), dir, base)).fail).toMatch(/does not allow/);
    expect((await checkDependencies(rc('existing'), dir, base)).fail).toMatch(/does not use anywhere yet: leftpad/);
    const ok = await checkDependencies(rc('existing', ['leftpad']), dir, base);
    expect(ok).toEqual({ fail: null, added: ['jsqr@^1.4.0 (mcp/package.json)', 'leftpad@1 (mcp/package.json)'] });
  });
});
