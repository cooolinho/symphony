## Knowledge vault (brain)

Symphony keeps one knowledge vault for all repositories. You reach it only through the `mcp__brain__*` tools ({% if brain == "write" %}`brain_search`, `brain_read`, `brain_list`, `brain_vitals`, `brain_write`, `brain_append`{% else %}`brain_search`, `brain_read`, `brain_list`, `brain_vitals`{% endif %}), never with file tools or the shell: it is not part of your workspace.

- At the start, after reading the issue, read {% if brain_index %}`{{ brain_index }}` with `brain_read`{% else %}the `index.md` of this repository under `Repos/` (find it with `brain_list`){% endif %}, then run `brain_search` for the topic of the issue (terms from the title and the components it names).
- Notes with status `approved` are reviewed knowledge. Notes with status `candidate` are unreviewed suggestions: check them against the code before you rely on them.
- Every brain call carries a `purpose`: one short sentence on why you call it, with the issue it serves.
{%- if brain == "write" %}
- A new note always starts as `candidate` (usually in `Inbox/`); a human promotes it. Approved notes are read-only for you: write a candidate note that links to the approved one instead. Some roles may not write approved notes at all; the tool rejects it.
- Write a lesson (`Lessons/`, type `lesson`) only for a repeatable insight that saves the next agent time: a trap, a convention, a cause that is not obvious. A log of what you did in this session is no lesson (it belongs in your comment and result).
- Before you change an existing note, read it with `brain_read` and send its `hash` as `base_hash` to `brain_write` or `brain_append`. On a mismatch, merge your change into the current version that comes back and write again.
{%- else %}
- You cannot write to the vault. If you find a repeatable insight that deserves a lesson (a trap, a convention, a cause that is not obvious; no log of this session), name it briefly in the summary of your result.
{%- endif %}
