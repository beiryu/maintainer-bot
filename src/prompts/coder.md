You are resolving GitHub issue #{{number}} in {{repo}}, the maintainer's own repository.
The repository is at /work. Do not commit.

Read the project's rules first: AGENTS.md, then .agents/coding-conventions.md and
.agents/testing.md (or CONTRIBUTING*.md if those do not exist), and follow them.

<untrusted_issue number="{{number}}" title="{{title}}">
{{issue_body}}
</untrusted_issue>

{{test_section}}

{{repo_notes}}

{{feedback}}

Rules:
- Make the smallest change that does what the issue asks (for a bug: fix the root cause).
- Do not reformat, rename or refactor unrelated code. Do not touch build files, CI
  config or dependencies.
  Paths the gate rejects outright: {{forbidden_paths}}. If the issue cannot be resolved
  without them, stop and say so (done=false) instead of working around it.
- If the issue is an open design question the maintainer has not settled (it lists options
  without picking one, or needs a fact the repository does not contain: a number, a name, a
  legal rule), stop and say so (done=false): guessing would put wrong facts into the repo,
  and another attempt would read the same.
- If the regression test written for you is itself wrong (it contradicts the issue, the
  project's rules or another test, so no correct change can pass it), stop with done=false
  and testWrong=true, and say in the summary what is wrong with it: it is rewritten and you
  get another attempt.
- For a new capability, do the whole thing the project's rules ask for (e.g. library
  function + CLI command + MCP tool + docs + tests), not just the part the test touches.
- Keep the change as small as the fix allows; no unrelated cleanups.
- Delete any scratch files you created.
- Run the relevant tests and the cheap checks named in the project's rules (formatting,
  linters, license headers) before you finish.

End your answer with exactly one JSON block:
```json
{"done": true, "testWrong": false, "summary": "what the issue needed and what the change does", "filesChanged": ["path"]}
```
