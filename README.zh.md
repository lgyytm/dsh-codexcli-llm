# dsh-codex

[English](README.md) | 中文

用于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的本地 [Codex CLI](https://developers.openai.com/codex/cli/) 集成插件。

它以一个 DSH bundle 安装。在模型选择器中选择 Codex 后，插件会为该会话启动本地 `codex app-server --stdio` 进程，跨回合保留 Codex thread，将可支持的审批请求交由 DSH 处理，并在标准 Web 对话中渲染 Codex 的推理、工具活动、用量与生成图片。

## 前置条件

- DeepSeek Harness `0.1.0-rc.5` 至 `<0.2.0`
- Node.js `^22.19.0 || >=24.0.0`
- PATH 中存在 Codex CLI `0.147.0` 或更高的兼容版本
- 已通过 `codex login` 完成 Codex 认证

插件使用本机 Codex 配置、沙箱和认证信息。除非 Codex 的配置本身要求，否则无需 OpenAI API Key。

## 安装

将已发布包安装到 Web profile：

```sh
dsh plugin --profile web add dsh-codex
```

也可以直接从 GitHub 安装，并固定到某个提交：

```sh
dsh plugin --profile web add github:lgyytm/dsh-codexcli-llm#COMMIT
```

GitHub 安装会在本机构建该包。pnpm 10 或更新版本会要求显式允许该构建。将提示的键加入 `$DSH_HOME/profiles/web/pnpm-workspace.yaml`：

```yaml
allowBuilds:
  dsh-codex: true
```

随后重新执行安装命令。启动或重启 Web 进程，并选择 **Codex default** 或本机 Codex CLI 报告的模型。

## 配置

bundle 会挂载一个 `llm-codex` 行。profile patch 可以设置它的配置：

```yaml
- id: llm-codex
  config:
    cwd: !!js process.cwd()
    approval: ask
    reasoningSummary: detailed
```

`approval: ask` 是默认值，会将命令、文件变更和额外权限请求路由至 DSH 审批 UI。无人值守策略可设置为 `allow`、`decline` 或 `cancel`。

## 行为与限制

Codex 仍是执行其原生工具的 agent。DSH 记录其可持久化的生命周期事件，为已支持的审批请求提供中介，并渲染已报告的推理、工具参数、结果、终端输出、token 用量和生成图片。它不会替代 Codex 的工具循环或沙箱。

只能显示 Codex app-server 实际公开的推理文本；插件无法公开模型的私有推理。用户输入和 MCP elicitation 请求会 fail closed，因为 DSH 的审批服务尚不能表达其结构化答案。

## 开发

```sh
pnpm install
pnpm run build
pnpm run typecheck
pnpm test
```

`pnpm pack` 会生成 registry 工件。发布前请在新的 DSH profile 中测试该工件：

```sh
pnpm pack
dsh plugin --profile codex-test add ./dsh-codex-0.1.0.tgz
dsh --profile codex-test --dump-config
```

GitHub 与 npm 发布配置见 [PUBLISHING.md](PUBLISHING.md)。

## 许可证

[MIT](LICENSE)
