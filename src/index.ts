/**
 * Interactive full-screen terminal front door for DeepSeek Harness agents
 * (DASH). Built on pi-tui's ready-made components — Editor (multi-line input
 * with history), Markdown (rendered transcript), and ScrollView (scrollback) —
 * laid out with VStack and driven by the stable-surface orchestrator
 * (`agents.create` / `agent.followup` / `agent.whenIdle` / `session/event`).
 *
 * @module @realchenwenqiao/dash
 */

import { randomUUID } from 'node:crypto'
import { execSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type AgentHandle, type ModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage, type LlmConfigurableProvider } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionLogSnapshot } from '@deepseek-ai/dsh-session-query'
// Empty type imports carry the loader Context merge (settlement await) and the
// cmdline Context merge (appExit host value).
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-commands'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { foldPlanMode } from '@deepseek-ai/dsh-plan-mode'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  CombinedAutocompleteProvider,
  Editor,
  Input,
  Key,
  Markdown,
  ProcessTerminal,
  ScrollView,
  SelectList,
  Text,
  TuiAltScreen,
  VStack,
  matchesKey,
  type Component,
  type EditorTheme,
  type SelectItem,
  type SlashCommand,
  type Terminal,
  type TUI,
} from '@earendil-works/pi-tui'
import { createPalette, gradientText, markdownTheme, quoteBlockBackground, selectTheme } from './components/theme.ts'
import { registerPackagedSkills } from './packaged-skills.ts'
import { formatTokens } from './chat/tokens.ts'
import { parseArguments } from './components/content.ts'

/** Stable Cordis plugin name. */
export const name = 'tui-runner'

/** Core services required before the interactive loop can start. */
export const inject = ['agentDefaultModel', 'agents', 'commands', 'credentials', 'llm', 'planMode', 'sessionQuery', 'sessions', 'skills', 'settings']

/** Tool output is capped so a huge `cat`/`find` cannot flood the transcript. */
const MAX_TOOL_RESULT_LINES = 40
/** Cap on the transcript markdown source; trimmed from the front at a line boundary. */
const MAX_TRANSCRIPT_CHARS = 200_000

/** ANSI Shadow "DASH" logo, rendered in the brand gradient at the top of the TUI. */
const DASH_LOGO = [
  '██████╗   █████╗  ███████╗ ██╗  ██╗',
  '██╔══██╗ ██╔══██╗ ██╔════╝ ██║  ██║',
  '██║  ██║ ███████║ ███████╗ ███████║',
  '██║  ██║ ██╔══██║ ╚════██║ ██╔══██║',
  '██████╔╝ ██║  ██║ ███████║ ██║  ██║',
  '╚═════╝  ╚═╝  ╚═╝ ╚══════╝ ╚═╝  ╚═╝',
].join('\n')

/** Conventional credential reference for a provider route (e.g. anthropic → ANTHROPIC_API_KEY). */
function deriveKeyRef(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

/** Working directory (home abbreviated as ~) plus the git branch when present. */
function cwdLabel(): string {
  const cwd = process.cwd()
  const home = process.env.HOME
  const display = home !== undefined && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd
  let branch = ''
  try {
    branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    }).toString().trim()
  } catch {
    // not a git repository, or git unavailable
  }
  return branch === '' ? display : `${display} (${branch})`
}

/** TUI-owned slash commands; the shared host catalog is merged in at runtime. */
const TUI_COMMANDS: SlashCommand[] = [
  // Conversation
  { name: 'new', description: 'start a new session' },
  { name: 'clear', description: 'clear the transcript' },
  { name: 'resume', description: 'resume a saved session' },
  { name: 'export', description: 'export the conversation to a markdown file' },
  // Session / environment
  { name: 'status', description: 'show session status' },
  { name: 'cost', description: 'show session token usage' },
  { name: 'tokens', description: 'show token breakdown' },
  { name: 'help', description: 'show shortcuts and commands' },
  // Model / display
  { name: 'model', description: 'switch the active model' },
  { name: 'thinking', description: 'toggle extended thinking display' },
  // Account
  { name: 'login', description: 'store an API key' },
  { name: 'logout', description: 'clear the stored API key' },
  // Skills (Claude Code parity — activation prompts for the model)
  { name: 'audit', description: 'run a code audit on this project' },
  { name: 'bug', description: 'capture a bug report' },
  { name: 'review', description: 'run a code review on this project' },
  { name: 'practice', description: 'practice programming with dash' },
  { name: 'pr_comments', description: 'review pull-request comments' },
  { name: 'release-notes', description: 'generate release notes' },
  { name: 'vuln-check', description: 'run a security vulnerability check' },
  // Exit
  { name: 'exit', description: 'quit dash' },
  { name: 'quit', description: 'quit dash' },
]

/** Activation prompts for the built-in skill commands (CC parity). */
const SKILL_COMMANDS: Record<string, string> = {
  audit: 'Run a comprehensive code audit on this project. Report risks, smells, and concrete fixes.',
  bug: 'Capture a structured bug report for the issue I am about to describe, then investigate it.',
  review: 'Run a comprehensive code review on this project. Report issues with severity and suggested changes.',
  practice: 'Practice programming with me on this project: propose an exercise, then review my attempt.',
  pr_comments: 'Review the pull-request comments for this project and propose responses or fixes.',
  'release-notes': 'Generate release notes from the recent changes in this repository.',
  'vuln-check': 'Run a security vulnerability check on this project and report findings.',
}

/**
 * Editor subclass that colors the leading `/command` token in the accent role
 * as the user types it, so slash commands read as commands before submission.
 */
class SlashEditor extends Editor {
  constructor(tui: TUI, theme: EditorTheme, private readonly accent: (text: string) => string) {
    super(tui, theme)
  }

  override render(width: number): string[] {
    const lines = super.render(width)
    // Color the leading `/command` on the first content line (index 1, after
    // the top border).
    const content = lines[1]
    if (content !== undefined) {
      const match = /^(\s*)(\/[A-Za-z0-9_-]*)/.exec(content)
      if (match !== null) {
        const indent = match[1] ?? ''
        const command = match[2] ?? ''
        if (command !== '') {
          lines[1] = indent + this.accent(command) + content.slice(indent.length + command.length)
        }
      }
    }
    // pi-tui renders the autocomplete dropdown BELOW the input box. Move the
    // dropdown lines above the top border so the menu grows upward instead of
    // shoving the editor (and the footer after it) down the content stream.
    let bottom = -1
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]
      if (line !== undefined && isBorderLine(line)) {
        bottom = index
        break
      }
    }
    if (bottom > 0 && bottom < lines.length - 1) {
      const menu = lines.splice(bottom + 1)
      lines.unshift(...menu)
    }
    return lines
  }
}

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g
const OSC = /\x1b\][^\x07]*\x07/g
const APC = /\x1b_[^\x07]*\x07/g

/** True for the editor's `─` borders (plain or scroll indicators). */
function isBorderLine(line: string): boolean {
  const stripped = line.replace(ANSI, '').replace(OSC, '').replace(APC, '').trim()
  return stripped.length > 0 && /^[─↑↓\s0-9]+$/.test(stripped) && stripped.includes('─')
}
/** Latest logged provider/model route, for the resume availability check. */
function resumeRoute(events: readonly SessionEvent[]): { provider: string; model: string } | undefined {
  const header = events.findLast(item => item.type === 'request/header')
  if (header?.type === 'request/header') {
    return { provider: header.data.header.config.provider, model: header.data.header.config.model }
  }
  const assistant = events.findLast(item => item.type === 'assistant/message')
  return assistant?.type === 'assistant/message'
    ? { provider: assistant.data.message.source.provider, model: assistant.data.message.source.model }
    : undefined
}

function summarizeToolArguments(raw: string): string {
  const { value, valid } = parseArguments(raw)
  if (!valid || typeof value !== 'object' || value === null) return ''
  const args = value as Record<string, unknown>
  if (typeof args.command === 'string') return args.command
  if (typeof args.path === 'string') return args.path
  for (const entry of Object.values(args)) {
    if (typeof entry === 'string') return entry
  }
  return ''
}

/** Flatten and clip a behavior line for the rewind picker. */
function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Format a duration in ms for the ledger's right column. */
function formatDuration(durationMs: number | null): string {
  if (durationMs === null || !Number.isFinite(durationMs)) return ''
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`
  return `${(durationMs / 1000).toFixed(1)}s`
}

/**
 * Growable markdown transcript. Assistant text streams through pi-tui's
 * Markdown renderer; user prompts and tool output are formatted as markdown
 * constructs (bold label, code fence). ScrollView provides the scrollback.
 */
class TranscriptContent implements Component {
  private readonly markdown: Markdown
  private source = ''
  /** Thinking sections render collapsed until Ctrl+O toggles this on. */
  private showThinking = false
  /** Tool output sections render collapsed until Ctrl+T toggles this on. */
  private showToolOutput = false
  /** Marker → accumulated thinking text, replaced at render time. */
  private readonly thinking = new Map<string, string>()
  private thinkingSeq = 0
  /** Marker → tool output body, replaced at render time. */
  private readonly toolOutputs = new Map<string, { text: string; lines: number }>()
  private toolSeq = 0
  /** Marker of the thinking section currently streaming, if any. */
  private openThinking: string | null = null

  constructor(pal: ReturnType<typeof createPalette>) {
    const fill = quoteBlockBackground(process.stdout.isTTY)
    this.markdown = new Markdown('', 0, 0, markdownTheme(pal), {
      bgColor: (line) => {
        // Paint blockquote lines (user messages, thinking, notes) as full-width
        // color blocks; everything else keeps the terminal background.
        const stripped = line.replace(ANSI, '').replace(OSC, '').replace(APC, '')
        return stripped.startsWith('│') ? fill(line) : line
      },
    })
  }

  private renderThinking(text: string): string {
    if (this.showThinking) {
      return `\n\n> 💭 ${text.replace(/\n/g, '\n> ')}\n\n`
    }
    return `\n\n**💭 Thinking**  _${text.length} chars · Ctrl+O to expand_\n\n`
  }

  private renderToolOutput(entry: { text: string; lines: number }): string {
    if (this.showToolOutput) {
      return `\n\n\`\`\`\n${entry.text}\n\`\`\`\n\n`
    }
    return `\n\n  ↳ _${entry.lines} lines · Ctrl+T to expand_\n\n`
  }

  private refresh(): void {
    if (this.source.length > MAX_TRANSCRIPT_CHARS) {
      const cut = this.source.length - MAX_TRANSCRIPT_CHARS + 50_000
      const boundary = this.source.indexOf('\n', cut)
      this.source = this.source.slice(boundary === -1 ? cut : boundary + 1)
      for (const marker of [...this.thinking.keys()]) {
        if (!this.source.includes(marker)) this.thinking.delete(marker)
      }
      for (const marker of [...this.toolOutputs.keys()]) {
        if (!this.source.includes(marker)) this.toolOutputs.delete(marker)
      }
    }
    let rendered = this.source
    for (const [marker, text] of this.thinking) {
      rendered = rendered.split(marker).join(this.renderThinking(text))
    }
    for (const [marker, entry] of this.toolOutputs) {
      rendered = rendered.split(marker).join(this.renderToolOutput(entry))
    }
    this.markdown.setText(rendered)
  }

  clear(): void {
    this.source = ''
    this.thinking.clear()
    this.toolOutputs.clear()
    this.openThinking = null
    this.refresh()
  }

  appendText(text: string): void {
    if (text === '') return
    this.source += text
    this.refresh()
  }

  appendThinking(text: string): void {
    if (text === '') return
    if (this.openThinking === null) {
      const marker = `\u0000think${this.thinkingSeq++}\u0000`
      this.thinking.set(marker, text)
      this.openThinking = marker
      this.source += marker
    } else {
      this.thinking.set(this.openThinking, (this.thinking.get(this.openThinking) ?? '') + text)
    }
    this.refresh()
  }

  finalizeThinking(): void {
    if (this.openThinking !== null) {
      this.openThinking = null
      this.refresh()
    }
  }

  toggleThinking(): void {
    this.showThinking = !this.showThinking
    this.refresh()
  }

  toggleToolOutput(): void {
    this.showToolOutput = !this.showToolOutput
    this.refresh()
  }

  appendUser(text: string): void {
    this.source += `\n\n> **You**  ${text}\n\n`
    this.refresh()
  }

  appendToolCall(name: string, summary: string): void {
    this.source += `\n\n**⚙ ${name}**${summary === '' ? '' : `  ${summary}`}\n\n`
    this.refresh()
  }

  appendToolResult(text: string): void {
    if (text === '') return
    const lines = text.split('\n')
    const shown = lines.slice(0, MAX_TOOL_RESULT_LINES)
    let body = shown.join('\n')
    if (lines.length > shown.length) body += `\n… ${lines.length - shown.length} more lines`
    const marker = `\u0000tool${this.toolSeq++}\u0000`
    this.toolOutputs.set(marker, { text: body, lines: lines.length })
    this.source += marker
    this.refresh()
  }

  render(width: number): string[] {
    return this.markdown.render(width)
  }

  invalidate(): void {
    this.markdown.invalidate()
  }
}

/**
 * Feed committed session events into the transcript + status line. Streams
 * text token-by-token from `assistant/chunk`, renders tool cards from
 * `tool/call`/`tool/result` through markdown, and posts a token footer.
 */
class TranscriptRenderer {
  /** Steps whose text already streamed as chunks, keyed `turn:step`. */
  private readonly streamed = new Set<string>()
  /** Steps whose reasoning already streamed as chunks, keyed `turn:step`. */
  private readonly reasoned = new Set<string>()
  private totalInput = 0
  private totalOutput = 0
  private totalReasoning = 0
  /** Cache-hit and context-window facts from the latest request. */
  private lastCacheRead = 0
  private lastBilledInput = 0
  /** Tools whose call has not yet produced a result, keyed by callId. */
  private runningTools = new Map<string, string>()
  /** Recent text-delta events feeding the streaming TPS estimate. */
  private chunkWindow: Array<{ time: number; chars: number }> = []
  private lastFooterRefresh = 0

  constructor(
    private readonly transcript: TranscriptContent,
    private readonly footer: Text,
    private readonly pal: ReturnType<typeof createPalette>,
    private readonly cwdLabel: string,
    private sessionId: string,
    private readonly getModel: () => ModelSelection,
    private readonly getContextWindow: () => number,
    private readonly getPlanActive: () => boolean,
  ) {}

  /** Reset cumulative counters and rebind the session id for a rewind replay. */
  reset(sessionId: string): void {
    this.streamed.clear()
    this.reasoned.clear()
    this.totalInput = 0
    this.totalOutput = 0
    this.totalReasoning = 0
    this.lastCacheRead = 0
    this.lastBilledInput = 0
    this.runningTools.clear()
    this.chunkWindow = []
    this.sessionId = sessionId
  }

  /** Expose cumulative usage for /status, /cost and /tokens. */
  usageSummary(): { input: number; output: number; reasoning: number; cacheRead: number; billedInput: number } {
    return {
      input: this.totalInput,
      output: this.totalOutput,
      reasoning: this.totalReasoning,
      cacheRead: this.lastCacheRead,
      billedInput: this.lastBilledInput,
    }
  }

  /** Rewrite the footer from cumulative totals, live activity, and the model. */
  refreshFooter(): void {
    const model = this.getModel()
    const effort = model.reasoningEffort !== undefined ? ` • ${model.reasoningEffort}` : ''
    const segments: string[] = []
    // Usage (dim).
    const usageParts = [`↑${formatTokens(this.totalInput)}`, `↓${formatTokens(this.totalOutput)}`]
    if (this.totalReasoning > 0) usageParts.push(`R${formatTokens(this.totalReasoning)}`)
    if (this.lastBilledInput > 0) usageParts.push(`CH${(this.lastCacheRead / this.lastBilledInput * 100).toFixed(1)}%`)
    segments.push(this.pal.dim(usageParts.join(' ')))
    // Context-window occupancy (warning/error as it crosses 80% / 95%).
    if (this.lastBilledInput > 0) {
      const window = this.getContextWindow()
      if (window > 0) {
        const pct = this.lastBilledInput / window * 100
        const pctText = `${pct.toFixed(1)}%/${formatTokens(window)}`
        segments.push(pct >= 95 ? this.pal.error(pctText) : pct >= 80 ? this.pal.warning(pctText) : this.pal.dim(pctText))
      }
    }
    // Live activity (accent): running tools and streaming TPS.
    const activityParts: string[] = []
    if (this.runningTools.size > 0) activityParts.push(`⚙ ${[...this.runningTools.values()].join(' · ')}`)
    const tps = this.currentTps()
    if (tps > 0) activityParts.push(`${tps.toFixed(0)}t/s`)
    if (activityParts.length > 0) segments.push(this.pal.accent(activityParts.join(' ')))
    // Model route (dim).
    segments.push(this.pal.dim(`(${model.provider}) ${model.model}${effort}${this.getPlanActive() ? ' · plan' : ''}`))
    const line2 = segments.filter(segment => segment !== '').join('  ')
    this.footer.setText(`${this.pal.dim(this.cwdLabel)}\n${line2}\n${this.pal.dim(this.sessionId)}`)
  }

  /** Streaming tokens-per-second estimate from the last 2s of text deltas. */
  private currentTps(): number {
    if (this.chunkWindow.length < 2) return 0
    const first = this.chunkWindow[0]
    const last = this.chunkWindow[this.chunkWindow.length - 1]
    if (first === undefined || last === undefined) return 0
    const span = last.time - first.time
    if (span <= 0) return 0
    let chars = 0
    for (const entry of this.chunkWindow) chars += entry.chars
    return (chars / 4) / (span / 1000)
  }

  private stepKey(turn: number, step: number): string {
    return `${turn}:${step}`
  }

  onEvent(event: SessionEvent): void {
    if (event.type === 'assistant/chunk') this.onChunk(event)
    else if (event.type === 'assistant/message') this.onAssistantMessage(event)
    else if (event.type === 'user/message') this.onUserMessage(event)
    else if (event.type === 'tool/call') this.onToolCall(event)
    else if (event.type === 'tool/result') this.onToolResult(event)
    else if (event.type === 'turn/end') this.onTurnEnd(event)
    else if (event.type === 'command/run') this.onCommandRun(event)
    else if (event.type === 'command/done') this.onCommandDone(event)
  }

  private onChunk(event: SessionEvent<'assistant/chunk'>): void {
    const { turn, step, chunk } = event.data
    const key = this.stepKey(turn, step)
    if (chunk.type === 'text-delta' && chunk.text !== '') {
      this.transcript.finalizeThinking()
      this.transcript.appendText(chunk.text)
      this.streamed.add(key)
      // Feed the streaming TPS window and refresh the footer on a throttle.
      this.chunkWindow.push({ time: event.time, chars: chunk.text.length })
      const cutoff = event.time - 2000
      while (this.chunkWindow.length > 0 && (this.chunkWindow[0]?.time ?? 0) < cutoff) this.chunkWindow.shift()
      if (event.time - this.lastFooterRefresh >= 300) {
        this.lastFooterRefresh = event.time
        this.refreshFooter()
      }
    } else if (chunk.type === 'reasoning-delta' && chunk.text !== '') {
      this.transcript.appendThinking(chunk.text)
      this.reasoned.add(key)
    }
  }

  private onAssistantMessage(event: SessionEvent<'assistant/message'>): void {
    const { turn, step, message, usage } = event.data
    const key = this.stepKey(turn, step)
    if (!this.reasoned.has(key)) {
      for (const block of message.content) {
        if (block.type === 'reasoning' && block.text !== '') this.transcript.appendThinking(block.text)
      }
    }
    if (!this.streamed.has(key)) {
      for (const block of message.content) {
        if (block.type === 'text' && block.text !== '') this.transcript.appendText(block.text)
      }
    }
    this.transcript.finalizeThinking()
    if (usage !== undefined) {
      this.totalInput += usage.inputTokens
      this.totalOutput += usage.outputTokens
      this.totalReasoning += usage.reasoningTokens ?? 0
      this.lastCacheRead = usage.cacheReadTokens ?? 0
      this.lastBilledInput = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
      this.refreshFooter()
    }
  }

  private onUserMessage(event: SessionEvent<'user/message'>): void {
    if (event.data.source.kind !== 'user') return
    const parts: string[] = []
    for (const block of event.data.content) {
      if (block.type === 'text' && block.text !== '') parts.push(block.text)
    }
    if (parts.length > 0) this.transcript.appendUser(parts.join('\n'))
  }

  private onToolCall(event: SessionEvent<'tool/call'>): void {
    const { name, arguments: raw, callId } = event.data
    this.runningTools.set(String(callId), name)
    this.transcript.appendToolCall(name, summarizeToolArguments(raw))
    this.refreshFooter()
  }

  private onToolResult(event: SessionEvent<'tool/result'>): void {
    const { message, error } = event.data
    this.runningTools.delete(String(message.source.callId))
    if (error !== undefined) {
      this.transcript.appendText(`\n\n> [error: ${error.code}]\n\n`)
      this.refreshFooter()
      return
    }
    const lines: string[] = []
    for (const block of message.content) {
      for (const inner of block.content) {
        if (inner.type === 'text' && inner.text !== '') lines.push(...inner.text.split('\n'))
      }
    }
    if (lines.length === 0) return
    this.transcript.appendToolResult(lines.join('\n'))
  }

  private onTurnEnd(event: SessionEvent<'turn/end'>): void {
    this.runningTools.clear()
    const { reason } = event.data
    if (reason.kind === 'error') {
      this.transcript.appendText(`\n\n> [error: ${reason.error.code}]\n\n`)
    } else if (reason.kind === 'max-tokens') {
      this.transcript.appendText('\n\n> [max-tokens]\n\n')
    }
  }

  private onCommandRun(event: SessionEvent<'command/run'>): void {
    const { name, args } = event.data
    const suffix = args !== undefined && args.trim() !== '' ? `  ${args.trim()}` : ''
    this.transcript.appendText(`\n\n**/${name}**${suffix}\n\n`)
  }

  private onCommandDone(event: SessionEvent<'command/done'>): void {
    const { kind, text } = event.data
    if (text === undefined || text === '') return
    if (kind === 'error') {
      this.transcript.appendText(`\n\n> [error: ${text}]\n\n`)
    } else {
      this.transcript.appendText(`${text}\n\n`)
    }
  }
}

/**
 * Mount the interactive full-screen driver.
 * @param ctx - plugin context carrying core services and the launcher-provided exit request.
 */
export function apply(ctx: Context): void {
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('tui-runner: the launcher must provide ctx.appExit before the tree mounts')
  }
  registerPackagedSkills(ctx)
  void run(ctx, exit).catch((error: unknown) => {
    process.stderr.write(`dash: ${error instanceof Error ? error.message : String(error)}\n`)
    exit(1)
  })
}

async function run(ctx: Context, exit: (code: number) => void): Promise<void> {
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  const commands = ctx.get('commands')
  const credentials = ctx.get('credentials')
  const llm = ctx.get('llm')
  const planMode = ctx.get('planMode')
  const sessionQuery = ctx.get('sessionQuery')
  const settings = ctx.get('settings')
  if (agents === undefined || defaultModel === undefined || sessions === undefined
    || commands === undefined || credentials === undefined || llm === undefined
    || planMode === undefined || sessionQuery === undefined || settings === undefined) {
    return
  }

  // `--resume <id>` (or `--resume=<id>`) resumes a persisted session instead of
  // minting a fresh one; the flag reaches us verbatim through ctx.cmdlineArgs.
  let resumeSessionId: SessionId | undefined
  const cmdlineArgs = ctx.get('cmdlineArgs')
  if (cmdlineArgs !== undefined) {
    const args = cmdlineArgs.get()
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]
      if (arg === '--resume' && index + 1 < args.length) {
        const next = args[index + 1]
        if (next !== undefined) resumeSessionId = SessionId(next)
        break
      }
      if (arg?.startsWith('--resume=') === true) {
        resumeSessionId = SessionId(arg.slice('--resume='.length))
        break
      }
    }
  }

  let selection = defaultModel.currentSelection()
  const selectionRef: ModelSelectionRef = { current: selection, assembled: undefined }
  // Snapshot retained so the resume path can replay the restored history into
  // the transcript once the renderer exists.
  let resumeSnapshot: SessionLogSnapshot | undefined
  let created: AgentHandle
  if (resumeSessionId === undefined) {
    created = await agents.create({
      sessionId: SessionId(`session-${randomUUID()}`),
      meta: { cwd: process.cwd() },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: (agentCtx) => {
        installModelSelection(agentCtx, selectionRef)
      },
    })
  } else {
    const snapshot = await sessionQuery.readSession(resumeSessionId)
    resumeSnapshot = snapshot
    // Restore the session's last route when present; otherwise keep the
    // default model so a resumed session still has a callable provider.
    const route = resumeRoute(snapshot.events)
    if (route !== undefined) {
      selection = { provider: route.provider, model: route.model }
      selectionRef.current = selection
    }
    created = await agents.resume({
      resumeSessionId,
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: (agentCtx) => {
        installModelSelection(agentCtx, selectionRef)
      },
    })
  }
  let agent = created.agent
  await agent.whenIdle()

  const terminal: Terminal = new ProcessTerminal()
  const ui = new TuiAltScreen(terminal)
  const pal = createPalette(process.stdout.isTTY)

  // Layout: gradient logo + subtitle, hint, scrollable transcript, token
  // footer, bordered editor.
  const truecolor = process.env.COLORTERM === 'truecolor'
  const logo = DASH_LOGO.split('\n').map(line => truecolor ? gradientText(line) : pal.brand(line)).join('\n')
  const banner = new Text(`${logo}\n${pal.dim('DeepSeek Awesome Harness')}`)
  const hint = new Text(pal.dim('Enter send · Shift+Enter newline · Ctrl+O think · Ctrl+T tools · Esc Esc rewind · Ctrl+C exit'))
  const transcript = new TranscriptContent(pal)
  const footer = new Text('')
  const editor = new SlashEditor(ui, { borderColor: pal.dim, selectList: selectTheme(pal) }, pal.accent)
  const hostCommands: SlashCommand[] = commands.list(agent).map(command => ({
    name: command.name,
    description: command.description,
    ...(command.input === undefined ? {} : { argumentHint: command.input.hint }),
  }))
  editor.setAutocompleteProvider(new CombinedAutocompleteProvider([...TUI_COMMANDS, ...hostCommands], process.cwd()))

  // The ENTIRE surface — banner, hint, transcript, editor, footer — forms one
  // scrollable content stream. Nothing is pinned: scrolling pushes the logo
  // and hint up and out of the viewport exactly like the conversation does.
  const body = new VStack([banner, hint, { component: transcript }, { component: editor, maxSize: 8 }, footer])
  const scrollView = new ScrollView(body, {
    follow: 'end',
    primary: true,
    scrollbar: 'auto',
    scrollbarStyle: pal.dim,
  })
  const layout = new VStack([{ component: scrollView, grow: 1 }])
  ui.setLayoutRoot(layout)
  ui.setFocus(editor)

  /** Active model's context window; resolved async and cached for the footer. */
  let contextWindow = 0
  const renderer = new TranscriptRenderer(
    transcript,
    footer,
    pal,
    cwdLabel(),
    agent.session.id,
    () => selectionRef.current ?? selection,
    () => contextWindow,
    () => foldPlanMode(agent.session.events),
  )
  // A resumed session replays its committed history into the transcript
  // (skipping token-level chunks — the full text already rides in
  // assistant/message); a fresh session starts with the welcome line.
  if (resumeSnapshot !== undefined) {
    for (const event of resumeSnapshot.events) {
      if (event.type !== 'assistant/chunk') renderer.onEvent(event)
    }
    transcript.appendText(`\n\n_Resumed ${resumeSnapshot.session.id} — history restored._\n\n`)
  } else {
    transcript.appendText('_Welcome to DASH — type a prompt and press Enter._')
  }
  renderer.refreshFooter()
  ui.renderNow()

  /** Resolve the active model's context window once per switch, then repaint. */
  const resolveContextWindow = async (): Promise<void> => {
    const model = selectionRef.current ?? selection
    try {
      const info = await llm.resolveModelInfo(model.provider, model.model)
      contextWindow = info.context?.contextWindow ?? 0
    } catch {
      contextWindow = 0
    }
    renderer.refreshFooter()
  }
  void resolveContextWindow()
  const offEvents = ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (session.id === agent.id) {
      renderer.onEvent(event)
      ui.renderNow()
    }
  })

  let running = false
  let shuttingDown = false

  /** Release the terminal and tear the agent down once, in order. */
  const teardown = async (): Promise<void> => {
    offExit()
    offEvents()
    try {
      await sessions.flush(agent.session)
    } catch { /* best-effort flush on exit */ }
    await created.dispose()
    ui.stop()
  }

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    await teardown()
    const profileIdx = process.argv.indexOf('--profile')
    const profile = profileIdx >= 0 ? process.argv[profileIdx + 1] : undefined
    const resumeCmd = profile !== undefined ? `dsh --profile ${profile} --resume ${agent.session.id}` : `dsh --resume ${agent.session.id}`
    process.stdout.write(`To resume this session: ${resumeCmd}\n`)
    exit(0)
  }

  /**
   * Rebuild the launcher argv for a process-replacement handoff: keep the
   * launcher flags (e.g. `--profile dash`) and swap any `--resume` argument.
   * Returns undefined when there is no script entry to re-exec.
   */
  const handoffArgv = (resumeId: SessionId | undefined): string[] | undefined => {
    const entry = process.argv[1]
    if (entry === undefined) return undefined
    const args = process.argv.slice(2)
    const filtered: string[] = []
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index] ?? ''
      if (arg === '--resume') { index += 1; continue }
      if (arg.startsWith('--resume=')) continue
      filtered.push(arg)
    }
    if (resumeId !== undefined) filtered.push(`--resume=${resumeId}`)
    return [entry, ...filtered]
  }

  /** Re-exec into the session's workspace with `--resume <id>` (process replacement). */
  const resumeHandoff = async (id: SessionId, cwd: string | undefined): Promise<void> => {
    if (shuttingDown) return
    const execve = process.execve?.bind(process)
    const argv = handoffArgv(id)
    if (argv === undefined || execve === undefined) {
      transcript.appendText('\n\n> [error: resume handoff unavailable in this runtime]\n\n')
      ui.renderNow()
      return
    }
    // Enter the workspace BEFORE teardown commits: an unreachable directory must
    // fail while the terminal can still be restored.
    if (cwd !== undefined) {
      try {
        process.chdir(cwd)
      } catch (error: unknown) {
        transcript.appendText(`\n\n> [error: cannot enter "${cwd}": ${error instanceof Error ? error.message : String(error)}]\n\n`)
        ui.renderNow()
        return
      }
    }
    shuttingDown = true
    await teardown()
    execve(process.execPath, [process.execPath, ...process.execArgv, ...argv], process.env)
    // execve replaces the process on success; reaching here means it failed.
    process.stderr.write('dash: resume handoff failed after terminal release\n')
    process.exit(1)
  }

  /** Re-exec into a fresh session (no --resume), keeping the current cwd. */
  const newSessionHandoff = async (): Promise<void> => {
    if (shuttingDown) return
    const execve = process.execve?.bind(process)
    const argv = handoffArgv(undefined)
    if (argv === undefined || execve === undefined) {
      transcript.appendText('\n\n> [error: new-session handoff unavailable in this runtime]\n\n')
      ui.renderNow()
      return
    }
    shuttingDown = true
    await teardown()
    execve(process.execPath, [process.execPath, ...process.execArgv, ...argv], process.env)
    process.stderr.write('dash: new-session handoff failed after terminal release\n')
    process.exit(1)
  }

  /** Export the conversation log to a timestamped markdown file. */
  const exportMarkdown = async (): Promise<void> => {
    const lines: string[] = [`# DASH session ${agent.session.id}\n`]
    for (const event of agent.session.events) {
      if (event.type === 'user/message' && event.data.source.kind === 'user') {
        for (const block of event.data.content) {
          if (block.type === 'text' && block.text !== '') lines.push(`## You\n\n${block.text}\n`)
        }
      } else if (event.type === 'assistant/message') {
        for (const block of event.data.message.content) {
          if (block.type === 'text' && block.text !== '') lines.push(`## Assistant\n\n${block.text}\n`)
        }
      } else if (event.type === 'tool/call') {
        lines.push(`\`\`\`\n⚙ ${event.data.name} ${event.data.arguments}\n\`\`\`\n`)
      }
    }
    const file = `dash-export-${Date.now()}.md`
    try {
      await writeFile(file, lines.join('\n'), 'utf8')
      transcript.appendText(`\n\n> exported ${lines.length} lines to **${file}**\n\n`)
    } catch (error: unknown) {
      transcript.appendText(`\n\n> [error: ${error instanceof Error ? error.message : String(error)}]\n\n`)
    }
    ui.renderNow()
  }

  editor.onSubmit = (text: string) => {
    editor.addToHistory(text)
    const trimmed = text.trim()
    if (trimmed === '' || shuttingDown) return
    if (trimmed.startsWith('/')) {
      handleSlashCommand(trimmed)
      return
    }
    if (running) return
    running = true
    // The user message renders through the session/event feed (onUserMessage),
    // not here — a manual append would double-render it once the driver
    // claims and logs the same message as user/message.
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: trimmed }],
      source: { kind: 'user' },
    }))
    agent.whenIdle().then(() => {
      running = false
      ui.renderNow()
    }).catch((error: unknown) => {
      running = false
      transcript.appendText(`\n\n> [error: ${error instanceof Error ? error.message : String(error)}]\n\n`)
      ui.renderNow()
    })
  }

  /** Route a `/command` to its handler instead of the agent. */
  /** Resolve and apply one picked (provider, model) to the live agent. */
  const switchModel = async (provider: string, model: string): Promise<void> => {
    try {
      const resolved = await llm.resolveCallConfig({ provider, model })
      selectionRef.current = {
        provider: resolved.provider,
        model: resolved.model,
        ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }),
      }
      renderer.refreshFooter()
      transcript.appendText(`\n\n> model → ${resolved.provider}/${resolved.model}\n\n`)
      void resolveContextWindow()
    } catch (error: unknown) {
      transcript.appendText(`\n\n> [error: ${error instanceof Error ? error.message : String(error)}]\n\n`)
    }
    ui.renderNow()
  }

  /** Open the model picker overlay over the shared provider/model catalog. */
  const openModelPicker = async (): Promise<void> => {
    const items: SelectItem[] = []
    const byValue = new Map<string, { provider: string; model: string }>()
    for (const provider of llm.listProviders()) {
      try {
        const models = await llm.listModels(provider.id)
        for (const model of models) {
          const value = `${provider.id}:${model.id}`
          items.push({
            value,
            label: model.name,
            description: provider.name,
          })
          byValue.set(value, { provider: provider.id, model: model.id })
        }
      } catch {
        // A provider that cannot list its catalog is skipped; others stay usable.
      }
    }
    if (items.length === 0) {
      transcript.appendText('\n\n> [/model] no models available — configure a provider first\n\n')
      ui.renderNow()
      return
    }
    const list = new SelectList(items, 12, selectTheme(pal))
    const handle = ui.showOverlay(list, { anchor: 'center', width: '64%', maxHeight: '60%' })
    list.onSelect = (item: SelectItem) => {
      handle.hide()
      const chosen = byValue.get(item.value)
      if (chosen !== undefined) void switchModel(chosen.provider, chosen.model)
    }
    list.onCancel = () => {
      handle.hide()
      ui.renderNow()
    }
    ui.renderNow()
  }

  /** Store one provider key, activate its route, then confirm. */
  const saveKey = async (entry: LlmConfigurableProvider, key: string): Promise<void> => {
    const keyRef = deriveKeyRef(entry.provider)
    try {
      await settings.mutate(settingsNamespace(entry.settingsNs), [
        { op: 'set', path: [...entry.settingsPath, 'apiKeyEnv'], value: keyRef },
      ])
      await credentials.set(credentialRef(keyRef), key)
      transcript.appendText(`\n\n> key stored for **${entry.displayName}** (${entry.provider}) — run /model to pick it\n\n`)
    } catch (error: unknown) {
      transcript.appendText(`\n\n> [error: ${error instanceof Error ? error.message : String(error)}]\n\n`)
    }
    ui.renderNow()
  }

  /** Prompt for one provider's API key in a centered single-line overlay. */
  const promptForKey = (entry: LlmConfigurableProvider): void => {
    transcript.appendText(`\n\n> enter the API key for **${entry.displayName}** (${entry.provider})\n\n`)
    ui.renderNow()
    const input = new Input()
    const handle = ui.showOverlay(input, { anchor: 'center', width: '70%' })
    input.onSubmit = (key: string) => {
      handle.hide()
      const trimmed = key.trim()
      if (trimmed !== '') void saveKey(entry, trimmed)
      else ui.renderNow()
    }
    input.onEscape = () => {
      handle.hide()
      ui.renderNow()
    }
  }

  /** Open the provider picker for /login. */
  const openLoginPicker = (): void => {
    const entries = llm.listConfigurableProviders()
    if (entries.length === 0) {
      transcript.appendText('\n\n> [/login] no configurable providers are available\n\n')
      ui.renderNow()
      return
    }
    const items: SelectItem[] = entries.map(entry => ({
      value: entry.provider,
      label: entry.displayName,
      description: entry.provider,
    }))
    const byProvider = new Map(entries.map(entry => [entry.provider, entry]))
    const list = new SelectList(items, 12, selectTheme(pal))
    const handle = ui.showOverlay(list, { anchor: 'center', width: '64%', maxHeight: '60%' })
    list.onSelect = (item: SelectItem) => {
      handle.hide()
      const entry = byProvider.get(item.value)
      if (entry !== undefined) promptForKey(entry)
    }
    list.onCancel = () => {
      handle.hide()
      ui.renderNow()
    }
    ui.renderNow()
  }

  /** Open the persisted-session picker for /resume. */
  const openResumePicker = async (): Promise<void> => {
    let records: Awaited<ReturnType<typeof sessionQuery.listSessions>>
    try {
      records = await sessionQuery.listSessions()
    } catch (error: unknown) {
      transcript.appendText(`\n\n> [error: ${error instanceof Error ? error.message : String(error)}]\n\n`)
      ui.renderNow()
      return
    }
    if (records.length === 0) {
      transcript.appendText('\n\n> [/resume] no saved sessions to resume\n\n')
      ui.renderNow()
      return
    }
    // Newest first; titles resolve in one batch, an unreadable row degrades to "Untitled".
    records.sort((a, b) => b.header.createdAt - a.header.createdAt)
    const titles = await sessionQuery.readTitleSnapshots(records.map(record => record.header.id)).catch(() => [])
    const titleOf = new Map<string, string>()
    for (const result of titles) {
      if (result.status === 'fulfilled' && result.value.title !== undefined) {
        titleOf.set(result.sessionId, result.value.title.title)
      }
    }
    const items: SelectItem[] = records.map((record) => {
      const when = new Date(record.header.createdAt).toLocaleString()
      const where = record.header.cwd !== undefined ? ` · ${record.header.cwd}` : ''
      return {
        value: record.header.id,
        label: titleOf.get(record.header.id) ?? 'Untitled',
        description: `${when}${where}`,
      }
    })
    openBottomPicker(items, (item: SelectItem) => {
      const record = records.find(candidate => candidate.header.id === item.value)
      if (record !== undefined) void resumeHandoff(record.header.id, record.header.cwd)
    })
  }

  /** One behavior row in the rewind ledger, mirroring the web Trajectory record. */
  interface RewindPoint {
    /** Inclusive seed boundary for the turn this row belongs to (-1 = empty history). */
    boundary: number
    /** Behavior kind marker. */
    kind: string
    /** Behavior summary text. */
    text: string
    /** Turn number this row belongs to. */
    turn: number
    /** Known duration in ms, or null. */
    durationMs: number | null
  }

  /**
   * Walk the log into a behavior ledger: one row per user message, tool call,
   * or assistant reply, each carrying the turn boundary it can be rewound to.
   * This mirrors the web Trajectory ledger's record shape (kind + text + time).
   */
  const collectRewindPoints = (events: readonly SessionEvent[]): RewindPoint[] => {
    const points: RewindPoint[] = []
    let prevTurnEnd = -1
    let turn = 0
    let stepStart: number | null = null
    const openTools = new Map<string, { point: RewindPoint; time: number }>()
    for (const event of events) {
      if (event.type === 'turn/start') {
        turn = event.data.turn
      } else if (event.type === 'step/start') {
        stepStart = event.time
      } else if (event.type === 'user/message') {
        if (event.data.source.kind === 'user') {
          for (const block of event.data.content) {
            if (block.type === 'text' && block.text !== '') {
              points.push({ boundary: prevTurnEnd, kind: 'user', text: clip(block.text, 48), turn, durationMs: null })
              break
            }
          }
        }
      } else if (event.type === 'tool/call') {
        const arg = summarizeToolArguments(event.data.arguments)
        const point: RewindPoint = {
          boundary: prevTurnEnd,
          kind: 'tool',
          text: `${event.data.name}${arg === '' ? '' : ` ${clip(arg, 32)}`}`,
          turn,
          durationMs: null,
        }
        points.push(point)
        openTools.set(String(event.data.callId), { point, time: event.time })
      } else if (event.type === 'tool/result') {
        const open = openTools.get(String(event.data.message.source.callId))
        if (open !== undefined) {
          open.point.durationMs = event.time - open.time
          if (event.data.error !== undefined) open.point.text += ' ✗'
          openTools.delete(String(event.data.message.source.callId))
        }
      } else if (event.type === 'assistant/message') {
        for (const block of event.data.message.content) {
          if (block.type === 'text' && block.text !== '') {
            points.push({
              boundary: prevTurnEnd,
              kind: 'assistant',
              text: clip(block.text, 48),
              turn,
              durationMs: stepStart !== null ? event.time - stepStart : null,
            })
            break
          }
        }
      } else if (event.type === 'turn/end') {
        prevTurnEnd = event.seq
      }
    }
    return points
  }

  /** The select list currently occupying the editor slot, or null when typing. */
  let activePicker: SelectList | null = null

  /** Swap the editor for a select list at the bottom of the stream (Claude Code-style). */
  const openBottomPicker = (items: SelectItem[], onSelect: (item: SelectItem) => void): void => {
    if (activePicker !== null) return
    const list = new SelectList(items, 12, selectTheme(pal))
    activePicker = list
    body.removeChild(editor)
    body.addChild(list, { maxSize: 12 })
    list.onSelect = (item: SelectItem) => {
      closeBottomPicker()
      onSelect(item)
    }
    list.onCancel = () => {
      closeBottomPicker()
    }
    ui.renderNow()
  }

  /** Restore the editor after a bottom picker closes. */
  const closeBottomPicker = (): void => {
    if (activePicker === null) return
    body.removeChild(activePicker)
    activePicker = null
    body.addChild(editor, { maxSize: 8 })
    ui.setFocus(editor)
    ui.renderNow()
  }

  /** Open the rewind picker: one checkpoint per completed turn, newest first. */
  const openRewindPicker = (): void => {
    const points = collectRewindPoints(agent.session.events)
    if (points.length === 0) {
      transcript.appendText('\n\n> [rewind] nothing to rewind yet\n\n')
      ui.renderNow()
      return
    }
    const items: SelectItem[] = [...points].reverse().map(point => ({
      value: String(point.boundary),
      label: `[${point.kind}] ${point.text}`,
      description: `#${point.turn}${point.durationMs !== null ? ` · ${formatDuration(point.durationMs)}` : ''}`,
    }))
    openBottomPicker(items, (item: SelectItem) => {
      void rewindTo(Number(item.value))
    })
  }

  /**
   * Fork the session back to the moment before the dropped turn, then keep the
   * terminal running on the child branch — the rewind that other harnesses
   * cannot express because their history is not a log of reversible behaviors.
   */
  const rewindTo = async (boundary: number): Promise<void> => {
    if (running || shuttingDown) {
      transcript.appendText('\n\n> [rewind] wait for the current turn to finish first\n\n')
      ui.renderNow()
      return
    }
    const seed = boundary < 0 ? [] : agent.session.events.slice(0, boundary + 1)
    const parentId = agent.session.id
    try {
      await sessions.flush(agent.session)
    } catch { /* best-effort flush before fork */ }
    await created.dispose()
    const newCreated = await agents.create({
      sessionId: SessionId(`session-${randomUUID()}`),
      seed,
      meta: { cwd: process.cwd(), parentSession: parentId, seedLength: seed.length },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: (agentCtx) => {
        installModelSelection(agentCtx, selectionRef)
      },
    })
    created = newCreated
    agent = newCreated.agent
    renderer.reset(agent.session.id)
    transcript.clear()
    for (const event of seed) {
      if (event.type !== 'assistant/chunk') renderer.onEvent(event)
    }
    transcript.appendText('\n\n_↩ Rewound onto a new branch (fork lineage preserved)._ \n\n')
    renderer.refreshFooter()
    ui.renderNow()
  }

  const handleSlashCommand = (line: string): void => {
    const commandName = line.slice(1).trim().split(/\s+/)[0] ?? ''
    const command = commandName.toLowerCase()
    if (command === 'exit' || command === 'quit') {
      void shutdown()
      return
    }
    if (command === 'clear') {
      transcript.clear()
      transcript.appendText('_Transcript cleared._')
      ui.renderNow()
      return
    }
    if (command === 'model') {
      void openModelPicker()
      return
    }
    if (command === 'login') {
      openLoginPicker()
      return
    }
    if (command === 'resume') {
      void openResumePicker()
      return
    }
    if (command === 'new') {
      void newSessionHandoff()
      return
    }
    if (command === 'thinking') {
      transcript.toggleThinking()
      ui.renderNow()
      return
    }
    if (command === 'status') {
      const usage = renderer.usageSummary()
      const model = selectionRef.current ?? selection
      const effort = model.reasoningEffort !== undefined ? ` • ${model.reasoningEffort}` : ''
      const status = [
        `session  ${agent.session.id}`,
        `cwd      ${cwdLabel()}`,
        `model    ${model.provider}/${model.model}${effort}`,
        `plan     ${foldPlanMode(agent.session.events) ? 'on' : 'off'}`,
        `tokens   ↑${formatTokens(usage.input)} ↓${formatTokens(usage.output)}${usage.reasoning > 0 ? ` R${formatTokens(usage.reasoning)}` : ''}`,
        `ledger   ${collectRewindPoints(agent.session.events).length} behavior rows`,
      ]
      transcript.appendText(`\n\n> ${status.join('\n> ')}\n\n`)
      ui.renderNow()
      return
    }
    if (command === 'cost' || command === 'tokens') {
      const usage = renderer.usageSummary()
      const parts = [`↑${formatTokens(usage.input)} in`, `↓${formatTokens(usage.output)} out`]
      if (usage.reasoning > 0) parts.push(`R${formatTokens(usage.reasoning)} reasoning`)
      if (usage.billedInput > 0) parts.push(`CH${(usage.cacheRead / usage.billedInput * 100).toFixed(1)}% cache-hit`)
      transcript.appendText(`\n\n> ${parts.join(' · ')}\n\n`)
      ui.renderNow()
      return
    }
    if (command === 'help') {
      const keys = [
        'Enter send · Shift+Enter newline · ↑↓ history',
        'Ctrl+O think · Ctrl+T tools · Shift+Tab plan',
        'Esc Esc rewind · Ctrl+C exit',
      ]
      const commandLines = TUI_COMMANDS.map(cmd => `  /${cmd.name} — ${cmd.description}`)
      transcript.appendText(`\n\n**Keys**\n\n${keys.map(k => `  ${k}`).join('\n')}\n\n**Commands**\n\n${commandLines.join('\n')}\n\n`)
      ui.renderNow()
      return
    }
    if (command === 'logout') {
      const model = selectionRef.current ?? selection
      const keyRef = deriveKeyRef(model.provider)
      void credentials.unset(credentialRef(keyRef)).then(() => {
        transcript.appendText(`\n\n> cleared credential **${keyRef}**\n\n`)
        ui.renderNow()
      }).catch((error: unknown) => {
        transcript.appendText(`\n\n> [error: ${error instanceof Error ? error.message : String(error)}]\n\n`)
        ui.renderNow()
      })
      return
    }
    if (command === 'export') {
      void exportMarkdown()
      return
    }
    const skillPrompt = SKILL_COMMANDS[command]
    if (skillPrompt !== undefined) {
      if (running) {
        transcript.appendText('\n\n> [error: wait for the current turn to finish first]\n\n')
        ui.renderNow()
        return
      }
      running = true
      agent.followup(createUserMessage({ content: [{ type: 'text', text: skillPrompt }], source: { kind: 'user' } }))
      agent.whenIdle().then(() => {
        running = false
        ui.renderNow()
      }).catch((error: unknown) => {
        running = false
        transcript.appendText(`\n\n> [error: ${error instanceof Error ? error.message : String(error)}]\n\n`)
        ui.renderNow()
      })
      return
    }
    // Delegate to the shared host command registry — the same handlers the
    // web UI dispatches, so /compact, /plan, /goal, etc. work unchanged.
    const controller = new AbortController()
    commands.execute(agent, line, controller.signal).then((execution) => {
      if (execution === undefined) {
        transcript.appendText(`\n\n> Unknown command \`/${command}\` — open the slash menu for the list\n\n`)
      }
      ui.renderNow()
    }).catch((error: unknown) => {
      // command/done renders handler failures; this covers lifecycle append failures.
      transcript.appendText(`\n\n> [error: ${error instanceof Error ? error.message : String(error)}]\n\n`)
      ui.renderNow()
    })
  }

  /** Toggle plan mode (Shift+Tab) and confirm the outcome in the transcript. */
  const togglePlanMode = (): void => {
    const target = !foldPlanMode(agent.session.events)
    const outcome = planMode.set(agent, target)
    const state = target ? 'on' : 'off'
    const message = outcome === 'committed'
      ? `Plan mode ${state}.`
      : outcome === 'queued'
        ? `Plan mode ${state} (applies from the next step).`
        : 'Plan mode unchanged.'
    transcript.appendText(`\n\n> ${message}\n\n`)
    renderer.refreshFooter()
    ui.renderNow()
  }

  // Shift+Tab toggles plan mode, Ctrl+O toggles thinking, Ctrl+C exits (and
  // cancels an open overlay first). The global listener runs before the focused
  // editor, so it wins over normal text entry.
  let lastEscape = 0
  const offExit = ui.addInputListener((data) => {
    if (activePicker !== null) {
      activePicker.handleInput(data)
      // SelectList updates its selection internally but (unlike an overlay)
      // does not trigger a repaint; redraw so ↑/↓ visibly move the highlight.
      ui.renderNow()
      return { consume: true }
    }
    if (matchesKey(data, Key.shift('tab')) && !ui.hasOverlay()) {
      togglePlanMode()
      return { consume: true }
    }
    if (matchesKey(data, Key.ctrl('o')) && !ui.hasOverlay()) {
      transcript.toggleThinking()
      ui.renderNow()
      return { consume: true }
    }
    if (matchesKey(data, Key.ctrl('t')) && !ui.hasOverlay()) {
      transcript.toggleToolOutput()
      ui.renderNow()
      return { consume: true }
    }
    if (matchesKey(data, Key.escape) && !ui.hasOverlay()) {
      const now = Date.now()
      if (now - lastEscape <= 500) {
        lastEscape = 0
        openRewindPicker()
      } else {
        lastEscape = now
      }
      return { consume: true }
    }
    if (matchesKey(data, Key.ctrl('c')) && !ui.hasOverlay()) {
      void shutdown()
      return { consume: true }
    }
    return undefined
  })

  ui.start()
}
