package main

// Canvas grades: saved with a daily history so the planner (browser) can give weak or slipping
// classes more time. The focus formula mirrors web/src/core/grades.ts; keep the two in step.

import (
	"context"
	"fmt"
	"math"
	"sort"
	"time"
)

const defaultGradeTarget = 93.0

type GradePoint struct {
	Date  string  `json:"date"`
	Score float64 `json:"score"`
}

type CourseGrade struct {
	Course  string       `json:"course"`
	Score   *float64     `json:"score"`
	Grade   *string      `json:"grade"`
	Target  *float64     `json:"target,omitempty"`
	Ignore  bool         `json:"ignore,omitempty"`
	History []GradePoint `json:"history"`
	Updated string       `json:"updated"`
}

// WorkFlag is past-due work hurting a grade (graded 0, or never turned in). The browser finds them on
// Canvas sync; missing work that can still be submitted gets a make-up task.
type WorkFlag struct {
	ID        string   `json:"id"`
	Course    string   `json:"course"`
	Title     string   `json:"title"`
	Kind      string   `json:"kind"` // missing | zero
	Points    float64  `json:"points"`
	Score     *float64 `json:"score"`
	DueAt     string   `json:"due_at,omitempty"`
	URL       string   `json:"url,omitempty"`
	CanSubmit bool     `json:"can_submit"`
	Status    string   `json:"status"` // open | planned | dismissed
	TaskID    string   `json:"task_id,omitempty"`
	Seen      string   `json:"seen"`
}

func openFlags(st *State) []WorkFlag {
	out := []WorkFlag{}
	for _, f := range st.Flags {
		if f.Status != "dismissed" {
			out = append(out, f)
		}
	}
	return out
}

type gradeIn struct {
	Course string
	Score  *float64
	Grade  *string
}

func round1(f float64) float64 { return math.Round(f*10) / 10 }

// recordGrades merges fresh scores: one history point per day, newest last, 40 kept.
func recordGrades(list []CourseGrade, fresh []gradeIn, now time.Time) []CourseGrade {
	day := now.Format(dateLayout)
	out := append([]CourseGrade(nil), list...)
	for _, f := range fresh {
		if f.Course == "" {
			continue
		}
		i := -1
		for j := range out {
			if out[j].Course == f.Course {
				i = j
				break
			}
		}
		if i < 0 {
			out = append(out, CourseGrade{Course: f.Course, History: []GradePoint{}})
			i = len(out) - 1
		}
		g := &out[i]
		g.History = append([]GradePoint(nil), g.History...)
		g.Grade, g.Updated = f.Grade, now.Format(localLayout)
		if f.Score == nil {
			g.Score = nil
			continue
		}
		v := round1(*f.Score)
		g.Score = &v
		if n := len(g.History); n > 0 && g.History[n-1].Date == day {
			g.History[n-1].Score = v
		} else {
			g.History = append(g.History, GradePoint{Date: day, Score: v})
		}
		if n := len(g.History); n > 40 {
			g.History = g.History[n-40:]
		}
	}
	return out
}

// gradeTrend is the change versus the oldest point in the last 21 days (before today).
func gradeTrend(g CourseGrade, now time.Time) (float64, bool) {
	if g.Score == nil {
		return 0, false
	}
	today, cutoff := now.Format(dateLayout), now.AddDate(0, 0, -21).Format(dateLayout)
	for _, h := range g.History {
		if h.Date >= cutoff && h.Date < today {
			return round1(*g.Score - h.Score), true
		}
	}
	if n := len(g.History); n > 1 {
		return round1(*g.Score - g.History[n-2].Score), true
	}
	return 0, false
}

// gradeFocus is what the planner does with each class (same numbers as subjectFocus in grades.ts).
func gradeFocus(grades []CourseGrade, now time.Time) []map[string]any {
	out := []map[string]any{}
	for _, g := range grades {
		row := map[string]any{"course": g.Course, "score": g.Score, "grade": g.Grade, "updated": g.Updated}
		if g.Ignore || g.Score == nil {
			row["level"] = "not planned"
			out = append(out, row)
			continue
		}
		target := defaultGradeTarget
		if g.Target != nil {
			target = *g.Target
		}
		gap := round1(math.Max(0, target-*g.Score))
		trend, hasTrend := gradeTrend(g, now)
		drop := math.Max(0, -trend)
		boost := round1(1 + math.Min(0.4, gap*0.03+drop*0.05) + 1e-9)
		review := 0.0
		if gap >= 2 || drop >= 2 {
			review = math.Min(120, math.Max(30, math.Round((20+gap*6+drop*8)/5)*5))
		}
		level := "ok"
		switch {
		case review > 0 && (gap >= 5 || drop >= 3):
			level = "focus"
		case review > 0:
			level = "watch"
		case hasTrend && trend >= 1:
			level = "improving"
		}
		row["target"], row["gap"], row["level"] = target, gap, level
		row["homework_time_multiplier"], row["weekly_review_minutes"] = boost, review
		if hasTrend {
			row["trend_2wk"] = trend
		}
		hist := g.History
		if len(hist) > 10 {
			hist = hist[len(hist)-10:]
		}
		row["history"] = hist
		out = append(out, row)
	}
	rank := map[string]int{"focus": 0, "watch": 1, "improving": 2, "ok": 3, "not planned": 4}
	sort.SliceStable(out, func(i, j int) bool { return rank[out[i]["level"].(string)] < rank[out[j]["level"].(string)] })
	return out
}

// saveGradesFromCourses stores the courses list canvasExplore built (what=courses|grades).
func (s *Server) saveGradesFromCourses(list []map[string]any) {
	fresh := []gradeIn{}
	for _, m := range list {
		c, _ := m["course"].(string)
		in := gradeIn{Course: c}
		if v, ok := m["current_score"].(*float64); ok {
			in.Score = v
		}
		if v, ok := m["current_grade"].(*string); ok {
			in.Grade = v
		}
		fresh = append(fresh, in)
	}
	if len(fresh) == 0 {
		return
	}
	now := s.now()
	if _, _, err := s.store.Update(func(st *State) error {
		st.Grades = recordGrades(st.Grades, fresh, now)
		return nil
	}); err == nil {
		s.store.LogAudit("relay", "grades", fmt.Sprintf("saved %d course grades", len(fresh)))
	}
}

// refreshGrades pulls current grades from Canvas (one request) and saves them.
func (s *Server) refreshGrades(ctx context.Context) error {
	if s.integ.CanvasToken == "" {
		return fmt.Errorf("no Canvas token on the relay")
	}
	_, err := s.canvasExplore(ctx, exploreArgs{What: "grades"}) // canvasExplore saves them
	return err
}

func gradesStale(st *State, now time.Time, maxAge time.Duration) bool {
	last := ""
	for _, g := range st.Grades {
		if g.Updated > last {
			last = g.Updated
		}
	}
	t, err := time.ParseInLocation(localLayout, last, now.Location())
	return err != nil || now.Sub(t) > maxAge
}

// gradesLoop refreshes grades every 6 hours (one small Canvas request) so trends build up
// even when no browser is open. Does nothing without a server-side Canvas token.
func (s *Server) gradesLoop(ctx context.Context) {
	if s.integ.CanvasToken == "" {
		return
	}
	t := time.NewTimer(2 * time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		if _, st, err := s.store.Get(); err == nil && gradesStale(st, s.now(), 6*time.Hour) {
			rctx, cancel := context.WithTimeout(ctx, time.Minute)
			_ = s.refreshGrades(rctx)
			cancel()
		}
		t.Reset(time.Hour)
	}
}
