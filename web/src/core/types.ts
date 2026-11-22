// Shared state document. Mirrors server/state.go field-for-field.

export interface Rules {
  school_days: number[]; // 1=Mon .. 7=Sun
  rest_days?: number[];  // 1=Mon .. 7=Sun kept free of study
  school_start: string;
  school_end: string;
  /** per ISO weekday ("1"=Mon) dismissal overrides, e.g. block days */
  school_end_by_day?: Record<string, string>;
  commute_min?: number;
  after_school_min: number;
  dinner_start: string;
  dinner_min: number;
  sleep_cutoff: string;
  weekend_start: string;
  block_min: number;
  break_min: number;
  min_block_min: number;
  preclear_hours: number;
  event_prep_min: number;
  quiet_weekday: string[];
  quiet_weekend: string[];
  quiet_by_day?: Record<string, string[]>;
  /** the one thing that matters most this week; the planner protects time for it */
  weekly_focus?: string;
}

export interface Bucket {
  key: string;
  name: string;
  target_hours: number;
  logged_minutes: number;
  week: string;
  load: number;
}

export type Category = "homework" | "quiz" | "test" | "lab" | "project";
export type TaskType = "HW" | "Quiz" | "Exam" | "Project" | "Lab";

export interface Task {
  id: string;
  source: string;
  course: string;
  title: string;
  description?: string;
  comments?: string[];
  category: Category;
  task_type: TaskType;
  points?: number | null;
  due_at?: string;
  cognitive_load: number;
  llm_minutes: number;
  estimated_minutes: number;
  human_minutes?: number | null;
  confidence: number;
  recommended_45m_blocks: number[];
  est_source: "llm" | "heuristic" | "human";
  /** one short line on why the estimate is what it is (signals from Canvas, or the model's reason) */
  est_why?: string;
  logged_minutes: number;
  status: "open" | "done";
  preclear_by?: string;
  first_step?: string;
  first_step_done?: boolean;
  /** high = pull work forward, low = yield to everything else; absent = normal */
  priority?: "high" | "normal" | "low";
  updated_at?: number;
  deleted_at?: number;
}

export interface CalEvent {
  id: string;
  title: string;
  kind: "event" | "blackout";
  start: string;
  end: string;
  updated_at?: number;
  deleted_at?: number;
}

export interface Block {
  id: string;
  date: string;
  start: string;
  end: string;
  kind: "task" | "bucket";
  task_id?: string;
  bucket: string;
  title: string;
  load: number;
  quiet: boolean;
  locked: boolean;
  status: "planned" | "done" | "missed";
  updated_at?: number;
  deleted_at?: number;
}

export interface Timer {
  state: "idle" | "running" | "paused";
  bucket?: string;
  task_id?: string;
  block_id?: string;
  planned_min?: number;
  started_at?: string; // RFC3339
  elapsed_sec: number;
  next_action?: string;
}

export interface Session {
  id: string;
  bucket: string;
  task_id?: string;
  planned_min: number;
  actual_min: number;
  energy: string;
  outcome: string;
  confidence?: 1 | 2 | 3;
  note?: string;
  ended_at: string;
}

export interface Feedback {
  kind: "correction" | "session";
  task_id?: string;
  bucket?: string;
  task_type: string;
  course?: string;
  ai_minutes: number;
  real_minutes: number;
  energy?: string;
  at: string;
}

export interface AtRisk {
  task_id: string;
  title: string;
  minutes: number;
  reason: string;
}

export interface Meta {
  needs_replan: boolean;
  at_risk: AtRisk[];
  /** fingerprint of the planner inputs the current plan was built from */
  plan_key?: string;
  last_canvas_sync?: string;
  updated_by: string;
  updated_at: string;
}

export interface CfCStep {
  t: number; // epoch ms
  x: number[];
  y?: number; // log pace ratio target
  key?: string;
}

export interface CfCSnapshot {
  hidden: number;
  backbone: number;
  params: number[];
  m: number[];
  v: number[];
  step: number;
  updates: number;
  last_loss: number | null;
  history: CfCStep[];
}

export interface InboxItem {
  id: string;
  source: "discord" | "email" | "screenshot" | "canvas" | "thought";
  external_id: string;
  from: string;
  subject: string;
  text: string;
  url?: string;
  received_at: string;
  tags: string[];
  status: "new" | "accepted" | "dismissed";
}

export interface Draft {
  id: string;
  to: string;
  subject: string;
  body: string;
  reason: string;
  status: "draft" | "sent" | "failed";
  created_at: string;
  sent_at?: string;
  error?: string;
  inbox_id?: string;
}

/** One hit/miss/check-in observation feeding the adaptive baseline. */
export interface MomentumEvent {
  at: string; // local ISO
  kind: "hit" | "miss" | "partial" | "checkin";
  minutes?: number;
  energy?: "low" | "med" | "high";
  mood?: number; // 1..5 from the optional check-in
  key?: string; // block id (dedupe)
}

export type Mode = "thriving" | "steady" | "stretched" | "overloaded";

export interface Momentum {
  events: MomentumEvent[];
  fast: number; // EWMA hit rate, last few blocks
  slow: number; // EWMA hit rate, personal baseline
  energy: number; // 0..1
  mood: number | null; // 0..1
  mode: Mode;
  since: string; // when the mode last changed
}

/** Work that is hurting a grade: past due and never turned in, or graded 0. */
export interface WorkFlag {
  id: string;            // canvas assignment id
  course: string;
  title: string;
  kind: "missing" | "zero";
  points: number;
  score: number | null;
  due_at?: string;
  url?: string;
  /** Canvas still accepts a submission (not locked) */
  can_submit: boolean;
  status: "open" | "planned" | "dismissed";
  task_id?: string;
  seen: string;          // last sync that still saw it
}

/** One Canvas course grade plus a daily history (newest last) so the planner can see trends. */
export interface CourseGrade {
  course: string;
  score: number | null;
  grade: string | null;
  /** the student's goal for this course (percent); default 93 */
  target?: number | null;
  /** true = leave this course out of focus planning (e.g. PE) */
  ignore?: boolean;
  history: { date: string; score: number }[];
  updated: string;
}

export interface AIMemoryMessage {
  role: "user" | "assistant";
  content: string;
}

export interface State {
  rules: Rules;
  buckets: Bucket[];
  tasks: Task[];
  events: CalEvent[];
  blocks: Block[];
  timer: Timer;
  sessions: Session[];
  feedback: Feedback[];
  cfc?: CfCSnapshot | null;
  momentum?: Momentum | null;
  inbox: InboxItem[];
  drafts: Draft[];
  meta: Meta;
  grades?: CourseGrade[];
  flags?: WorkFlag[];
  ai_memory?: AIMemoryMessage[];
}

export const SCHOOL = "SCHOOL";

export function defaultState(): State {
  return {
    rules: {
      school_days: [1, 2, 3, 4, 5], school_start: "08:30", school_end: "15:30",
      after_school_min: 45, dinner_start: "19:00", dinner_min: 90, sleep_cutoff: "22:30",
      weekend_start: "09:00", block_min: 45, break_min: 10, min_block_min: 20,
      preclear_hours: 48, event_prep_min: 30,
      quiet_weekday: ["16:15-18:30"], quiet_weekend: ["09:00-12:00", "14:00-17:00"],
    },
    buckets: [
      { key: "AIME", name: "AIME (Competition Math)", target_hours: 6, logged_minutes: 0, week: "", load: 5 },
      { key: "USAAIO", name: "USAAIO (AI Olympiad)", target_hours: 5, logged_minutes: 0, week: "", load: 5 },
      { key: "RESEARCH", name: "ISEF / Synopsys Research", target_hours: 6, logged_minutes: 0, week: "", load: 5 },
      { key: "ACT", name: "ACT Prep", target_hours: 3, logged_minutes: 0, week: "", load: 4 },
      { key: "PHYSICS", name: "Physics / Extra STEM", target_hours: 3, logged_minutes: 0, week: "", load: 3 },
      { key: "SELF", name: "Self-improvement", target_hours: 2, logged_minutes: 0, week: "", load: 3 },
      { key: SCHOOL, name: "Tier 1 School", target_hours: 0, logged_minutes: 0, week: "", load: 3 },
    ],
    tasks: [], events: [], blocks: [], sessions: [], feedback: [],
    timer: { state: "idle", elapsed_sec: 0 },
    cfc: null, momentum: null, inbox: [], drafts: [],
    meta: { needs_replan: true, at_risk: [], updated_by: "browser", updated_at: "" },
  };
}
