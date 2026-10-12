/**
 * Every server function the browser may call, by name. The RPC route only
 * dispatches names listed here; each function does its own access checks.
 */
import * as auth from "@/server/services/auth"
import * as dashboard from "@/server/services/dashboard"
import * as emails from "@/server/services/emails"
import * as google from "@/server/services/google"
import * as meetings from "@/server/services/meetings"
import * as minutes from "@/server/services/minutes"
import * as notifications from "@/server/services/notifications"
import * as passwordLinks from "@/server/services/password-links"
import * as members from "@/server/services/members"
import * as platform from "@/server/services/platform"
import * as settings from "@/server/services/settings"
import * as tasks from "@/server/services/tasks"

export const api = {
  login: auth.login,
  logout: auth.logout,
  getMe: auth.getMe,
  updateMe: auth.updateMe,
  changePassword: auth.changePassword,
  setMyAvatar: auth.setMyAvatar,
  listMyEmails: emails.listMyEmails,
  addMyEmail: emails.addMyEmail,
  resendEmailConfirmation: emails.resendEmailConfirmation,
  confirmEmail: emails.confirmEmail,
  removeMyEmail: emails.removeMyEmail,
  makeEmailPrimary: emails.makeEmailPrimary,
  setWorkspaceEmail: emails.setWorkspaceEmail,
  listMyWorkspaces: auth.listMyWorkspaces,

  getDashboard: dashboard.getDashboard,

  listTasks: tasks.listTasks,
  getTask: tasks.getTask,
  createTask: tasks.createTask,
  updateTask: tasks.updateTask,
  cancelTask: tasks.cancelTask,
  deleteTask: tasks.deleteTask,
  listCalendarTasks: tasks.listCalendarTasks,

  listMeetings: meetings.listMeetings,
  getMeeting: meetings.getMeeting,
  listMeetingTasks: meetings.listMeetingTasks,
  listMeetingOptions: meetings.listMeetingOptions,
  createMeeting: meetings.createMeeting,
  updateMeeting: meetings.updateMeeting,
  deleteMeeting: meetings.deleteMeeting,
  retranslateMeeting: meetings.retranslateMeeting,

  listMeetingMinutes: minutes.listMeetingMinutes,
  listMinutes: minutes.listMinutes,
  getMinutes: minutes.getMinutes,
  createMinutes: minutes.createMinutes,
  updateMinutes: minutes.updateMinutes,
  deleteMinutes: minutes.deleteMinutes,
  translateMinutes: minutes.translateMinutes,
  getTranslationAvailable: minutes.getTranslationAvailable,

  listPeople: members.listPeople,
  listMembers: members.listMembers,
  addMember: members.addMember,
  updateMember: members.updateMember,
  removeMember: members.removeMember,
  resendInvite: members.resendInvite,
  listInvitations: members.listInvitations,
  resendInvitation: members.resendInvitation,
  cancelInvitation: members.cancelInvitation,
  listMyInvitations: members.listMyInvitations,
  answerInvitation: members.answerInvitation,

  getInvite: passwordLinks.getInvite,
  acceptInvite: passwordLinks.acceptInvite,
  requestPasswordReset: passwordLinks.requestPasswordReset,
  getPasswordReset: passwordLinks.getPasswordReset,
  resetPassword: passwordLinks.resetPassword,

  listNotifications: notifications.listNotifications,
  unreadNotificationCount: notifications.unreadNotificationCount,
  markNotificationsRead: notifications.markNotificationsRead,
  latestPushNotification: notifications.latestPushNotification,
  getNotificationPrefs: notifications.getNotificationPrefs,
  setNotificationPref: notifications.setNotificationPref,
  getPushPublicKey: notifications.getPushPublicKey,
  getEmailAvailable: notifications.getEmailAvailable,
  savePushSubscription: notifications.savePushSubscription,
  removePushSubscription: notifications.removePushSubscription,

  getGoogleStatus: google.getGoogleStatus,
  syncGoogleNow: google.syncGoogleNow,
  disconnectGoogle: google.disconnectGoogle,
  listGoogleContainers: google.listGoogleContainers,
  setGoogleContainerSelected: google.setGoogleContainerSelected,
  listPersonalTasks: google.listPersonalTasks,
  createPersonalTask: google.createPersonalTask,
  updatePersonalTask: google.updatePersonalTask,
  deletePersonalTask: google.deletePersonalTask,
  listPersonalEvents: google.listPersonalEvents,
  createPersonalEvent: google.createPersonalEvent,
  updatePersonalEvent: google.updatePersonalEvent,
  deletePersonalEvent: google.deletePersonalEvent,
  getGoogleSyncHealth: google.getGoogleSyncHealth,
  retryFailedGoogleJobs: google.retryFailedGoogleJobs,

  listAccounts: platform.listAccounts,
  getAccount: platform.getAccount,
  createAccount: platform.createAccount,
  updateAccount: platform.updateAccount,
  setAccountLogo: platform.setAccountLogo,
  listAccountMembers: platform.listAccountMembers,
  listAllUsers: platform.listAllUsers,
  createUser: platform.createUser,
  resendUserInvite: platform.resendUserInvite,
  updateUser: platform.updateUser,
  setUserPassword: platform.setUserPassword,
  deleteUser: platform.deleteUser,
  attachUser: platform.attachUser,
  setMembershipRole: platform.setMembershipRole,
  detachUser: platform.detachUser,

  getPlatformSettings: settings.getPlatformSettings,
  savePlatformSettings: settings.savePlatformSettings,
  resetPlatformSettings: settings.resetPlatformSettings,
  sendTestEmail: settings.sendTestEmail,
  generatePushKeys: settings.generatePushKeys,
  testTranslation: settings.testTranslation,
}

export type Api = typeof api
export type ApiMethod = keyof Api
