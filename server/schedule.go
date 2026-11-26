package main

import (
	"fmt"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Server-side scheduling is deliberately small: protected buffers, gap finding and the
// evening-event override. Full weekly planning runs in the browser (web/src/core/schedule.ts)
// which re-plans whenever meta.needs_replan is set.

type span struct{ s, e time.Time }

func hm(v string) int {
	parts := strings.SplitN(v, ":", 2)
	if len(parts) != 2 {
		return 0
	}
	h, _ := strconv.Atoi(parts[0])
	m, _ := strconv.Atoi(parts[1])
	return h*60 + m
}

func at(day time.Time, minutes int) time.Time {
	y, mo, d := day.Date()
	return time.Date(y, mo, d, 0, 0, 0, 0, day.Location()).Add(time.Duration(minutes) * time.Minute)
}

// schoolHolidayName returns the US federal/public+private school holiday name if no school is held on day.
func schoolHolidayName(day time.Time) string {
	m := day.Month()
	d := day.Day()
	wd := int(day.Weekday()) // 0=Sun..6=Sat
	// Observed fixed-date federal holidays (Fri if Sat, Mon if Sun)
	isObserved := func(month time.Month, target int) bool {
		if m == month && d == target {
			return true
		}
		if wd == 5 && day.AddDate(0, 0, 1).Month() == month && day.AddDate(0, 0, 1).Day() == target {
			return true
		}
		if wd == 1 && day.AddDate(0, 0, -1).Month() == month && day.AddDate(0, 0, -1).Day() == target {
			return true
		}
		return false
	}
	if (m == time.December && d >= 24) || (m == time.January && d == 1) || isObserved(time.January, 1) {
		return "Winter Break / New Year's"
	}
	if m == time.January && wd == 1 && d >= 15 && d <= 21 {
		return "MLK Jr. Day"
	}
	if m == time.February && wd == 1 && d >= 15 && d <= 21 {
		return "Presidents' Day"
	}
	if m == time.May && wd == 1 && d >= 25 {
		return "Memorial Day"
	}
	if isObserved(time.June, 19) {
		return "Juneteenth"
	}
	if isObserved(time.July, 4) {
		return "Independence Day"
	}
	if m == time.September && wd == 1 && d <= 7 {
		return "Labor Day"
	}
	if m == time.October && wd == 1 && d >= 8 && d <= 14 {
		return "Indigenous Peoples' / Columbus Day"
	}
	if isObserved(time.November, 11) {
		return "Veterans Day"
	}
	if m == time.November && ((wd == 4 && d >= 22 && d <= 28) || (wd == 5 && d >= 23 && d <= 29)) {
		return "Thanksgiving Break"
	}
	return ""
}

func isSchoolDay(r Rules, day time.Time) bool {
	if schoolHolidayName(day) != "" {
		return false
	}
	if slices.Contains(r.NoSchoolDates, day.Format("2006-01-02")) {
		return false
	}
	wd := int(day.Weekday())
	if wd == 0 {
		wd = 7
	}
	for _, d := range r.SchoolDays {
		if d == wd {
			return true
		}
	}
	return false
}

func parseLocal(v string, loc *time.Location) (time.Time, error) {
	if len(v) > 16 {
		v = v[:16]
	}
	return time.ParseInLocation(localLayout, v, loc)
}

// FixedSpans returns the protected blocks of a day: school, snack break, dinner, events, sleep.
func FixedSpans(r Rules, day time.Time, events []Event) []struct {
	Kind, Title string
	S, E        time.Time
} {
	type fx = struct {
		Kind, Title string
		S, E        time.Time
	}
	out := []fx{}
	if isSchoolDay(r, day) {
		end := hm(schoolEnd(r, day))
		comm := max(0, r.CommuteMin)
		out = append(out, fx{"school", "School", at(day, hm(r.SchoolStart)), at(day, end)})
		if comm > 0 {
			out = append(out, fx{"buffer", "Commute", at(day, end), at(day, end+comm)})
		}
		out = append(out, fx{"buffer", "Snack & decompress", at(day, end+comm), at(day, end+comm+r.AfterSchoolMin)})
	}
	d := hm(r.DinnerStart)
	out = append(out, fx{"dinner", "Dinner & family", at(day, d), at(day, d+r.DinnerMin)})
	out = append(out, fx{"sleep", "Sleep (hard cutoff)", at(day, hm(r.SleepCutoff)), at(day, 24*60)})
	dayS, dayE := at(day, 0), at(day, 24*60)
	for _, ev := range events {
		s, err1 := parseLocal(ev.Start, day.Location())
		e, err2 := parseLocal(ev.End, day.Location())
		if err1 != nil || err2 != nil || !e.After(dayS) || !s.Before(dayE) {
			continue
		}
		if ev.Kind == "event" && r.EventPrepMin > 0 {
			out = append(out, fx{"prep", "Get ready: " + ev.Title, s.Add(-time.Duration(r.EventPrepMin) * time.Minute), s})
		}
		out = append(out, fx{ev.Kind, ev.Title, s, e})
	}
	return out
}

// schoolEnd is the day's dismissal time, honouring per-weekday overrides.
func schoolEnd(r Rules, day time.Time) string {
	dow := int(day.Weekday())
	if dow == 0 {
		dow = 7
	}
	if v, ok := r.SchoolEndByDay[strconv.Itoa(dow)]; ok && v != "" {
		return v
	}
	return r.SchoolEnd
}

// StudyWindow is the earliest/latest study minute of the day.
func StudyWindow(r Rules, day time.Time) (time.Time, time.Time) {
	start := hm(r.WeekendStart)
	if isSchoolDay(r, day) {
		start = hm(schoolEnd(r, day))
	}
	return at(day, start), at(day, hm(r.SleepCutoff))
}

// FreeGaps returns free study time on a day after removing fixed spans and planned blocks.
func FreeGaps(r Rules, day time.Time, events []Event, blocks []Block, now time.Time) []span {
	ws, we := StudyWindow(r, day)
	if now.After(ws) && sameDay(now, day) {
		ws = now.Truncate(5 * time.Minute).Add(5 * time.Minute)
	}
	gaps := []span{{ws, we}}
	cut := func(bs, be time.Time) {
		next := gaps[:0:0]
		for _, g := range gaps {
			if !be.After(g.s) || !bs.Before(g.e) {
				next = append(next, g)
				continue
			}
			if bs.After(g.s) {
				next = append(next, span{g.s, bs})
			}
			if be.Before(g.e) {
				next = append(next, span{be, g.e})
			}
		}
		gaps = next
	}
	for _, f := range FixedSpans(r, day, events) {
		cut(f.S, f.E)
	}
	brk := time.Duration(r.BreakMin) * time.Minute
	for _, b := range blocks {
		if b.Date != day.Format(dateLayout) || b.Status != "planned" {
			continue
		}
		s, err1 := parseLocal(b.Start, day.Location())
		e, err2 := parseLocal(b.End, day.Location())
		if err1 == nil && err2 == nil {
			cut(s, e.Add(brk))
		}
	}
	return gaps
}

func sameDay(a, b time.Time) bool {
	ay, am, ad := a.Date()
	by, bm, bd := b.Date()
	return ay == by && am == bm && ad == bd
}

// ValidateBlock rejects a block that touches protected time.
func ValidateBlock(r Rules, events []Event, b Block, loc *time.Location) error {
	s, err := parseLocal(b.Start, loc)
	if err != nil {
		return err
	}
	e, err := parseLocal(b.End, loc)
	if err != nil {
		return err
	}
	if !e.After(s) || !sameDay(s, e) {
		return fmt.Errorf("block must start and end on the same day")
	}
	ws, we := StudyWindow(r, s)
	if s.Before(ws) || e.After(we) {
		return fmt.Errorf("outside study hours (school or sleep cutoff)")
	}
	for _, f := range FixedSpans(r, s, events) {
		if s.Before(f.E) && e.After(f.S) {
			return fmt.Errorf("overlaps protected block: %s", f.Title)
		}
	}
	return nil
}

func minutesOf(b Block, loc *time.Location) int {
	s, err1 := parseLocal(b.Start, loc)
	e, err2 := parseLocal(b.End, loc)
	if err1 != nil || err2 != nil {
		return 0
	}
	return int(e.Sub(s).Minutes())
}

// OverrideResult reports what an evening-event override changed.
type OverrideResult struct {
	Event     Event    `json:"event"`
	Dropped   []Block  `json:"dropped_blocks"`
	Preclear  []string `json:"precleared_tasks"`
	Placed    []Block  `json:"placed_blocks"`
	AtRisk    []AtRisk `json:"at_risk"`
	CutoffHHM string   `json:"sleep_cutoff"`
}

// ApplyEventOverride adds an evening event, drops study blocks from the event (minus prep)
// to the sleep cutoff, and re-places Tier 1 work due by the end of the next day into free
// time before the event. Work that cannot fit is reported; sleep is never used.
func ApplyEventOverride(st *State, ev Event, preclearCourse string, preclearBefore *time.Time,
	dropAfter bool, now time.Time, newID func() string) (OverrideResult, error) {
	loc := now.Location()
	r := st.Rules
	start, err := parseLocal(ev.Start, loc)
	if err != nil {
		return OverrideResult{}, fmt.Errorf("bad start: %w", err)
	}
	end, err := parseLocal(ev.End, loc)
	if err != nil || !end.After(start) {
		end = start.Add(150 * time.Minute)
		ev.End = end.Format(localLayout)
	}
	if ev.ID == "" {
		ev.ID = newID()
	}
	if ev.Kind == "" {
		ev.Kind = "event"
	}
	day := at(start, 0)
	cutoff := at(day, hm(r.SleepCutoff))
	ready := start.Add(-time.Duration(r.EventPrepMin) * time.Minute)
	res := OverrideResult{Event: ev, CutoffHHM: r.SleepCutoff}
	st.Events = append(st.Events, ev)
	if dropAfter && cutoff.After(start) {
		st.Events = append(st.Events, Event{ID: newID(), Title: "No study after " + ev.Title,
			Kind: "blackout", Start: start.Format(localLayout), End: cutoff.Format(localLayout)})
	}

	// Which Tier 1 tasks must be cleared before the event?
	horizon := at(day, 2*24*60) // due by the end of tomorrow
	need := map[string]int{}
	order := []*Task{}
	for i := range st.Tasks {
		t := &st.Tasks[i]
		if t.Status != "open" || t.DueAt == "" {
			continue
		}
		due, err := parseLocal(t.DueAt, loc)
		if err != nil || !due.Before(horizon) {
			continue
		}
		deadline := ready
		if preclearBefore != nil && preclearCourse != "" &&
			strings.Contains(strings.ToLower(t.Course+" "+t.Title), strings.ToLower(preclearCourse)) {
			if preclearBefore.Before(deadline) {
				deadline = *preclearBefore
			}
		}
		t.PreclearBy = deadline.Format(localLayout)
		res.Preclear = append(res.Preclear, t.Title)
		order = append(order, t)
	}
	sort.SliceStable(order, func(i, j int) bool { return order[i].PreclearBy < order[j].PreclearBy })

	// Lift unlocked blocks: the pre-clear tasks' blocks (any day), everything on the event day
	// from the get-ready time on, and today's competitive blocks before it (Tier 1 goes first;
	// those are put back below if time remains).
	keep := st.Blocks[:0:0]
	var lifted []Block
	for _, b := range st.Blocks {
		bs, err := parseLocal(b.Start, loc)
		today := err == nil && b.Date == day.Format(dateLayout) && !bs.Before(now)
		if b.Status != "planned" || b.Locked {
			keep = append(keep, b)
			continue
		}
		switch {
		case b.Kind == "task" && isIn(order, b.TaskID):
			res.Dropped = append(res.Dropped, b)
		case today && !bs.Before(ready):
			res.Dropped = append(res.Dropped, b)
		case today && b.Kind == "bucket":
			lifted = append(lifted, b)
		default:
			keep = append(keep, b)
		}
	}
	st.Blocks = keep

	// Remaining minutes per pre-clear task (minus time already planned before the deadline).
	for _, t := range order {
		est := t.EstMinutes
		if t.HumanMinutes != nil {
			est = *t.HumanMinutes
		}
		need[t.ID] = max(0, est-int(t.LoggedMinutes))
	}
	for _, t := range order {
		deadline, _ := parseLocal(t.PreclearBy, loc)
		left := 0
		chunks := blocksFor(need[t.ID], r.BlockMin, r.MinBlockMin)
		for len(chunks) > 0 {
			c := chunks[0]
			chunks = chunks[1:]
			placed := false
			for _, g := range FreeGaps(r, day, st.Events, st.Blocks, now) {
				e := g.e
				if deadline.Before(e) {
					e = deadline
				}
				avail := int(e.Sub(g.s).Minutes())
				dur := min(c, avail)
				if dur < c && c-dur < r.MinBlockMin { // never leave a sliver
					dur = c - r.MinBlockMin
				}
				if dur < min(c, r.MinBlockMin) {
					continue
				}
				b := Block{ID: newID(), Date: day.Format(dateLayout), Start: g.s.Format(localLayout),
					End: g.s.Add(time.Duration(dur) * time.Minute).Format(localLayout), Kind: "task",
					TaskID: t.ID, Bucket: school, Title: t.Course + ": " + t.Title, Load: t.CognitiveLoad,
					Status: "planned"}
				st.Blocks = append(st.Blocks, b)
				res.Placed = append(res.Placed, b)
				if dur < c {
					chunks = append([]int{c - dur}, chunks...)
				}
				placed = true
				break
			}
			if !placed {
				left += c
			}
		}
		if left >= 5 {
			res.AtRisk = append(res.AtRisk, AtRisk{TaskID: t.ID, Title: t.Title, Minutes: left,
				Reason: "does not fit before " + deadline.Format("3:04 PM") + "; the planner will move it to the next free slot before its due time (sleep is protected)"})
		}
	}
	// Put lifted competitive blocks back into free time before the event, if any is left.
	for _, b := range lifted {
		dur := minutesOf(b, loc)
		placed := false
		for _, g := range FreeGaps(r, day, st.Events, st.Blocks, now) {
			e := g.e
			if ready.Before(e) {
				e = ready
			}
			if int(e.Sub(g.s).Minutes()) >= dur {
				b.Start = g.s.Format(localLayout)
				b.End = g.s.Add(time.Duration(dur) * time.Minute).Format(localLayout)
				st.Blocks = append(st.Blocks, b)
				placed = true
				break
			}
		}
		if !placed {
			res.Dropped = append(res.Dropped, b)
		}
	}
	sort.SliceStable(st.Blocks, func(i, j int) bool { return st.Blocks[i].Start < st.Blocks[j].Start })
	st.Meta.AtRisk = res.AtRisk
	st.Meta.NeedsReplan = true
	return res, nil
}

func isIn(ts []*Task, id string) bool {
	for _, t := range ts {
		if t.ID == id {
			return true
		}
	}
	return false
}

// ReplanServer deterministically regenerates future unlocked planned blocks across a 7-day horizon
// using FreeGaps, preserving done/locked blocks, protected buffers, and rest_days.
func ReplanServer(st *State, now time.Time, newID func() string, loc *time.Location) {
	st.normalizeWeek(now)
	kept := make([]Block, 0, len(st.Blocks))
	lockedTaskMin := map[string]int{}
	lockedBucketMin := map[string]int{}
	for _, b := range st.Blocks {
		s, err := parseLocal(b.Start, loc)
		keep := b.Status == "done" || b.Locked || (err == nil && s.Before(now))
		if keep {
			kept = append(kept, b)
			if b.Status == "planned" && b.Locked {
				m := minutesOf(b, loc)
				if b.TaskID != "" {
					lockedTaskMin[b.TaskID] += m
				} else {
					lockedBucketMin[b.Bucket] += m
				}
			}
		}
	}
	st.Blocks = kept
	blockMin := max(20, st.Rules.BlockMin)
	minBlock := max(15, st.Rules.MinBlockMin)
	brk := max(0, st.Rules.BreakMin)

	daySlots := make([][]span, 7)
	days := make([]time.Time, 7)
	for i := 0; i < 7; i++ {
		d := now.AddDate(0, 0, i)
		days[i] = d
		daySlots[i] = FreeGaps(st.Rules, d, st.Events, st.Blocks, now)
	}

	takeSlot := func(maxDay int, dur int) (span, bool) {
		for i := 0; i <= maxDay && i < 7; i++ {
			for j := range daySlots[i] {
				g := daySlots[i][j]
				avail := int(g.e.Sub(g.s).Minutes())
				if avail < min(dur, minBlock) {
					continue
				}
				use := min(dur, avail)
				s := g.s
				e := s.Add(time.Duration(use) * time.Minute)
				daySlots[i][j].s = e.Add(time.Duration(brk) * time.Minute)
				if int(daySlots[i][j].e.Sub(daySlots[i][j].s).Minutes()) < minBlock {
					daySlots[i] = append(daySlots[i][:j], daySlots[i][j+1:]...)
				}
				return span{s, e}, true
			}
		}
		return span{}, false
	}

	// 1. Place open Tier 1 tasks sorted by due date.
	open := []*Task{}
	for i := range st.Tasks {
		if st.Tasks[i].Status == "open" {
			open = append(open, &st.Tasks[i])
		}
	}
	sort.Slice(open, func(i, j int) bool {
		di, dj := open[i].DueAt, open[j].DueAt
		if di == "" {
			di = "9999"
		}
		if dj == "" {
			dj = "9999"
		}
		return di < dj
	})

	atRisk := []AtRisk{}
	for _, t := range open {
		est := t.EstMinutes
		if t.HumanMinutes != nil {
			est = *t.HumanMinutes
		}
		need := est - int(t.LoggedMinutes) - lockedTaskMin[t.ID]
		if need < 5 {
			continue
		}
		maxDay := 6
		if t.DueAt != "" {
			if due, err := parseLocal(t.DueAt, loc); err == nil {
				diff := int(due.Sub(at(now, 0)).Hours() / 24)
				if diff >= 0 && diff < maxDay {
					maxDay = diff
				}
			}
		}
		rem := need
		for rem > 0 {
			chunk := min(rem, blockMin)
			sp, ok := takeSlot(maxDay, chunk)
			if !ok {
				atRisk = append(atRisk, AtRisk{TaskID: t.ID, Title: t.Title, Minutes: rem, Reason: "not enough free time before deadline"})
				break
			}
			got := int(sp.e.Sub(sp.s).Minutes())
			st.Blocks = append(st.Blocks, Block{
				ID: newID(), Date: sp.s.Format(dateLayout), Start: sp.s.Format(localLayout), End: sp.e.Format(localLayout),
				Kind: "task", TaskID: t.ID, Bucket: school, Title: t.Title, Load: max(1, t.CognitiveLoad), Status: "planned",
			})
			rem -= got
		}
	}

	// 2. Place remaining weekly Tier 2 bucket hours.
	for _, b := range st.Buckets {
		if b.Key == school || b.TargetHours <= 0 {
			continue
		}
		rem := int(b.TargetHours*60) - int(b.LoggedMinutes) - lockedBucketMin[b.Key]
		for rem >= minBlock {
			chunk := min(rem, blockMin)
			sp, ok := takeSlot(6, chunk)
			if !ok {
				break
			}
			got := int(sp.e.Sub(sp.s).Minutes())
			st.Blocks = append(st.Blocks, Block{
				ID: newID(), Date: sp.s.Format(dateLayout), Start: sp.s.Format(localLayout), End: sp.e.Format(localLayout),
				Kind: "bucket", Bucket: b.Key, Title: b.Name, Load: max(1, b.Load), Status: "planned",
			})
			rem -= got
		}
	}
	sort.Slice(st.Blocks, func(i, j int) bool { return st.Blocks[i].Start < st.Blocks[j].Start })
	st.Meta.AtRisk = atRisk
	st.Meta.NeedsReplan = false
}
