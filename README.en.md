# dsh-codex

[中文](README.md) | English

Local [Codex CLI](https://developers.openai.com/codex/cli/) integration for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

It installs as one DSH bundle. Selecting Codex in the model picker starts a local `codex app-server --stdio` process for the session, preserves its Codex thread across turns, routes eligible approvals through DSH, and renders Codex reasoning, tool activity, usage, and generated images in the standard Web conversation.

## Requirements

- DeepSeek Harness `0.1.0-rc.5` through `<0.2.0`
- Node.js `^22.19.0 || >=24.0.0`
- Codex CLI `0.147.0` or a later compatible version on `PATH`
- Codex authentication completed with `codex login`

The plugin uses the local Codex configuration, sandbox, and authentication. It does not use an OpenAI API key unless your Codex configuration does.

## Installation

The plugin is currently distributed from GitHub only. Pin a tested commit when installing it:

```sh
dsh plugin --profile web add github:lgyytm/dsh-codexcli-llm#COMMIT
```

A GitHub installation builds the package locally. pnpm 10 or later asks for explicit permission before running that build. Add the displayed key to `$DSH_HOME/profiles/web/pnpm-workspace.yaml`:

```yaml
allowBuilds:
  dsh-codex: true
```

Then repeat the installation. Start or restart the Web process and select **Codex default** or a model reported by the local Codex CLI.

## Configuration

The bundle mounts one `llm-codex` row. A profile patch can set its configuration:

```yaml
- id: llm-codex
  config:
    cwd: !!js process.cwd()
    approval: ask
    reasoningSummary: detailed
```

`approval: ask` is the default and routes command, file-change, and additional-permission requests through DSH's approval UI. `allow`, `decline`, and `cancel` are unattended policies.

## Behavior and limits

Codex remains the agent that executes its native tools. DSH observes its durable lifecycle, mediates supported approval requests, and renders the reported reasoning, tool arguments, results, terminal output, token use, and generated images. It does not replace Codex's tool loop or sandbox.

Only reasoning text that Codex app-server publishes can be displayed. The plugin cannot reveal private model reasoning. User-input and MCP elicitation requests fail closed because their structured answers are not yet represented by DSH's approval service.

## Development

```sh
pnpm install
pnpm run build
pnpm run typecheck
pnpm test
```

`pnpm pack` produces a registry artifact. Test an artifact in a new DSH profile before publishing:

```sh
pnpm pack
dsh plugin --profile codex-test add ./dsh-codex-0.1.0.tgz
dsh --profile codex-test --dump-config
```

For GitHub source installation and version tags, see [PUBLISHING.md](PUBLISHING.md).

## License

[MIT](LICENSE)
