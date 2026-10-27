import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';

// An upstream the repo's data is built from. The bot compares what the repo pins with
// what upstream has now and hands the difference to the research run.
const Source = z.object({
  name: z.string(),
  // github: a repository whose pinned commit is read from `pinned_from` (a 40-hex sha near the repo name).
  // url: a page whose text is snapshotted and diffed between runs.
  kind: z.enum(['github', 'url']),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).optional(),
  url: z.string().url().optional(),
  // File in the repo that holds the pinned sha for this source (default: the SOURCES.md next to the data).
  pinned_from: z.string().optional(),
  // Only upstream commits touching these paths matter.
  paths: z.array(z.string()).default([]),
  note: z.string().default(''),
});

// The bot works on the user's own repositories: it pushes branches to the repo itself,
// opens issues from its own audit and opens PRs without a claim step.
const RepoConfig = z.object({
  full_name: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  default_branch: z.string().default('main'),
  branch_prefix: z.string().default(''),
  // Branch name after the prefix; {{type}} (the PR title's Conventional Commit type, e.g. feat),
  // {{number}} and {{slug}} are filled in.
  branch_name: z.string().default('{{type}}/{{number}}-{{slug}}'),
  // Which open issues are work: 'assigned' = assigned to github_user (the maintainer takes an
  // issue the usual way, by assigning it); 'any' = every open issue not skipped by a label.
  pick: z.enum(['assigned', 'any']).default('assigned'),
  // Only issues with one of these labels are picked up (empty: any open issue not skipped).
  labels: z.array(z.string()).default([]),
  skip_labels: z.array(z.string()).default([]),
  // Command template for the reproducer's test; {{vars}} come from the reproducer's testVars.
  focused_test: z.string(),
  gate: z.array(z.string()).default([]),
  forbidden_paths: z.array(z.string()).default([]),
  // When set, the patch may only touch files under these paths (e.g. one package of a monorepo).
  allowed_paths: z.array(z.string()).default([]),
  // Appended to every PR body when set ('' = none; the repo may state AI use once in its docs instead).
  agent_disclosure: z.string().default(''),
  // Project conventions the agents must follow beyond what they read in the repo. Also the
  // reviewer's checklist and part of what the planner measures the repo against.
  notes: z.string().default(''),
  // What research looks for. features: the next features to build (the web research only;
  // the newcomer tryout and code review, which mostly find fixes, are skipped) and the planner
  // opens a fix only for a wrong result or a crash. all: features, fixes, polish and outreach.
  focus: z.enum(['features', 'all']).default('features'),
  // Bot accounts whose inline review comments count as feedback, e.g. "github-actions[bot]".
  review_bots: z.array(z.string()).default([]),
  // Commands run after the commit, in a clone with full history, before pushing; what they
  // change is folded into the same commit.
  after_commit: z.array(z.string()).default([]),
  signoff: z.boolean().default(false),
  // --- maintainer role ---
  // Roadmap the planner reads (items `### RM-NNN · scope: title` with a `- status:` line); '' when none.
  roadmap_file: z.string().default(''),
  // Conventional Commits types/scopes the repo's PR lint accepts; the PR title is checked before opening.
  pr_types: z.array(z.string()).default([]),
  pr_scopes: z.array(z.string()).default([]),
  // Files the planner gets in full (rules, docs, API surface) besides the roadmap; relative to the repo.
  audit_files: z.array(z.string()).default(['README.md', 'CONTRIBUTING.md', 'AGENTS.md']),
  sources: z.array(Source).default([]),
  // none: the change may not touch dependencies. existing: it may add a dependency the repo
  // already uses somewhere (any package.json), or one listed in allowed_dependencies.
  dependencies: z.enum(['none', 'existing']).default('none'),
  allowed_dependencies: z.array(z.string()).default([]),
  // Packages the project publishes, for the traction numbers the planner weighs (npm names).
  packages: z.array(z.string()).default([]),
});

const Config = z.object({
  // Account `gh` must be logged in as on the host (issues, pushes, PRs). The Copilot
  // token can belong to a different account; this one is checked so the bot never posts
  // as the wrong identity.
  github_user: z.string().regex(/^[\w-]+$/),
  // Private half of an SSH key added to github_user as a *signing* key: every commit the bot
  // makes is then signed (Verified). Without passphrase, since runs are unattended.
  commit_signing_key: z.string().optional(),
  // git: commits are made and pushed here, signed with commit_signing_key. api: the local
  // commits are replayed through GitHub's API, which signs them itself (Verified under
  // github_user); no key is needed, which is what a runner wants.
  push_via: z.enum(['git', 'api']).default('git'),
  repos: z.array(RepoConfig).default([]),
  // No cap on open PRs, issues being worked on or research items: the bot takes everything it finds.
  limits: z.object({
    // A run stops before cloning or building when the disk holding work/ has less free space.
    min_free_disk_gb: z.number().default(15),
    // After each run the least recently used Go build output is dropped while the cache is past this (modules stay).
    max_go_build_cache_gb: z.number().default(6),
    max_attempts: z.number().default(3),
  }),
  budget: z.object({
    max_cost_per_call_usd: z.number().default(3),
    // No agent runs once this month's recorded spend reaches it (0: no limit); the dashboard says so.
    max_cost_per_month_usd: z.number().default(0),
    // A higher cap for some agents (the research steps), by agent name.
    per_agent_usd: z.record(z.string(), z.number()).default({}),
  }),
  sandbox: z.object({
    // docker: agents and gate commands run in a throwaway container on this machine.
    // runner: they run directly in the current environment, which is itself throwaway (a
    // GitHub Actions job). Nothing on the host is protected from the agent then, so the
    // environment must hold no credential beyond the model's.
    mode: z.enum(['docker', 'runner']).default('docker'),
    image: z.string().default('maintainer-bot-sandbox'),
    memory: z.string().default('5g'),
    cpus: z.string().default('4'),
    // Agent CLI run inside the container.
    runtime: z.enum(['copilot', 'claude']).default('copilot'),
    // Env var that carries the model credential into agent containers. For copilot this
    // must be a fine-grained PAT with only the "Copilot Requests" permission, never the
    // token `gh` uses on the host.
    auth_env: z.enum(['COPILOT_GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']).default('COPILOT_GITHUB_TOKEN'),
    model: z.string().optional(),
    // Per agent: a stronger model and more reasoning where judgement matters (the research steps, the planner).
    models: z.record(z.string(), z.string()).default({}),
    reasoning: z.record(z.string(), z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])).default({}),
    cache_volume: z.string().default('maintainer-bot-cache'),
    agent_timeout_min: z.number().default(30),
    gate_timeout_min: z.number().default(60),
  }),
  // Lock held while a run is in progress. Point oss-bot and this bot at the same file when
  // both are scheduled on one machine: two sandboxes do not fit the Docker VM together.
  lock_file: z.string().default('data/run.lock'),
  notify: z.preprocess((v) => v ?? {}, z.object({
    telegram_chat_id: z.string().optional(), // token read from TELEGRAM_BOT_TOKEN
    slack_webhook_env: z.string().optional(),
  })),
}).superRefine((c, ctx) => {
  for (const r of c.repos) {
    for (const s of r.sources) {
      if (s.kind === 'github' && !s.repo) ctx.addIssue({ code: 'custom', path: ['repos'], message: `${r.full_name}: source ${s.name} needs repo` });
      if (s.kind === 'url' && !s.url) ctx.addIssue({ code: 'custom', path: ['repos'], message: `${r.full_name}: source ${s.name} needs url` });
    }
  }
});

export type RepoConfig = z.infer<typeof RepoConfig>;
export type SourceConfig = z.infer<typeof Source>;
export type Config = z.infer<typeof Config>;
export const RepoConfigSchema = RepoConfig;
export const parseConfig = (raw: unknown): Config => Config.parse(raw);

/** `owner/name` → `owner`. */
export const repoOwner = (fullName: string) => fullName.split('/')[0];

// One file per repo next to config.yaml: `repo add` writes them, `repo remove` deletes them.
export const reposDir = (configPath = 'config.yaml') => join(dirname(configPath), 'repos');
export const repoFile = (fullName: string, configPath = 'config.yaml') =>
  join(reposDir(configPath), `${fullName.replace('/', '__')}.yaml`);

export function loadConfig(path = 'config.yaml'): Config {
  const raw = parse(readFileSync(path, 'utf8')) ?? {};
  const inline: unknown[] = Array.isArray(raw.repos) ? raw.repos : [];
  const dir = reposDir(path);
  const fromFiles = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort()
      .map((f) => ({ ...parse(readFileSync(join(dir, f), 'utf8')), _file: f }))
    : [];
  // A repos/*.yaml file wins over a leftover block in config.yaml for the same repo.
  const names = new Set(fromFiles.map((r) => r.full_name));
  const repos = [...fromFiles.map(({ _file, ...r }) => r), ...inline.filter((r) => !names.has((r as { full_name?: string }).full_name))];
  return Config.parse({ ...raw, repos });
}

/** Writes repos/<owner>__<name>.yaml; comments in an existing file are not kept. */
export function writeRepoConfig(rc: RepoConfig, configPath = 'config.yaml') {
  mkdirSync(reposDir(configPath), { recursive: true });
  writeFileSync(repoFile(rc.full_name, configPath), stringify(rc, { lineWidth: 0 }));
}

export function repoConfig(cfg: Config, fullName: string): RepoConfig {
  const r = cfg.repos.find((x) => x.full_name === fullName);
  if (!r) throw new Error(`repo ${fullName} is not configured (repos/*.yaml or config.yaml)`);
  return r;
}
