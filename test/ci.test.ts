import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ciConfig, setupOutputs } from '../src/ci.js';

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
  limits: { audit_interval_hours: 168 }
focused_test: "pnpm vitest run {{file}}"
gate: ["pnpm test"]
pr_scopes: [core]
`), 'beiryu/vn-skills');
    expect(cfg.github_user).toBe('beiryu');
    expect(cfg.push_via).toBe('api');
    expect(cfg.sandbox.mode).toBe('runner');
    expect(cfg.sandbox.auth_env).toBe('COPILOT_GITHUB_TOKEN');
    expect(cfg.budget).toEqual({ max_cost_per_call_usd: 3, max_cost_per_month_usd: 100 });
    expect(cfg.limits.audit_interval_hours).toBe(168);
    expect(cfg.limits.max_attempts).toBe(3);
    expect(cfg.repos[0].full_name).toBe('beiryu/vn-skills');
    expect(cfg.repos[0].gate).toEqual(['pnpm test']);
    expect(cfg.repos[0].pr_scopes).toEqual(['core']);
  });
  it('lets the bot block pick claude and another account', () => {
    const cfg = ciConfig(file('bot: { runtime: claude, github_user: someone }\nfocused_test: x\n'), 'org/repo');
    expect([cfg.github_user, cfg.sandbox.runtime, cfg.sandbox.auth_env]).toEqual(['someone', 'claude', 'ANTHROPIC_API_KEY']);
  });
});

describe('setupOutputs', () => {
  it('tells the workflow which toolchains to install', () => {
    const out = setupOutputs(file('bot: { setup: [pnpm@12.11.2, go@1.24, uv] }\nfocused_test: x\n'));
    expect(out).toBe('runtime=copilot\nauth_env=COPILOT_GITHUB_TOKEN\nnode=22\npnpm=pnpm@12.11.2\ngo=1.24\nuv=true');
    expect(setupOutputs(file('focused_test: x\n'))).toBe('runtime=copilot\nauth_env=COPILOT_GITHUB_TOKEN\nnode=22\npnpm=\ngo=\nuv=');
  });
});
