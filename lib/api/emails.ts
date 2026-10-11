/** Your email addresses: one login, a different address per workspace if you like. */
import { rpc } from "@/lib/api/rpc"
import type { MyEmails } from "@/lib/types"

export const listMyEmails = (): Promise<MyEmails> => rpc("listMyEmails")

/** Sends a confirmation link to the new address. */
export const addMyEmail = (email: string): Promise<MyEmails> => rpc("addMyEmail", email)

export const resendEmailConfirmation = (email: string): Promise<void> =>
  rpc("resendEmailConfirmation", email)

/** The link from the confirmation email (no sign-in needed). */
export const confirmEmail = (token: string): Promise<{ email: string }> =>
  rpc("confirmEmail", token)

export const removeMyEmail = (email: string): Promise<MyEmails> => rpc("removeMyEmail", email)

export const makeEmailPrimary = (email: string): Promise<MyEmails> =>
  rpc("makeEmailPrimary", email)

export const setWorkspaceEmail = (accountId: string, email: string): Promise<MyEmails> =>
  rpc("setWorkspaceEmail", accountId, email)
