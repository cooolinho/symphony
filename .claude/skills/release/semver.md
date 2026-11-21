# Choosing the version

[Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`, compared with the last tag `vA.B.C`.

## The argument

`/release v2.3.0` (or `2.3.0`) is taken as it is, if it is higher than the last tag. Equal or lower: comment why and
move the issue to "Blocked". A pre-release or build suffix (`2.3.0-rc.1`) is not supported: say so and block.

## Without an argument

Look at every change of Phase 2 and take the largest bump any of them needs:

| Change | Bump |
|---|---|
| Label `breaking` or `breaking-change`, `BREAKING CHANGE:` in a commit body, `!` after the type in a commit subject (`feat!:`), or the project's own definition of a breaking change (e.g. a removed or renamed configuration key, a changed default that needs action) | MAJOR |
| `Type: feature` (or `feat:` subject), a new option, command, page or check | MINOR |
| `Type: bug`, `Type: refactor`, `Type: docs`, `Type: chore`, tests, dependencies, everything else | PATCH |

- MAJOR: `A+1.0.0`; MINOR: `A.B+1.0`; PATCH: `A.B.C+1`.
- **Before 1.0.0** (`0.x.y`): a breaking change bumps MINOR, everything else PATCH. Never jump to `1.0.0` on your own;
  that takes the argument.
- When the issue text says which kind of release it is ("feature release", "nur Bugfixes"), that wins over a doubtful
  label, but never makes a breaking change smaller than MAJOR.
- Name the reason in the plan: "MINOR: #212 and #215 add features; no breaking change".
