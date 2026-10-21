# Documentation

Central overview of all Symphony documents. For an overview of the project, see the [README](../README.md).

## Getting started

- [Getting Started](getting-started.md): requirements, installation, board, token, `.env`, dry run and start
- [Docker](docker.md): running with Docker Compose behind Traefik: setup, updates, backup, common errors and security;
  local test setup without Traefik (`docker-compose.local.yml`)
- [Usage](usage.md): the life of an issue, rounds, limits and manual resume, intervening while it runs, model and effort choice, `repo-init`, dashboard
  and API, logs and cost, several repositories, Laravel Boost, security and troubleshooting

## Reference

- [configuration.md](configuration.md): every `WORKFLOW.md` option, `$VARIABLE` references, hooks and prompt variables
- [adapters/github-project.md](adapters/github-project.md): the GitHub Projects adapter: settings, normalization, agent tools and errors
- [agent-claude.md](agent-claude.md): Claude Code sessions, permissions, skills and plugins, Laravel Boost, timeouts and cost accounting
- [results.md](results.md): result contracts of the pipeline stages: kinds, verdicts, consistency rules, comment marker, size cap and the `report_result` tool
- [concepts/multi-agent.md](concepts/multi-agent.md): the multi-agent pipeline: architecture, decisions and the GitHub spike results
- [concepts/multi-backend.md](concepts/multi-backend.md): concept for several agent backends with failover on session limits
- [conformance.md](conformance.md): differences from the specification and implementation-defined behavior
- [laravel-repositories.md](laravel-repositories.md): conventions for Laravel repositories
- [laravel-subagents.md](laravel-subagents.md): the Laravel subagents and the workflow roles: findings from the logs and the plan
- [e2e.md](e2e.md): end-to-end test of the orchestration and the Laravel integration test (`npm run test:laravel`)
