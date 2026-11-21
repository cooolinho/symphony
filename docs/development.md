# Development

Working on Symphony itself. Contributions: [CONTRIBUTING.md](../CONTRIBUTING.md); vulnerabilities: [SECURITY.md](../SECURITY.md).

```bash
npm test                 # tests
npm run typecheck        # TypeScript check
npm run check            # both
node scripts/demo.ts     # dashboard with made-up data on http://127.0.0.1:4000 (no GitHub, no Claude)
npm run e2e              # end-to-end test on a test board (creates real issues)
npm run test:laravel     # Laravel integration against a real app (needs PHP 8.3+, Composer, network)
```

Every change goes through a pull request into `develop`; releases go from `develop` to `main` with a release pull
request and a tag `vX.Y.Z` ([git flow](gitflow.md)). CI ([.github/workflows/ci.yml](../.github/workflows/ci.yml))
runs `npm run check` on Node 26 and builds and starts the Docker image for every pull request. Symphony's own agents
work on this repository too: their pull requests are merged into `develop` by the merge gate once the review approved
them and every check passed. For setups whose agents target the default branch,
[.github/workflows/automerge.yml](../.github/workflows/automerge.yml) squash-merges agent pull requests after CI; it
leaves pull requests from forks, with the label `manual-merge`, without a linked issue or touching `.github/` or the
package files to a human.

The installer (`install.sh`, `scripts/install/lib/`) is plain bash: `npm test` covers it with stubbed tools
(`test/install-script.test.ts`), and CI runs `shellcheck -x install.sh`.

← [Documentation](index.md) · [Git flow](gitflow.md)
