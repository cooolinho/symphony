# Knowledge vault (brain)

How to run and look after the knowledge vault. Reference for the keys: [configuration.md](configuration.md#brain); for the tool signatures: [agent-claude.md](agent-claude.md#brain-tools); for the container: [docker.md](docker.md#obsidian-profile-brain).

## Purpose

The brain is one shared knowledge vault for all configured repositories: decisions, lessons and notes that agents write down so later runs do not start from zero. It is a folder of Markdown files with YAML frontmatter, kept under Git. Agents reach it only through the `brain_*` tools (never as a directory), and a human reviews it in [Obsidian](https://obsidian.md). It is off by default: set `brain.enabled: true` and give roles a [`brain` mode](#role-switch).

## Vault layout

With `brain.enabled: true` Symphony creates the structure at startup in `brain.path` (default `~/brain`; in Docker the `brain` volume). Files and folders that already exist are never overwritten.

- `README.md`: the rules of the vault. Agents cannot write it.
- `Inbox/`, `Repos/`, `Decisions/`, `Lessons/`, `Issues/`, `Agents/`: the folders for new notes.
- `Repos/<owner>-<name>/index.md`: one index note per configured repository. Its path is available to prompts as `brain_index`.
- `Kandidaten-Review.base` and `Neueste Lessons.base`: two Obsidian Bases views (candidates to review, newest lessons).
- `.gitignore`: ignores `.obsidian/workspace*.json` and `.trash/`.
- `.obsidian/`: Obsidian's own settings. It belongs to the human, Symphony never touches or commits it.

## Frontmatter

Every note starts with YAML frontmatter.

| Field | Set by | Meaning |
| --- | --- | --- |
| `type` | agent | One of `index`, `decision`, `lesson`, `issue`, `agent`, `note`. Required. |
| `status` | Symphony / human | `candidate`, `approved` or `deprecated`. |
| `repo` | agent | Repository the note is about (string). |
| `sources` | agent | List of references (issues, pull requests, files). |
| `issue`, `role`, `run` | Symphony | Issue, role and run of the last write. |
| `created`, `updated` | Symphony | Timestamps; `created` stays on an existing note. |

Unknown fields are kept. Status lifecycle: `candidate` → `approved` → `deprecated`.

- A new note is always `candidate`. Agents cannot create or promote `approved` notes.
- Only a human promotes a note to `approved` (in Obsidian or on the dashboard). An `approved` note is read-only for agents; they write a candidate note and link it.
- On the dashboard, approve sets `approved` and `updated` and moves the note to its `target` (else the folder of its `type`; `-2`, `-3`, … when the file exists). Links are not rewritten, so approve refuses a file name that would not be unique in the vault. Reject sets `deprecated` and leaves the file in place. Both commit as `human` (`approve: <path>`, `reject: <path>`); revert takes the approve commit back with `git revert`.
- `deprecated` notes never show up in `brain_search`.

## Tools

Roles with a brain mode get these tools (MCP server `brain`); the full signatures are in [agent-claude.md](agent-claude.md#brain-tools).

- `brain_search`: full-text search over title, frontmatter and body; `approved` notes first, then `candidate`.
- `brain_read`: returns `content`, parsed frontmatter and `hash`.
- `brain_list`: lists the files and subfolders of a folder.
- `brain_write`: creates or replaces a whole note.
- `brain_append`: adds text under a heading of an existing note.

Every call takes an optional `purpose`: one sentence on why the call is made. It is stored in the access log `<log-dir>/brain/access.jsonl`. Both write tools take `base_hash`, the `hash` returned by `brain_read`; it is required for `brain_append`. If the note changed since, the write is rejected (see [Clash rules](#clash-rules)).

## Role switch

The field `brain` of a role in `WORKFLOW.md` decides what the role's sessions may do: `off` (default) no tools, `read` only `brain_search`, `brain_read`, `brain_list`, `write` all five. It only has an effect with `brain.enabled: true`; roles with `read` or `write` also get the prompt section `roles/brain.md`.

| Mode | Roles in the shipped `WORKFLOW.md` |
| --- | --- |
| `write` | `issue-analyst`, `architect`, `reviewer` |
| `read` | `developer`, `test-engineer`, `security-auditor` |
| `off` | `docs` and the command roles |

An existing `WORKFLOW.md` without the field gives no role brain tools. See [configuration.md](configuration.md#roles).

## Clash rules

Several runs may write the same note. Two checks reject a write, in this order:

1. `window`: another run wrote the same note successfully within `brain.clash_window_ms` (default `600000`, 10 minutes). The same run may write again at once. `0` turns the check off.
2. `hash_mismatch`: `base_hash` differs from the current hash of the note.

Both return `rejected` with the current `content` and `hash` and write nothing. Each rejection is recorded as a clash (`open`) and logged in the access log.

To resolve a clash the agent merges its change into the returned current version and writes again with the new `hash` (after the window has passed, if the reason was `window`). A human can check the note in Obsidian or with `git log` in the vault. The dashboard API lists the clashes with three versions of the note: at the rejection, the rejected content and the current one. The first two are kept for 7 days in `<log-dir>/brain/clashes/<id>.json`; without that file the version at the rejection comes from git. The human marks a clash resolved there.

## Obsidian container

The compose profile `brain` starts an Obsidian web UI on the `brain` volume. Add `brain` to `COMPOSE_PROFILES` and set `BRAIN_DOMAIN` (for example `brain.docker.lan`) in `.env`. It is reachable only through Traefik with the same Basic auth login as the dashboard, over plain HTTP, so it is for the LAN only; do not expose it to the internet. On first start open the folder `/config/vault` as the vault. Details: [docker.md](docker.md#obsidian-profile-brain).

A `brain.obsidian_url` key for the dashboard's "Open in Obsidian" link is coming with E7-7a.

## Backup

The vault is the `brain` volume; back it up like the other volumes ([docker.md](docker.md#volumes-and-backup)).

The vault is also a Git repository: every agent write is one commit (author `symphony-<role>`), changes made in Obsidian are committed as `human`. Inside the container:

```bash
docker compose exec symphony git -C /home/symphony/brain log -- Lessons/some-note.md
docker compose exec symphony git -C /home/symphony/brain show <sha>
docker compose exec symphony git -C /home/symphony/brain revert <sha>
```

Use `git log` to see who changed a note, and `git revert` to undo a change.

## Reset

To start with an empty vault: stop Symphony, delete everything in the vault directory except `.obsidian/` (delete `.git/` too for a fresh history), and start Symphony again. Structure and `git init` are created anew. Keep `.obsidian/` to keep Obsidian's settings.
