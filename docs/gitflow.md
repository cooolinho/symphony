# Git flow: branches, merges and releases

How changes reach Symphony's `main` branch and a release. The same model is used for the repositories Symphony works
on (`tracker.provider.base_branch: develop`). [CONTRIBUTING.md](../CONTRIBUTING.md) covers the development setup and
what a pull request must contain.

## Branches

| Branch | Purpose | Who writes to it |
|---|---|---|
| `main` | Released code only. Every commit on it is a release or will become one; tags `vX.Y.Z` point here. | Merges of release pull requests (and hotfixes), by a maintainer |
| `develop` | Integration branch. Every change lands here first; the running container is tested from it before a release. | Merges of pull requests: automatic for agent pull requests, by a maintainer for all others |
| `feature/<topic>` | A new feature or change | Branched from `develop` |
| `fix/<topic>` | A bug fix | Branched from `develop` |
| `docs/<topic>`, `ci/<topic>`, `refactor/<topic>` | Documentation, CI or a refactoring without behavior change | Branched from `develop` |
| `symphony/issue-<number>` | The branch Symphony's agents work on for one issue | Created by the developer agent from `develop` |
| `hotfix/<topic>` | An urgent fix for a released version | Branched from `main` |

Nobody pushes directly to `main` or `develop`; every change goes through a pull request. `<topic>` is short, lowercase
and hyphenated (`feature/merge-gate-checks`, `fix/ci-mysql-alias`).

## Pull requests and merges

- **Into `develop`.** One topic per pull request, with tests and documentation (see CONTRIBUTING.md). CI runs
  `npm run check` and a Docker build; it must be green.
  - Agent pull requests (`symphony/issue-<number>`) are merged by Symphony itself once the agent review approved them
    and every check of the head passed (the [merge gate](adapters/github-project.md#merge-gate)), with **squash**.
  - All other pull requests are reviewed and merged by a maintainer, with a **merge commit** ("Merge pull request #…").
- **Into `main`.** Only release pull requests from `develop` (see below) and hotfixes. A maintainer merges them with a
  **merge commit**, never squash, so `main` keeps the history of `develop`.
- **Commit messages** are in German: a short summary line in the style of the existing history ("Merge-Gate:
  auto_merge liest die PR-Checks …"), then a body that says why. Changes written with an AI assistant end with a
  `Co-Authored-By:` trailer. The pull request body references the issue (`Closes #<number>`).

## Releases

Versions follow [Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`. The version lives in `package.json`
(and `package-lock.json`); the dashboard header shows it, read at startup, so a container built from a release shows
the release's version.

1. **Bump the version on `develop`.** A pull request `release/vX.Y.Z` (or part of the last pull request before the
   release) sets `"version": "X.Y.Z"` in `package.json` and both root entries of `package-lock.json`. The version
   must be in the code before it is tagged.
2. **Test `develop`.** Rebuild the container from `develop` and let real issues run through the pipeline.
3. **Release pull request.** Open a pull request `develop` → `main` titled `Release vX.Y.Z`, with German notes
   summarizing the merged pull requests. A maintainer merges it (merge commit).
4. **Tag and GitHub release.** On the merge commit of `main`, create the tag `vX.Y.Z` and a GitHub release of the same
   name with the release notes (e.g. through the REST API: `POST /repos/<owner>/<repo>/releases` with
   `tag_name: "vX.Y.Z"`, `target_commitish: "main"`). Tags are never moved or reused; a mistake gets a new patch
   version.
5. **Deploy.** On the server: `git fetch --tags && git checkout vX.Y.Z`, then `docker compose build symphony`. Wait
   until `GET /api/v1/state` shows no running agents (`counts.running` is 0), then `docker compose up -d symphony`
   and wait for the container to be `healthy`. The dashboard header now shows `vX.Y.Z`.

| Change since the last release | Version |
|---|---|
| Breaking change: a `WORKFLOW.md` key or `.env` variable removed or renamed, a changed default that needs action | `MAJOR` |
| New feature, new option, new check | `MINOR` |
| Bug fix, documentation, internal change | `PATCH` |

## Hotfixes

For an urgent fix to a released version, branch `hotfix/<topic>` from `main`, open the pull request against `main`,
bump the patch version in it, and release it as above (steps 4 and 5). Then merge `main` back into `develop` with a
pull request, so the fix is not lost with the next release.
