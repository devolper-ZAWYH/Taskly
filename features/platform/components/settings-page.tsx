"use client"

import {
  CheckIcon,
  CopyIcon,
  KeyRoundIcon,
  LanguagesIcon,
  MailIcon,
  SparklesIcon,
  TriangleAlertIcon,
} from "lucide-react"
import * as React from "react"
import { ConfirmDialog } from "@/components/shell/confirm-dialog"
import { FormError, FormRow } from "@/components/shell/form-row"
import { PageHeader } from "@/components/shell/page-header"
import { PasswordInput } from "@/components/shell/password-input"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { toastManager } from "@/components/ui/toast"
import { useCurrentUser } from "@/features/auth/use-auth"
import {
  useGeneratePushKeys,
  usePlatformSettings,
  useResetPlatformSettings,
  useSavePlatformSettings,
  useSendTestEmail,
  useTestLiveSummary,
  useTestTranslation,
} from "@/features/platform/hooks/use-platform"
import { useLocale } from "@/lib/i18n/locale-provider"
import {
  SUMMARY_PROVIDER_SPECS,
  SUMMARY_PROVIDERS,
  type SummaryProvider,
  type SummaryProviderSpec,
} from "@/lib/summarize"
import { PROVIDER_SPECS, TRANSLATION_PROVIDERS, type TranslationProvider } from "@/lib/translation"
import type { PlatformSettings, SettingSource } from "@/lib/types"
import { cn } from "@/lib/utils"

type Group = "app" | "mail" | "google" | "push" | "translation" | "live"

/** Platform → Settings: the deployment's address, email, Google client and push keys. */
export function PlatformSettingsPage(): React.ReactElement {
  const { t, errorMessage } = useLocale()
  const settings = usePlatformSettings()

  return (
    <div className="flex flex-col">
      <PageHeader
        eyebrow={t("platform.eyebrow")}
        title={t("platform.settings.title")}
        subtitle={t("platform.settings.subtitle")}
      />
      {settings.isPending ? (
        <Skeleton className="mt-8 h-96 w-full rounded-md" />
      ) : settings.isError ? (
        <div className="mt-8">
          <FormError message={errorMessage(settings.error)} />
        </div>
      ) : (
        <>
          {!settings.data.encryptionReady ? (
            <p
              role="alert"
              className="mt-6 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive-bg p-3 text-sm text-destructive-foreground"
            >
              <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              {t("platform.settings.noKey")}
            </p>
          ) : null}
          {/* Keyed on the saved values so each form starts from what's stored. */}
          <AppSection key={`app:${settings.data.app.origin}`} settings={settings.data} />
          <MailSection key={`mail:${JSON.stringify(settings.data.mail)}`} settings={settings.data} />
          <GoogleSection
            key={`google:${JSON.stringify(settings.data.google)}`}
            settings={settings.data}
          />
          <PushSection settings={settings.data} />
          <TranslationSection
            key={`translation:${JSON.stringify(settings.data.translation)}`}
            settings={settings.data}
          />
          <LiveSummariesSection
            key={`live:${JSON.stringify(settings.data.live)}`}
            settings={settings.data}
          />
        </>
      )}
    </div>
  )
}

function Section({
  title,
  hint,
  group,
  source,
  status,
  children,
}: {
  title: string
  hint: string
  group: Group
  source: SettingSource
  status?: { ready: boolean; label: string }
  children: React.ReactNode
}): React.ReactElement {
  const { t, errorMessage } = useLocale()
  const reset = useResetPlatformSettings()
  return (
    <section
      className="grid gap-6 border-b py-8 md:grid-cols-[240px_1fr] md:gap-12"
      data-testid={`settings-${group}`}
    >
      <div>
        <h2 className="font-display text-xl">{title}</h2>
        <p className="mt-1 text-sm text-foreground-muted">{hint}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="h-5 px-2 text-xs">
            {t(`platform.settings.source.${source}`)}
          </Badge>
          {status ? (
            <span
              className={cn(
                "inline-flex items-center gap-1.5 text-xs",
                status.ready ? "text-success" : "text-foreground-muted",
              )}
            >
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  status.ready ? "bg-success" : "bg-foreground-disabled",
                )}
              />
              {status.label}
            </span>
          ) : null}
        </div>
        {source === "console" ? (
          <Button
            variant="link"
            size="sm"
            className="mt-2 h-auto px-0 text-xs"
            loading={reset.isPending}
            onClick={() =>
              reset.mutate(group, {
                onSuccess: () =>
                  toastManager.add({ type: "success", title: t("platform.settings.resetDone") }),
                onError: (error) => toastManager.add({ type: "error", title: errorMessage(error) }),
              })
            }
          >
            {t("platform.settings.useEnvironment")}
          </Button>
        ) : null}
      </div>
      {/* min-w-0: long keys and URLs truncate instead of widening the page. */}
      <div className="max-w-md min-w-0">{children}</div>
    </section>
  )
}

function useSaved() {
  const { t } = useLocale()
  return () => toastManager.add({ type: "success", title: t("platform.settings.saved") })
}

function AppSection({ settings }: { settings: PlatformSettings }): React.ReactElement {
  const { t, errorMessage } = useLocale()
  const save = useSavePlatformSettings()
  const saved = useSaved()
  const [origin, setOrigin] = React.useState(settings.app.origin)
  const here = typeof window === "undefined" ? "" : window.location.origin

  return (
    <Section
      title={t("platform.settings.app.title")}
      hint={t("platform.settings.app.hint")}
      group="app"
      source={settings.app.source}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate({ group: "app", origin }, { onSuccess: saved })
        }}
      >
        <FormRow label={t("platform.settings.app.origin")} htmlFor="settings-origin">
          <Input
            id="settings-origin"
            dir="ltr"
            inputMode="url"
            placeholder="https://tasks.example.com"
            value={origin}
            onChange={(e) => setOrigin(e.target.value)}
          />
        </FormRow>
        {here && origin !== here ? (
          <button
            type="button"
            className="-mt-2 self-start text-xs text-foreground-secondary underline underline-offset-2"
            onClick={() => setOrigin(here)}
          >
            {t("platform.settings.app.useThis")}: <span dir="ltr">{here}</span>
          </button>
        ) : null}
        <FormError message={save.error ? errorMessage(save.error) : null} />
        <div>
          <Button
            type="submit"
            loading={save.isPending}
            disabled={!origin.trim() || origin === settings.app.origin}
          >
            {t("platform.settings.save")}
          </Button>
        </div>
      </form>
    </Section>
  )
}

function MailSection({ settings }: { settings: PlatformSettings }): React.ReactElement {
  const { t, errorMessage } = useLocale()
  const me = useCurrentUser()
  const save = useSavePlatformSettings()
  const test = useSendTestEmail()
  const saved = useSaved()
  const mail = settings.mail
  const [draft, setDraft] = React.useState({
    host: mail.host,
    port: String(mail.port),
    secure: mail.secure,
    user: mail.user,
    from: mail.from,
    password: "",
  })
  const set = <K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) =>
    setDraft((current) => ({ ...current, [key]: value }))

  return (
    <Section
      title={t("platform.settings.mail.title")}
      hint={t("platform.settings.mail.hint")}
      group="mail"
      source={mail.source}
      status={{
        ready: mail.ready,
        label: mail.ready ? t("platform.settings.mail.ready") : t("platform.settings.mail.notReady"),
      }}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate(
            { group: "mail", ...draft, port: Number(draft.port) || 465 },
            { onSuccess: saved },
          )
        }}
      >
        <div className="grid grid-cols-[1fr_6rem] gap-3">
          <FormRow label={t("platform.settings.mail.host")} htmlFor="smtp-host">
            <Input
              id="smtp-host"
              dir="ltr"
              placeholder="mail.zawyh.com"
              value={draft.host}
              onChange={(e) => set("host", e.target.value)}
            />
          </FormRow>
          <FormRow label={t("platform.settings.mail.port")} htmlFor="smtp-port">
            <Input
              id="smtp-port"
              dir="ltr"
              inputMode="numeric"
              value={draft.port}
              onChange={(e) => set("port", e.target.value.replace(/\D/g, ""))}
            />
          </FormRow>
        </div>
        <label className="flex cursor-pointer items-center justify-between gap-4 rounded-md border p-3 text-sm">
          {t("platform.settings.mail.secure")}
          <Switch checked={draft.secure} onCheckedChange={(on) => set("secure", on)} />
        </label>
        <FormRow label={t("platform.settings.mail.user")} htmlFor="smtp-user">
          <Input
            id="smtp-user"
            dir="ltr"
            autoComplete="off"
            placeholder="noreply@zawyh.com"
            value={draft.user}
            onChange={(e) => set("user", e.target.value)}
          />
        </FormRow>
        <FormRow
          label={t("platform.settings.mail.password")}
          htmlFor="smtp-pass"
          hint={mail.passwordSet ? t("platform.settings.keepSecret") : undefined}
        >
          <PasswordInput
            id="smtp-pass"
            value={draft.password}
            onChange={(value) => set("password", value)}
            autoComplete="off"
          />
        </FormRow>
        <FormRow
          label={t("platform.settings.mail.from")}
          htmlFor="smtp-from"
          hint={t("platform.settings.mail.fromHint")}
        >
          <Input
            id="smtp-from"
            dir="ltr"
            placeholder="Taskly <noreply@zawyh.com>"
            value={draft.from}
            onChange={(e) => set("from", e.target.value)}
          />
        </FormRow>
        <FormError message={save.error ? errorMessage(save.error) : null} />
        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            loading={save.isPending}
            disabled={!draft.host.trim() || !draft.user.trim()}
          >
            {t("platform.settings.save")}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!mail.ready}
            loading={test.isPending}
            onClick={() =>
              test.mutate(undefined, {
                onSuccess: (result) =>
                  toastManager.add(
                    result.ok
                      ? {
                          type: "success",
                          title: t("platform.settings.mail.testSent", { email: me.email }),
                        }
                      : {
                          type: "error",
                          title: t("platform.settings.mail.testFailed", {
                            error: result.error ?? "",
                          }),
                        },
                  ),
                onError: (error) => toastManager.add({ type: "error", title: errorMessage(error) }),
              })
            }
          >
            <MailIcon />
            {t("platform.settings.mail.test")}
          </Button>
        </div>
      </form>
    </Section>
  )
}

function GoogleSection({ settings }: { settings: PlatformSettings }): React.ReactElement {
  const { t, errorMessage } = useLocale()
  const save = useSavePlatformSettings()
  const saved = useSaved()
  const google = settings.google
  const [clientId, setClientId] = React.useState(google.clientId)
  const [clientSecret, setClientSecret] = React.useState("")
  const [copied, setCopied] = React.useState(false)

  return (
    <Section
      title={t("platform.settings.google.title")}
      hint={t("platform.settings.google.hint")}
      group="google"
      source={google.source}
      status={{
        ready: google.ready,
        label: google.ready
          ? t("platform.settings.google.ready")
          : t("platform.settings.google.notReady"),
      }}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate({ group: "google", clientId, clientSecret }, { onSuccess: saved })
        }}
      >
        <FormRow label={t("platform.settings.google.clientId")} htmlFor="google-client-id">
          <Input
            id="google-client-id"
            dir="ltr"
            autoComplete="off"
            placeholder="1234-abc.apps.googleusercontent.com"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
          />
        </FormRow>
        <FormRow
          label={t("platform.settings.google.clientSecret")}
          htmlFor="google-client-secret"
          hint={google.secretSet ? t("platform.settings.keepSecret") : undefined}
        >
          <PasswordInput
            id="google-client-secret"
            value={clientSecret}
            onChange={setClientSecret}
            autoComplete="off"
          />
        </FormRow>
        <FormRow
          label={t("platform.settings.google.redirectUri")}
          hint={t("platform.settings.google.redirectHint")}
        >
          <div className="flex items-center gap-2">
            <code
              dir="ltr"
              className="min-w-0 flex-1 truncate rounded-md border bg-surface-muted px-3 py-2 text-xs"
            >
              {google.redirectUri || "—"}
            </code>
            {google.redirectUri ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={async () => {
                  await navigator.clipboard.writeText(google.redirectUri).catch(() => {})
                  setCopied(true)
                }}
              >
                {copied ? <CheckIcon /> : <CopyIcon />}
                {copied ? t("platform.settings.copied") : t("platform.settings.copy")}
              </Button>
            ) : null}
          </div>
        </FormRow>
        <FormError message={save.error ? errorMessage(save.error) : null} />
        <div>
          <Button type="submit" loading={save.isPending} disabled={!clientId.trim()}>
            {t("platform.settings.save")}
          </Button>
        </div>
      </form>
    </Section>
  )
}

function PushSection({ settings }: { settings: PlatformSettings }): React.ReactElement {
  const { t, errorMessage } = useLocale()
  const generate = useGeneratePushKeys()
  const [confirming, setConfirming] = React.useState(false)
  const push = settings.push

  return (
    <Section
      title={t("platform.settings.push.title")}
      hint={t("platform.settings.push.hint")}
      group="push"
      source={push.source}
      status={{
        ready: push.ready,
        label: push.ready ? t("platform.settings.push.ready") : t("platform.settings.push.notReady"),
      }}
    >
      <div className="flex flex-col gap-4">
        <FormRow label={t("platform.settings.push.publicKey")}>
          <code
            dir="ltr"
            className="block truncate rounded-md border bg-surface-muted px-3 py-2 text-xs"
          >
            {push.publicKey || "—"}
          </code>
        </FormRow>
        <p className="text-xs text-foreground-muted">
          {t("platform.settings.push.devices", { count: push.devices })}
        </p>
        <div>
          <Button
            type="button"
            variant={push.ready ? "outline" : "default"}
            loading={generate.isPending}
            onClick={() => (push.ready ? setConfirming(true) : generate.mutate(undefined))}
          >
            <KeyRoundIcon />
            {t("platform.settings.push.generate")}
          </Button>
        </div>
        <FormError message={generate.error ? errorMessage(generate.error) : null} />
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("platform.settings.push.generateTitle")}
        description={t("platform.settings.push.generateBody")}
        confirmLabel={t("platform.settings.push.generate")}
        onConfirm={async () => {
          await generate.mutateAsync(undefined)
          toastManager.add({ type: "success", title: t("platform.settings.push.generated") })
        }}
      />
    </Section>
  )
}

function TranslationSection({ settings }: { settings: PlatformSettings }): React.ReactElement {
  const { t, errorMessage } = useLocale()
  const save = useSavePlatformSettings()
  const test = useTestTranslation()
  const saved = useSaved()
  const current = settings.translation
  const [provider, setProvider] = React.useState(current.provider)
  const [key, setKey] = React.useState("")
  const [keyId, setKeyId] = React.useState(current.keyId)
  const [region, setRegion] = React.useState(current.region)
  const [model, setModel] = React.useState(current.model)
  const spec = provider ? PROVIDER_SPECS[provider as TranslationProvider] : null
  // A saved key only carries over while the same service stays selected.
  const keySaved = current.keySet && provider === current.provider
  const label = (p: string) =>
    p ? t(`platform.settings.translation.providers.${p as TranslationProvider}`) : t("platform.settings.translation.off")

  return (
    <Section
      title={t("platform.settings.translation.title")}
      hint={t("platform.settings.translation.hint")}
      group="translation"
      source={current.source}
      status={{
        ready: current.ready,
        label: current.ready
          ? t("platform.settings.translation.ready")
          : t("platform.settings.translation.notReady"),
      }}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate(
            { group: "translation", provider, key, keyId, region, model },
            { onSuccess: saved },
          )
        }}
      >
        <FormRow label={t("platform.settings.translation.provider")} htmlFor="translation-provider">
          <Select
            value={provider || "off"}
            onValueChange={(value) => {
              const next = !value || value === "off" ? "" : value
              setProvider(next)
              setKey("")
              setModel(next === current.provider ? current.model : "")
            }}
          >
            <SelectTrigger id="translation-provider" data-testid="translation-provider">
              <span className="truncate">{label(provider)}</span>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="off">{t("platform.settings.translation.off")}</SelectItem>
              {TRANSLATION_PROVIDERS.map((p) => (
                <SelectItem key={p} value={p}>
                  {label(p)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormRow>
        {provider ? (
          <p className="-mt-2 text-xs text-foreground-muted">
            {t(`platform.settings.translation.notes.${provider as TranslationProvider}`)}
          </p>
        ) : null}

        {spec?.keyId ? (
          <FormRow label={t("platform.settings.translation.keyId")} htmlFor="translation-key-id">
            <Input
              id="translation-key-id"
              dir="ltr"
              autoComplete="off"
              value={keyId}
              onChange={(e) => setKeyId(e.target.value)}
            />
          </FormRow>
        ) : null}
        {spec?.key ? (
          <FormRow
            label={
              provider === "amazon"
                ? t("platform.settings.translation.keyAmazon")
                : t("platform.settings.translation.key")
            }
            htmlFor="translation-key"
            hint={keySaved ? t("platform.settings.keepSecret") : undefined}
          >
            <PasswordInput id="translation-key" value={key} onChange={setKey} autoComplete="off" />
          </FormRow>
        ) : null}
        {spec?.region ? (
          <FormRow
            label={t("platform.settings.translation.region")}
            htmlFor="translation-region"
            hint={
              provider === "amazon"
                ? t("platform.settings.translation.regionAmazonHint")
                : t("platform.settings.translation.regionAzureHint")
            }
          >
            <Input
              id="translation-region"
              dir="ltr"
              autoComplete="off"
              value={region}
              onChange={(e) => setRegion(e.target.value)}
            />
          </FormRow>
        ) : null}
        {spec?.model ? (
          <FormRow label={t("platform.settings.translation.model")} htmlFor="translation-model">
            <Input
              id="translation-model"
              dir="ltr"
              autoComplete="off"
              placeholder={spec.model}
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
          </FormRow>
        ) : null}

        <FormError message={save.error ? errorMessage(save.error) : null} />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" loading={save.isPending}>
            {t("platform.settings.save")}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!current.ready}
            loading={test.isPending}
            onClick={() => test.mutate(undefined, { onError: (error) => toastManager.add({ type: "error", title: errorMessage(error) }) })}
          >
            <LanguagesIcon />
            {t("platform.settings.translation.test")}
          </Button>
        </div>
        {test.data ? (
          test.data.ok ? (
            <div className="flex flex-col gap-2 rounded-md border p-3 text-sm" data-testid="translation-test">
              <p className="text-xs font-medium text-success">{t("platform.settings.translation.testOk")}</p>
              <p dir="rtl" lang="ar">{test.data.toArabic}</p>
              <p dir="ltr" lang="en">{test.data.toEnglish}</p>
            </div>
          ) : (
            <FormError
              message={t("platform.settings.translation.testFailed", { error: test.data.error ?? "" })}
            />
          )
        ) : null}
      </form>
    </Section>
  )
}

/**
 * Live meetings' summaries (docs/live-meetings.md §6): where the review draft
 * is made after a capture — the default keeps it on the recording device, and
 * a service here drafts it on the server instead (liveSummarize).
 */
function LiveSummariesSection({ settings }: { settings: PlatformSettings }): React.ReactElement {
  const { t, errorMessage } = useLocale()
  const save = useSavePlatformSettings()
  const test = useTestLiveSummary()
  const saved = useSaved()
  const current = settings.live
  const [provider, setProvider] = React.useState(current.provider)
  const [key, setKey] = React.useState("")
  const [baseUrl, setBaseUrl] = React.useState(current.baseUrl)
  const [model, setModel] = React.useState(current.model)
  const spec: SummaryProviderSpec | null =
    provider ? SUMMARY_PROVIDER_SPECS[provider as SummaryProvider] : null
  // A saved key only carries over while the same service stays selected.
  const keySaved = current.keySet && provider === current.provider
  const label = (p: string) =>
    p
      ? t(`platform.settings.live.providers.${p as SummaryProvider}`)
      : t("platform.settings.live.off")

  return (
    <Section
      title={t("platform.settings.live.title")}
      hint={t("platform.settings.live.hint")}
      group="live"
      source={current.source}
      status={{
        ready: current.ready,
        label: current.ready
          ? t("platform.settings.live.ready")
          : t("platform.settings.live.notReady"),
      }}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate(
            {
              group: "live",
              provider: provider === "on_device" ? "" : provider,
              key,
              baseUrl,
              model,
            },
            { onSuccess: saved },
          )
        }}
      >
        <FormRow label={t("platform.settings.live.provider")} htmlFor="live-provider">
          <Select
            value={provider || "on_device"}
            onValueChange={(value) => {
              const next = !value || value === "on_device" ? "" : value
              setProvider(next)
              setKey("")
              setBaseUrl(next === current.provider ? current.baseUrl : "")
              setModel(next === current.provider ? current.model : "")
            }}
          >
            <SelectTrigger id="live-provider" data-testid="live-provider">
              <span className="truncate">
                {provider
                  ? t(`platform.settings.live.providers.${provider as SummaryProvider}`)
                  : t("platform.settings.live.off")}
              </span>
            </SelectTrigger>
            <SelectContent>
              {SUMMARY_PROVIDERS.map((p) => (
                <SelectItem key={p} value={p}>
                  {label(p)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormRow>
        <p className="-mt-2 text-xs text-foreground-muted">
          {t(`platform.settings.live.notes.${(provider || "on_device") as SummaryProvider}`)}
        </p>

        {spec?.key ? (
          <FormRow
            label={t("platform.settings.live.key")}
            htmlFor="live-key"
            hint={keySaved ? t("platform.settings.keepSecret") : undefined}
          >
            <PasswordInput id="live-key" value={key} onChange={setKey} autoComplete="off" />
          </FormRow>
        ) : null}
        {spec?.baseUrl ? (
          <FormRow
            label={t("platform.settings.live.baseUrl")}
            htmlFor="live-base-url"
            hint={t("platform.settings.live.baseUrlHint")}
          >
            <Input
              id="live-base-url"
              dir="ltr"
              inputMode="url"
              placeholder="https://api.example.com"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </FormRow>
        ) : null}
        {provider ? (
          <FormRow
            label={t("platform.settings.live.model")}
            htmlFor="live-model"
            hint={t("platform.settings.live.modelHint")}
          >
            <Input
              id="live-model"
              dir="ltr"
              autoComplete="off"
              placeholder={spec?.model ?? "my-model-123"}
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
          </FormRow>
        ) : null}

        <FormError message={save.error ? errorMessage(save.error) : null} />
        {/* Save stays available on "On the device": it is how a service is switched off. */}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" loading={save.isPending}>
            {t("platform.settings.save")}
          </Button>
          {provider ? (
            <Button
              type="button"
              variant="outline"
              disabled={!current.ready}
              loading={test.isPending}
              onClick={() =>
                test.mutate(undefined, {
                  onError: (error) => toastManager.add({ type: "error", title: errorMessage(error) }),
                })
              }
            >
              <SparklesIcon />
              {t("platform.settings.live.test")}
            </Button>
          ) : null}
        </div>
        {provider && test.data ? (
          test.data.ok ? (
            <div className="flex flex-col gap-2 rounded-md border p-3 text-sm" data-testid="live-summary-test">
              <p className="text-xs font-medium text-success">{t("platform.settings.live.testOk")}</p>
              <p dir="auto">{test.data.summary}</p>
            </div>
          ) : (
            <FormError
              message={t("platform.settings.live.testFailed", { error: test.data.error ?? "" })}
            />
          )
        ) : null}
      </form>
    </Section>
  )
}
