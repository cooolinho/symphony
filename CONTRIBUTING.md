# Contributing

Thanks for your interest in Symphony! Bug reports, ideas and pull requests are welcome.

## Before you start

- Search the [existing issues](https://github.com/cooolinho/symphony/issues) first.
- For larger changes, open an issue to discuss the idea before you write code.
- Report security problems privately, see [SECURITY.md](SECURITY.md).
- This project follows the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/):
  be respectful and constructive.

## Development setup

You need Node.js 26 or newer.

```bash
npm ci
npm run check   # typecheck and tests
```

| Command | Purpose |
|---|---|
| `npm test` | unit tests (`node:test`) |
| `npm run typecheck` | TypeScript check |
| `npm run check` | both, as run by CI |
| `npm run e2e` | end-to-end test on a test board (creates real issues, needs a token) |
| `npm run test:laravel` | Laravel integration test (needs PHP 8.3+, Composer, network) |

`npm run check` must pass before you open a pull request. The documentation starts at [docs/index.md](docs/index.md);
[docs/getting-started.md](docs/getting-started.md) explains how to run Symphony itself.

## Pull requests

1. Fork the repository and branch from `develop`.
2. Keep the change focused: one topic per pull request.
3. Add or update tests for changed behavior, and update the documentation (`docs/`, `README.md`) if you change
   configuration, behavior or commands. `README.de.md` mirrors `README.md`.
4. Write clear commit messages. Reference the issue with `Closes #<number>` in the pull request description.
5. Open the pull request against `develop` and fill in the template.

Branch names, merge rules and the release process are in [docs/gitflow.md](docs/gitflow.md).

CI runs `npm run check` and a Docker build for every pull request. Pull requests from the Symphony agents
(`symphony/*` branches of this repository) are merged automatically under the rules in the [README](README.md); all
other pull requests, including every pull request from a fork, are reviewed and merged by a maintainer.

## Conventions

- TypeScript, ES modules, no build step (`node src/cli.ts`). Match the style of the surrounding code.
- Documentation, code comments and runtime messages are in English.
- Never commit secrets: `.env` is ignored, `.env.example` documents the variables.

## License

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
