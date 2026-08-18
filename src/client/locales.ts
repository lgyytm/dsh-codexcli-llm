/** Dictionary namespace owned by the Codex observation UI. */
export const NS = 'codex-observation'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'reasoning.title': '思考',
  'reasoning.empty.running': '正在执行推理步骤，Codex 未提供可展示的摘要。',
  'reasoning.empty.completed': '推理步骤已完成，Codex 未提供可展示的摘要。',
  'tool.command': '命令',
  'tool.fileChange': '文件修改',
  'tool.webSearch': '网页搜索',
  'tool.generic': '工具 · {name}',
  'status.running': '运行中',
  'status.waiting': '等待审批',
  'status.allowed': '已批准',
  'status.declined': '已拒绝',
  'status.cancelled': '已取消',
  'status.completed': '已完成',
  'status.failed': '失败',
  'details.arguments': '参数',
  'details.result': '结果',
  'details.structuredResult': '结构化结果',
  'details.error': '错误',
  'details.duration': '{duration} 毫秒',
  'details.exitCode': '退出码 {code}',
  'details.truncated': '… 已截断，共 {total} 字符',
  'terminal.exitCode': '退出码 {code}',
  'terminal.copy': '复制',
  'terminal.copied': '复制成功',
  'terminal.noOutput': '无输出',
  'terminal.collapse': '收起输出',
  'terminal.expand': '… 其余 {hidden} 行',
  'terminal.expandAria': '展开其余 {hidden} 行输出',
}

/** English dictionary (same key set). */
export const en: Record<CodexObservationKey, string> = {
  'reasoning.title': 'Think',
  'reasoning.empty.running': 'Reasoning is in progress; Codex did not provide a displayable summary.',
  'reasoning.empty.completed': 'Reasoning completed; Codex did not provide a displayable summary.',
  'tool.command': 'Command',
  'tool.fileChange': 'File change',
  'tool.webSearch': 'Web search',
  'tool.generic': 'Tool · {name}',
  'status.running': 'Running',
  'status.waiting': 'Waiting for approval',
  'status.allowed': 'Approved',
  'status.declined': 'Declined',
  'status.cancelled': 'Cancelled',
  'status.completed': 'Completed',
  'status.failed': 'Failed',
  'details.arguments': 'Arguments',
  'details.result': 'Result',
  'details.structuredResult': 'Structured result',
  'details.error': 'Error',
  'details.duration': '{duration} ms',
  'details.exitCode': 'Exit code {code}',
  'details.truncated': '… truncated, {total} characters total',
  'terminal.exitCode': 'Exit code {code}',
  'terminal.copy': 'Copy',
  'terminal.copied': 'Copied',
  'terminal.noOutput': 'No output',
  'terminal.collapse': 'Collapse output',
  'terminal.expand': '… {hidden} more lines',
  'terminal.expandAria': 'Expand {hidden} more output lines',
}

/** Union of this namespace's dictionary keys. */
export type CodexObservationKey = keyof typeof zh
