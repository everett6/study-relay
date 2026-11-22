package main

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"
)

// Extended MCP tools: recurring schedules, batch mutations + instant replan,
// Canvas ROI triage, competition problem-set tracking, and 1-call block swap.

var mcpToolsV2 = []tool{
	{
		Name:        "set_recurring_schedule",
		Description: "Define recurring weekly environment windows (quiet_home_alone, family_dinner, recurring_class) and rest_days, then replan.",
		InputSchema: obj(map[string]any{
			"kind":       map[string]any{"type": "string", "enum": []string{"quiet_home_alone", "family_dinner", "recurring_class", "rest_days"}},
			"days":       map[string]any{"type": "array", "items": map[string]any{"type": "number"}, "description": "ISO weekdays 1=Mon .. 7=Sun"},
			"start":      str("HH:MM"),
			"end":        str("HH:MM"),
			"title":      str("label for recurring_class, e.g. AP Physics 1"),
			"replan_now": map[string]any{"type": "boolean", "description": "replan immediately (default true)"},
		}, "kind"),
	},
	{
		Name:        "batch_update_schedule",
		Description: "Apply multiple schedule/task mutations (complete, add, move, cancel, swap) in a single MCP round-trip, replan, and return today's updated blocks.",
		InputSchema: obj(map[string]any{
			"actions": map[string]any{
				"type": "array",
				"items": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"op":                map[string]any{"type": "string", "enum": []string{"complete", "add", "move", "cancel", "swap"}},
						"task_id":           str("for complete"),
						"match":             str("substring match for complete/move/cancel/swap"),
						"block_id":          str("for move/cancel/swap"),
						"title":             str("for add/swap"),
						"course":            str("for add"),
						"bucket":            str("for swap"),
						"category":          str("homework|quiz|test|lab|project"),
						"due_at":            str("YYYY-MM-DDTHH:MM"),
						"date":              str("YYYY-MM-DD"),
						"start":             str("HH:MM"),
						"end":               str("HH:MM"),
						"estimated_minutes": num("minutes"),
						"cognitive_load":    num("1-5"),
					},
				},
			},
			"replan": map[string]any{"type": "boolean", "description": "run server replan after batch (default true)"},
		}, "actions"),
	},
	{
		Name:        "replan_now",
		Description: "Immediately recompute the 7-day block schedule on the server and return today's blocks and at_risk tasks.",
		InputSchema: obj(map[string]any{"date": str("optional YYYY-MM-DD; defaults to today")}),
	},
	{
		Name:        "triage_canvas_opportunities",
		Description: "Rank missing/zero and extra-credit Canvas work by points-per-minute ROI and optionally auto-slot the top items into open buffers.",
		InputSchema: obj(map[string]any{
			"auto_slot": map[string]any{"type": "boolean", "description": "schedule top ROI items into today's free slots"},
			"max_items": num("max items to return/slot (default 5)"),
		}),
	},
	{
		Name:        "log_problem_set",
		Description: "Log competition/problem-set accuracy (topic, attempted, solved, error_type) and auto-create a targeted review task if accuracy < 75%.",
		InputSchema: obj(map[string]any{
			"bucket":     str("AIME | USAAIO | PHYSICS | ACT | RESEARCH"),
			"topic":      str("e.g. Combinatorics, Rotational Dynamics, Self-Attention"),
			"attempted":  num("number of problems attempted"),
			"solved":     num("number of problems solved"),
			"error_type": map[string]any{"type": "string", "enum": []string{"concept", "algebra", "time"}},
			"minutes":    num("optional minutes spent to log to the bucket"),
		}, "bucket", "topic", "attempted", "solved"),
	},
	{
		Name:        "get_next_problems",
		Description: "Return topic mastery stats from logged problem sets and recommend the weakest topic / next worksheet to open.",
		InputSchema: obj(map[string]any{"bucket": str("optional bucket filter")}),
	},
	{
		Name:        "swap_block_focus",
		Description: "Immediately reassign an existing planned block to a different task or bucket in one call without waiting for a full replan.",
		InputSchema: obj(map[string]any{
			"block_id":  str("existing block id"),
			"match":     str("substring of current block title or bucket"),
			"new_title": str("new title for the block"),
			"bucket":    str("optional new bucket key (AIME, USAAIO, RESEARCH, ACT, PHYSICS, SCHOOL)"),
			"task_id":   str("optional task id to link"),
		}, "new_title"),
	},
	{
		Name:        "get_daily_briefing",
		Description: "One-shot daily context loader for Gemini: returns today's blocks, free gaps, timer, buckets, grades summary, top Canvas ROI opportunities, weak competition topics, and unread inbox count.",
		InputSchema: obj(map[string]any{"date": str("optional YYYY-MM-DD; defaults to today")}),
	},
	{
		Name:        "find_free_slots",
		Description: "Find open study time slots across one or more days respecting school, breaks, dinner, sleep, events, and existing blocks.",
		InputSchema: obj(map[string]any{
			"date":        str("start YYYY-MM-DD (default today)"),
			"days":        num("number of days to scan (1-7, default 3)"),
			"min_minutes": num("minimum slot length in minutes (default 20)"),
		}),
	},
	{
		Name:        "reschedule_missed_blocks",
		Description: "Clear any planned blocks whose end time has already passed without completion and immediately replan remaining work into later free slots.",
		InputSchema: obj(map[string]any{"date": str("optional YYYY-MM-DD; defaults to today")}),
	},
	{
		Name:        "search_tasks",
		Description: "Search and filter tasks by keyword, course, status (open|done|all), or due window without dumping the whole matrix.",
		InputSchema: obj(map[string]any{
			"query":           str("substring match on title or description"),
			"course":          str("course filter"),
			"status":          map[string]any{"type": "string", "enum": []string{"open", "done", "all"}},
			"due_within_days": num("only tasks due within N days"),
		}),
	},
	{
		Name:        "delete_task_or_event",
		Description: "Remove a duplicate/cancelled task or calendar event and its planned blocks, optionally replanning immediately.",
		InputSchema: obj(map[string]any{
			"task_id":  str("task id to remove"),
			"event_id": str("event id to remove"),
			"replan":   map[string]any{"type": "boolean", "description": "replan immediately (default true)"},
		}),
	},
	{
		Name:        "get_assignment_details",
		Description: "Read full hidden assignment directions, teacher/submission comments, and estimation rationale for a task by task_id or title/course substring.",
		InputSchema: obj(map[string]any{
			"task_id": str("task id"),
			"match":   str("substring match on task title or course"),
		}),
	},
}

func matchPlannedBlock(b *Block, blockID, match string) bool {
	if blockID != "" && b.ID == blockID {
		return true
	}
	return match != "" && b.Status == "planned" && strings.Contains(strings.ToLower(b.Title+" "+b.Bucket), strings.ToLower(match))
}

func (s *Server) todaySnapshot(st *State, date string) map[string]any {
	ds := date
	if ds == "" {
		ds = s.now().Format(dateLayout)
	}
	blks := []Block{}
	for _, b := range st.Blocks {
		if b.Date == ds {
			blks = append(blks, b)
		}
	}
	return map[string]any{"date": ds, "today_blocks": blks, "at_risk": st.Meta.AtRisk}
}

func (s *Server) callToolV2(name string, raw json.RawMessage) (map[string]any, bool, error) {
	switch name {
	case "set_recurring_schedule":
		var a struct {
			Kind      string `json:"kind"`
			Days      []int  `json:"days"`
			Start     string `json:"start"`
			End       string `json:"end"`
			Title     string `json:"title"`
			ReplanNow *bool  `json:"replan_now"`
		}
		if err := json.Unmarshal(raw, &a); err != nil {
			return nil, true, err
		}
		res, err := s.toolSetRecurring(a.Kind, a.Days, a.Start, a.End, a.Title, a.ReplanNow == nil || *a.ReplanNow)
		return res, true, err
	case "batch_update_schedule":
		var a struct {
			Actions []json.RawMessage `json:"actions"`
			Replan  *bool             `json:"replan"`
		}
		if err := json.Unmarshal(raw, &a); err != nil {
			return nil, true, err
		}
		res, err := s.toolBatchUpdate(a.Actions, a.Replan == nil || *a.Replan)
		return res, true, err
	case "replan_now":
		var a struct {
			Date string `json:"date"`
		}
		_ = json.Unmarshal(raw, &a)
		res, err := s.toolReplanNow(a.Date)
		return res, true, err
	case "triage_canvas_opportunities":
		var a struct {
			AutoSlot bool `json:"auto_slot"`
			MaxItems int  `json:"max_items"`
		}
		_ = json.Unmarshal(raw, &a)
		res, err := s.toolTriageCanvas(a.AutoSlot, a.MaxItems)
		return res, true, err
	case "log_problem_set":
		var a struct {
			Bucket    string  `json:"bucket"`
			Topic     string  `json:"topic"`
			Attempted int     `json:"attempted"`
			Solved    int     `json:"solved"`
			ErrorType string  `json:"error_type"`
			Minutes   float64 `json:"minutes"`
		}
		if err := json.Unmarshal(raw, &a); err != nil {
			return nil, true, err
		}
		res, err := s.toolLogProblemSet(a.Bucket, a.Topic, a.Attempted, a.Solved, a.ErrorType, a.Minutes)
		return res, true, err
	case "get_next_problems":
		var a struct {
			Bucket string `json:"bucket"`
		}
		_ = json.Unmarshal(raw, &a)
		res, err := s.toolGetNextProblems(a.Bucket)
		return res, true, err
	case "swap_block_focus":
		var a struct {
			BlockID  string `json:"block_id"`
			Match    string `json:"match"`
			NewTitle string `json:"new_title"`
			Bucket   string `json:"bucket"`
			TaskID   string `json:"task_id"`
		}
		if err := json.Unmarshal(raw, &a); err != nil {
			return nil, true, err
		}
		res, err := s.toolSwapBlockFocus(a.BlockID, a.Match, a.NewTitle, a.Bucket, a.TaskID)
		return res, true, err
	case "get_daily_briefing":
		var a struct {
			Date string `json:"date"`
		}
		_ = json.Unmarshal(raw, &a)
		res, err := s.toolDailyBriefing(a.Date)
		return res, true, err
	case "find_free_slots":
		var a struct {
			Date       string `json:"date"`
			Days       int    `json:"days"`
			MinMinutes int    `json:"min_minutes"`
		}
		_ = json.Unmarshal(raw, &a)
		res, err := s.toolFindFreeSlots(a.Date, a.Days, a.MinMinutes)
		return res, true, err
	case "reschedule_missed_blocks":
		var a struct {
			Date string `json:"date"`
		}
		_ = json.Unmarshal(raw, &a)
		res, err := s.toolRescheduleMissed(a.Date)
		return res, true, err
	case "search_tasks":
		var a struct {
			Query         string `json:"query"`
			Course        string `json:"course"`
			Status        string `json:"status"`
			DueWithinDays int    `json:"due_within_days"`
		}
		_ = json.Unmarshal(raw, &a)
		res, err := s.toolSearchTasks(a.Query, a.Course, a.Status, a.DueWithinDays)
		return res, true, err
	case "delete_task_or_event":
		var a struct {
			TaskID  string `json:"task_id"`
			EventID string `json:"event_id"`
			Replan  *bool  `json:"replan"`
		}
		if err := json.Unmarshal(raw, &a); err != nil {
			return nil, true, err
		}
		res, err := s.toolDeleteTaskOrEvent(a.TaskID, a.EventID, a.Replan == nil || *a.Replan)
		return res, true, err
	case "get_assignment_details":
		var a struct {
			TaskID string `json:"task_id"`
			Match  string `json:"match"`
		}
		_ = json.Unmarshal(raw, &a)
		res, err := s.toolGetAssignmentDetails(a.TaskID, a.Match)
		return res, true, err
	}
	return nil, false, nil
}

func (s *Server) toolSetRecurring(kind string, days []int, start, end, title string, replan bool) (map[string]any, error) {
	now := s.now()
	var snap map[string]any
	_, st, err := s.store.Update(func(st *State) error {
		switch kind {
		case "quiet_home_alone":
			if start == "" || end == "" {
				return fmt.Errorf("start and end (HH:MM) required")
			}
			win := start + "-" + end
			if len(days) == 0 {
				st.Rules.QuietWeekday = []string{win}
			} else {
				if st.Rules.QuietByDay == nil {
					st.Rules.QuietByDay = map[string][]string{}
				}
				for _, d := range days {
					st.Rules.QuietByDay[fmt.Sprint(d)] = []string{win}
				}
			}
		case "family_dinner":
			if start != "" {
				st.Rules.DinnerStart = start
			}
			if start != "" && end != "" {
				if sT, e1 := time.Parse("15:04", start); e1 == nil {
					if eT, e2 := time.Parse("15:04", end); e2 == nil && eT.After(sT) {
						st.Rules.DinnerMin = int(eT.Sub(sT).Minutes())
					}
				}
			}
		case "rest_days":
			st.Rules.RestDays = days
		case "recurring_class":
			if start == "" || end == "" || len(days) == 0 {
				return fmt.Errorf("days, start, and end required for recurring_class")
			}
			if title == "" {
				title = "Class"
			}
			daySet := map[int]bool{}
			for _, d := range days {
				daySet[d] = true
			}
			for i := 0; i < 28; i++ {
				d := now.AddDate(0, 0, i)
				wd := int(d.Weekday())
				if wd == 0 {
					wd = 7
				}
				if !daySet[wd] {
					continue
				}
				ds := d.Format(dateLayout)
				st.Events = append(st.Events, Event{
					ID: "rec-" + s.newID(), Title: title, Kind: "blackout",
					Start: ds + "T" + start, End: ds + "T" + end,
				})
			}
		default:
			return fmt.Errorf("unknown kind %q", kind)
		}
		if replan {
			ReplanServer(st, now, s.newID, s.loc)
		} else {
			st.Meta.NeedsReplan = true
		}
		snap = s.todaySnapshot(st, "")
		return nil
	})
	if err != nil {
		return nil, err
	}
	snap["rules"] = st.Rules
	return snap, nil
}

func (s *Server) toolBatchUpdate(actions []json.RawMessage, replan bool) (map[string]any, error) {
	now := s.now()
	applied := []string{}
	var snap map[string]any
	_, _, err := s.store.Update(func(st *State) error {
		for _, raw := range actions {
			var op struct {
				Op      string   `json:"op"`
				TaskID  string   `json:"task_id"`
				Match   string   `json:"match"`
				BlockID string   `json:"block_id"`
				Title   string   `json:"title"`
				Course  string   `json:"course"`
				Bucket  string   `json:"bucket"`
				Cat     string   `json:"category"`
				DueAt   string   `json:"due_at"`
				Date    string   `json:"date"`
				Start   string   `json:"start"`
				End     string   `json:"end"`
				EstMin  *float64 `json:"estimated_minutes"`
				Load    *float64 `json:"cognitive_load"`
			}
			if err := json.Unmarshal(raw, &op); err != nil {
				return err
			}
			switch op.Op {
			case "complete":
				q := strings.ToLower(op.Match)
				for i := range st.Tasks {
					t := &st.Tasks[i]
					if (op.TaskID != "" && t.ID == op.TaskID) || (q != "" && t.Status == "open" && strings.Contains(strings.ToLower(t.Title+" "+t.Course), q)) {
						t.Status = "done"
						for j := range st.Blocks {
							if st.Blocks[j].TaskID == t.ID && st.Blocks[j].Status == "planned" {
								st.Blocks[j].Status = "done"
							}
						}
						applied = append(applied, "complete:"+t.Title)
						break
					}
				}
			case "add":
				if op.Title == "" {
					continue
				}
				est := 45
				if op.EstMin != nil && *op.EstMin >= 5 {
					est = int(*op.EstMin + 0.5)
				}
				load := 3
				if op.Load != nil && *op.Load >= 1 && *op.Load <= 5 {
					load = int(*op.Load + 0.5)
				}
				cat := op.Cat
				if cat == "" {
					cat = "homework"
				}
				t := Task{
					ID: "mcp-" + s.newID(), Source: "mcp", Course: op.Course, Title: op.Title,
					Category: cat, TaskType: typeOf[cat], DueAt: op.DueAt, CognitiveLoad: load,
					LLMMinutes: est, EstMinutes: est, Confidence: 0.85,
					Blocks: blocksFor(est, st.Rules.BlockMin, st.Rules.MinBlockMin), EstSource: "human", Status: "open",
				}
				st.Tasks = append(st.Tasks, t)
				applied = append(applied, "add:"+t.Title)
			case "cancel":
				for i := range st.Blocks {
					b := &st.Blocks[i]
					if matchPlannedBlock(b, op.BlockID, op.Match) {
						applied = append(applied, "cancel:"+b.Title)
						st.Blocks = append(st.Blocks[:i], st.Blocks[i+1:]...)
						break
					}
				}
			case "move":
				for i := range st.Blocks {
					b := &st.Blocks[i]
					if matchPlannedBlock(b, op.BlockID, op.Match) {
						if op.Date != "" && op.Start != "" {
							dur := 45 * time.Minute
							if sT, e1 := time.ParseInLocation(localLayout, b.Start, s.loc); e1 == nil {
								if eT, e2 := time.ParseInLocation(localLayout, b.End, s.loc); e2 == nil && eT.After(sT) {
									dur = eT.Sub(sT)
								}
							}
							if ns, e1 := time.ParseInLocation(localLayout, op.Date+"T"+op.Start, s.loc); e1 == nil {
								ne := ns.Add(dur)
								if op.End != "" {
									if pe, e2 := time.ParseInLocation(localLayout, op.Date+"T"+op.End, s.loc); e2 == nil && pe.After(ns) {
										ne = pe
									}
								}
								b.Date, b.Start, b.End, b.Locked = op.Date, ns.Format(localLayout), ne.Format(localLayout), true
								applied = append(applied, "move:"+b.Title)
							}
						}
						break
					}
				}
			case "swap":
				for i := range st.Blocks {
					b := &st.Blocks[i]
					if matchPlannedBlock(b, op.BlockID, op.Match) {
						if op.Title != "" {
							b.Title = op.Title
						}
						if op.Bucket != "" {
							b.Bucket = strings.ToUpper(op.Bucket)
						}
						b.Locked = true
						applied = append(applied, "swap:"+b.Title)
						break
					}
				}
			}
		}
		if replan {
			ReplanServer(st, now, s.newID, s.loc)
		} else {
			st.Meta.NeedsReplan = true
		}
		snap = s.todaySnapshot(st, "")
		return nil
	})
	if err != nil {
		return nil, err
	}
	snap["applied"] = applied
	return snap, nil
}

func (s *Server) toolReplanNow(date string) (map[string]any, error) {
	now := s.now()
	var snap map[string]any
	_, _, err := s.store.Update(func(st *State) error {
		ReplanServer(st, now, s.newID, s.loc)
		snap = s.todaySnapshot(st, date)
		return nil
	})
	return snap, err
}

func (s *Server) toolTriageCanvas(autoSlot bool, maxItems int) (map[string]any, error) {
	if maxItems <= 0 {
		maxItems = 5
	}
	now := s.now()
	type opp struct {
		ID     string  `json:"id"`
		Course string  `json:"course"`
		Title  string  `json:"title"`
		Kind   string  `json:"kind"` // zero | makeup | extra_credit | high_points
		Points float64 `json:"points"`
		EstMin int     `json:"estimated_minutes"`
		ROIPts float64 `json:"points_per_min"`
		DueAt  string  `json:"due_at,omitempty"`
	}
	out := []opp{}
	var snap map[string]any
	_, _, err := s.store.Update(func(st *State) error {
		for _, t := range st.Tasks {
			if t.Status != "open" {
				continue
			}
			pts := 10.0
			if t.Points != nil && *t.Points > 0 {
				pts = *t.Points
			}
			est := t.EstMinutes
			if t.HumanMinutes != nil {
				est = *t.HumanMinutes
			}
			if est < 5 {
				est = 30
			}
			low := strings.ToLower(t.Title)
			kind := ""
			if t.Source == "makeup" {
				kind = "zero_makeup"
			} else if strings.Contains(low, "extra credit") || strings.Contains(low, " ec") {
				kind = "extra_credit"
			} else if t.Points != nil && *t.Points >= 30 {
				kind = "high_points"
			}
			if kind != "" {
				out = append(out, opp{
					ID: t.ID, Course: t.Course, Title: t.Title, Kind: kind,
					Points: pts, EstMin: est, ROIPts: round2(pts / float64(est)), DueAt: t.DueAt,
				})
			}
		}
		sort.Slice(out, func(i, j int) bool { return out[i].ROIPts > out[j].ROIPts })
		if len(out) > maxItems {
			out = out[:maxItems]
		}
		if autoSlot && len(out) > 0 {
			pre := now.Add(4 * time.Hour).Format(localLayout)
			for i := range st.Tasks {
				for _, o := range out {
					if st.Tasks[i].ID == o.ID && st.Tasks[i].PreclearBy == "" {
						st.Tasks[i].PreclearBy = pre
					}
				}
			}
			ReplanServer(st, now, s.newID, s.loc)
		}
		snap = s.todaySnapshot(st, "")
		return nil
	})
	if err != nil {
		return nil, err
	}
	snap["opportunities"] = out
	return snap, nil
}

func (s *Server) toolLogProblemSet(bucket, topic string, attempted, solved int, errType string, minutes float64) (map[string]any, error) {
	if attempted <= 0 || solved < 0 || solved > attempted {
		return nil, fmt.Errorf("attempted must be > 0 and 0 <= solved <= attempted")
	}
	now := s.now()
	acc := round2(float64(solved) / float64(attempted) * 100)
	var reviewTask *Task
	_, _, err := s.store.Update(func(st *State) error {
		bKey := strings.ToUpper(strings.TrimSpace(bucket))
		st.Problems = append(st.Problems, ProblemLog{
			ID: "prob-" + s.newID(), Bucket: bKey, Topic: topic, Attempted: attempted,
			Solved: solved, ErrorType: errType, At: now.Format(localLayout),
		})
		if len(st.Problems) > 200 {
			st.Problems = st.Problems[len(st.Problems)-200:]
		}
		if minutes > 0 {
			st.bucket(bKey).LoggedMinutes += minutes
		}
		if acc < 75 {
			t := Task{
				ID: "rev-" + s.newID(), Source: "mcp", Course: bKey,
				Title:    fmt.Sprintf("Review weak topic: %s (%d/%d, %s)", topic, solved, attempted, errType),
				Category: "quiz", TaskType: "Quiz", DueAt: now.AddDate(0, 0, 2).Format(dateLayout) + "T21:00",
				CognitiveLoad: 4, LLMMinutes: 30, EstMinutes: 30, Confidence: 0.9,
				Blocks: []int{30}, EstSource: "mcp", Status: "open",
			}
			st.Tasks = append(st.Tasks, t)
			reviewTask = &t
			ReplanServer(st, now, s.newID, s.loc)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"accuracy_pct": acc, "review_scheduled": reviewTask}, nil
}

func (s *Server) toolGetNextProblems(bucket string) (map[string]any, error) {
	_, st, err := s.store.Get()
	if err != nil {
		return nil, err
	}
	type stat struct {
		Bucket    string  `json:"bucket"`
		Topic     string  `json:"topic"`
		Attempted int     `json:"attempted"`
		Solved    int     `json:"solved"`
		Accuracy  float64 `json:"accuracy_pct"`
	}
	agg := map[string]*stat{}
	for _, p := range st.Problems {
		if bucket != "" && !strings.EqualFold(p.Bucket, bucket) {
			continue
		}
		k := p.Bucket + "|" + strings.ToLower(p.Topic)
		cur := agg[k]
		if cur == nil {
			cur = &stat{Bucket: p.Bucket, Topic: p.Topic}
			agg[k] = cur
		}
		cur.Attempted += p.Attempted
		cur.Solved += p.Solved
	}
	list := make([]stat, 0, len(agg))
	for _, v := range agg {
		if v.Attempted > 0 {
			v.Accuracy = round2(float64(v.Solved) / float64(v.Attempted) * 100)
		}
		list = append(list, *v)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Accuracy < list[j].Accuracy })
	rec := "All logged topics are >=75% mastery; pick a timed mock set."
	if len(list) > 0 && list[0].Accuracy < 80 {
		rec = fmt.Sprintf("Focus next on %s: %s (currently %.0f%% accuracy)", list[0].Bucket, list[0].Topic, list[0].Accuracy)
	}
	return map[string]any{"topics": list, "recommendation": rec}, nil
}

func (s *Server) toolSwapBlockFocus(blockID, match, newTitle, bucket, taskID string) (map[string]any, error) {
	var swapped *Block
	var snap map[string]any
	_, _, err := s.store.Update(func(st *State) error {
		for i := range st.Blocks {
			b := &st.Blocks[i]
			if matchPlannedBlock(b, blockID, match) {
				b.Title = newTitle
				if bucket != "" {
					b.Bucket = strings.ToUpper(bucket)
				}
				if taskID != "" {
					b.TaskID = taskID
					b.Kind = "task"
				}
				b.Locked = true
				cp := *b
				swapped = &cp
				break
			}
		}
		if swapped == nil {
			return fmt.Errorf("matching planned block not found")
		}
		snap = s.todaySnapshot(st, swapped.Date)
		return nil
	})
	if err != nil {
		return nil, err
	}
	snap["block"] = swapped
	return snap, nil
}

func (s *Server) toolDailyBriefing(date string) (map[string]any, error) {
	now := s.now()
	ds := date
	if ds == "" {
		ds = now.Format(dateLayout)
	}
	_, st, err := s.store.Get()
	if err != nil {
		return nil, err
	}
	snap := s.todaySnapshot(st, ds)
	slots, err := s.toolFindFreeSlots(ds, 1, 15)
	if err != nil {
		return nil, err
	}
	triage, err := s.toolTriageCanvas(false, 5)
	if err != nil {
		return nil, err
	}
	probs, err := s.toolGetNextProblems("")
	if err != nil {
		return nil, err
	}
	unread := 0
	for _, it := range st.Inbox {
		if it.Status == "new" {
			unread++
		}
	}
	openCount := 0
	for _, t := range st.Tasks {
		if t.Status == "open" {
			openCount++
		}
	}
	gradesSummary := make([]map[string]any, 0, len(st.Grades))
	for _, g := range st.Grades {
		gradesSummary = append(gradesSummary, map[string]any{
			"course": g.Course, "score": g.Score, "grade": g.Grade,
		})
	}
	targetDay, _ := time.ParseInLocation(dateLayout, ds, s.loc)
	holiday := schoolHolidayName(targetDay)
	return map[string]any{
		"date":                  ds,
		"holiday":               holiday,
		"school_day":            isSchoolDay(st.Rules, targetDay),
		"now":                   now.Format(localLayout),
		"today_blocks":          snap["today_blocks"],
		"free_slots":            slots["slots"],
		"timer":                 st.Timer,
		"buckets":               st.Buckets,
		"open_task_count":       openCount,
		"at_risk":               st.Meta.AtRisk,
		"grades":                gradesSummary,
		"flags":                 st.Flags,
		"top_opportunities":     triage["opportunities"],
		"weak_topics":           probs["topics"],
		"problem_next_step":     probs["recommendation"],
		"unread_inbox_count":    unread,
		"active_quiet_by_day":   st.Rules.QuietByDay,
		"quiet_weekday_windows": st.Rules.QuietWeekday,
		"quiet_weekend_windows": st.Rules.QuietWeekend,
	}, nil
}

func (s *Server) toolFindFreeSlots(date string, days, minMinutes int) (map[string]any, error) {
	now := s.now()
	startDay := now
	if date != "" {
		if d, err := time.ParseInLocation(dateLayout, date, s.loc); err == nil {
			startDay = d
		}
	}
	if days <= 0 {
		days = 3
	}
	if days > 7 {
		days = 7
	}
	if minMinutes <= 0 {
		minMinutes = 20
	}
	_, st, err := s.store.Get()
	if err != nil {
		return nil, err
	}
	type slot struct {
		Date    string `json:"date"`
		Weekday string `json:"weekday"`
		Start   string `json:"start"`
		End     string `json:"end"`
		Minutes int    `json:"minutes"`
		Quiet   bool   `json:"quiet"`
	}
	out := []slot{}
	for d := 0; d < days; d++ {
		day := startDay.AddDate(0, 0, d)
		gaps := FreeGaps(st.Rules, day, st.Events, st.Blocks, now)
		for _, g := range gaps {
			mins := int(g.e.Sub(g.s).Minutes())
			if mins < minMinutes {
				continue
			}
			out = append(out, slot{
				Date:    day.Format(dateLayout),
				Weekday: day.Weekday().String()[:3],
				Start:   g.s.Format("15:04"),
				End:     g.e.Format("15:04"),
				Minutes: mins,
				Quiet:   isQuietAt(st.Rules, g.s),
			})
		}
	}
	return map[string]any{"slots": out, "min_minutes": minMinutes, "days": days}, nil
}

func isQuietAt(r Rules, t time.Time) bool {
	wd := int(t.Weekday())
	if wd == 0 {
		wd = 7
	}
	wins := r.QuietByDay[fmt.Sprintf("%d", wd)]
	if len(wins) == 0 {
		if wd <= 5 {
			wins = r.QuietWeekday
		} else {
			wins = r.QuietWeekend
		}
	}
	cur := t.Hour()*60 + t.Minute()
	for _, w := range wins {
		parts := strings.SplitN(w, "-", 2)
		if len(parts) != 2 {
			continue
		}
		if cur >= hm(parts[0]) && cur < hm(parts[1]) {
			return true
		}
	}
	return false
}

func (s *Server) toolRescheduleMissed(date string) (map[string]any, error) {
	now := s.now()
	ds := date
	if ds == "" {
		ds = now.Format(dateLayout)
	}
	cleared := []string{}
	var snap map[string]any
	_, _, err := s.store.Update(func(st *State) error {
		kept := make([]Block, 0, len(st.Blocks))
		for _, b := range st.Blocks {
			if b.Date == ds && b.Status == "planned" && !b.Locked {
				if eT, eErr := time.ParseInLocation(localLayout, b.End, s.loc); eErr == nil && !eT.After(now) {
					cleared = append(cleared, b.Title)
					continue
				}
			}
			kept = append(kept, b)
		}
		st.Blocks = kept
		ReplanServer(st, now, s.newID, s.loc)
		snap = s.todaySnapshot(st, ds)
		return nil
	})
	if err != nil {
		return nil, err
	}
	snap["cleared_missed"] = cleared
	return snap, nil
}

func (s *Server) toolSearchTasks(query, course, status string, dueWithinDays int) (map[string]any, error) {
	_, st, err := s.store.Get()
	if err != nil {
		return nil, err
	}
	if status == "" {
		status = "open"
	}
	q := strings.ToLower(strings.TrimSpace(query))
	cFilter := strings.ToLower(strings.TrimSpace(course))
	now := s.now()
	var cutoff time.Time
	if dueWithinDays > 0 {
		cutoff = now.AddDate(0, 0, dueWithinDays)
	}
	matches := []Task{}
	for _, t := range st.Tasks {
		if status != "all" && t.Status != status {
			continue
		}
		if cFilter != "" && !strings.Contains(strings.ToLower(t.Course), cFilter) {
			continue
		}
		if q != "" && !strings.Contains(strings.ToLower(t.Title+" "+t.Description+" "+t.Course), q) {
			continue
		}
		if dueWithinDays > 0 {
			if t.DueAt == "" {
				continue
			}
			dt, err := parseLocal(t.DueAt, s.loc)
			if err != nil || dt.After(cutoff) {
				continue
			}
		}
		matches = append(matches, t)
	}
	return map[string]any{"count": len(matches), "tasks": matches}, nil
}

func (s *Server) toolDeleteTaskOrEvent(taskID, eventID string, replan bool) (map[string]any, error) {
	if taskID == "" && eventID == "" {
		return nil, fmt.Errorf("task_id or event_id is required")
	}
	now := s.now()
	removed := []string{}
	var snap map[string]any
	_, _, err := s.store.Update(func(st *State) error {
		if taskID != "" {
			nextTasks := make([]Task, 0, len(st.Tasks))
			for _, t := range st.Tasks {
				if t.ID == taskID {
					removed = append(removed, "task:"+t.Title)
					continue
				}
				nextTasks = append(nextTasks, t)
			}
			st.Tasks = nextTasks
			nextBlocks := make([]Block, 0, len(st.Blocks))
			for _, b := range st.Blocks {
				if b.TaskID == taskID && b.Status == "planned" {
					continue
				}
				nextBlocks = append(nextBlocks, b)
			}
			st.Blocks = nextBlocks
		}
		if eventID != "" {
			nextEvents := make([]Event, 0, len(st.Events))
			for _, e := range st.Events {
				if e.ID == eventID {
					removed = append(removed, "event:"+e.Title)
					continue
				}
				nextEvents = append(nextEvents, e)
			}
			st.Events = nextEvents
		}
		if len(removed) == 0 {
			return fmt.Errorf("matching task_id or event_id not found")
		}
		if replan {
			ReplanServer(st, now, s.newID, s.loc)
		} else {
			st.Meta.NeedsReplan = true
		}
		snap = s.todaySnapshot(st, "")
		return nil
	})
	if err != nil {
		return nil, err
	}
	snap["removed"] = removed
	return snap, nil
}

func (s *Server) toolGetAssignmentDetails(taskID, match string) (map[string]any, error) {
	if taskID == "" && match == "" {
		return nil, fmt.Errorf("task_id or match is required")
	}
	_, st, err := s.store.Get()
	if err != nil {
		return nil, err
	}
	q := strings.ToLower(strings.TrimSpace(match))
	found := []map[string]any{}
	for _, t := range st.Tasks {
		if (taskID != "" && t.ID == taskID) || (q != "" && strings.Contains(strings.ToLower(t.Title+" "+t.Course+" "+t.Description), q)) {
			cmts := t.Comments
			if cmts == nil {
				cmts = []string{}
			}
			found = append(found, map[string]any{
				"id":                t.ID,
				"course":            t.Course,
				"title":             t.Title,
				"status":            t.Status,
				"due_at":            t.DueAt,
				"points":            t.Points,
				"estimated_minutes": t.EstMinutes,
				"human_minutes":     t.HumanMinutes,
				"est_why":           t.EstWhy,
				"directions":        t.Description,
				"comments":          cmts,
			})
		}
	}
	return map[string]any{"count": len(found), "assignments": found}, nil
}
