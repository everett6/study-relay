package main

import (
	"encoding/json"
	"fmt"
	"time"
)

// State is the single JSON document shared by the browser client and the relay.
// The browser owns planning, LLM inference and CfC training; the relay stores the
// document and applies small, deterministic edits requested over MCP.
type State struct {
	Rules    Rules             `json:"rules"`
	Buckets  []Bucket          `json:"buckets"`
	Tasks    []Task            `json:"tasks"`
	Events   []Event           `json:"events"`
	Blocks   []Block           `json:"blocks"`
	Timer    Timer             `json:"timer"`
	Sessions []Session         `json:"sessions"`
	Feedback []Feedback        `json:"feedback"` // pending CfC training items (browser consumes)
	CfC      json.RawMessage   `json:"cfc,omitempty"`
	Momentum json.RawMessage   `json:"momentum,omitempty"` // browser-owned adaptive baseline
	Inbox    []InboxItem       `json:"inbox"`
	Drafts   []Draft           `json:"drafts"`
	Meta     Meta              `json:"meta"`
	Grades   []CourseGrade     `json:"grades,omitempty"` // Canvas grades + daily history (planner uses them)
	Flags    []WorkFlag        `json:"flags,omitempty"`  // zeros and missing work found on Canvas
	Problems []ProblemLog      `json:"problems,omitempty"`
	AIMemory []AIMemoryMessage `json:"ai_memory"`
}

type AIMemoryMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type ProblemLog struct {
	ID        string `json:"id"`
	Bucket    string `json:"bucket"`
	Topic     string `json:"topic"`
	Attempted int    `json:"attempted"`
	Solved    int    `json:"solved"`
	ErrorType string `json:"error_type,omitempty"` // concept | algebra | time
	At        string `json:"at"`
}

type Rules struct {
	SchoolDays  []int  `json:"school_days"` // 1=Mon .. 7=Sun
	RestDays    []int  `json:"rest_days,omitempty"`
	SchoolStart string `json:"school_start"`
	SchoolEnd   string `json:"school_end"`
	// SchoolEndByDay overrides SchoolEnd per ISO weekday ("1"=Mon .. "7"=Sun), e.g. block days.
	SchoolEndByDay map[string]string   `json:"school_end_by_day,omitempty"`
	CommuteMin     int                 `json:"commute_min,omitempty"`
	AfterSchoolMin int                 `json:"after_school_min"`
	DinnerStart    string              `json:"dinner_start"`
	DinnerMin      int                 `json:"dinner_min"`
	SleepCutoff    string              `json:"sleep_cutoff"`
	WeekendStart   string              `json:"weekend_start"`
	BlockMin       int                 `json:"block_min"`
	BreakMin       int                 `json:"break_min"`
	MinBlockMin    int                 `json:"min_block_min"`
	PreclearHours  int                 `json:"preclear_hours"`
	EventPrepMin   int                 `json:"event_prep_min"`
	QuietWeekday   []string            `json:"quiet_weekday"`
	QuietWeekend   []string            `json:"quiet_weekend"`
	QuietByDay     map[string][]string `json:"quiet_by_day,omitempty"`
	// GoalDays limits a weekly goal (bucket key) to these ISO weekdays; missing = any day.
	GoalDays map[string][]int `json:"goal_days,omitempty"`
	// NoSchoolDates are one-off YYYY-MM-DD days without school (breaks, sick days).
	NoSchoolDates []string `json:"no_school_dates,omitempty"`
	// WeeklyFocus is the one thing that matters most this week; the planner protects time for it.
	WeeklyFocus string `json:"weekly_focus,omitempty"`
}

type Bucket struct {
	Key           string  `json:"key"`
	Name          string  `json:"name"`
	TargetHours   float64 `json:"target_hours"`
	LoggedMinutes float64 `json:"logged_minutes"`
	Week          string  `json:"week"` // ISO week the logged minutes belong to
	Load          int     `json:"load"`
}

type Task struct {
	ID            string   `json:"id"`
	Source        string   `json:"source"` // canvas | manual | mcp
	Course        string   `json:"course"`
	Title         string   `json:"title"`
	Description   string   `json:"description,omitempty"`
	Comments      []string `json:"comments,omitempty"`
	Category      string   `json:"category"`  // homework | quiz | test | lab | project
	TaskType      string   `json:"task_type"` // HW | Quiz | Exam | Project | Lab
	Points        *float64 `json:"points,omitempty"`
	DueAt         string   `json:"due_at,omitempty"`
	CognitiveLoad int      `json:"cognitive_load"`
	LLMMinutes    int      `json:"llm_minutes"`
	EstMinutes    int      `json:"estimated_minutes"`
	HumanMinutes  *int     `json:"human_minutes,omitempty"`
	Confidence    float64  `json:"confidence"`
	Blocks        []int    `json:"recommended_45m_blocks"`
	EstSource     string   `json:"est_source"` // llm | heuristic | human
	EstWhy        string   `json:"est_why,omitempty"`
	LoggedMinutes float64  `json:"logged_minutes"`
	Status        string   `json:"status"` // open | done
	PreclearBy    string   `json:"preclear_by,omitempty"`
	FirstStep     string   `json:"first_step,omitempty"`
	FirstStepDone bool     `json:"first_step_done,omitempty"`
	// Priority: high pulls work forward, low yields to everything else; empty = normal.
	Priority  string `json:"priority,omitempty"`
	UpdatedAt int64  `json:"updated_at,omitempty"`
	DeletedAt int64  `json:"deleted_at,omitempty"`
}

type Event struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Kind      string `json:"kind"` // event | blackout
	Start     string `json:"start"`
	End       string `json:"end"`
	UpdatedAt int64  `json:"updated_at,omitempty"`
	DeletedAt int64  `json:"deleted_at,omitempty"`
}

type Block struct {
	ID        string `json:"id"`
	Date      string `json:"date"`
	Start     string `json:"start"`
	End       string `json:"end"`
	Kind      string `json:"kind"` // task | bucket
	TaskID    string `json:"task_id,omitempty"`
	Bucket    string `json:"bucket"`
	Title     string `json:"title"`
	Load      int    `json:"load"`
	Quiet     bool   `json:"quiet"`
	Locked    bool   `json:"locked"`
	Status    string `json:"status"` // planned | done
	UpdatedAt int64  `json:"updated_at,omitempty"`
	DeletedAt int64  `json:"deleted_at,omitempty"`
}

type Timer struct {
	State      string  `json:"state"` // idle | running | paused
	Bucket     string  `json:"bucket,omitempty"`
	TaskID     string  `json:"task_id,omitempty"`
	BlockID    string  `json:"block_id,omitempty"`
	PlannedMin int     `json:"planned_min,omitempty"`
	StartedAt  string  `json:"started_at,omitempty"` // RFC3339 of the current running stretch
	ElapsedSec float64 `json:"elapsed_sec"`          // accumulated before StartedAt
	NextAction string  `json:"next_action,omitempty"`
}

type Session struct {
	ID         string  `json:"id"`
	Bucket     string  `json:"bucket"`
	TaskID     string  `json:"task_id,omitempty"`
	PlannedMin int     `json:"planned_min"`
	ActualMin  float64 `json:"actual_min"`
	Energy     string  `json:"energy"`
	Outcome    string  `json:"outcome"`
	Confidence int     `json:"confidence,omitempty"`
	Note       string  `json:"note,omitempty"`
	EndedAt    string  `json:"ended_at"`
}

type Feedback struct {
	Kind        string  `json:"kind"` // correction | session
	TaskID      string  `json:"task_id,omitempty"`
	Bucket      string  `json:"bucket,omitempty"`
	TaskType    string  `json:"task_type"`
	Course      string  `json:"course,omitempty"`
	AIMinutes   float64 `json:"ai_minutes"`
	RealMinutes float64 `json:"real_minutes"`
	Energy      string  `json:"energy,omitempty"`
	At          string  `json:"at"`
}

type AtRisk struct {
	TaskID  string `json:"task_id"`
	Title   string `json:"title"`
	Minutes int    `json:"minutes"`
	Reason  string `json:"reason"`
}

type Meta struct {
	NeedsReplan bool     `json:"needs_replan"`
	AtRisk      []AtRisk `json:"at_risk"`
	UpdatedBy   string   `json:"updated_by"`
	UpdatedAt   string   `json:"updated_at"`
	// PlanKey fingerprints the planner inputs the current plan was built from (set by the browser).
	PlanKey        string `json:"plan_key,omitempty"`
	LastCanvasSync string `json:"last_canvas_sync,omitempty"`
}

const (
	localLayout = "2006-01-02T15:04"
	dateLayout  = "2006-01-02"
	school      = "SCHOOL"
)

func DefaultState() *State {
	return &State{
		Rules: Rules{
			SchoolDays: []int{1, 2, 3, 4, 5}, SchoolStart: "08:30", SchoolEnd: "15:30",
			AfterSchoolMin: 45, DinnerStart: "19:00", DinnerMin: 90, SleepCutoff: "22:30",
			WeekendStart: "09:00", BlockMin: 45, BreakMin: 10, MinBlockMin: 20,
			PreclearHours: 48, EventPrepMin: 30,
			QuietWeekday: []string{"16:15-18:30"}, QuietWeekend: []string{"09:00-12:00", "14:00-17:00"},
		},
		Buckets: []Bucket{
			{Key: "AIME", Name: "AIME (Competition Math)", TargetHours: 6, Load: 5},
			{Key: "USAAIO", Name: "USAAIO (AI Olympiad)", TargetHours: 5, Load: 5},
			{Key: "RESEARCH", Name: "ISEF / Synopsys Research", TargetHours: 6, Load: 5},
			{Key: "ACT", Name: "ACT Prep", TargetHours: 3, Load: 4},
			{Key: "PHYSICS", Name: "Physics / Extra STEM", TargetHours: 3, Load: 3},
			{Key: school, Name: "Tier 1 School", TargetHours: 0, Load: 3},
		},
		Tasks: []Task{}, Events: []Event{}, Blocks: []Block{}, Sessions: []Session{},
		Feedback: []Feedback{}, Timer: Timer{State: "idle"}, Inbox: []InboxItem{}, Drafts: []Draft{},
	}
}

func isoWeek(t time.Time) string {
	y, w := t.ISOWeek()
	return fmt.Sprintf("%d-W%02d", y, w)
}

// normalizeWeek resets weekly bucket totals when a new ISO week starts.
func (s *State) normalizeWeek(now time.Time) {
	wk := isoWeek(now)
	for i := range s.Buckets {
		if s.Buckets[i].Week != wk {
			s.Buckets[i].Week = wk
			s.Buckets[i].LoggedMinutes = 0
		}
	}
}

func (s *State) bucket(key string) *Bucket {
	for i := range s.Buckets {
		if s.Buckets[i].Key == key {
			return &s.Buckets[i]
		}
	}
	return nil
}

func (s *State) task(id string) *Task {
	for i := range s.Tasks {
		if s.Tasks[i].ID == id {
			return &s.Tasks[i]
		}
	}
	return nil
}

func (s *State) block(id string) *Block {
	for i := range s.Blocks {
		if s.Blocks[i].ID == id {
			return &s.Blocks[i]
		}
	}
	return nil
}

// fillDefaults repairs documents posted by older clients so the relay never panics on nil.
func (s *State) fillDefaults() {
	d := DefaultState()
	if s.Rules.SleepCutoff == "" {
		s.Rules = d.Rules
	}
	if len(s.Buckets) == 0 {
		s.Buckets = d.Buckets
	}
	if s.Tasks == nil {
		s.Tasks = []Task{}
	}
	if s.Events == nil {
		s.Events = []Event{}
	}
	if s.Blocks == nil {
		s.Blocks = []Block{}
	}
	if s.Sessions == nil {
		s.Sessions = []Session{}
	}
	if s.Feedback == nil {
		s.Feedback = []Feedback{}
	}
	if s.Inbox == nil {
		s.Inbox = []InboxItem{}
	}
	if s.Drafts == nil {
		s.Drafts = []Draft{}
	}
	if len(s.Inbox) > 200 {
		s.Inbox = s.Inbox[len(s.Inbox)-200:]
	}
	if len(s.Drafts) > 100 {
		s.Drafts = s.Drafts[len(s.Drafts)-100:]
	}
	if s.Timer.State == "" {
		s.Timer.State = "idle"
	}
	if len(s.Sessions) > 500 { // keep the document small
		s.Sessions = s.Sessions[len(s.Sessions)-500:]
	}
	if len(s.Feedback) > 200 {
		s.Feedback = s.Feedback[len(s.Feedback)-200:]
	}
}
