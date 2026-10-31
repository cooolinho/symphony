# Concept: multiple agent backends with failover on session limits

## Goal

Today every issue runs on exactly one agent, Claude Code through `@anthropic-ai/claude-agent-sdk`
(`src/agent/claude.ts`, wired in `src/service.ts`). When the Claude subscription hits a session limit
(`five_hour`, `seven_day`), Symphony detects it (`#classifySessionLimit` in `claude.ts`, `src/agent/rate-limit.ts`),
retries with backoff and then **waits for the reset**. While it waits, the dispatch gate (`#dispatchGate` in
`src/orchestrator/orchestrator.ts`) holds back **every** new issue.

Symphony should switch to another backend instead of waiting. It should also be able to spread the load on purpose,
e.g. run the reviewer or auditor on a cheaper backend.

Available access: the Claude subscription, GitHub Copilot, pay-per-use API keys and free tiers. Operation: Docker
(Compose sidecar) and local (WSL, npm).

## Constraints (terms of use)

- **Never route the Claude subscription (OAuth token) through a gateway.** Since February 2026 Anthropic's terms forbid
  using Free/Pro/Max OAuth tokens in proxies and third-party tools. Claude Code keeps talking to Anthropic directly with
  the subscription; OmniRoute is only the fallback for API keys and free tiers.
- **Never route Copilot through OmniRoute.** Unofficial Copilot proxies risk an account suspension. Copilot is
  connected through GitHub's own `@github/copilot-sdk` / Copilot CLI (stage 2).
- Do not enable OmniRoute providers marked `tos: avoid` (e.g. Kiro, OpenCode Free).

## What exists and is reused

- Agent-neutral contract `AgentRunner` / `AgentSession` / `SessionPolicy` (`src/agent/types.ts`). Orchestrator and worker
  depend only on it; the one exception is `StartSessionParams.config: ClaudeConfig`.
- Generic limit path: `SessionLimitInfo`, `RetryEntry.kind = 'session_limit'`, `SessionLimitState`,
  `sessionLimitWaitMs` / `failureBackoffMs` (`src/orchestrator/eligibility.ts`).
- `claude.env` is already merged into the agent environment (`#options()` in `claude.ts`), so a gateway works today via
  `ANTHROPIC_BASE_URL`.
- Per-model overrides `claude.by_model` and `sessionClaudeConfig` (`src/agent/model.ts`); role overrides
  `roles.<name>.claude.*` (`src/workflow/config.ts`).
- Tests: `FakeRunner` (`test/helpers.ts`), `fakeQuery()` (`test/claude.test.ts`), session-limit scenarios in
  `test/orchestrator.test.ts`.
- Every run starts a fresh session (no `--resume`); the context lives on the board and in git, so switching the backend
  between two runs is safe.

## Stage 1: named backends and failover through OmniRoute (Claude Code stays the agent)

Claude Code stays the harness, so tools, MCP, skills, Laravel Boost and permissions are unchanged. A backend of
`kind: claude` with its own environment points Claude Code at OmniRoute, which spreads the requests over API keys and
free tiers with a combo.

### 1.1 Configuration (`src/workflow/config.ts`, `docs/configuration.md`)

New top-level section `backends` (add it to `CORE_TOP_LEVEL`) and new keys under `agent`. Without `backends` there is
exactly one implicit backend `claude` built from the `claude` section: behaviour is unchanged.

```yaml
backends:
  claude: {}                         # the Claude subscription, direct (base: the claude section)
  omniroute:
    kind: claude                     # Claude Code as the harness, only the environment differs
    limit_detection: gateway         # see 1.3
    claude:                          # overrides on top of the claude section
      model: $OMNIROUTE_MODEL        # e.g. claude/combo/symphony-coding
      fallback_model: null
      effort: null                   # other models often support neither effort nor thinking
      permission_mode: bypassPermissions   # the auto classifier needs Anthropic models; the read-only deny list still applies
      env:
        ANTHROPIC_BASE_URL: ${OMNIROUTE_URL:-http://omniroute:20128}   # no /v1 suffix
        ANTHROPIC_AUTH_TOKEN: $OMNIROUTE_API_KEY
        ANTHROPIC_API_KEY: ""
        CLAUDE_CODE_OAUTH_TOKEN: ""  # never hand the subscription token to the gateway
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: "190000"
agent:
  backend_order: [claude, omniroute] # failover chain
  on_session_limit: failover         # failover | wait (wait = today's behaviour)
```

- Types: `BackendConfig { name; kind: 'claude' | 'copilot'; limitDetection; claude: ClaudeConfig /* merged */ }`.
  `ServiceConfig` gets `backends: ReadonlyMap<string, BackendConfig>`; `agent` gets `backendOrder` and `onSessionLimit`.
- Validation: names in `backend_order` must exist. A backend that sets `ANTHROPIC_BASE_URL` always runs with an empty
  `CLAUDE_CODE_OAUTH_TOKEN`; if the config sets one, warn and override it with `""`.
- Roles: new key `roles.<name>.backend` (`ROLE_KEYS`), e.g. `roles.reviewer.backend: omniroute` to save Claude quota.

### 1.2 Choosing the backend per issue

- New label `Backend: <name>` to pin an issue. Parsed in `src/agent/model.ts` next to `Model:`; `src/repo-init/labels.ts`
  creates one label per configured backend.
- Precedence: label > role > first backend of `backend_order` that is not cooling down.
- `Model:` label: `modelForLabelValue` (`src/agent/model-name.ts`) rejects non-Claude names today. New form
  `Model: <backend>/<model>` (e.g. `Model: omniroute/glm/glm-5.2`) selects the backend and passes the model name through
  unchecked. Without a prefix the current Claude validation stays.
- `sessionClaudeConfig(...)` takes the chosen `BackendConfig` as its base instead of `config.claude` (call site in
  `#dispatch`, handed to `startSession` in `src/orchestrator/worker.ts`).

### 1.3 Limit state per backend and failover (`src/orchestrator/orchestrator.ts`)

- New state `#backendCooldowns: Map<backend, { until; window; observedAt }>`, set when a run fails with a
  `sessionLimit` in an account-wide window (`ACCOUNT_WIDE_WINDOWS`).
- `on_session_limit: failover`: if a backend that is not cooling down is left, `#scheduleRetry` re-runs the issue right
  away (short delay, e.g. 5 s) as `kind: 'failure'` without a waiting `session_limit`; the retry entry records the chosen
  backend. If every backend is cooling down, today's flow applies (retries, then wait for the earliest reset).
- `#dispatchGate()` holds back dispatches only when **every** backend of the chain is cooling down; otherwise `#dispatch`
  picks the first free one.
- Return: after `until` + `SESSION_LIMIT_RESET_BUFFER_MS` the backend is free again and new runs start on the first
  backend of the chain (the subscription first). Running sessions on another backend are not interrupted.
- Persistence: cooldowns are written to `<logDir>/state/backend-cooldowns.json` (the `state` volume) and loaded at start,
  so a restart does not fire against an exhausted account again.
- Gateway limits: when OmniRoute has no route left it answers 429/503 without a `rate_limit_event`. With
  `limit_detection: gateway`, `#classifySessionLimit` turns such a 429 into a `session_limit` with `window: 'gateway'`
  and no reset time; that backend then cools down with a backoff (e.g. 15 min).

### 1.4 Display and costs

- `session_configured` and `run_started` carry the field `backend`; dashboard, issue detail page and history show it
  (`src/http/*`, `HistoryLog`).
- The snapshot's `rate_limits` gains `backends: [{ name, status, until }]`.
- `model-costs.yml` and `src/costs/pricing.ts` only know Claude ids. Unknown models of a gateway backend are shown as
  "cost unknown (see the OmniRoute dashboard)" instead of $0; optional prices per backend under `<backend>/<model>`.

### 1.5 Running OmniRoute

- Docker: new service `omniroute` in `docker-compose.yml` and `docker-compose.local.yml` with `profiles: [omniroute]`
  (opt-in). Image `diegosouzapw/omniroute:<pinned version>`, volume `omniroute-data:/app/data`,
  `OMNIROUTE_MEMORY_MB=2048`, reachable only on an internal network. Dashboard: `127.0.0.1:20128` in the local compose
  file; behind Traefik either its own router with the same BasicAuth middleware or not published at all. `symphony`
  gets `depends_on: omniroute` with `required: false`.
- `docker/entrypoint.sh`: besides `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`, `OMNIROUTE_API_KEY` (and from stage 2
  `COPILOT_GITHUB_TOKEN`) also counts as agent access.
- `.env.example`: `OMNIROUTE_URL`, `OMNIROUTE_API_KEY`, `OMNIROUTE_MODEL`, `SYMPHONY_ON_SESSION_LIMIT=failover`.
- Local (WSL): `npm i -g omniroute`, start `omniroute` (port 20128), set `OMNIROUTE_URL=http://localhost:20128`.
- OmniRoute setup: connect the API keys and free-tier providers, create a combo `symphony-coding` (strategy `priority`:
  paid API keys first, then free), enable the discovery alias `claude/combo/symphony-coding`. Check with
  `GET /api/monitoring/health/route`.
- Docs: new `docs/omniroute.md` (setup, combo recommendation, terms of use, troubleshooting: `400 Ambiguous model`,
  no `/v1` suffix), linked from `docs/agent-claude.md`, `docs/docker.md` and the session-limit section of
  `docs/usage.md`. Add the feature to the README under ✨ Features and 📚 Documentation, keeping its section structure.

### 1.6 Risks to check in a spike

- Tool use and streaming of other models through OmniRoute's Anthropic interface: only put models into the combo that
  are known to handle tools.
- `permission_mode: auto` needs Anthropic, so the gateway backend uses `bypassPermissions` or `acceptEdits` plus
  `allowed_tools`; the read-only deny list in `claude.ts` applies regardless.
- Code quality drops: keep `agent.max_turns` and the checks as strict for the fallback backend; optionally pin the
  reviewer role to Claude.

## Stage 2: Copilot as its own runner (`kind: copilot`)

The Copilot subscription brings its own quota (premium requests) and Claude, GPT and Gemini models through GitHub's
official runtime, without conflicting with any terms.

1. Spike (1–2 days): try `@github/copilot-sdk` (public preview) on Node 26. Check sessions with a `cwd`, custom tools for
   Symphony's tracker tools (`AgentToolSpec`), stdio MCP for Laravel Boost, the permission handler, the event stream,
   usage, the error on an exhausted quota, and loading of `AGENTS.md`, `CLAUDE.md` and skills. Fallback if the SDK is not
   enough: `copilot -p … --allow-all-tools --no-ask-user --additional-mcp-config @file` with JSONL output; the tracker
   tools then run as a stdio MCP server that calls back into a local Symphony route.
2. Neutral config: `StartSessionParams.config` becomes `{ backend: BackendConfig }`. Shared fields (model, timeouts, env,
   appended prompt, budget) move to an `AgentSessionConfig`; Claude-specific fields stay in `ClaudeConfig`. New
   `CopilotConfig { model; allowedTools; deniedTools; env; executable }`.
3. `src/agent/copilot.ts`: `CopilotAgentRunner implements AgentRunner`. It maps `SessionPolicy.readOnly` to a deny list
   of write and shell tools, its events to `AgentEvent`, quota errors to `SessionLimitInfo { window: 'copilot_premium' }`,
   and uses `processGroupSpawner` (`src/agent/spawn.ts`) where the SDK offers a spawn hook.
4. Runner registry in `src/service.ts`: `Map<kind, AgentRunner>` with `claude` and `copilot`; the worker picks the runner
   by `backend.kind`.
5. Environment: Copilot gets `COPILOT_GITHUB_TOKEN` (fine-grained PAT with "Copilot Requests"), separate from the
   tracker's `GITHUB_TOKEN`. `childEnvironment()` (`src/agent/env.ts`) keeps removing the tracker token;
   `src/workspace/manager.ts` also removes `COPILOT_GITHUB_TOKEN` from hooks and checks. The Dockerfile installs the
   Copilot CLI via npm (or uses the SDK bundle if it ships one).
6. Boost: `src/laravel/boost.ts` also writes the Copilot agent into `boost.json` when a Copilot backend is configured
   (`AGENTS.md` / `.github/copilot-instructions.md`).
7. Tool names: assumptions like `mcp__<server>__<tool>`, `Skill` and `AskUserQuestion` (`src/agent/claude.ts`,
   `src/orchestrator/tool-usage.ts`, `src/http/issue-page.ts`) go through a small per-runner `toolNaming` function.
8. Typical chain: `backend_order: [claude, copilot, omniroute]`.

Outlook (stage 3, optional): an OpenCode runner (`opencode run --format json`, plugin `@omniroute/opencode-provider`)
as a second harness for free and third-party models, if Claude Code works poorly with them through the gateway.

## Order

1. `backends` config and types
2. Backend choice (label, role)
3. Cooldowns and failover in the orchestrator
4. Persistence of cooldowns
5. Gateway limit detection
6. Compose, entrypoint and docs
7. Copilot spike
8. Neutral session config
9. Copilot runner

## Verification

- Unit tests (`npm test`, node:test):
  - `test/workflow.test.ts`: parsing `backends`, defaults without `backends`, validation errors, forced empty OAuth token.
  - `test/model.test.ts`: `Backend:` label, `Model: <backend>/<model>`, precedence label > role > chain.
  - `test/orchestrator.test.ts` (with `FakeRunner`): a `session_limit` on `claude` leads to an immediate retry on
    `omniroute`; the gate closes only when every backend cools down; after the reset the next run uses `claude` again;
    cooldowns survive a restart.
  - `test/claude.test.ts`: a gateway 429 with `limit_detection: gateway` yields `session_limit`.
  - Stage 2: `test/copilot.test.ts` with a fake client modelled on `fakeQuery()`.
- Type check with the project's tsc script.
- End to end, locally: `docker compose -f docker-compose.local.yml --profile omniroute up -d`, create the combo in the
  OmniRoute dashboard (`127.0.0.1:20128`), move a test issue labelled `Backend: omniroute` to Ready: the run completes
  (commit, PR, checks) and the OmniRoute log shows its `X-OmniRoute-Decision`. Then simulate failover (a fake limit in
  `scripts/e2e`, or briefly an invalid Claude token): `session_limit`, then the run continues on `omniroute` without a
  dispatch pause, and the dashboard shows the backend.
