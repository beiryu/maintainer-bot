import { describe, expect, it } from 'vitest';
import { layoutSummary, testCounts } from '../src/audit.js';
import { checkPrTitle } from '../src/orchestrator.js';
import { markDone, parseRoadmap, rmIdFromTitle, roadmapSummary } from '../src/roadmap.js';
import { lineDiff, pinnedSha } from '../src/watch.js';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROADMAP = `# Roadmap

## v0.2 — Launch-ready

### RM-001 · repo: golden fixtures

- status: filed (#2)
- milestone: v0.2
- labels: type: chore, area: core
- size: m
- agent: yes

Move expected values into fixtures.
Acceptance:

- [ ] each skill has a fixture

### RM-012 · vn-phone: normalise phone numbers

- status: planned
- milestone: v0.3
- size: s
- agent: yes
- depends: RM-001

Goal text.

---

## v0.4

### RM-020 · python: port

- status: idea
- size: l
- agent: no
`;

describe('roadmap', () => {
  it('parses items, fields and the filed issue number', () => {
    const items = parseRoadmap(ROADMAP);
    expect(items.map((i) => i.id)).toEqual(['RM-001', 'RM-012', 'RM-020']);
    const [a, b, c] = items;
    expect([a.scope, a.title, a.status, a.issue]).toEqual(['repo', 'golden fixtures', 'filed (#2)', 2]);
    expect(a.labels).toEqual(['type: chore', 'area: core']);
    expect(a.text).toContain('Acceptance:');
    expect([b.status, b.size, b.agent, b.depends]).toEqual(['planned', 's', 'yes', ['RM-001']]);
    expect([c.status, c.agent]).toEqual(['idea', 'no']);
    expect(roadmapSummary(items)).toContain('RM-012 [planned] vn-phone: normalise phone numbers  size=s agent=yes depends=RM-001');
  });
  it('marks one item done without touching the others', () => {
    const out = markDone(ROADMAP, 'RM-012', 42);
    expect(out).toContain('### RM-012 · vn-phone: normalise phone numbers\n\n- status: done (#42)');
    expect(out).toContain('- status: filed (#2)');
    expect(out).toContain('- status: idea');
    expect(() => markDone(ROADMAP, 'RM-999', 1)).toThrow(/not in the roadmap/);
  });
  it('finds the roadmap id in an issue title', () => {
    expect(rmIdFromTitle('[RM-012] vn-phone: normalise')).toBe('RM-012');
    expect(rmIdFromTitle('fix: RM-001 fixtures')).toBe('RM-001');
    expect(rmIdFromTitle('plain title')).toBeNull();
  });
});

describe('checkPrTitle', () => {
  const rc = { pr_types: ['feat', 'fix', 'docs'], pr_scopes: ['core', 'cli'] } as never;
  it('accepts a title the repo lint would', () => {
    expect(checkPrTitle('feat(core): add phone parser', rc)).toBeNull();
    expect(checkPrTitle('docs: fix typo', rc)).toBeNull();
  });
  it('rejects wrong shape, type and scope', () => {
    expect(checkPrTitle('Add phone parser', rc)).toMatch(/type\(scope\)/);
    expect(checkPrTitle('chore(core): x', rc)).toMatch(/type "chore"/);
    expect(checkPrTitle('fix(web): x', rc)).toMatch(/scope "web"/);
  });
  it('checks nothing beyond the shape when the repo lists no types', () => {
    expect(checkPrTitle('anything(x): y', { pr_types: [], pr_scopes: [] } as never)).toBeNull();
  });
});

describe('audit context', () => {
  it('folds the file list into directories with counts', () => {
    const out = layoutSummary(['README.md', 'packages/core/src/a.ts', 'packages/core/src/b.ts', 'packages/cli/src/x.ts', 'tests/a.test.ts']);
    expect(out).toContain('(root)  1 file');
    expect(out).toContain('packages/core/  2 files');
    expect(out).toContain('packages/cli/  1 file');
    expect(out).toContain('tests/  1 file');
  });
  it('counts test cases per file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mb-'));
    mkdirSync(join(dir, 'tests'));
    writeFileSync(join(dir, 'tests', 'a.test.ts'), `describe('x', () => {\n  it('one', () => {});\n  test('two', () => {});\n  it.each([1])('three', () => {});\n});\n`);
    expect(testCounts(dir, ['tests/a.test.ts', 'src/b.ts'])).toBe('tests/a.test.ts  3');
  });
});

describe('watch', () => {
  it('reads the sha pinned next to a repo name in a build script or a sources table', () => {
    const script = `const S = { repo: 'thanglequoc/vietnamese-provinces-database', sha: '8b78ba5118715e1fa81769286724db79346abf52' };`;
    expect(pinnedSha(script, 'thanglequoc/vietnamese-provinces-database')).toBe('8b78ba5118715e1fa81769286724db79346abf52');
    const table = `| provinces.json | [x/y](https://github.com/x/y) | \`7fac8c4\` | MIT |`;
    expect(pinnedSha(table, 'x/y')).toBe('7fac8c4');
    expect(pinnedSha('nothing here', 'x/y')).toBeNull();
  });
  it('diffs lines, not markup', () => {
    expect(lineDiff('a\nb\nc', 'a\nc\nd')).toBe('- b\n+ d');
  });
});
