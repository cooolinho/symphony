# Templates

Write everything except the marker headings in the language of the issue.

## Release plan comment

```markdown
## Release Plan

**Version:** vX.Y.Z (last release: vA.B.C) – <MINOR: reason>
**Range:** `vA.B.C..origin/<base>`, <n> pull requests
**Version files:** package.json, package-lock.json, CHANGELOG.md   (or: none – tag and CHANGELOG.md only)
**Bump branch:** release/vX.Y.Z

<the release notes below>
```

## Release notes

Used for the bump pull request, the release pull request, the GitHub release and the changelog section. Group by kind,
newest first inside a group, leave out empty groups. Name the epics the issue text mentions in the summary line.

```markdown
<One or two sentences: what this release brings, e.g. "Completes the epics E18–E26: …".>

### Features
- <Issue title> (#<pr>, closes #<issue>)

### Fixes
- …

### Other changes
- …
```

## CHANGELOG.md

A new file starts with:

```markdown
# Changelog

All notable changes to this project are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).
```

Each release adds, above the previous ones:

```markdown
## [X.Y.Z] - YYYY-MM-DD

### Added
- …

### Fixed
- …

### Changed
- …
```

## Release report comment

Symphony posts this itself when `publish_release` succeeds. Write it only when the result's `warnings` say the report
could not be posted.

```markdown
## Release Report

**Released:** [vX.Y.Z](<release_url>)
**Version bump:** #<bump pr> into `<base>`
**Release pull request:** #<release pr> into `<default branch>`   (left out when the base branch is the default branch)
**Contains:** <n> pull requests (#…, #…)

<notes: an argument that was ignored, a version file that was missing, anything a human should know>
```
