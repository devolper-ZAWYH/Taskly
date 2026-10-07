/**
 * Every server function the browser may call, by name. The RPC route only
 * dispatches names listed here; each function does its own access checks.
 */
import * as auth from "@/server/services/auth"
import * as meetings from "@/server/services/meetings"
import * as notifications from "@/server/services/notifications"
import * as members from "@/server/services/members"
import * as platform from "@/server/services/platform"
import * as tasks from "@/server/services/tasks"

export const api = {
  login: auth.login,
  logout: auth.logout,
  getMe: auth.getMe,
  updateMe: auth.updateMe,
  changePassword: auth.changePassword,
  setMyAvatar: auth.setMyAvatar,
  listMyWorkspaces: auth.listMyWorkspaces,

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

  listPeople: members.listPeople,
  listMembers: members.listMembers,
  addMember: members.addMember,
  updateMember: members.updateMember,
  removeMember: members.removeMember,

  listNotifications: notifications.listNotifications,
  unreadNotificationCount: notifications.unreadNotificationCount,
  markNotificationsRead: notifications.markNotificationsRead,
  latestPushNotification: notifications.latestPushNotification,
  getNotificationPrefs: notifications.getNotificationPrefs,
  setNotificationPref: notifications.setNotificationPref,
  getPushPublicKey: notifications.getPushPublicKey,
  savePushSubscription: notifications.savePushSubscription,
  removePushSubscription: notifications.removePushSubscription,

  listAccounts: platform.listAccounts,
  getAccount: platform.getAccount,
  createAccount: platform.createAccount,
  updateAccount: platform.updateAccount,
  setAccountLogo: platform.setAccountLogo,
  listAccountMembers: platform.listAccountMembers,
  listAllUsers: platform.listAllUsers,
  createUser: platform.createUser,
  updateUser: platform.updateUser,
  setUserPassword: platform.setUserPassword,
  deleteUser: platform.deleteUser,
  attachUser: platform.attachUser,
  setMembershipRole: platform.setMembershipRole,
  detachUser: platform.detachUser,
}

export type Api = typeof api
export type ApiMethod = keyof Api
