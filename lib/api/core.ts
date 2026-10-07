export type ErrorCode =
  | "unauthorized"
  | "forbidden"
  | "notFound"
  | "badRequest"
  | "invalidCredentials"
  | "accountDisabled"
  | "wrongPassword"
  | "passwordTooShort"
  | "emailTaken"
  | "emailInvalid"
  | "nameRequired"
  | "titleRequired"
  | "selfDemote"
  | "selfDeactivate"
  | "selfDelete"
  | "inactiveAssignee"
  | "invalidTimeRange"
  | "meetingNotFound"
  | "workspaceNotFound"
  | "workspaceInactive"
  | "alreadyMember"
  | "selfRemove"
  | "userNotFound"
  | "logoTooLarge"
  | "logoInvalid"
  | "avatarTooLarge"
  | "avatarInvalid"

/** Error whose `code` maps to a translated message (`errors.<code>`). */
export class AppError extends Error {
  constructor(public readonly code: ErrorCode) {
    super(code)
    this.name = "AppError"
  }
}

export const MIN_PASSWORD_LENGTH = 8
