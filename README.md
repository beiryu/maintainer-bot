# maintainer-bot

Keeps your **own** open-source repositories moving. It audits a repo for what is missing or
inconsistent and proposes issues; you approve them; it implements each one (failing test
first, then the change), runs the repo's own gate, has an adversarial reviewer agent check
the result, and opens the pull request on the repo itself. It also watches the upstream data
sources a repo pins, follows up on its open PRs, and drafts replies to other people's issues
and reviews of their PRs. You merge.

Everything happens **under your account**: issues, commits (signed by GitHub, Verified), PRs,
comments. Nothing on GitHub marks the bot's work; state AI use once in the repo's
CONTRIBUTING (`agent_disclosure` adds a line per PR if you want one).

Sibling of `oss-bot` (same pipeline; copied, not shared). oss-bot works on other people's
repos and asks before every post; maintainer-bot works on yours, so the only approval is
**the issue**: what gets filed is your call, the PR for an approved issue opens on its own.

## Pipeline

```
sources ─(watch)─▶ upstream digest ─┐
repo mirror ─(auditor)──────────────┴▶ proposal p<n> ─(tick / approve)─▶ GitHub issue, assigned to you
open issue assigned to you ─▶ claimed ─▶ reproduced ─▶ coded ─▶ gated ─▶ reviewed ─▶ pr_open ─(you merge)─▶ done
                           when it gives up: "bot dừng lại" on the dashboard; nothing is posted on GitHub
open PR: CI failed / review comments / behind base ─(followup agent)─▶ drafted fix, reply or rebase ─(tick a<n>)─▶ pushed
someone else's issue ─(maintainer-triage)─▶ draft d<n>: labels + reply ─(tick d<n> [+take])─▶ posted [+ assigned to you → pipeline]
someone else's PR ─(pr-reviewer, from the diff and its CI)─▶ draft d<n>: review ─(tick d<n> [+changes])─▶ posted
```

You take an issue the way any maintainer does, by assigning it to yourself. Other people's
issues are never worked on until you take them; their PRs are reviewed once per head commit,
the review is a comment or "request changes", never an approval. Gate fail or reviewer reject
→ back to `reproduced` (or `claimed` when the test itself is wrong), at most `max_attempts`
times; then the issue is handed back with the reason.

## On GitHub Actions (the normal way)

The bot runs inside the repository it maintains, as a reusable workflow. Nothing runs on
your machine; you decide on a pinned **Maintainer Dashboard** issue, from the phone if you like.

```
event (issue assigned to you, review comment, CI failed, weekly schedule, dashboard tick)
  ▼
agent job    read-only token + the model credential → agents, gate, reviewer → state file
  ▼
publish job  your fine-grained PAT, no model credential → ticks carried out, PRs opened
             (commits through the API, signed by GitHub), dashboard rendered, state saved
             on the branch maintainer-bot/state
```

Setup, per repository:

1. Copy [`templates/maintainer.yml`](templates/maintainer.yml) to `.github/workflows/maintainer.yml`
   and [`templates/maintainer-bot.yml`](templates/maintainer-bot.yml) to `.github/maintainer-bot.yml`
   (gate, focused test, conventions, scopes; the `bot:` block holds runtime, toolchains and budget).
2. Secrets: `MODEL_TOKEN` as a repository secret (a Copilot fine-grained PAT with **only**
   "Copilot Requests", or an Anthropic key with `runtime: claude`). `BOT_PAT` in an
   environment named `bot`: a fine-grained PAT of yours for **this repository only**, with
   Contents, Issues and Pull requests read/write (Metadata read comes with it). Not Workflows:
   the bot must not be able to change `.github/`.
3. Turn on "Keep my email addresses private" in your GitHub email settings, so API commits
   carry your noreply address.
4. Run the workflow once by hand (Actions → maintainer-bot → Run workflow): it creates and
   pins the dashboard. Keep `draft_prs: true` until the first PRs look right.

Then: assign an issue to yourself and the next run implements it; tick a checkbox on the
dashboard to approve a proposal, a drafted fix or a reply; comment `/reject p8 reason`,
`/retry #14`, `/take 12`, `/pause`, `/resume`.

Costs: Actions minutes are free for public repositories. Model spend is capped per agent
call (`max_cost_per_call_usd`) and per month (`max_cost_per_month_usd`); the dashboard shows
this month's total. The dashboard also warns when `BOT_PAT` is about to expire.

## On your machine

The same bot runs from a terminal with Docker as the sandbox, state in `data/state.db`, an
inbox instead of the dashboard. Useful for `repo add` (the scout drafts a config), `repo doctor`
(does the gate pass on the base?), dry runs, and repos you do not want on Actions.

```bash
npm install
docker build -t maintainer-bot-sandbox docker/      # Node 22 + pnpm, Go, Python/uv, Copilot CLI
gh auth login                                       # the account that owns the repos
cp config.example.yaml config.yaml                  # github_user, commit_signing_key, lock_file
echo 'export COPILOT_GITHUB_TOKEN=github_pat_...' > .env && chmod 600 .env
source .env
npm run -s maintainer-bot -- repo add https://github.com/you/repo   # scout drafts repos/<you>__<repo>.yaml, gate is probed
npm run -s maintainer-bot -- repo doctor you/repo   # every gate step must pass on the base
npm run -s maintainer-bot -- audit --repo you/repo  # proposals land in the inbox
npm run -s maintainer-bot -- inbox
```

| Command | What it does |
| --- | --- |
| `run` | follow up open PRs → other people's issues/PRs → watch sources + audit (when due) → pick up open issues assigned to you → advance → open PRs |
| `take <n> [--repo R]` | assign issue #n to you; the next run implements it |
| `run --repo R --issue N [--dry]` | one issue; `--dry` stops after review, `approve <id>` then opens the PR |
| `run --triage-only` / `--no-audit` / `--audit-only` | scoring only / skip or isolate the audit |
| `audit [--repo R]`, `watch` | sources + auditor now / sources only |
| `inbox [--refresh]`, `show <id>`, `cost` | what needs you; one item in full; spend by agent |
| `approve p<n> [--no-edit]` / `reject p<n> [reason]` | file or drop a proposal |
| `approve d<n> [--take] [--request-changes]` / `reject d<n>` | post or drop a drafted triage reply / PR review |
| `approve a<n>` / `reject a<n>` | send or discard a drafted reply/fix/rebase |
| `repo add\|remove\|list\|doctor` | per-repo config (`repos/<owner>__<name>.yaml`) |
| `state export\|import <file>` | the state as JSON (what the Actions jobs pass around) |

`launchd/dev.khanh.maintainerbot.plist` runs `bin/maintainer-bot-run.sh` every 2 hours for a
machine-hosted setup; `notify:` sends Telegram/Slack messages. With `push_via: api` the
machine, too, pushes through the API instead of a signing key.

## Security model

Agents and gate commands run where the repo's code can do no harm: a container on the
machine (`sandbox.mode: docker`), or a throwaway Actions job that holds nothing but the model
credential (`runner`), which the runtime strips from the agents' shell. The agent's clone is
untrusted: patches are exported from it and applied to clones the agent never touched;
`copilot` runs with explicit tool grants, `--disable-builtin-mcps`, `--deny-tool=url`,
`--secret-env-vars`, `--max-ai-credits`. Text from issues, PRs and upstream sources is wrapped
as untrusted data in every prompt, and cannot forge a dashboard marker. On Actions the job
that can write to GitHub runs no agent and no repository code; the job that runs agents can
only read. Other people's PRs are never executed there: the reviewer reads the diff and the
repository's own CI result.
