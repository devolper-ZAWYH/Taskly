/**
 * The card's words, in the person's Taskly language. They live here rather
 * than in messages/ because the card is its own small page, built separately
 * (scripts/build-cards.mjs), and shouldn't carry the whole app's dictionary.
 */
const en = {
  newTask: "New task",
  newMeeting: "New meeting",
  today: "Today",
  chooseMeeting: "Choose a meeting",
  whoAttendees: "Who should attend?",
  whoAssignees: "Who is it for?",
  whoReaders: "Who can read the minutes?",
  whoOther: "Choose people",
  whoDidYouMean: "Who did you mean?",

  for: "For",
  due: "Due",
  priority: "Priority",
  fromMeeting: "Meeting",
  when: "When",
  where: "Where",
  who: "Who",
  agenda: "Agenda",
  you: "You",

  priorities: { none: "None", low: "Low", medium: "Medium", high: "High", urgent: "Urgent" },
  roles: { administrator: "Administrator", member: "Member" },

  heardAs: (said: string, name: string) => `Heard “${said}” as ${name}`,
  pastDue: "This due date has already passed.",
  pastMeeting: "This time has already passed.",
  clashes: "Clashes",
  clash: (who: string, meeting: string, time: string, isYou: boolean) =>
    isYou ? `You have “${meeting}” at ${time}` : `${who} has “${meeting}” at ${time}`,
  inZone: (zone: string) => `Times in ${zone}`,

  createTask: "Create task",
  createMeeting: "Create meeting",
  creating: "Creating…",
  discard: "Discard",
  changeHint: "To change something, just tell Claude.",
  taskCreated: "Task created",
  meetingCreated: "Meeting created",
  discarded: "Discarded. Nothing was created.",
  openInTaskly: "Open in Taskly",

  couldBe: (said: string) => `“${said}” could be:`,
  nobodyMatches: (said: string) => `Nobody matches “${said}”. Tell Claude who you meant.`,
  continue: "Continue",
  checking: "Checking…",

  meetings: "Meetings",
  tasks: "Tasks",
  noMeetings: "No meetings today.",
  noTasks: "Nothing due today.",
  overdue: "Overdue",
  moreTasks: (n: number) => `${n} more in Taskly`,
  markDone: (title: string) => `Mark “${title}” done`,
  openTaskly: "Open Taskly",

  people: (n: number) => (n === 1 ? "1 person" : `${n} people`),
  yourMinutes: "Your minutes",
  showMore: (n: number) => `Show ${n} more`,
  noMeetingsFound: "No meetings in this period. Tell Claude when it was.",
  searchPeople: "Search people",
  noPeopleFound: "Nobody matches that.",
  done: (n: number) => (n === 0 ? "Done" : `Done (${n})`),
  sent: "Sent to Claude",

  /** What a choice says in the chat, as the person's own message. */
  pickedMeeting: (title: string, when: string) => `The meeting “${title}”, ${when}.`,
  pickedPeople: (names: string) => names,
  andList: (items: string[]) =>
    items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`,

  errors: {
    expired: "This review has expired. Ask Claude to review it again.",
    not_admin: "Only workspace administrators can do this.",
    workspace_required: "Claude will ask which workspace to use.",
    write_scope: "Claude has read-only access. Reconnect it with write access to make changes.",
    generic: "That didn't work. Ask Claude to try again.",
    nothing: "Nothing to show here. See Claude's reply.",
    cancelled: "Cancelled.",
    sendFailed: "Couldn't send that to Claude. Type your choice instead.",
  },
}

export type Strings = typeof en

const ar: Strings = {
  newTask: "مهمة جديدة",
  newMeeting: "اجتماع جديد",
  today: "اليوم",
  chooseMeeting: "اختر اجتماعًا",
  whoAttendees: "من يحضر؟",
  whoAssignees: "لمن المهمة؟",
  whoReaders: "من يمكنه قراءة المحضر؟",
  whoOther: "اختر الأشخاص",
  whoDidYouMean: "من تقصد؟",

  for: "إلى",
  due: "الاستحقاق",
  priority: "الأولوية",
  fromMeeting: "الاجتماع",
  when: "الموعد",
  where: "المكان",
  who: "الحضور",
  agenda: "جدول الأعمال",
  you: "أنت",

  priorities: { none: "بدون", low: "منخفضة", medium: "متوسطة", high: "عالية", urgent: "عاجلة" },
  roles: { administrator: "مسؤول", member: "عضو" },

  heardAs: (said, name) => `فُهم «${said}» على أنه ${name}`,
  pastDue: "تاريخ الاستحقاق هذا قد مضى.",
  pastMeeting: "هذا الوقت قد مضى.",
  clashes: "تعارضات",
  clash: (who, meeting, time, isYou) =>
    isYou ? `لديك «${meeting}» في ${time}` : `لدى ${who} «${meeting}» في ${time}`,
  inZone: (zone) => `الأوقات بتوقيت ${zone}`,

  createTask: "إنشاء المهمة",
  createMeeting: "إنشاء الاجتماع",
  creating: "جارٍ الإنشاء…",
  discard: "تجاهل",
  changeHint: "لتغيير أي شيء، أخبر Claude.",
  taskCreated: "تم إنشاء المهمة",
  meetingCreated: "تم إنشاء الاجتماع",
  discarded: "تم التجاهل. لم يُنشأ شيء.",
  openInTaskly: "فتح في Taskly",

  couldBe: (said) => `«${said}» قد يكون:`,
  nobodyMatches: (said) => `لا أحد يطابق «${said}». أخبر Claude بمن تقصد.`,
  continue: "متابعة",
  checking: "جارٍ التحقق…",

  meetings: "الاجتماعات",
  tasks: "المهام",
  noMeetings: "لا اجتماعات اليوم.",
  noTasks: "لا شيء مستحق اليوم.",
  overdue: "متأخرة",
  moreTasks: (n) => `${n} أخرى في Taskly`,
  markDone: (title) => `تعليم «${title}» كمنجزة`,
  openTaskly: "فتح Taskly",

  people: (n) => (n === 1 ? "شخص واحد" : n === 2 ? "شخصان" : `${n} أشخاص`),
  yourMinutes: "محضرك",
  showMore: (n) => `عرض ${n} أخرى`,
  noMeetingsFound: "لا اجتماعات في هذه الفترة. أخبر Claude متى كان.",
  searchPeople: "ابحث عن شخص",
  noPeopleFound: "لا أحد يطابق ذلك.",
  done: (n) => (n === 0 ? "تم" : `تم (${n})`),
  sent: "أُرسل إلى Claude",

  pickedMeeting: (title, when) => `اجتماع «${title}»، ${when}.`,
  pickedPeople: (names) => names,
  andList: (items) =>
    items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join("، ")} و${items.at(-1)}`,

  errors: {
    expired: "انتهت صلاحية هذه المراجعة. اطلب من Claude مراجعتها مجددًا.",
    not_admin: "هذا متاح لمسؤولي مساحة العمل فقط.",
    workspace_required: "سيسألك Claude عن مساحة العمل التي تريدها.",
    write_scope: "صلاحية Claude للقراءة فقط. أعد ربطه بصلاحية الكتابة لإجراء تغييرات.",
    generic: "لم ينجح ذلك. اطلب من Claude المحاولة مجددًا.",
    nothing: "لا شيء لعرضه هنا. اطّلع على رد Claude.",
    cancelled: "أُلغي.",
    sendFailed: "تعذّر إرسال ذلك إلى Claude. اكتب اختيارك بدلًا من ذلك.",
  },
}

export function stringsFor(locale: "en" | "ar"): Strings {
  return locale === "ar" ? ar : en
}
