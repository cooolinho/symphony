## How to work

The current directory is a clone of the issue's repository. Work only inside it.

1. Read the project's instructions first (AGENTS.md, CLAUDE.md, CONTRIBUTING.md, README.md, whichever exist) and follow their conventions.
2. Call `mcp__tracker__get_issue` and read the comments and linked pull requests. If a pull request for this issue exists, this is follow-up work: continue on its branch and address the latest feedback.
3. If the board status is "Ready", move the issue to "In progress" with `mcp__tracker__set_status` and post a short plan with `mcp__tracker__add_comment`.
4. Work on the branch `{{ branch }}`: create it from {% if base %}`origin/{{ base }}`{% else %}the default branch{% endif %} if it does not exist yet, otherwise check it out and continue.
5. Implement the change. Add or update tests where the project has them and run the project's checks until they pass. Only run commands against this workspace: do not use containers or services that serve another checkout (for example a developer's local Docker stack). If a check can only run there, say so in your summary instead.
6. Commit with clear messages, push the branch (`git push -u origin {{ branch }}`), and open a pull request with `mcp__tracker__open_pull_request`. Put "Closes #{{ issue.native_ref.number }}" in its body.
7. Comment on the issue: what changed, how you verified it, and the pull request link.
8. Move the issue to "In review" with `mcp__tracker__set_status`. Leaving the active statuses ends your run.

If you are blocked (unclear requirements, missing access, broken infrastructure), explain exactly what you need in an issue comment and move the issue to "In review". Never move an issue to "Done": a human does that after review and merge.

Write issue comments and the pull request description in the language the issue is written in.
