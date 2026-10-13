"use client"

import {
  CheckIcon,
  CircleCheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  MicIcon,
  MonitorIcon,
  MousePointerClickIcon,
  TriangleAlertIcon,
  UnplugIcon,
} from "lucide-react"
import Link from "next/link"
import * as React from "react"
import { ConfirmDialog } from "@/components/shell/confirm-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs"
import { toastManager } from "@/components/ui/toast"
import { useCurrentUser } from "@/features/auth/use-auth"
import { useClaudeSetup, useDisconnectClaude } from "@/features/connector/hooks"
import { useLocale } from "@/lib/i18n/locale-provider"
import type { ClaudeConnection, ClaudeSetup as Setup } from "@/lib/types"

/** Claude's own page for adding connectors (named in Anthropic's docs; re-check if Claude changes it). */
const CLAUDE_CONNECTORS_URL = "https://claude.ai/customize/connectors"

/**
 * Settings → Set up MCP: step-by-step instructions to add Taskly to Claude as
 * a custom connector, written for people who've never heard of MCP; then
 * their connections, with Disconnect.
 */
export function ClaudeSetup(): React.ReactElement {
  const { t, errorMessage } = useLocale()
  const setup = useClaudeSetup()

  if (setup.isPending) return <Skeleton className="h-40 w-full rounded-md" />
  if (setup.isError) {
    return <p className="text-sm text-foreground-muted">{errorMessage(setup.error)}</p>
  }
  const data = setup.data
  const url = data.connectorUrl
  if (!data.available || !url) return <Unavailable />

  const connected = data.connections.length > 0
  return (
    <div className="flex flex-col gap-6" data-testid="claude-setup">
      {!data.publicUrl ? (
        <p className="flex gap-2 rounded-md border border-warning/40 bg-warning-bg p-3 text-sm text-warning-foreground">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
          {t("claude.setup.localOnly")}
        </p>
      ) : null}

      {connected ? (
        <>
          <Connections connections={data.connections} />
          <details className="group rounded-md border p-4">
            <summary className="cursor-pointer text-sm font-medium">{t("claude.setup.connectAnother")}</summary>
            <div className="mt-4">
              <Steps url={url} />
            </div>
          </details>
        </>
      ) : (
        <Steps url={url} />
      )}

      <TryIt setup={data} />
      <Help url={url} />
    </div>
  )
}

function Unavailable(): React.ReactElement {
  const { t } = useLocale()
  const me = useCurrentUser()
  return (
    <div className="text-sm text-foreground-muted" data-testid="claude-unavailable">
      <p>{t("claude.setup.unavailable")}</p>
      {me.isOperator ? (
        <Link href="/platform/settings" className="mt-2 inline-block underline underline-offset-2">
          {t("claude.setup.unavailableOperator")}
        </Link>
      ) : null}
    </div>
  )
}

// ---- Copy helpers -----------------------------------------------------------------

function useCopy(): [boolean, (text: string) => void] {
  const { t } = useLocale()
  const [copied, setCopied] = React.useState(false)
  const copy = React.useCallback(
    (text: string) => {
      void navigator.clipboard
        .writeText(text)
        .then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 2000)
        })
        .catch(() => toastManager.add({ type: "error", title: t("claude.setup.copyFailed") }))
    },
    [t],
  )
  return [copied, copy]
}

/** A read-only field and its Copy button (the connector URL, the Claude Code command). */
function CopyField({ value, label }: { value: string; label: string }): React.ReactElement {
  const { t } = useLocale()
  const [copied, copy] = useCopy()
  return (
    <div className="flex gap-2">
      <Input value={value} readOnly dir="ltr" aria-label={label} onFocus={(e) => e.currentTarget.select()} />
      <Button type="button" variant="outline" onClick={() => copy(value)}>
        {copied ? <CheckIcon /> : <CopyIcon />}
        {copied ? t("claude.setup.copied") : t("claude.setup.copy")}
      </Button>
    </div>
  )
}

/** A block of text to paste somewhere (a starter prompt, the message for an owner). */
function CopyBlock({ text, testId }: { text: string; testId?: string }): React.ReactElement {
  const { t } = useLocale()
  const [copied, copy] = useCopy()
  return (
    <div className="flex items-start gap-2 rounded-md border bg-surface-strong/40 p-3" data-testid={testId}>
      <p dir="auto" className="flex-1 text-sm whitespace-pre-line">
        {text}
      </p>
      <Button type="button" variant="ghost" size="sm" onClick={() => copy(text)} aria-label={t("claude.setup.copy")}>
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </div>
  )
}

function StepHeading({ n, children }: { n: number; children: React.ReactNode }): React.ReactElement {
  return (
    <h3 className="flex items-center gap-2 text-sm font-semibold">
      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-foreground text-xs text-background">
        {n}
      </span>
      {children}
    </h3>
  )
}

// ---- Steps -------------------------------------------------------------------------

function Steps({ url }: { url: string }): React.ReactElement {
  const { t } = useLocale()
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <StepHeading n={1}>{t("claude.setup.step1")}</StepHeading>
        <CopyField value={url} label={t("claude.setup.urlLabel")} />
      </section>

      <section className="flex flex-col gap-3">
        <StepHeading n={2}>{t("claude.setup.step2")}</StepHeading>
        <Tabs defaultValue="personal">
          <TabsList>
            <TabsTab value="personal">{t("claude.setup.plansPersonal")}</TabsTab>
            <TabsTab value="team">{t("claude.setup.plansTeam")}</TabsTab>
          </TabsList>
          <TabsPanel value="personal" className="flex flex-col gap-3 pt-2">
            <Button
              variant="outline"
              className="self-start"
              render={<a href={CLAUDE_CONNECTORS_URL} target="_blank" rel="noopener noreferrer" />}
            >
              <ExternalLinkIcon />
              {t("claude.setup.openClaude")}
            </Button>
            <ol className="ms-5 list-decimal space-y-1.5 text-sm text-foreground-secondary">
              <li>{t("claude.setup.personal1")}</li>
              <li>{t("claude.setup.personal2")}</li>
              <li>{t("claude.setup.personal3")}</li>
              <li>{t("claude.setup.personal4")}</li>
            </ol>
            <p className="text-xs text-foreground-muted">{t("claude.setup.freePlan")}</p>
          </TabsPanel>
          <TabsPanel value="team" className="flex flex-col gap-3 pt-2">
            <p className="text-sm text-foreground-secondary">{t("claude.setup.teamIntro")}</p>
            <CopyBlock text={t("claude.setup.ownerMessage", { url })} testId="claude-owner-message" />
            <p className="text-sm text-foreground-secondary">{t("claude.setup.teamAfter")}</p>
          </TabsPanel>
        </Tabs>
      </section>
    </div>
  )
}

/**
 * Step 3: examples of what to say. No commands: people just ask. The
 * delegation and meeting examples only show for administrators. "Your day"
 * comes first: it shows a card straight away.
 */
function TryIt({ setup }: { setup: Setup }): React.ReactElement {
  const { t } = useLocale()
  const several = setup.workspaces.length > 1
  const admin = setup.workspaces.some((w) => w.role === "administrator")
  const prompts = [
    t("claude.setup.promptDay"),
    t("claude.setup.promptTask"),
    t("claude.setup.promptMinutes"),
    ...(admin ? [t("claude.setup.promptDelegate"), t("claude.setup.promptMeeting")] : []),
  ]
  return (
    <section className="flex flex-col gap-3">
      <StepHeading n={setup.connections.length > 0 ? 1 : 3}>{t("claude.setup.step3")}</StepHeading>
      <p className="text-sm text-foreground-secondary">{t("claude.setup.turnOn")}</p>
      <div className="flex flex-col gap-2">
        {prompts.map((prompt) => (
          <CopyBlock key={prompt} text={prompt} />
        ))}
      </div>
      {!admin ? <p className="text-xs text-foreground-muted">{t("claude.setup.adminOnly")}</p> : null}
      {several ? (
        <p className="text-xs text-foreground-muted" data-testid="claude-several-workspaces">
          {t("claude.setup.severalWorkspaces", { count: setup.workspaces.length })}
        </p>
      ) : null}
      <p className="flex items-center gap-2 text-xs text-foreground-muted">
        <MousePointerClickIcon className="size-3.5 shrink-0" />
        {t("claude.setup.cards")}
      </p>
      <p className="flex items-center gap-2 text-xs text-foreground-muted">
        <MicIcon className="size-3.5 shrink-0" />
        {t("claude.setup.voice")}
      </p>
    </section>
  )
}

function Help({ url }: { url: string }): React.ReactElement {
  const { t } = useLocale()
  const tips = ["tipUrl", "tipLoop", "tipNotInChat", "tipAsks", "tipArabic"] as const
  return (
    <div className="flex flex-col gap-2">
      <details className="rounded-md border p-4">
        <summary className="cursor-pointer text-sm font-medium">{t("claude.setup.helpTitle")}</summary>
        <p className="mt-3 mb-2 text-sm text-foreground-secondary">{t("claude.setup.helpHint")}</p>
        <CopyBlock text={t("claude.setup.helpPrompt", { url })} testId="claude-help-prompt" />
      </details>
      <details className="rounded-md border p-4">
        <summary className="cursor-pointer text-sm font-medium">{t("claude.setup.codeTitle")}</summary>
        <div className="mt-3 flex flex-col gap-2">
          <CopyField value={`claude mcp add --transport http taskly ${url}`} label={t("claude.setup.codeTitle")} />
          <p className="text-xs text-foreground-muted">{t("claude.setup.codeHint")}</p>
        </div>
      </details>
      <details className="rounded-md border p-4">
        <summary className="cursor-pointer text-sm font-medium">{t("claude.setup.troubleTitle")}</summary>
        <ul className="mt-3 ms-5 list-disc space-y-1.5 text-sm text-foreground-secondary">
          {tips.map((tip) => (
            <li key={tip}>{t(`claude.setup.${tip}`)}</li>
          ))}
        </ul>
      </details>
    </div>
  )
}

// ---- Connections ---------------------------------------------------------------------

function Connections({ connections }: { connections: ClaudeConnection[] }): React.ReactElement {
  const { t, formatDateTime } = useLocale()
  const disconnect = useDisconnectClaude()
  const [pending, setPending] = React.useState<ClaudeConnection | null>(null)
  return (
    <section className="flex flex-col gap-3" data-testid="claude-connections">
      <p className="flex items-center gap-2 text-sm font-medium">
        <CircleCheckIcon className="size-4 text-success" />
        {t("claude.setup.connected")}
      </p>
      <ul className="divide-y rounded-md border">
        {connections.map((c) => (
          <li key={c.id} className="flex items-center gap-3 p-3">
            {c.local ? <MonitorIcon className="size-4 shrink-0" /> : null}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium" dir="auto">
                {c.local ? t("claude.setup.localApp", { app: c.app }) : c.app}
              </p>
              <p className="text-xs text-foreground-muted">
                {c.lastUsedAt
                  ? t("claude.setup.lastUsed", { date: formatDateTime(c.lastUsedAt) })
                  : t("claude.setup.neverUsed")}
              </p>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => setPending(c)}>
              <UnplugIcon />
              {t("claude.setup.disconnect")}
            </Button>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
        title={t("claude.setup.disconnectTitle")}
        description={t("claude.setup.disconnectBody", { app: pending?.app ?? "" })}
        confirmLabel={t("claude.setup.disconnect")}
        onConfirm={async () => {
          if (!pending) return
          await disconnect.mutateAsync(pending.id)
          toastManager.add({ type: "success", title: t("claude.setup.disconnected") })
        }}
      />
    </section>
  )
}
