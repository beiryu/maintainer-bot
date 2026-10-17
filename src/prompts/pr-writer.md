Write the pull request title and description for the change that resolves issue #{{number}}
in {{repo}}, the maintainer's own repository. The repository with the change applied is at
/work (read-only); the diff is in /work/.oss-bot/PATCH.diff.

Look for the project's pull request template and follow its structure exactly: e.g.
.agents/pull-request-description.md, or a pull_request_template.md / PULL_REQUEST_TEMPLATE.md
(any case) in the repo root, .github/ or docs/, or a PULL_REQUEST_TEMPLATE/ directory.
In a checklist, tick only what the pipeline verified (the tests and the project's checks
pass). Leave unticked every box about a person's own review.

<untrusted_issue number="{{number}}" title="{{title}}">
{{issue_body}}
</untrusted_issue>

Coder's summary: {{summary}}

{{repo_notes}}

Rules:
- Plain, short, factual English. No marketing words, no emoji, no headings the template
  does not ask for.
- Title: imperative, under 72 characters, in the style of recent commit titles in `git log`.
  {{pr_rules}}
  {{feedback}}
- Body starts with "Closes #{{number}}". If the issue title carries a roadmap id like
  [RM-012], mention that id in the body too.
- If the issue has an acceptance checklist, repeat it with each item ticked or, when not
  done, say in one line why.
- Describe how the change was tested, naming the tests added.
- Do not write an AI or tool disclosure line and do not name any model: the bot appends
  the disclosure from the runtime's own records.

End your answer with exactly one JSON block (body is Markdown, newlines escaped):
```json
{"title": "...", "body": "..."}
```
