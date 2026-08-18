import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  DisclosureRow,
  IconApiOutline14,
  IconEditOutline16,
  IconGlobeOutline14,
  IconSparkle16,
  IconThinkOutline14,
  JsonBlock,
  StateDot,
  TerminalBlock,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState, TerminalBlockLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CodexObservationData } from './observation-definition.ts'
import { useThrottledVisualUpdate } from './useThrottledVisualUpdate.ts'
import css from './CodexObservationView.module.css'

type CodexObservationViewProps =
  PropsRuntime<'conversation.chat.node', 'codex-observation'>
  & PropsLocale<'codex-observation'>

type Translate = CodexObservationViewProps['t']

interface StatusView {
  readonly dot: StateDotState
  readonly label: string
  readonly running: boolean
}

function statusView(data: CodexObservationData, t: Translate): StatusView {
  if (data.error !== undefined || data.status === 'failed' || (data.exitCode ?? 0) !== 0) {
    return { dot: 'error', label: t('status.failed'), running: false }
  }
  if (data.approvalDecision === 'decline' || data.status === 'declined') {
    return { dot: 'warning', label: t('status.declined'), running: false }
  }
  if (data.approvalDecision === 'cancel') {
    return { dot: 'warning', label: t('status.cancelled'), running: false }
  }
  if (data.stage === 'approval-requested') {
    return { dot: 'warning', label: t('status.waiting'), running: true }
  }
  if (data.stage === 'approval-decided' && data.approvalDecision === 'allow') {
    return { dot: 'ongoing', label: t('status.allowed'), running: true }
  }
  if (data.stage !== 'item-completed' && data.status !== 'completed') {
    return { dot: 'ongoing', label: t('status.running'), running: true }
  }
  return { dot: 'done', label: t('status.completed'), running: false }
}

function toolTitle(data: CodexObservationData, t: Translate): string {
  switch (data.type) {
    case 'commandExecution': return t('tool.command')
    case 'fileChange': return t('tool.fileChange')
    case 'webSearch': return t('tool.webSearch')
    default: return t('tool.generic', { name: data.toolName ?? data.type })
  }
}

function toolIcon(data: CodexObservationData): ReactNode {
  switch (data.type) {
    case 'commandExecution': return <IconApiOutline14 />
    case 'fileChange': return <IconEditOutline16 />
    case 'webSearch': return <IconGlobeOutline14 />
    default: return <IconSparkle16 />
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function displayValue(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return value
  }
}

function commandFacts(data: CodexObservationData): { command: string; cwd?: string } {
  const args = record(displayValue(data.toolArguments))
  const command = typeof args?.command === 'string' ? args.command : ''
  const cwd = typeof args?.cwd === 'string' ? args.cwd : undefined
  return { command, ...cwd === undefined ? {} : { cwd } }
}

function firstLine(text: string): string {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}

function reasoningSummary(text: string, running: boolean): string {
  if (!running) return firstLine(text)
  /* v8 ignore next -- split always returns at least one element for a string. */
  return text.trimEnd().split('\n').at(-1) ?? ''
}

function useProgressiveText(target: string, animate: boolean): { text: string; revealing: boolean } {
  const [text, setText] = useState(() => animate ? '' : target)
  const textRef = useRef(text)
  const revealingRef = useRef(animate && target.length > 0)

  useEffect(() => {
    if (animate && textRef.current !== target) revealingRef.current = true
    if (!revealingRef.current) {
      textRef.current = target
      setText(target)
      return
    }

    const targetUnits = Array.from(target)
    const extendsVisibleText = target.startsWith(textRef.current)
    let visibleUnits = extendsVisibleText ? Array.from(textRef.current).length : 0
    if (!extendsVisibleText) {
      textRef.current = ''
      setText('')
    }
    let frame: number
    const revealNext = (): void => {
      visibleUnits = Math.min(visibleUnits + 1, targetUnits.length)
      const next = targetUnits.slice(0, visibleUnits).join('')
      textRef.current = next
      if (visibleUnits === targetUnits.length) revealingRef.current = false
      setText(next)
      if (revealingRef.current) frame = requestAnimationFrame(revealNext)
    }
    frame = requestAnimationFrame(revealNext)
    return () => {
      cancelAnimationFrame(frame)
    }
  }, [animate, target])

  return { text, revealing: revealingRef.current && text !== target }
}

function toolSummary(data: CodexObservationData, status: StatusView): string {
  if (data.error !== undefined) return firstLine(data.error)
  const args = record(displayValue(data.toolArguments))
  const candidate = args?.command ?? args?.path ?? args?.query ?? data.toolName
  if (typeof candidate === 'string' && candidate.length > 0) return candidate
  return status.label
}

function terminalLabels(t: Translate): Partial<TerminalBlockLabels> {
  return {
    exitCode: code => t('terminal.exitCode', { code }),
    running: t('status.running'),
    failed: t('status.failed'),
    done: t('status.completed'),
    copy: t('terminal.copy'),
    copied: t('terminal.copied'),
    noOutput: t('terminal.noOutput'),
    collapseAria: t('terminal.collapse'),
    collapse: t('terminal.collapse'),
    expandAria: hidden => t('terminal.expandAria', { hidden }),
    expand: hidden => t('terminal.expand', { hidden }),
  }
}

function Summary({ text, status }: { text: string; status: StatusView }) {
  return (
    <>
      <span className={css.separator} aria-hidden />
      <span className={status.dot === 'error' ? css.errorSummary : css.summary}>{text}</span>
      <span className={css.status}>{status.label}</span>
    </>
  )
}

function ReasoningView({
  data, live, t,
}: { data: CodexObservationData; live: boolean; t: Translate }) {
  const status = statusView(data, t)
  const [open, setOpen] = useState(false)
  const summaryRef = useRef<HTMLSpanElement>(null)
  const target = data.reasoning ?? ''
  const animate = live && status.running && data.stage === 'item-delta'
  const progressive = useProgressiveText(target, animate)
  const visualStatus: StatusView = progressive.revealing
    ? { dot: 'ongoing', label: t('status.running'), running: true }
    : status
  const empty = t(visualStatus.running ? 'reasoning.empty.running' : 'reasoning.empty.completed')
  const summary = progressive.text.length === 0
    ? empty
    : reasoningSummary(progressive.text, visualStatus.running)
  const scheduleSummaryScroll = useThrottledVisualUpdate(() => {
    const element = summaryRef.current
    /* v8 ignore next -- hook cleanup cancels the pending frame before ref teardown. */
    if (element === null) return
    element.scrollLeft = visualStatus.running ? element.scrollWidth - element.clientWidth : 0
  })
  useEffect(() => {
    scheduleSummaryScroll()
  }, [scheduleSummaryScroll, visualStatus.running, summary])
  return (
    <div
      className={css.root}
      data-codex-observation="reasoning"
      data-status={visualStatus.running ? 'item-delta' : data.stage}
      data-reasoning-kind={data.reasoningKind}
    >
      <DisclosureRow
        rowClassName={css.row}
        leadingClassName={css.leading}
        titleClassName={css.title}
        chevronClassName={css.chevron}
        icon={<IconThinkOutline14 />}
        title={t('reasoning.title')}
        open={open}
        expandable
        expandOnRowClick
        keepContentWhenOpen
        onToggle={() => { setOpen(value => !value) }}
        collapsedContent={(
          <>
            <span className={css.separator} aria-hidden />
            <span
              ref={summaryRef}
              className={visualStatus.dot === 'error' ? css.errorSummary : css.summary}
              data-follow-end={visualStatus.running || undefined}
            >
              {summary}
            </span>
            <span className={css.status}>{visualStatus.label}</span>
          </>
        )}
      >
        <div className={css.reasoningBody}>
          {progressive.text.length === 0
            ? <span className={css.empty}>{empty}</span>
            : progressive.text}
        </div>
      </DisclosureRow>
    </div>
  )
}

function ToolDetails({ data, t }: { data: CodexObservationData; t: Translate }) {
  return (
    <div className={css.details}>
      {data.toolArguments !== undefined && (
        <JsonBlock
          label={t('details.arguments')}
          payload={displayValue(data.toolArguments)}
          defaultOpen
          truncatedLabel={total => t('details.truncated', { total })}
        />
      )}
      {data.toolResult !== undefined && (
        <JsonBlock
          label={t('details.result')}
          payload={displayValue(data.toolResult)}
          defaultOpen
          truncatedLabel={total => t('details.truncated', { total })}
        />
      )}
      {data.error !== undefined && <div className={css.error}>{t('details.error')}: {data.error}</div>}
      {data.exitCode !== undefined && data.exitCode !== 0 && (
        <div className={css.error}>{t('details.exitCode', { code: data.exitCode })}</div>
      )}
    </div>
  )
}

/** Chat renderer for one Codex reasoning or tool lifecycle. */
export const CodexObservationView = memo(function CodexObservationView({
  node, t, useSession,
}: CodexObservationViewProps) {
  const data = node.data
  const [open, setOpen] = useState(false)
  const live = useSession(snapshot => snapshot.running)
  if (data.type === 'reasoning' || data.type === 'reasoning_delta') {
    return <ReasoningView data={data} live={live} t={t} />
  }
  const status = statusView(data, t)
  const command = commandFacts(data)
  return (
    <div
      className={css.root}
      data-codex-observation="tool"
      data-tool={data.toolName}
      data-status={data.stage}
    >
      <DisclosureRow
        rowClassName={css.row}
        leadingClassName={css.leading}
        titleClassName={css.title}
        chevronClassName={css.chevron}
        icon={status.dot === 'done' || status.dot === 'ongoing' ? toolIcon(data) : <StateDot state={status.dot} />}
        title={toolTitle(data, t)}
        open={open}
        expandable
        expandOnRowClick
        keepContentWhenOpen
        onToggle={() => { setOpen(value => !value) }}
        collapsedContent={<Summary text={toolSummary(data, status)} status={status} />}
      >
        <div className={css.toolBody}>
          {data.type === 'commandExecution' ? (
            <>
              {data.toolArguments !== undefined && (
                <JsonBlock
                  label={t('details.arguments')}
                  payload={displayValue(data.toolArguments)}
                  defaultOpen
                  truncatedLabel={total => t('details.truncated', { total })}
                />
              )}
              <div className={css.resultLabel}>{t('details.result')}</div>
              <TerminalBlock
                command={command.command}
                {...command.cwd === undefined ? {} : { cwd: command.cwd }}
                {...typeof data.toolResult === 'string' ? { output: data.toolResult } : {}}
                {...data.exitCode === undefined ? {} : { exitCode: data.exitCode }}
                running={status.running}
                labels={terminalLabels(t)}
              />
              {data.toolResult !== undefined && typeof data.toolResult !== 'string' && (
                <JsonBlock
                  label={t('details.structuredResult')}
                  payload={data.toolResult}
                  defaultOpen
                  truncatedLabel={total => t('details.truncated', { total })}
                />
              )}
              {data.error !== undefined && <div className={css.error}>{t('details.error')}: {data.error}</div>}
            </>
          ) : <ToolDetails data={data} t={t} />}
        </div>
      </DisclosureRow>
    </div>
  )
})
