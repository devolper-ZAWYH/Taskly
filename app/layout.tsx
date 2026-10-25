import type { Metadata, Viewport } from "next"
import { Cairo, JetBrains_Mono, Plus_Jakarta_Sans } from "next/font/google"
import { cookies } from "next/headers"
import { Providers } from "@/app/providers"
import { LOCALE_COOKIE } from "@/lib/i18n/locale-cookie"
import type { Locale } from "@/lib/types"
import "./globals.css"

const jakarta = Plus_Jakarta_Sans({ subsets: ["latin"], variable: "--font-jakarta" })
const jetbrains = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains" })
const cairo = Cairo({ subsets: ["arabic", "latin"], variable: "--font-cairo" })

export const metadata: Metadata = {
  title: "Taskly",
  description: "Tasks and meetings for your workspace.",
  applicationName: "Taskly",
  // iOS: open full-screen from the home screen, with this name under the icon.
  appleWebApp: { capable: true, title: "Taskly", statusBarStyle: "default" },
}

export const viewport: Viewport = {
  themeColor: "#ffffff",
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const stored = (await cookies()).get(LOCALE_COOKIE)?.value
  const locale: Locale = stored === "ar" ? "ar" : "en"

  return (
    <html
      lang={locale}
      dir={locale === "ar" ? "rtl" : "ltr"}
      className={`${jakarta.variable} ${jetbrains.variable} ${cairo.variable}`}
    >
      <body className="min-h-dvh">
        <Providers initialLocale={locale}>{children}</Providers>
      </body>
    </html>
  )
}
