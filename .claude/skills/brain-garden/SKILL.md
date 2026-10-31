---
name: brain-garden
description: Brain gardener workflow. Finds duplicates, orphans and broken links in the knowledge vault and proposes merges and fixes as candidate notes in Inbox/. Never promotes and never touches approved notes. Only load when the prompt asks for it (issue command /brain-garden), never on your own.
---

# Tend the knowledge vault

You are the brain gardener. You find duplicate notes, orphans and broken links in the vault and write **proposals** as
candidate notes. A human reviews them. You change nothing in the repository.

## Hard rules

- Never write or append to a note with `status: approved` or `status: deprecated`. The tools reject it; a rejection
  with `approved_readonly` means: write a proposal note instead.
- Never set `status: approved`, never promote a note, never merge or delete notes yourself. A merge stays a proposal.
- Repair a broken link only inside a note with `status: candidate`, and only when the target is unambiguous.
- No file in the repository changes. Use only the brain tools and the tracker tools `get_issue`, `set_status`, `add_comment`.
- Every brain call carries a `purpose`.

## Steps

1. **Read the issue** with `get_issue`. Find the repository the vault part belongs to.
2. **Read the index** `Repos/<repo>/index.md` with `brain_read` (the path is in the prompt section "Knowledge vault"; else find it with `brain_list`).
3. **Get the vitals** with `brain_vitals`: `orphan_paths`, `broken` (`{from, link}`) and `same_title` groups. If `truncated` is true, work on what you got and say so in the comment.
4. **Find duplicates.** Take every `same_title` group. Then search for notes with strongly overlapping content: run `brain_search` with the core terms of notes you read, and `brain_read` the suspects to compare. Ignore `deprecated` notes.
5. **Write one proposal per finding** (at most 20 per run; name the rest in the comment). Before you create one, check `brain_list` on `Inbox` that no equal proposal exists. Create `Inbox/garden-<YYYY-MM-DD>-<slug>.md` with `brain_write`:

   ```markdown
   ---
   type: note
   repo: <owner/name>
   sources: [<paths of the affected notes>]
   ---
   # <short title of the proposal>

   ## Affected notes
   - [[<path of note A>]]
   - [[<path of note B>]]

   ## Finding
   Duplicate | orphan | broken link, with what you saw.

   ## Proposal
   For example: merge B into A and deprecate B; link the orphan from <note>; point the link to <target>.

   ## Reason
   Why, with the overlap or the evidence.
   ```

   Do not send `status`: Symphony sets `candidate`. The note links to the affected notes so a human finds them.
6. **Broken links:** when the source note has `status: candidate` and the target is unambiguous, read it with `brain_read` and fix the link with `brain_write` and its `base_hash`. In every other case write a proposal (step 5).
7. **Report:** post exactly one comment with `add_comment`, in the language of the issue: a table of the proposals (note path, kind, affected notes), the numbers from `brain_vitals` (orphans, broken links, same-title groups) and what was left out. Then `set_status("In review")` and end your turn.
