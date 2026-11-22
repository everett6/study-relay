package main

import (
	"embed"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"io/fs"
	"net/http"
	"strconv"
	"strings"
)

//go:embed presets/*.json
var presetsFS embed.FS

// withSecurityHeaders adds standard institutional security headers to every HTTP response.
func withSecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Permissions-Policy", "geolocation=(), camera=()")
		next.ServeHTTP(w, r)
	})
}

type SchoolPreset struct {
	ID             string            `json:"id"`
	Name           string            `json:"name"`
	Description    string            `json:"description"`
	CanvasBaseURL  string            `json:"canvas_base_url,omitempty"`
	IMAPFilters    string            `json:"imap_filters,omitempty"`
	SchoolStart    string            `json:"school_start"`
	SchoolEnd      string            `json:"school_end"`
	SchoolEndByDay map[string]string `json:"school_end_by_day,omitempty"`
	AfterSchoolMin int               `json:"after_school_min"`
	BlockMin       int               `json:"block_min"`
	BreakMin       int               `json:"break_min"`
	SleepCutoff    string            `json:"sleep_cutoff"`
}

func loadEmbeddedPresets() []SchoolPreset {
	entries, err := fs.ReadDir(presetsFS, "presets")
	if err != nil {
		return nil
	}
	var out []SchoolPreset
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		if raw, err := fs.ReadFile(presetsFS, "presets/"+e.Name()); err == nil {
			var p SchoolPreset
			if json.Unmarshal(raw, &p) == nil && p.ID != "" {
				out = append(out, p)
			}
		}
	}
	return out
}

func allSchoolPresets() []SchoolPreset {
	emb := loadEmbeddedPresets()
	seen := map[string]bool{}
	out := make([]SchoolPreset, 0, len(emb)+len(schoolPresets))
	for _, p := range emb {
		seen[p.ID] = true
		out = append(out, p)
	}
	for _, p := range schoolPresets {
		if !seen[p.ID] {
			out = append(out, p)
		}
	}
	return out
}

var schoolPresets = []SchoolPreset{
	{
		ID: "phhs_no7", Name: "Piedmont Hills HS (no 7th period)",
		Description: "PHHS modified block: 8:30 AM start; out 2:45 PM Mon/Tue/Fri after period 6, 2:00 PM on Wed/Thu block days. 45-min blocks, 10:30 PM sleep cutoff.",
		SchoolStart: "08:30", SchoolEnd: "14:45", SchoolEndByDay: map[string]string{"3": "14:00", "4": "14:00"},
		AfterSchoolMin: 45, BlockMin: 45, BreakMin: 10, SleepCutoff: "22:30",
	},
	{
		ID: "standard_hs", Name: "Standard High School",
		Description: "8:15 AM - 3:15 PM school, 45-min decompression break, 45-min blocks with 10-min breaks, 10:30 PM sleep cutoff.",
		SchoolStart: "08:15", SchoolEnd: "15:15", AfterSchoolMin: 45, BlockMin: 45, BreakMin: 10, SleepCutoff: "22:30",
	},
	{
		ID: "block_schedule", Name: "Block Schedule (A/B)",
		Description: "8:30 AM - 3:30 PM school, 45-min break, 60-min deep focus blocks with 15-min breaks, 10:30 PM sleep cutoff.",
		SchoolStart: "08:30", SchoolEnd: "15:30", AfterSchoolMin: 45, BlockMin: 60, BreakMin: 15, SleepCutoff: "22:30",
	},
	{
		ID: "zero_period_stem", Name: "Zero-Period STEM",
		Description: "7:30 AM - 2:30 PM school, 45-min break, 45-min blocks, earlier 10:00 PM sleep cutoff.",
		SchoolStart: "07:30", SchoolEnd: "14:30", AfterSchoolMin: 45, BlockMin: 45, BreakMin: 10, SleepCutoff: "22:00",
	},
	{
		ID: "finals_week", Name: "Finals Week Recovery",
		Description: "Half-day finals (8:15 AM - 1:00 PM), 35-min focused sprints with 15-min recovery breaks, 10:00 PM sleep cutoff.",
		SchoolStart: "08:15", SchoolEnd: "13:00", AfterSchoolMin: 45, BlockMin: 35, BreakMin: 15, SleepCutoff: "22:00",
	},
	{
		ID: "college", Name: "College / University",
		Description: "9:00 AM - 4:00 PM classes, 30-min transition break, 50-min blocks, 11:30 PM sleep cutoff.",
		SchoolStart: "09:00", SchoolEnd: "16:00", AfterSchoolMin: 30, BlockMin: 50, BreakMin: 10, SleepCutoff: "23:30",
	},
}

func (s *Server) presetsHTTP(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"presets": allSchoolPresets()})
}

func (s *Server) applyPresetHTTP(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4<<10)).Decode(&body); err != nil || body.ID == "" {
		httpError(w, http.StatusBadRequest, "preset id required")
		return
	}
	res, err := s.toolApplyPreset(body.ID)
	if err != nil {
		httpError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.store.LogAudit("http", "apply_preset", body.ID)
	writeJSON(w, http.StatusOK, res)
}

func findSchoolPreset(id string) *SchoolPreset {
	all := allSchoolPresets()
	for i := range all {
		if all[i].ID == id {
			return &all[i]
		}
	}
	return nil
}

func (s *Server) toolApplyPreset(id string) (map[string]any, error) {
	found := findSchoolPreset(id)
	if found == nil {
		return nil, fmt.Errorf("unknown preset %q", id)
	}
	if found.CanvasBaseURL != "" && s.cfg.CanvasBase == "https://instructure.com" {
		s.cfg.CanvasBase = found.CanvasBaseURL
	}
	var out Rules
	_, _, err := s.store.Update(func(st *State) error {
		st.Rules.SchoolStart = found.SchoolStart
		st.Rules.SchoolEnd = found.SchoolEnd
		st.Rules.SchoolEndByDay = found.SchoolEndByDay
		st.Rules.AfterSchoolMin = found.AfterSchoolMin
		st.Rules.BlockMin = found.BlockMin
		st.Rules.BreakMin = found.BreakMin
		st.Rules.SleepCutoff = found.SleepCutoff
		st.Meta.NeedsReplan = true
		out = st.Rules
		return nil
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"preset": found, "rules": out}, nil
}

func (s *Server) auditHTTP(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	entries, err := s.store.ListAudit(limit)
	if err != nil {
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"audit": entries})
}

func (s *Server) exportJSONHTTP(w http.ResponseWriter, _ *http.Request) {
	v, st, err := s.store.Get()
	if err != nil {
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}
	entries, _ := s.store.ListAudit(200)
	s.store.LogAudit("http", "export_json", fmt.Sprintf("version=%d", v))
	w.Header().Set("Content-Disposition", `attachment; filename="study-export.json"`)
	writeJSON(w, http.StatusOK, map[string]any{"version": v, "state": st, "audit": entries})
}

func (s *Server) exportCSVHTTP(w http.ResponseWriter, _ *http.Request) {
	_, st, err := s.store.Get()
	if err != nil {
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.store.LogAudit("http", "export_csv", fmt.Sprintf("tasks=%d sessions=%d", len(st.Tasks), len(st.Sessions)))
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="study-log.csv"`)
	cw := csv.NewWriter(w)
	_ = cw.Write([]string{"kind", "id", "course_or_bucket", "title", "status_or_outcome", "estimated_min", "actual_or_logged_min", "due_or_ended_at"})
	for _, t := range st.Tasks {
		est := t.EstMinutes
		if t.HumanMinutes != nil {
			est = *t.HumanMinutes
		}
		_ = cw.Write([]string{"task", t.ID, t.Course, t.Title, t.Status, strconv.Itoa(est), fmt.Sprintf("%.1f", t.LoggedMinutes), t.DueAt})
	}
	for _, se := range st.Sessions {
		_ = cw.Write([]string{"session", se.ID, se.Bucket, se.TaskID, se.Outcome, strconv.Itoa(se.PlannedMin), fmt.Sprintf("%.1f", se.ActualMin), se.EndedAt})
	}
	cw.Flush()
}

func (s *Server) accountResetHTTP(w http.ResponseWriter, _ *http.Request) {
	if err := s.store.Reset(); err != nil {
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.store.LogAudit("http", "account_reset", "FERPA state wipe")
	writeJSON(w, http.StatusOK, map[string]any{"reset": true})
}

// buildDigest computes a privacy-preserving counselor & wellness digest (no private email/Discord text).
func (s *Server) buildDigest() (map[string]any, error) {
	v, st, err := s.store.Get()
	if err != nil {
		return nil, err
	}
	st.normalizeWeek(s.now())

	openCount, doneCount := 0, 0
	for _, t := range st.Tasks {
		if t.Status == "done" {
			doneCount++
		} else {
			openCount++
		}
	}

	var totalLoggedMin, totalTargetHrs float64
	bucketSummary := make([]map[string]any, 0, len(st.Buckets))
	for _, b := range st.Buckets {
		totalLoggedMin += b.LoggedMinutes
		totalTargetHrs += b.TargetHours
		pct := 0.0
		if b.TargetHours > 0 {
			pct = round2((b.LoggedMinutes / 60.0) / b.TargetHours * 100)
		}
		bucketSummary = append(bucketSummary, map[string]any{
			"key": b.Key, "name": b.Name, "logged_hours": round2(b.LoggedMinutes / 60),
			"target_hours": b.TargetHours, "adherence_pct": pct,
		})
	}

	var moodSum, moodCount float64
	mode := "steady"
	if len(st.Momentum) > 0 {
		var m struct {
			Mode     string `json:"lastMcpMode"`
			Checkins []struct {
				Mood float64 `json:"mood"`
			} `json:"checkins"`
		}
		if json.Unmarshal(st.Momentum, &m) == nil {
			if m.Mode != "" {
				mode = m.Mode
			}
			for _, c := range m.Checkins {
				if c.Mood > 0 {
					moodSum += c.Mood
					moodCount++
				}
			}
		}
	}
	avgMood := 0.0
	if moodCount > 0 {
		avgMood = round2(moodSum / moodCount)
	}
	alert := len(st.Meta.AtRisk) > 0 || mode == "lighter" || mode == "stretched"

	return map[string]any{
		"version":            v,
		"workload_mode":      mode,
		"wellness_alert":     alert,
		"avg_mood":           avgMood,
		"checkin_count":      int(moodCount),
		"open_tasks":         openCount,
		"completed_tasks":    doneCount,
		"at_risk":            st.Meta.AtRisk,
		"sessions_logged":    len(st.Sessions),
		"total_logged_hours": round2(totalLoggedMin / 60),
		"total_target_hours": round2(totalTargetHrs),
		"buckets":            bucketSummary,
		"breaks": map[string]any{
			"after_school_min":  st.Rules.AfterSchoolMin,
			"between_block_min": st.Rules.BreakMin,
			"sleep_cutoff":      st.Rules.SleepCutoff,
		},
	}, nil
}

func (s *Server) counselorDigestHTTP(w http.ResponseWriter, _ *http.Request) {
	d, err := s.buildDigest()
	if err != nil {
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, d)
}

func (s *Server) transcriptHTTP(w http.ResponseWriter, r *http.Request) {
	d, err := s.buildDigest()
	if err != nil {
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if r.URL.Query().Get("format") == "json" {
		writeJSON(w, http.StatusOK, d)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	var rows strings.Builder
	for _, b := range d["buckets"].([]map[string]any) {
		rows.WriteString(fmt.Sprintf("<tr><td>%s</td><td>%.2fh</td><td>%.1fh</td><td>%.0f%%</td></tr>",
			html.EscapeString(fmt.Sprint(b["name"])), b["logged_hours"], b["target_hours"], b["adherence_pct"]))
	}
	page := fmt.Sprintf(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Study Transcript</title>
<style>body{font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;color:#111}
table{width:100%%;border-collapse:collapse;margin-top:16px}th,td{border:1px solid #ddd;padding:8px;text-align:left}
th{background:#f5f5f7}.meta{color:#555;font-size:14px}</style></head><body>
<h1>Weekly Study Transcript</h1>
<p class="meta">Workload Mode: <strong>%s</strong> · Logged: <strong>%.2fh / %.1fh</strong> · Tasks Done: <strong>%v</strong> · Sessions: <strong>%v</strong></p>
<table><thead><tr><th>Goal / Bucket</th><th>Logged</th><th>Target</th><th>Adherence</th></tr></thead><tbody>%s</tbody></table>
</body></html>`,
		html.EscapeString(fmt.Sprint(d["workload_mode"])),
		d["total_logged_hours"], d["total_target_hours"], d["completed_tasks"], d["sessions_logged"], rows.String())
	_, _ = io.WriteString(w, page)
}
