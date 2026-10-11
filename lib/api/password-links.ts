/** One-time password links: accepting an invitation, and "Forgot password?". */
import { rpc } from "@/lib/api/rpc"
import type { PublicUser } from "@/lib/types"

export type LinkHolder = { name: string; email: string }

export const getInvite = (token: string): Promise<LinkHolder> => rpc("getInvite", token)

/** Sets the password and signs them in. */
export const acceptInvite = (token: string, password: string): Promise<PublicUser> =>
  rpc("acceptInvite", token, password)

/** Emails a reset link if the address has an account; answers the same either way. */
export const requestPasswordReset = (email: string): Promise<void> =>
  rpc("requestPasswordReset", email)

export const getPasswordReset = (token: string): Promise<LinkHolder> =>
  rpc("getPasswordReset", token)

/** Sets the new password, signs out other sessions, and signs them in. */
export const resetPassword = (token: string, password: string): Promise<PublicUser> =>
  rpc("resetPassword", token, password)
