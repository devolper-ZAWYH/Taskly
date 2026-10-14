"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import * as React from "react"
import { ClaudeMark } from "@/components/shell/claude-mark"
import { GoogleLogo } from "@/components/shell/google-logo"
import { FormError, FormRow } from "@/components/shell/form-row"
import { PageHeader } from "@/components/shell/page-header"
import { PasswordInput } from "@/components/shell/password-input"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select"
import { toastManager } from "@/components/ui/toast"
import { ME_KEY, useCurrentUser } from "@/features/auth/use-auth"
import { ClaudeSetup } from "@/features/connector/claude-setup"
import { GoogleSettings } from "@/features/google/google-settings"
import { NotificationSettings } from "@/features/notifications/notification-settings"
import { EmailAddresses } from "@/features/settings/email-addresses"
import { InstallApp } from "@/features/settings/install-app"
import { ShareApp } from "@/features/settings/share-app"
import { AvatarField } from "@/features/users/components/avatar-field"
import { PEOPLE_KEY } from "@/features/tasks/hooks/use-tasks"
import { changePassword, updateMe } from "@/lib/api/auth"
import { useLocale } from "@/lib/i18n/locale-provider"
import type { Locale } from "@/lib/types"

const LANGUAGES: { value: Locale; label: string }[] = [
  { value: "en", label: "English" },
  { value: "ar", label: "العربية" },
]

function Section({
  title,
  hint,
  icon,
  id,
  children,
}: {
  title: string
  hint: string
  icon?: React.ReactNode
  /** Anchor, e.g. /settings#claude. */
  id?: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <section id={id} className="grid scroll-mt-20 gap-6 border-b py-8 md:grid-cols-[240px_1fr] md:gap-12">
      <div>
        <h2 className="flex items-center gap-2 font-display text-xl">
          {icon}
          {title}
        </h2>
        <p className="mt-1 text-sm text-foreground-muted">{hint}</p>
      </div>
      <div className="max-w-md">{children}</div>
    </section>
  )
}

export default function SettingsPage() {
  const { t, errorMessage, setLocale } = useLocale()
  const me = useCurrentUser()
  const queryClient = useQueryClient()

  const [name, setName] = React.useState(me.name)
  const [language, setLanguage] = React.useState<Locale>(me.locale)
  const profile = useMutation({
    mutationFn: () => updateMe({ name, locale: language }),
    onSuccess: (user) => {
      queryClient.setQueryData(ME_KEY, user)
      void queryClient.invalidateQueries({ queryKey: PEOPLE_KEY })
      setLocale(user.locale)
      toastManager.add({ type: "success", title: t("settings.saved") })
    },
  })

  const [current, setCurrent] = React.useState("")
  const [next, setNext] = React.useState("")
  const [confirm, setConfirm] = React.useState("")
  const [mismatch, setMismatch] = React.useState(false)
  const password = useMutation({
    mutationFn: () => changePassword(current, next),
    onSuccess: () => {
      setCurrent("")
      setNext("")
      setConfirm("")
      toastManager.add({ type: "success", title: t("settings.passwordChanged") })
    },
  })

  return (
    <div className="flex flex-col">
      <PageHeader eyebrow={t("settings.eyebrow")} title={t("settings.title")} />

      <Section title={t("settings.profile")} hint={t("settings.profileHint")}>
        <form
          className="flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault()
            profile.mutate()
          }}
        >
          <FormRow label={t("settings.photo")}>
            <AvatarField />
          </FormRow>
          <FormRow label={t("settings.name")} htmlFor="settings-name">
            <Input id="settings-name" value={name} onChange={(e) => setName(e.target.value)} />
          </FormRow>
          <FormRow label={t("settings.email")} htmlFor="settings-email">
            <Input id="settings-email" value={me.email} disabled dir="ltr" />
          </FormRow>
          <FormRow label={t("settings.language")}>
            <Select value={language} onValueChange={(v) => v && setLanguage(v as Locale)}>
              <SelectTrigger>
                <span>{LANGUAGES.find((l) => l.value === language)?.label}</span>
              </SelectTrigger>
              <SelectContent>
                {LANGUAGES.map((l) => (
                  <SelectItem key={l.value} value={l.value}>
                    {l.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormRow>
          <FormError message={profile.error ? errorMessage(profile.error) : null} />
          <div>
            <Button
              type="submit"
              loading={profile.isPending}
              disabled={name === me.name && language === me.locale}
            >
              {t("common.save")}
            </Button>
          </div>
        </form>
      </Section>

      <Section title={t("settings.emails.title")} hint={t("settings.emails.hint")}>
        <EmailAddresses />
      </Section>

      <Section
        id="google"
        title={t("google.settings.title")}
        hint={t("google.settings.hint")}
        icon={<GoogleLogo className="size-5" />}
      >
        {/* Reads ?google=… after Google's consent screen, so it needs a Suspense boundary. */}
        <React.Suspense>
          <GoogleSettings />
        </React.Suspense>
      </Section>

      <Section
        id="claude"
        title={t("claude.setup.title")}
        hint={t("claude.setup.hint")}
        icon={<ClaudeMark className="size-6" />}
      >
        <ClaudeSetup />
      </Section>

      <Section title={t("notifications.settingsTitle")} hint={t("notifications.settingsHint")}>
        <NotificationSettings />
      </Section>

      <Section title={t("install.settingsTitle")} hint={t("install.settingsHint")}>
        <InstallApp />
      </Section>

      <Section title={t("share.title")} hint={t("share.hint")}>
        <ShareApp />
      </Section>

      <Section title={t("settings.password")} hint={t("settings.passwordHint")}>
        <form
          className="flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault()
            const differs = next !== confirm
            setMismatch(differs)
            if (!differs) password.mutate()
          }}
        >
          <FormRow label={t("settings.currentPassword")} htmlFor="current-password">
            <PasswordInput
              id="current-password"
              value={current}
              onChange={setCurrent}
              autoComplete="current-password"
            />
          </FormRow>
          <FormRow label={t("settings.newPassword")} htmlFor="new-password">
            <PasswordInput id="new-password" value={next} onChange={setNext} />
          </FormRow>
          <FormRow label={t("settings.confirmPassword")} htmlFor="confirm-password">
            <PasswordInput id="confirm-password" value={confirm} onChange={setConfirm} />
          </FormRow>
          <FormError
            message={
              mismatch
                ? t("settings.mismatch")
                : password.error
                  ? errorMessage(password.error)
                  : null
            }
          />
          <div>
            <Button
              type="submit"
              loading={password.isPending}
              disabled={!current || !next || !confirm}
            >
              {t("settings.updatePassword")}
            </Button>
          </div>
        </form>
      </Section>
    </div>
  )
}
