---
name: release
description: Release workflow. Collects everything merged into the base branch since the last vX.Y.Z tag, picks the version (the argument, else Semantic Versioning from the changes), bumps the version files and CHANGELOG.md in a pull request and publishes the release with publish_release (merge into the default branch, tag, GitHub release). Only load when the prompt asks for it (issue command /release), never on your own.
argument-hint: "[vX.Y.Z]"
---

# Publish a release

Your brief: turn everything that was merged into the base branch since the last release into a new version, fully
automatically. The release issue usually waits on the board with "Blocked by" on the epics or issues that belong to
the release; Symphony starts you only once those are done, so you do not wait for anything yourself.

```
/release            -> version from the changes (semver.md)
/release v2.3.0     -> exactly this version
Version after epics E18–E26.          (free text: context for the release notes)
Blocked by #181, #182, #189           (what the release waits for)
```

You change **only** the version files and `CHANGELOG.md`, on the branch `release/vX.Y.Z`. You never push to the
default branch or the base branch, never create or move a tag with git, and never merge with git or `gh`: the merges,
the tag and the GitHub release are done by the tool `publish_release`, which checks the pull requests' checks first.

**Argument** (`$ARGUMENTS`): an optional version `X.Y.Z` or `vX.Y.Z`. Anything else: ignore it, derive the version and
note that in the report.

The comment heading `## Release Plan` is a marker you search for in later runs; always write it in English, exactly as
in [templates.md](templates.md), whatever the language of the issue. `## Release Report` is posted by Symphony itself
when `publish_release` succeeds.

## Phase 0: Determine the situation

Call `get_issue` and read the comments.

- **No `## Release Plan`**: new run, continue with Phase 1.
- **`## Release Plan` but no `## Release Report`**: an earlier run stopped. Take the version, the pull request and the
  files from the plan; skip the phases already done (the branch `release/vX.Y.Z` exists on the remote, the pull request
  is open or merged) and go on with Phase 5 or 6. `publish_release` skips every step that is already done.
- **`## Release Report` present**: the release is out. Create nothing again; end your turn.

## Phase 1: The last release

1. `git fetch origin --tags --prune`.
2. The last release is the highest tag of the form `vX.Y.Z` (`git tag --list 'v*' --sort=-v:refname | head -1`).
   Tags of another form do not count.
3. Without such a tag this is the first release: the range is the whole history of the base branch, and the version is
   the argument, else the version already in the version file (Phase 4), else `0.1.0`.

## Phase 2: What goes into the release

1. The base branch is the one the prompt names (`tracker.provider.base_branch`), else the default branch.
2. List the changes: `git log --first-parent --format='%H %s' <last tag>..origin/<base>`. Squash merges end in
   `(#<number>)`, merge commits read `Merge pull request #<number> from …`; collect those pull request numbers.
3. For every pull request, read its issue with `get_issue_by_number` (the pull request body names it with
   `Closes #<n>`; the branch `symphony/issue-<n>` names it too): title, `Type:` label, labels such as `breaking`, the
   parent epic. A commit without a pull request goes into the notes with its subject line.
4. **Nothing since the last tag**: comment that there is nothing to release and move the issue to "Blocked".

## Phase 3: The version

Follow [semver.md](semver.md). The argument wins, but it must be higher than the last tag; if not, comment why and move
to "Blocked". Without an argument, derive MAJOR, MINOR or PATCH from the changes and name the reason in the plan.

## Phase 4: The version files

1. The project's instructions decide first (AGENTS.md, CLAUDE.md, CONTRIBUTING.md, docs on releases such as
   `docs/gitflow.md`, a `.symphony/release.md`): which files hold the version, the commit message style, the language
   of the changelog.
2. Otherwise look for these, in this order, and take every one that carries a version today:
   - `package.json` `"version"` (then also both root entries of `package-lock.json`: `"version"` and
     `packages[""].version`);
   - `composer.json` `"version"`;
   - `config/app.php` with a `'version' =>` entry;
   - a `VERSION` file in the repository root;
   - `pyproject.toml` `[project] version`, `Cargo.toml` `[package] version`.
   A file that has no version today gets none: do not add a field Composer or npm do not need.
3. **No version file**: then the version lives in the tag and `CHANGELOG.md` only. That is fine; say so in the plan.
4. `CHANGELOG.md` is always updated (Keep a Changelog: a new section `## [X.Y.Z] - YYYY-MM-DD` on top of the existing
   ones, below `## [Unreleased]` if there is one, whose entries move into the new section). Create the file if it is
   missing, with the header from [templates.md](templates.md).

## Phase 5: The bump

1. Post the `## Release Plan` comment ([templates.md](templates.md)) with `add_comment`: version and why, last tag,
   the pull requests, the files.
2. `git switch -c release/vX.Y.Z origin/<base>`.
3. Change only the version files and `CHANGELOG.md`. Do not run `npm install` or `composer update`; edit the lock entry
   by hand.
4. Commit in the style of the repository's history (language, summary line), e.g. `Version X.Y.Z`; push the branch.
5. `open_pull_request` with `head: release/vX.Y.Z`, the title `Version X.Y.Z` and the release notes as body (no
   `base`: it targets the base branch). Note the pull request number.

## Phase 6: Publish

Call `publish_release` with `version`, `pull_request`, `notes` (the release notes from [templates.md](templates.md))
and `files` (the version files of Phase 4, without `CHANGELOG.md`).

- `published`: Symphony posted the `## Release Report` with your notes, closed the issue and moved it to the done
  column. Look at `warnings`: if one says the report or the move failed, post the report yourself
  ([templates.md](templates.md)); never move the issue to the done column yourself. End your turn.
- `pending`: checks are still running. Call it again with the same arguments, up to 6 times. Still `pending` after
  that: comment the reason and move the issue to "Blocked"; moving it back to "Ready" continues the release.
- `failed`: read `reason` and `step`. Something you can fix on your branch (a file outside the declared ones, a
  forgotten version file): fix it, push, call again once. Anything else (failing checks, a conflict, an opt-out label,
  a version that is not higher than the last tag): comment the reason and move the issue to "Blocked".
