import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ciConfig, deskRepo, setupOutputs, withinHours } from '../src/ci.js';

const file = (text: string) => {
  const f = join(mkdtempSync(join(tmpdir(), 'mbci-')), 'maintainer-bot.yml');
  writeFileSync(f, text);
  return f;
};

describe('ciConfig', () => {
  it('builds a runner config for one repo from its .github/maintainer-bot.yml', () => {
    const cfg = ciConfig(file(`
bot:
  runtime: copilot
  setup: [node@22, pnpm@12.11.2]
  budget: { max_cost_per_month_usd: 100 }
  limits: { max_attempts: 5 }
focused_test: "pnpm vitest run {{file}}"
gate: ["pnpm test"]
pr_scopes: [core]
`), 'beiryu/vn-skills');
    expect(cfg.github_user).toBe('beiryu');
    expect(cfg.push_via).toBe('api');
    expect(cfg.sandbox.mode).toBe('runner');
    expect(cfg.sandbox.auth_env).toBe('COPILOT_GITHUB_TOKEN');
    expect(cfg.budget).toEqual({ max_cost_per_call_usd: 3, max_cost_per_month_usd: 100, per_agent_usd: {} });
    expect(cfg.limits.max_attempts).toBe(5);
    expect(cfg.repos[0].full_name).toBe('beiryu/vn-skills');
    expect(cfg.repos[0].gate).toEqual(['pnpm test']);
    expect(cfg.repos[0].pr_scopes).toEqual(['core']);
  });
  it('lets the bot block pick claude and another account', () => {
    const cfg = ciConfig(file('bot: { runtime: claude, github_user: someone }\nfocused_test: x\n'), 'org/repo');
    expect([cfg.github_user, cfg.sandbox.runtime, cfg.sandbox.auth_env]).toEqual(['someone', 'claude', 'ANTHROPIC_API_KEY']);
  });
});

describe('deskRepo', () => {
  it('is the repo itself unless the bot block names a private desk', () => {
    expect(deskRepo(file('focused_test: x\n'), 'beiryu/vn-skills')).toBe('beiryu/vn-skills');
    expect(deskRepo(file('bot: { dashboard_repo: beiryu/maintainer-desk }\nfocused_test: x\n'), 'beiryu/vn-skills')).toBe('beiryu/maintainer-desk');
  });
});

describe('setupOutputs', () => {
  it('tells the workflow which toolchains to install', () => {
    const out = setupOutputs(file('bot: { setup: [pnpm@12.11.2, go@1.24, uv] }\nfocused_test: x\n'));
    expect(out).toBe('runtime=copilot\nauth_env=COPILOT_GITHUB_TOKEN\nnode=22\npnpm=pnpm@12.11.2\ngo=1.24\nuv=true\nopen=true');
    expect(setupOutputs(file('focused_test: x\n'))).toBe('runtime=copilot\nauth_env=COPILOT_GITHUB_TOKEN\nnode=22\npnpm=\ngo=\nuv=\nopen=true');
  });
  it('says whether the run is in working hours', () => {
    const f = file('bot: { hours: "9-21", timezone: Asia/Ho_Chi_Minh }\nfocused_test: x\n');
    expect(setupOutputs(f, new Date('2026-10-22T02:30:00Z'))).toContain('open=true');   // 09:30 in Vietnam
    expect(setupOutputs(f, new Date('2026-10-22T14:30:00Z'))).toContain('open=false');  // 21:30
  });
});

describe('withinHours', () => {
  const at = (iso: string) => new Date(iso);
  it('includes the first hour and excludes the last', () => {
    expect(withinHours('9-21', 'Asia/Ho_Chi_Minh', at('2026-10-22T02:00:00Z'))).toBe(true);  // 09:00
    expect(withinHours('9-21', 'Asia/Ho_Chi_Minh', at('2026-10-22T13:59:00Z'))).toBe(true);  // 20:59
    expect(withinHours('9-21', 'Asia/Ho_Chi_Minh', at('2026-10-22T14:00:00Z'))).toBe(false); // 21:00
    expect(withinHours('9-21', 'Asia/Ho_Chi_Minh', at('2026-10-22T01:59:00Z'))).toBe(false); // 08:59
  });
  it('wraps past midnight and is always open without hours', () => {
    expect(withinHours('22-6', 'UTC', at('2026-10-22T23:00:00Z'))).toBe(true);
    expect(withinHours('22-6', 'UTC', at('2026-10-22T12:00:00Z'))).toBe(false);
    expect(withinHours(undefined, 'UTC', at('2026-10-22T12:00:00Z'))).toBe(true);
  });
});

describe('shortError', () => {
  it('turns a failed git command line into what failed and why', async () => {
    const { shortError } = await import('../src/ci.js');
    const e = Object.assign(new Error("Command failed with exit code 128: git -c 'core.hooksPath=/dev/null' checkout --quiet --detach 5a22"), { stderr: 'fatal: reference is not a tree: 5a22' });
    expect(shortError(e)).toBe('git checkout failed (exit 128): fatal: reference is not a tree: 5a22');
    expect(shortError(new Error('d3 is already done\nmore'))).toBe('d3 is already done');
  });
});

describe('stopComment', () => {
  it('states the reason plainly and how to resume, with nothing that says bot', async () => {
    const { stopComment } = await import('../src/ci.js');
    const c = stopComment('coder gave up: Blocked: vn-pit needs a legal source that is not in the repo', 69, '#59');
    expect(c).toBe('<!-- maintainer-bot:stop -->\nPausing this one: vn-pit needs a legal source that is not in the repo.');
    expect(c.replace(/<!--[^]*?-->/g, '')).not.toMatch(/bot|🤖/i); // hidden marker aside, nothing visible says bot
    expect(stopComment('error: rates belong in data/, which the bot cannot edit. The maintainer must supply a source first.', 69, ''))
      .toBe("<!-- maintainer-bot:stop -->\nPausing this one: rates belong in data/, which I can't edit. Need to supply a source first.");
  });
});
