# maintainer-bot

Keeps your **own** open-source repositories moving. It audits a repo for what is missing or
inconsistent and proposes issues; you approve them from an inbox; it implements each one
(failing test first, then the change), runs the repo's own gate, has an adversarial reviewer
agent check the result, and opens the pull request on the repo itself. It also watches the
upstream data sources a repo pins and follows up on its open PRs. You merge.

Sibling of `oss-bot` (same sandbox, pipeline and inbox; copied, not shared). oss-bot works
on other people's repos and asks before every post; maintainer-bot works on yours, so the
only approval is **the issue**: what gets filed is your call, the PR for an approved issue
opens on its own.

## Pipeline

```
sources ─(watch)─▶ upstream digest ─┐
repo mirror ─(auditor)──────────────┴▶ proposal p<n> ─(approve p<n>, editor)─▶ GitHub issue, assigned to you
open issue assigned to you ─▶ claimed ─▶ reproduced ─▶ coded ─▶ gated ─▶ reviewed ─▶ pr_open ─(you merge)─▶ done
                           when it gives up: notification + "dừng lại" in the inbox; nothing is posted on GitHub
open PR: CI failed / review comments / behind base ─(followup agent)─▶ drafted fix, reply or rebase ─(approve a<n>)─▶ pushed
someone else's issue ─(maintainer-triage)─▶ draft d<n>: labels + reply ─(approve d<n> [--take])─▶ posted [+ assigned to you → pipeline]
someone else's PR ─(gate in sandbox + pr-reviewer)─▶ draft d<n>: review + recommendation ─(approve d<n> [--request-changes])─▶ posted
```

Nothing on GitHub marks the bot's work: no process labels, branches named like
`feat/17-…`, no tool line on PRs (state AI use once in the repo's CONTRIBUTING instead;
`agent_disclosure` adds a line per PR if you want one). You take an issue the way any
maintainer does, by assigning it to yourself. Other people's issues are never worked on
until you take them; their PRs are reviewed once
per head commit, the review is a comment or "request changes", never an approval.

Gate fail or reviewer reject → back to `reproduced` (or `claimed` when the test itself is
wrong), at most `limits.max_attempts` times; then the issue is handed back with the reason.

## Setup

```bash
npm install
docker build -t maintainer-bot-sandbox docker/      # Node 22 + pnpm, Go, Python/uv, Copilot CLI
gh auth login                                       # the account that owns the repos
cp config.example.yaml config.yaml                  # github_user, commit_signing_key, lock_file
echo 'export COPILOT_GITHUB_TOKEN=github_pat_...' > .env && chmod 600 .env   # Copilot PAT, "Copilot Requests" only
source .env
npm run -s maintainer-bot -- repo add https://github.com/you/repo   # scout drafts repos/<you>__<repo>.yaml, gate is probed
npm run -s maintainer-bot -- repo doctor you/repo   # every gate step must pass on the base
npm run -s maintainer-bot -- audit --repo you/repo  # proposals land in the inbox
npm run -s maintainer-bot -- inbox
```

Each repo is one file under `repos/`. Besides the gate and conventions it carries the
maintainer-side settings: `pick` (`assigned` or `any`), `roadmap_file`, `pr_types`/`pr_scopes`
(checked before a PR is opened, mirroring the repo's PR lint), `audit_files`, `sources`. See `repos/beiryu__vn-skills.yaml`.

## Daily use

| Command | What it does |
| --- | --- |
| `run` | follow up open PRs → other people's issues/PRs → watch sources + audit (when due per `audit_interval_hours`) → pick up open issues assigned to you (not skipped, no open PR) → advance → open PRs |
| `take <n> [--repo R]` | assign issue #n to you; the next run implements it |
| `run --repo R --issue N [--dry]` | one issue; `--dry` stops after review, `approve <id>` then opens the PR |
| `run --triage-only` | score every open issue without working on any |
| `run --no-audit` / `run --audit-only` | skip or isolate the audit |
| `audit [--repo R]` | watch sources + auditor now |
| `watch` | sources only, no agents |
| `inbox [--refresh]` | proposals, drafted follow-ups, open PRs, work in progress, queue |
| `show p<n> / a<n> / <id>` | a proposal, a drafted action, an issue with its diff and agent log |
| `approve p<n> [--no-edit]` | opens the issue (editor first, title on line 1) and queues it |
| `reject p<n> [reason]` | drops the proposal; the reason is shown to the next audit |
| `approve d<n> [--take] [--request-changes]` / `reject d<n>` | post or drop the triage reply / PR review drafted for someone else's issue or PR |
| `approve a<n>` / `reject a<n>` | send or discard a drafted reply/fix/rebase on an open PR |
| `repo add|remove|list|doctor` | per-repo config |
| `cost` | spend by agent |

Notifications (`notify:` in config) go out for every PR opened, every follow-up draft,
merges, closes, and a run summary with what needs you.

## Security model

Same as oss-bot: agents and gate commands run in the sandbox container with only the issue's
clone mounted and only the model credential (agents) or nothing (gate); the agent's clone is
untrusted, patches are exported inside the container and applied to host-made clones;
`copilot` runs with explicit tool grants, `--disable-builtin-mcps`, `--deny-tool=url`,
`--secret-env-vars`, `--max-ai-credits`. GitHub credentials stay on the host (`gh`). Text
from issues, PRs and upstream sources is wrapped as untrusted data in every prompt. The
Copilot token must be a fine-grained PAT with **only** "Copilot Requests".

Two bots on one Docker VM: set `lock_file` to the same path in both configs so they never
run a sandbox at the same time, and stagger their launchd intervals.

## Scheduling

`launchd/dev.khanh.maintainerbot.plist` runs `bin/maintainer-bot-run.sh` every 2 hours;
install it one hour after oss-bot's. Logs: `data/launchd.log`.
