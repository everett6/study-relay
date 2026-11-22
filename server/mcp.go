package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/mail"
	"sort"
	"strings"
	"sync"
	"time"
)

// Minimal MCP server: JSON-RPC 2.0 over Streamable HTTP (POST /mcp, JSON responses) plus the
// legacy HTTP+SSE transport (GET /mcp/sse announces POST /mcp?sessionId=...).

const mcpProtocol = "2025-06-18"

var supportedProtocols = []string{"2025-06-18", "2025-03-26", "2024-11-05"}

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type toolAnnotations struct {
	ReadOnlyHint    bool `json:"readOnlyHint"`
	DestructiveHint bool `json:"destructiveHint"`
	IdempotentHint  bool `json:"idempotentHint"`
	OpenWorldHint   bool `json:"openWorldHint"`
}

type tool struct {
	Name        string           `json:"name"`
	Description string           `json:"description"`
	InputSchema map[string]any   `json:"inputSchema"`
	Annotations *toolAnnotations `json:"annotations,omitempty"`
}

var readOnlyToolNames = map[string]bool{
	"get_schedule_and_buckets":  true,
	"canvas_explore":            true,
	"get_grades":                true,
	"list_inbox":                true,
	"get_week_overview":         true,
	"get_momentum_and_sessions": true,
	"get_study_resources":       true,
	"get_counselor_digest":      true,
	"get_audit_log":             true,
	"get_next_problems":         true,
	"get_daily_briefing":        true,
	"find_free_slots":           true,
	"search_tasks":              true,
	"get_assignment_details":    true,
}

func annotatedTools() []tool {
	all := append(append([]tool{}, tools...), mcpToolsV2...)
	for i := range all {
		ro := readOnlyToolNames[all[i].Name]
		all[i].Annotations = &toolAnnotations{
			ReadOnlyHint:    ro,
			DestructiveHint: all[i].Name == "delete_task_or_event",
			IdempotentHint:  ro,
			OpenWorldHint:   false,
		}
	}
	return all
}

func obj(props map[string]any, required ...string) map[string]any {
	m := map[string]any{"type": "object", "properties": props, "additionalProperties": false}
	if len(required) > 0 {
		m["required"] = required
	}
	return m
}

func str(desc string) map[string]any { return map[string]any{"type": "string", "description": desc} }
func num(desc string) map[string]any { return map[string]any{"type": "number", "description": desc} }

var tools = []tool{
	{
		Name: "get_schedule_and_buckets",
		Description: "Return the scheduled blocks for a day (default today), protected buffers, the active " +
			"Task Estimation Matrix, and weekly bucket hours (AIME, USAAIO, Research, ACT, Physics, Tier 1 School).",
		InputSchema: obj(map[string]any{"date": str("YYYY-MM-DD; defaults to today")}),
	},
	{
		Name: "add_or_override_task",
		Description: "Add a new task, or override the estimated minutes / cognitive load of an existing task " +
			"(match by task_id or by a title/course substring). Overrides are logged as human corrections for " +
			"the browser's CfC liquid network.",
		InputSchema: obj(map[string]any{
			"task_id":           str("existing task id"),
			"match":             str("substring of course or title to find an existing task"),
			"title":             str("title for a new task"),
			"course":            str("course for a new task"),
			"category":          map[string]any{"type": "string", "enum": []string{"homework", "quiz", "test", "lab", "project"}},
			"due_at":            str("YYYY-MM-DDTHH:MM local time"),
			"estimated_minutes": num("minutes (5-1200)"),
			"cognitive_load":    num("1-5"),
		}),
	},
	{
		Name: "apply_event_override",
		Description: "Handle an evening event (banquet, competition, ...): pre-clear Tier 1 Canvas work due by " +
			"tomorrow earlier in the day, drop study blocks from the event to the sleep cutoff, and never " +
			"schedule past the 10:30 PM cutoff.",
		InputSchema: obj(map[string]any{
			"title":            str("event name, e.g. Banquet"),
			"start":            str("HH:MM or YYYY-MM-DDTHH:MM"),
			"end":              str("optional HH:MM or YYYY-MM-DDTHH:MM (default start + 2.5h)"),
			"date":             str("YYYY-MM-DD; defaults to today"),
			"preclear_course":  str("optional course/title substring that must be done earlier"),
			"preclear_before":  str("optional HH:MM deadline for preclear_course"),
			"drop_after_event": map[string]any{"type": "boolean", "description": "drop all study after the event starts (default true)"},
		}, "title", "start"),
	},
	{
		Name: "control_study_timer",
		Description: "Start, pause, resume, complete, or read the Study Mode timer (45-minute blocks by default). " +
			"Completing logs elapsed minutes to the target bucket.",
		InputSchema: obj(map[string]any{
			"action":         map[string]any{"type": "string", "enum": []string{"start", "pause", "resume", "complete", "status"}},
			"bucket":         str("AIME | USAAIO | RESEARCH | ACT | PHYSICS | SCHOOL"),
			"task_id":        str("Tier 1 task to work on (logs to SCHOOL)"),
			"block_id":       str("scheduled block to run"),
			"minutes":        num("planned length (default 45)"),
			"actual_minutes": num("override elapsed minutes on complete"),
			"energy":         map[string]any{"type": "string", "enum": []string{"high", "med", "low"}},
			"finished":       map[string]any{"type": "boolean", "description": "task finished (default true)"},
		}, "action"),
	},
	{
		Name: "canvas_explore",
		Description: "Dig through the student's Canvas classes (esuhsd.instructure.com): courses with current grades, " +
			"assignments with submission status, recent announcements, modules, or syllabus. Read-only on Canvas " +
			"(reading all grades also saves them to the planner's grade history).",
		InputSchema: obj(map[string]any{
			"what":    map[string]any{"type": "string", "enum": []string{"courses", "grades", "assignments", "announcements", "modules", "syllabus"}},
			"course":  str("optional course name substring, e.g. biology"),
			"search":  str("optional keyword filter"),
			"refresh": map[string]any{"type": "boolean", "description": "bypass 90s cache and fetch live from Canvas"},
		}, "what"),
	},
	{
		Name: "get_grades",
		Description: "The student's current Canvas grade in each class, the 2-week trend, their goal, zeros and missing work " +
			"(missing_and_zeros; status planned = a make-up task is scheduled), and what the planner does " +
			"about it: below-goal or slipping classes get extra weekly review minutes and more time on homework. " +
			"refresh=true pulls fresh grades from Canvas first (otherwise they refresh every 6 hours). " +
			"To change a goal, the student uses the Tasks view or says e.g. \"I want an A in chem\" in the app.",
		InputSchema: obj(map[string]any{"refresh": map[string]any{"type": "boolean", "description": "pull fresh grades from Canvas first"}}),
	},
	{
		Name:        "list_inbox",
		Description: "List club / college-counselor messages collected from Discord and email (and screenshots), plus pending email drafts.",
		InputSchema: obj(map[string]any{
			"status": map[string]any{"type": "string", "enum": []string{"new", "all"}},
			"source": map[string]any{"type": "string", "enum": []string{"discord", "email", "screenshot", "any"}},
		}),
	},
	{
		Name: "draft_email",
		Description: "Create an email DRAFT (e.g. a reply to the college counselor or a club). It is never sent by this " +
			"tool: the student reviews it and presses Send in the app.",
		InputSchema: obj(map[string]any{
			"to": str("recipient address"), "subject": str("subject"), "body": str("plain-text body"),
			"reason": str("why this email is needed"), "inbox_id": str("optional inbox item it replies to"),
		}, "to", "subject", "body"),
	},
	{
		Name:        "get_week_overview",
		Description: "Return a multi-day schedule overview (default 7 days): planned/done blocks per day, events, daily study minutes, bucket progress, and at-risk tasks.",
		InputSchema: obj(map[string]any{
			"start_date": str("YYYY-MM-DD; defaults to today"),
			"days":       num("number of days (1-14, default 7)"),
		}),
	},
	{
		Name:        "mark_task_done",
		Description: "Mark an open task as done (or reopen it) by task_id or title/course match substring. Marks associated planned blocks done and flags replan.",
		InputSchema: obj(map[string]any{
			"task_id": str("existing task id"),
			"match":   str("substring of course or title"),
			"status":  map[string]any{"type": "string", "enum": []string{"done", "open"}},
		}),
	},
	{
		Name:        "manage_block",
		Description: "Move/reschedule a study block, pin or unpin it, or cancel/remove it.",
		InputSchema: obj(map[string]any{
			"block_id": str("existing block id"),
			"match":    str("substring of block title or bucket"),
			"action":   map[string]any{"type": "string", "enum": []string{"move", "pin", "unpin", "cancel"}},
			"date":     str("target YYYY-MM-DD for move"),
			"start":    str("target HH:MM for move"),
			"end":      str("target HH:MM for move (optional; preserves duration)"),
		}, "action"),
	},
	{
		Name:        "set_bucket_target",
		Description: "Update weekly target hours (0-40) or cognitive load (1-5) for a Tier 2 bucket (AIME, USAAIO, RESEARCH, ACT, PHYSICS).",
		InputSchema: obj(map[string]any{
			"bucket":         str("bucket key, e.g. AIME, USAAIO, RESEARCH, ACT, PHYSICS"),
			"target_hours":   num("weekly target hours (0-40)"),
			"cognitive_load": num("1-5"),
		}, "bucket"),
	},
	{
		Name:        "check_in_mood",
		Description: "Record a 1-5 mood/energy check-in (1=rough .. 5=great) so the adaptive momentum mode updates accordingly.",
		InputSchema: obj(map[string]any{
			"mood": num("1-5"),
			"note": str("optional short note"),
		}, "mood"),
	},
	{
		Name:        "get_momentum_and_sessions",
		Description: "Return adaptive momentum/workload mode, recent study sessions, CfC feedback queue, and integration status.",
		InputSchema: obj(map[string]any{
			"limit": num("max recent sessions to return (default 15)"),
		}),
	},
	{
		Name:        "update_rules_and_breaks",
		Description: "Read or update scheduling rules: after-school break, between-block break, block length, dinner, sleep cutoff, and school hours.",
		InputSchema: obj(map[string]any{
			"after_school_min": num("after-school break minutes (0-180)"),
			"break_min":        num("break minutes between study blocks (0-60)"),
			"block_min":        num("default study block minutes (15-120)"),
			"dinner_start":     str("HH:MM"),
			"dinner_min":       num("dinner duration minutes (0-240)"),
			"sleep_cutoff":     str("HH:MM hard cutoff"),
			"school_start":     str("HH:MM"),
			"school_end":       str("HH:MM"),
			"preclear_hours":   num("hours before due date to pre-clear Tier 1 work (0-168)"),
		}),
	},
	{
		Name:        "manage_research_milestone",
		Description: "Add, list, or complete research project milestones and deadlines (ISEF / Synopsys / Science Fair) with optional calendar deadline events.",
		InputSchema: obj(map[string]any{
			"action":             map[string]any{"type": "string", "enum": []string{"add", "list", "complete"}},
			"task_id":            str("existing milestone task id (for complete)"),
			"match":              str("substring match (for complete)"),
			"title":              str("milestone title (for add)"),
			"phase":              map[string]any{"type": "string", "enum": []string{"literature", "design", "experiment", "analysis", "paper", "poster"}},
			"due_at":             str("YYYY-MM-DDTHH:MM deadline"),
			"estimated_minutes":  num("minutes (5-1200)"),
			"cognitive_load":     num("1-5 (default 4)"),
			"add_deadline_event": map[string]any{"type": "boolean", "description": "also block a 30-min deadline event on the calendar"},
		}, "action"),
	},
	{
		Name: "plan_competition_goal",
		Description: "Generate a concrete study roadmap, recommended research/references, weekly bucket hours, and " +
			"curated worksheet/mock-exam assignments for a competition or research goal (e.g. score 8 on AIME, qualify for Round 2 on USAAIO, ISEF research).",
		InputSchema: obj(map[string]any{
			"goal":         map[string]any{"type": "string", "enum": []string{"AIME", "USAAIO", "RESEARCH", "ACT", "PHYSICS"}},
			"target":       str("target score or round, e.g. '8' for AIME or 'round 2' for USAAIO"),
			"deadline":     str("optional target YYYY-MM-DD"),
			"assign_tasks": map[string]any{"type": "boolean", "description": "add curated worksheets/mocks to the Estimation Matrix and raise weekly bucket hours (default true)"},
		}, "goal"),
	},
	{
		Name:        "get_study_resources",
		Description: "Look up curated worksheets, past papers, textbooks, and research references for AIME, USAAIO, RESEARCH, ACT, or PHYSICS without modifying state.",
		InputSchema: obj(map[string]any{
			"goal":   map[string]any{"type": "string", "enum": []string{"AIME", "USAAIO", "RESEARCH", "ACT", "PHYSICS"}},
			"target": str("optional target score or round"),
		}, "goal"),
	},
	{
		Name:        "get_counselor_digest",
		Description: "Return a privacy-preserving counselor & wellness digest: workload mode, average mood, at-risk deadlines, bucket adherence, and break settings (no private email/Discord text).",
		InputSchema: obj(map[string]any{}),
	},
	{
		Name:        "apply_school_preset",
		Description: "Apply an institutional bell-schedule & break preset (standard_hs, block_schedule, zero_period_stem, finals_week, college).",
		InputSchema: obj(map[string]any{
			"preset_id": map[string]any{"type": "string", "enum": []string{"standard_hs", "block_schedule", "zero_period_stem", "finals_week", "college"}},
		}, "preset_id"),
	},
	{
		Name:        "get_audit_log",
		Description: "Return recent FERPA/compliance audit log entries recording MCP calls, exports, presets, and sends.",
		InputSchema: obj(map[string]any{
			"limit": num("max entries (default 50)"),
		}),
	},
}

type sseSession struct {
	ch chan []byte
}

type mcpSessions struct {
	mu sync.Mutex
	m  map[string]*sseSession
}

func (s *Server) mcpPost(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	s.touchPresence()
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		httpError(w, http.StatusBadRequest, "read error")
		return
	}
	var out []byte
	var rpcLabel string
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) > 0 && trimmed[0] == '[' {
		var reqs []rpcRequest
		if err := json.Unmarshal(trimmed, &reqs); err != nil {
			rpcLabel = "batch:parse_err"
			out, _ = json.Marshal(rpcResponse{JSONRPC: "2.0", ID: json.RawMessage("null"), Error: &rpcError{-32700, "parse error"}})
		} else {
			resps := []rpcResponse{}
			labels := make([]string, 0, len(reqs))
			for _, rq := range reqs {
				labels = append(labels, rq.Method)
				if resp := s.handleRPC(rq); resp != nil {
					resps = append(resps, *resp)
				}
			}
			rpcLabel = "batch[" + strings.Join(labels, ",") + "]"
			if len(resps) > 0 {
				out, _ = json.Marshal(resps)
			}
		}
	} else {
		var rq rpcRequest
		if err := json.Unmarshal(trimmed, &rq); err != nil {
			rpcLabel = "parse_err"
			out, _ = json.Marshal(rpcResponse{JSONRPC: "2.0", ID: json.RawMessage("null"), Error: &rpcError{-32700, "parse error"}})
		} else {
			rpcLabel = rq.Method
			if rq.Method == "tools/call" {
				var p struct {
					Name string `json:"name"`
				}
				if json.Unmarshal(rq.Params, &p) == nil && p.Name != "" {
					rpcLabel = "tools/call:" + p.Name
				}
			}
			if resp := s.handleRPC(rq); resp != nil {
				out, _ = json.Marshal(resp)
			}
		}
	}

	if sid := r.URL.Query().Get("sessionId"); sid != "" { // legacy SSE transport
		s.sse.mu.Lock()
		sess := s.sse.m[sid]
		s.sse.mu.Unlock()
		if sess == nil {
			httpError(w, http.StatusNotFound, "unknown session")
			return
		}
		if out != nil {
			select {
			case sess.ch <- out:
			case <-time.After(5 * time.Second):
				httpError(w, http.StatusServiceUnavailable, "session stalled")
				return
			}
		}
		log.Printf("mcp: POST /mcp?sessionId=%s %s dur=%s bytes=%d", sid, rpcLabel, time.Since(start).Round(time.Millisecond), len(out))
		w.WriteHeader(http.StatusAccepted)
		return
	}
	if out == nil { // notifications only
		log.Printf("mcp: POST /mcp %s status=202 dur=%s", rpcLabel, time.Since(start).Round(time.Millisecond))
		w.WriteHeader(http.StatusAccepted)
		return
	}
	log.Printf("mcp: POST /mcp %s status=200 dur=%s bytes=%d", rpcLabel, time.Since(start).Round(time.Millisecond), len(out))
	w.Header().Set("Content-Type", "application/json")
	if len(out) > 2048 && strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Set("Vary", "Accept-Encoding")
		gz, _ := gzip.NewWriterLevel(w, gzip.BestSpeed)
		_, _ = gz.Write(out)
		_ = gz.Close()
		return
	}
	_, _ = w.Write(out)
}

func (s *Server) mcpSSE(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		httpError(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}
	sid := s.newID()
	sess := &sseSession{ch: make(chan []byte, 8)}
	s.sse.mu.Lock()
	if len(s.sse.m) >= 16 {
		s.sse.mu.Unlock()
		httpError(w, http.StatusTooManyRequests, "too many sessions")
		return
	}
	s.sse.m[sid] = sess
	s.sse.mu.Unlock()
	defer func() {
		s.sse.mu.Lock()
		delete(s.sse.m, sid)
		s.sse.mu.Unlock()
	}()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	fmt.Fprintf(w, "event: endpoint\ndata: /mcp?sessionId=%s\n\n", sid)
	fl.Flush()
	tick := time.NewTicker(25 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case msg := <-sess.ch:
			fmt.Fprintf(w, "event: message\ndata: %s\n\n", msg)
			fl.Flush()
		case <-tick.C:
			fmt.Fprint(w, ": keepalive\n\n")
			fl.Flush()
		}
	}
}

func (s *Server) handleRPC(rq rpcRequest) *rpcResponse {
	isNotification := len(rq.ID) == 0 || string(rq.ID) == "null"
	reply := func(result any, err *rpcError) *rpcResponse {
		if isNotification {
			return nil
		}
		return &rpcResponse{JSONRPC: "2.0", ID: rq.ID, Result: result, Error: err}
	}
	if rq.JSONRPC != "2.0" {
		return reply(nil, &rpcError{-32600, "invalid request: jsonrpc must be 2.0"})
	}
	switch rq.Method {
	case "initialize":
		var p struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		_ = json.Unmarshal(rq.Params, &p)
		ver := mcpProtocol
		for _, v := range supportedProtocols {
			if v == p.ProtocolVersion {
				ver = v
			}
		}
		return reply(map[string]any{
			"protocolVersion": ver,
			"capabilities": map[string]any{
				"tools":     map[string]any{"listChanged": false},
				"resources": map[string]any{"subscribe": false, "listChanged": false},
				"prompts":   map[string]any{"listChanged": false},
			},
			"serverInfo": map[string]any{"name": "study-relay", "version": version},
			"instructions": "Adaptive study scheduler. Times are local wall-clock (YYYY-MM-DDTHH:MM). " +
				"Protected: school, 45-min after-school break, between-block breaks, 90-min dinner at 7 PM, 10:30 PM sleep cutoff.",
		}, nil)
	case "ping":
		return reply(map[string]any{}, nil)
	case "tools/list":
		return reply(map[string]any{"tools": annotatedTools()}, nil)
	case "resources/list":
		return reply(map[string]any{"resources": mcpResources}, nil)
	case "resources/read":
		var p struct {
			URI string `json:"uri"`
		}
		if err := json.Unmarshal(rq.Params, &p); err != nil || p.URI == "" {
			return reply(nil, &rpcError{-32602, "invalid params: uri required"})
		}
		res, err := s.readResource(p.URI)
		if err != nil {
			return reply(nil, &rpcError{-32602, err.Error()})
		}
		return reply(res, nil)
	case "prompts/list":
		return reply(map[string]any{"prompts": mcpPrompts}, nil)
	case "prompts/get":
		var p struct {
			Name      string            `json:"name"`
			Arguments map[string]string `json:"arguments"`
		}
		if err := json.Unmarshal(rq.Params, &p); err != nil || p.Name == "" {
			return reply(nil, &rpcError{-32602, "invalid params: name required"})
		}
		res, err := s.getPrompt(p.Name, p.Arguments)
		if err != nil {
			return reply(nil, &rpcError{-32602, err.Error()})
		}
		return reply(res, nil)
	case "tools/call":
		var p struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if err := json.Unmarshal(rq.Params, &p); err != nil {
			return reply(nil, &rpcError{-32602, "invalid params"})
		}
		res, err := s.callTool(p.Name, p.Arguments)
		if err != nil {
			if _, unknown := err.(unknownTool); unknown {
				return reply(nil, &rpcError{-32602, err.Error()})
			}
			return reply(map[string]any{"content": []map[string]any{{"type": "text", "text": err.Error()}},
				"isError": true}, nil)
		}
		if p.Name != "get_audit_log" {
			s.store.LogAudit("mcp", p.Name, string(p.Arguments))
		}
		text, _ := json.MarshalIndent(res, "", "  ")
		return reply(map[string]any{"content": []map[string]any{{"type": "text", "text": string(text)}},
			"structuredContent": res, "isError": false}, nil)
	default:
		if strings.HasPrefix(rq.Method, "notifications/") {
			return nil
		}
		return reply(nil, &rpcError{-32601, "method not found: " + rq.Method})
	}
}

type unknownTool string

func (u unknownTool) Error() string { return "unknown tool: " + string(u) }

func (s *Server) callTool(name string, raw json.RawMessage) (map[string]any, error) {
	if len(raw) == 0 || string(raw) == "null" {
		raw = json.RawMessage("{}")
	}
	switch name {
	case "get_schedule_and_buckets":
		var a struct {
			Date string `json:"date"`
		}
		if err := json.Unmarshal(raw, &a); err != nil {
			return nil, err
		}
		return s.toolGetSchedule(a.Date)
	case "add_or_override_task":
		var a taskArgs
		if err := json.Unmarshal(raw, &a); err != nil {
			return nil, err
		}
		return s.toolTask(a)
	case "apply_event_override":
		var a eventArgs
		a.DropAfterEvent = true
		if err := json.Unmarshal(raw, &a); err != nil {
			return nil, err
		}
		return s.toolEvent(a)
	case "get_grades":
		var a struct {
			Refresh bool `json:"refresh"`
		}
		if err := json.Unmarshal(raw, &a); err != nil {
			return nil, err
		}
		return s.toolGetGrades(a.Refresh)
	case "canvas_explore":
		var a exploreArgs
		if err := json.Unmarshal(raw, &a); err != nil {
			return nil, err
		}
		ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
		defer cancel()
		return s.canvasExplore(ctx, a)
	case "list_inbox":
		var a struct{ Status, Source string }
		if err := json.Unmarshal(raw, &a); err != nil {
			return nil, err
		}
		_, st, err := s.store.Get()
		if err != nil {
			return nil, err
		}
		items := []InboxItem{}
		for _, it := range st.Inbox {
			if (a.Status == "" || a.Status == "new") && it.Status != "new" {
				continue
			}
			if a.Source != "" && a.Source != "any" && it.Source != a.Source {
				continue
			}
			items = append(items, it)
		}
		drafts := []Draft{}
		for _, d := range st.Drafts {
			if d.Status != "sent" {
				drafts = append(drafts, d)
			}
		}
		return map[string]any{"inbox": items, "pending_drafts": drafts, "integrations": s.integ.Status()}, nil
	case "draft_email":
		var a struct{ To, Subject, Body, Reason, InboxID string }
		if err := json.Unmarshal(raw, &a); err != nil {
			return nil, err
		}
		if _, err := mail.ParseAddress(a.To); err != nil {
			return nil, fmt.Errorf("to must be an email address")
		}
		if strings.TrimSpace(a.Subject) == "" || strings.TrimSpace(a.Body) == "" {
			return nil, fmt.Errorf("subject and body are required")
		}
		d := Draft{ID: s.newID(), To: a.To, Subject: a.Subject, Body: a.Body, Reason: a.Reason, InboxID: a.InboxID,
			Status: "draft", CreatedAt: s.now().Format(localLayout)}
		if _, _, err := s.store.Update(func(st *State) error { st.Drafts = append(st.Drafts, d); return nil }); err != nil {
			return nil, err
		}
		return map[string]any{"draft": d, "note": "saved as a draft; the student must press Send in the app"}, nil
	case "control_study_timer":
		var a timerArgs
		a.Finished = true
		if err := json.Unmarshal(raw, &a); err != nil {
			return nil, err
		}
		return s.toolTimer(a)
	case "get_week_overview":
		var a struct {
			StartDate string `json:"start_date"`
			Days      int    `json:"days"`
		}
		if err := json.Unmarshal(raw, &a); err != nil {
			return nil, err
		}
		return s.toolWeekOverview(a.StartDate, a.Days)
	case "mark_task_done":
		var a struct {
			TaskID string `json:"task_id"`
			Match  string `json:"match"`
			Status string `json:"status"`
		}
		if err := json.Unmarshal(raw, &a); err != nil {
			return nil, err
		}
		return s.toolMarkTask(a.TaskID, a.Match, a.Status)
	case "manage_block":
		var a blockArgs
		if err := json.Unmarshal(raw, &a); err != nil {
			return nil, err
		}
		return s.toolManageBlock(a)
	case "set_bucket_target":
		var a struct {
			Bucket        string   `json:"bucket"`
			TargetHours   *float64 `json:"target_hours"`
			CognitiveLoad *float64 `json:"cognitive_load"`
		}
		if err := json.Unmarshal(raw, &a); err != nil {
			return nil, err
		}
		return s.toolSetBucket(a.Bucket, a.TargetHours, a.CognitiveLoad)
	case "check_in_mood":
		var a struct {
			Mood float64 `json:"mood"`
			Note string  `json:"note"`
		}
		if err := json.Unmarshal(raw, &a); err != nil {
			return nil, err
		}
		return s.toolCheckIn(a.Mood, a.Note)
	case "get_momentum_and_sessions":
		var a struct {
			Limit int `json:"limit"`
		}
		if err := json.Unmarshal(raw, &a); err != nil {
			return nil, err
		}
		return s.toolMomentumAndSessions(a.Limit)
	case "update_rules_and_breaks":
		var a rulesArgs
		if err := json.Unmarshal(raw, &a); err != nil {
			return nil, err
		}
		return s.toolUpdateRules(a)
	case "manage_research_milestone":
		var a researchArgs
		if err := json.Unmarshal(raw, &a); err != nil {
			return nil, err
		}
		return s.toolManageResearchMilestone(a)
	case "plan_competition_goal":
		var a struct {
			Goal        string `json:"goal"`
			Target      string `json:"target"`
			Deadline    string `json:"deadline"`
			AssignTasks *bool  `json:"assign_tasks"`
		}
		if err := json.Unmarshal(raw, &a); err != nil {
			return nil, err
		}
		assign := true
		if a.AssignTasks != nil {
			assign = *a.AssignTasks
		}
		return s.toolPlanCompetitionGoal(a.Goal, a.Target, a.Deadline, assign)
	case "get_study_resources":
		var a struct {
			Goal   string `json:"goal"`
			Target string `json:"target"`
		}
		if err := json.Unmarshal(raw, &a); err != nil {
			return nil, err
		}
		return s.toolPlanCompetitionGoal(a.Goal, a.Target, "", false)
	case "get_counselor_digest":
		return s.buildDigest()
	case "apply_school_preset":
		var a struct {
			PresetID string `json:"preset_id"`
		}
		if err := json.Unmarshal(raw, &a); err != nil {
			return nil, err
		}
		return s.toolApplyPreset(a.PresetID)
	case "get_audit_log":
		var a struct {
			Limit int `json:"limit"`
		}
		if err := json.Unmarshal(raw, &a); err != nil {
			return nil, err
		}
		entries, err := s.store.ListAudit(a.Limit)
		if err != nil {
			return nil, err
		}
		return map[string]any{"audit": entries}, nil
	}
	if res, handled, err := s.callToolV2(name, raw); handled {
		return res, err
	}
	return nil, unknownTool(name)
}

// ------------------------------------------------------------------ tools

func (s *Server) toolGetSchedule(date string) (map[string]any, error) {
	now := s.now()
	day := now
	if date != "" {
		d, err := time.ParseInLocation(dateLayout, date, s.loc)
		if err != nil {
			return nil, fmt.Errorf("date must be YYYY-MM-DD")
		}
		day = d
	}
	v, st, err := s.store.Get()
	if err != nil {
		return nil, err
	}
	st.normalizeWeek(now)
	ds := day.Format(dateLayout)
	blocks := []Block{}
	for _, b := range st.Blocks {
		if b.Date == ds {
			blocks = append(blocks, b)
		}
	}
	fixed := []map[string]string{}
	for _, f := range FixedSpans(st.Rules, day, st.Events) {
		fixed = append(fixed, map[string]string{"kind": f.Kind, "title": f.Title,
			"start": f.S.Format(localLayout), "end": f.E.Format(localLayout)})
	}
	sort.Slice(fixed, func(i, j int) bool { return fixed[i]["start"] < fixed[j]["start"] })
	tasks := []map[string]any{}
	for _, t := range st.Tasks {
		if t.Status != "open" {
			continue
		}
		est := t.EstMinutes
		if t.HumanMinutes != nil {
			est = *t.HumanMinutes
		}
		tasks = append(tasks, map[string]any{"id": t.ID, "course": t.Course, "title": t.Title,
			"task_type": t.TaskType, "cognitive_load": t.CognitiveLoad, "llm_minutes": t.LLMMinutes,
			"estimated_minutes": est, "human_override": t.HumanMinutes != nil,
			"recommended_45m_blocks": t.Blocks, "due_at": t.DueAt, "preclear_by": t.PreclearBy})
	}
	sort.Slice(tasks, func(i, j int) bool { return fmt.Sprint(tasks[i]["due_at"]) < fmt.Sprint(tasks[j]["due_at"]) })
	buckets := []map[string]any{}
	for _, b := range st.Buckets {
		buckets = append(buckets, map[string]any{"key": b.Key, "name": b.Name, "target_hours": b.TargetHours,
			"logged_hours": round2(b.LoggedMinutes / 60), "week": b.Week})
	}
	return map[string]any{"date": ds, "version": v, "blocks": blocks, "protected": fixed,
		"task_estimation_matrix": tasks, "buckets": buckets, "timer": st.Timer, "at_risk": st.Meta.AtRisk,
		"grades": gradeFocus(st.Grades, now), "missing_and_zeros": openFlags(st), "needs_replan": st.Meta.NeedsReplan}, nil
}

func (s *Server) toolGetGrades(refresh bool) (map[string]any, error) {
	_, st, err := s.store.Get()
	if err != nil {
		return nil, err
	}
	note := ""
	if refresh || gradesStale(st, s.now(), 6*time.Hour) {
		ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
		defer cancel()
		if err := s.refreshGrades(ctx); err != nil {
			note = "could not refresh from Canvas: " + err.Error()
		} else if _, st, err = s.store.Get(); err != nil {
			return nil, err
		}
	}
	out := map[string]any{"grades": gradeFocus(st.Grades, s.now()), "missing_and_zeros": openFlags(st),
		"how_planning_uses_it": "Classes below the goal (default 93%) or down 2+ points in two weeks get weekly 'Review: <class>' " +
			"blocks and their homework estimates are multiplied by homework_time_multiplier."}
	if note != "" {
		out["note"] = note
	}
	if len(st.Grades) == 0 {
		out["note"] = "no grades saved yet; " + note
	}
	return out, nil
}

type taskArgs struct {
	TaskID        string   `json:"task_id"`
	Match         string   `json:"match"`
	Title         string   `json:"title"`
	Course        string   `json:"course"`
	Category      string   `json:"category"`
	DueAt         string   `json:"due_at"`
	EstMinutes    *float64 `json:"estimated_minutes"`
	CognitiveLoad *float64 `json:"cognitive_load"`
}

var baseMinutes = map[string]int{"homework": 40, "quiz": 40, "test": 120, "lab": 75, "project": 150}
var typeOf = map[string]string{"homework": "HW", "quiz": "Quiz", "test": "Exam", "lab": "Lab", "project": "Project"}
var baseLoad = map[string]int{"homework": 3, "quiz": 3, "test": 5, "lab": 3, "project": 4}

func blocksFor(minutes, block, minBlock int) []int {
	out := []int{}
	for minutes >= block {
		out = append(out, block)
		minutes -= block
	}
	if minutes > 0 {
		if minutes < minBlock && len(out) > 0 {
			out[len(out)-1] += minutes
		} else {
			out = append(out, minutes)
		}
	}
	return out
}

func (s *Server) toolTask(a taskArgs) (map[string]any, error) {
	if a.EstMinutes != nil && (*a.EstMinutes < 5 || *a.EstMinutes > 1200) {
		return nil, fmt.Errorf("estimated_minutes must be 5..1200")
	}
	if a.CognitiveLoad != nil && (*a.CognitiveLoad < 1 || *a.CognitiveLoad > 5) {
		return nil, fmt.Errorf("cognitive_load must be 1..5")
	}
	now := s.now()
	var result map[string]any
	_, _, err := s.store.Update(func(st *State) error {
		var t *Task
		if a.TaskID != "" {
			t = st.task(a.TaskID)
			if t == nil {
				return fmt.Errorf("no task with id %s", a.TaskID)
			}
		} else if a.Match != "" {
			q := strings.ToLower(a.Match)
			var hits []*Task
			for i := range st.Tasks {
				if st.Tasks[i].Status == "open" &&
					strings.Contains(strings.ToLower(st.Tasks[i].Course+" "+st.Tasks[i].Title), q) {
					hits = append(hits, &st.Tasks[i])
				}
			}
			if len(hits) == 0 {
				return fmt.Errorf("no open task matches %q", a.Match)
			}
			if len(hits) > 1 {
				names := []string{}
				for _, h := range hits {
					names = append(names, h.Title)
				}
				return fmt.Errorf("ambiguous match %q: %s", a.Match, strings.Join(names, "; "))
			}
			t = hits[0]
		}
		if t != nil { // override
			if a.EstMinutes == nil && a.CognitiveLoad == nil {
				return fmt.Errorf("nothing to override: give estimated_minutes and/or cognitive_load")
			}
			if a.EstMinutes != nil {
				m := int(*a.EstMinutes)
				prev := t.EstMinutes
				if t.HumanMinutes != nil {
					prev = *t.HumanMinutes
				}
				t.HumanMinutes = &m
				t.EstSource = "human"
				t.Blocks = blocksFor(m, st.Rules.BlockMin, st.Rules.MinBlockMin)
				st.Feedback = append(st.Feedback, Feedback{Kind: "correction", TaskID: t.ID, TaskType: t.TaskType,
					Course: t.Course, AIMinutes: float64(prev), RealMinutes: float64(m), At: now.Format(localLayout)})
			}
			if a.CognitiveLoad != nil {
				t.CognitiveLoad = int(*a.CognitiveLoad)
			}
			st.Meta.NeedsReplan = true
			result = map[string]any{"action": "override", "task": *t}
			return nil
		}
		if a.Title == "" {
			return fmt.Errorf("title is required to add a task (or give task_id/match to override)")
		}
		cat := a.Category
		if _, ok := baseMinutes[cat]; !ok {
			cat = "homework"
		}
		mins := baseMinutes[cat]
		src := "heuristic"
		var human *int
		if a.EstMinutes != nil {
			m := int(*a.EstMinutes)
			human = &m
			src = "human"
		}
		load := baseLoad[cat]
		if a.CognitiveLoad != nil {
			load = int(*a.CognitiveLoad)
		}
		if a.DueAt != "" {
			if _, err := parseLocal(a.DueAt, s.loc); err != nil {
				return fmt.Errorf("due_at must be YYYY-MM-DDTHH:MM")
			}
		}
		eff := mins
		if human != nil {
			eff = *human
		}
		nt := Task{ID: s.newID(), Source: "mcp", Course: a.Course, Title: a.Title, Category: cat,
			TaskType: typeOf[cat], DueAt: a.DueAt, CognitiveLoad: load, LLMMinutes: mins, EstMinutes: mins,
			HumanMinutes: human, Confidence: 0.4, Blocks: blocksFor(eff, st.Rules.BlockMin, st.Rules.MinBlockMin),
			EstSource: src, Status: "open"}
		st.Tasks = append(st.Tasks, nt)
		st.Meta.NeedsReplan = true
		result = map[string]any{"action": "added", "task": nt,
			"note": "the browser's LLM refines the estimate and re-plans on its next sync"}
		return nil
	})
	return result, err
}

type eventArgs struct {
	Title          string `json:"title"`
	Start          string `json:"start"`
	End            string `json:"end"`
	Date           string `json:"date"`
	PreclearCourse string `json:"preclear_course"`
	PreclearBefore string `json:"preclear_before"`
	DropAfterEvent bool   `json:"drop_after_event"`
}

func (s *Server) resolveTime(date, v string) (string, error) {
	if v == "" {
		return "", nil
	}
	if len(v) >= 16 {
		if _, err := parseLocal(v, s.loc); err != nil {
			return "", err
		}
		return v[:16], nil
	}
	if date == "" {
		date = s.now().Format(dateLayout)
	}
	if hm(v) <= 0 && v != "00:00" {
		return "", fmt.Errorf("time must be HH:MM")
	}
	m := hm(v)
	return fmt.Sprintf("%sT%02d:%02d", date, m/60, m%60), nil
}

func (s *Server) toolEvent(a eventArgs) (map[string]any, error) {
	if strings.TrimSpace(a.Title) == "" {
		return nil, fmt.Errorf("title is required")
	}
	start, err := s.resolveTime(a.Date, a.Start)
	if err != nil || start == "" {
		return nil, fmt.Errorf("start must be HH:MM or YYYY-MM-DDTHH:MM")
	}
	end, err := s.resolveTime(start[:10], a.End)
	if err != nil {
		return nil, fmt.Errorf("bad end time")
	}
	var before *time.Time
	if a.PreclearBefore != "" {
		b, err := s.resolveTime(start[:10], a.PreclearBefore)
		if err != nil {
			return nil, fmt.Errorf("bad preclear_before")
		}
		t, _ := parseLocal(b, s.loc)
		before = &t
	}
	var res OverrideResult
	_, _, err = s.store.Update(func(st *State) error {
		var e error
		res, e = ApplyEventOverride(st, Event{Title: a.Title, Kind: "event", Start: start, End: end},
			a.PreclearCourse, before, a.DropAfterEvent, s.now(), s.newID)
		return e
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"event": res.Event, "dropped_blocks": len(res.Dropped), "precleared_tasks": res.Preclear,
		"placed_blocks": res.Placed, "at_risk": res.AtRisk, "sleep_cutoff": res.CutoffHHM}, nil
}

type timerArgs struct {
	Action    string   `json:"action"`
	Bucket    string   `json:"bucket"`
	TaskID    string   `json:"task_id"`
	BlockID   string   `json:"block_id"`
	Minutes   *float64 `json:"minutes"`
	ActualMin *float64 `json:"actual_minutes"`
	Energy    string   `json:"energy"`
	Finished  bool     `json:"finished"`
}

func timerElapsed(t Timer, now time.Time) float64 {
	el := t.ElapsedSec
	if t.State == "running" && t.StartedAt != "" {
		if st, err := time.Parse(time.RFC3339, t.StartedAt); err == nil {
			el += now.Sub(st).Seconds()
		}
	}
	return el
}

func (s *Server) toolTimer(a timerArgs) (map[string]any, error) {
	now := s.now()
	var out map[string]any
	_, _, err := s.store.Update(func(st *State) error {
		st.normalizeWeek(now)
		t := &st.Timer
		switch a.Action {
		case "status":
		case "start":
			if t.State != "idle" {
				return fmt.Errorf("a %s timer is already %s; complete it first", t.Bucket, t.State)
			}
			nt := Timer{State: "running", PlannedMin: st.Rules.BlockMin, StartedAt: now.Format(time.RFC3339)}
			if a.Minutes != nil {
				nt.PlannedMin = int(*a.Minutes)
			}
			if a.BlockID != "" {
				b := st.block(a.BlockID)
				if b == nil {
					return fmt.Errorf("no block %s", a.BlockID)
				}
				nt.BlockID, nt.TaskID, nt.Bucket = b.ID, b.TaskID, b.Bucket
				if a.Minutes == nil {
					nt.PlannedMin = minutesOf(*b, s.loc)
				}
			} else if a.TaskID != "" {
				if st.task(a.TaskID) == nil {
					return fmt.Errorf("no task %s", a.TaskID)
				}
				nt.TaskID, nt.Bucket = a.TaskID, school
			} else {
				nt.Bucket = strings.ToUpper(a.Bucket)
			}
			if st.bucket(nt.Bucket) == nil {
				return fmt.Errorf("unknown bucket %q", a.Bucket)
			}
			*t = nt
		case "pause":
			if t.State != "running" {
				return fmt.Errorf("timer is not running")
			}
			t.ElapsedSec = timerElapsed(*t, now)
			t.State, t.StartedAt = "paused", ""
		case "resume":
			if t.State != "paused" {
				return fmt.Errorf("timer is not paused")
			}
			t.State, t.StartedAt = "running", now.Format(time.RFC3339)
		case "complete":
			if t.State == "idle" {
				return fmt.Errorf("no timer running")
			}
			actual := timerElapsed(*t, now) / 60
			if a.ActualMin != nil {
				actual = *a.ActualMin
			}
			actual = max(1, float64(int(actual*10+0.5))/10)
			energy := a.Energy
			if energy == "" {
				energy = "med"
			}
			outcome := "done"
			if !a.Finished {
				outcome = "need_more"
			} else if actual < float64(t.PlannedMin)-1 {
				outcome = "done_early"
			}
			b := st.bucket(t.Bucket)
			b.LoggedMinutes += actual
			fb := Feedback{Kind: "session", Bucket: t.Bucket, TaskType: "Goal", AIMinutes: float64(t.PlannedMin),
				RealMinutes: actual, Energy: energy, At: now.Format(localLayout)}
			if t.TaskID != "" {
				if task := st.task(t.TaskID); task != nil {
					task.LoggedMinutes += actual
					est := task.EstMinutes
					if task.HumanMinutes != nil {
						est = *task.HumanMinutes
					}
					fb.TaskID, fb.TaskType, fb.Course, fb.AIMinutes = task.ID, task.TaskType, task.Course, float64(est)
					fb.RealMinutes = task.LoggedMinutes
					if a.Finished {
						task.Status = "done"
					}
				}
			}
			if t.BlockID != "" {
				if blk := st.block(t.BlockID); blk != nil {
					blk.Status = "done"
				}
			}
			if a.Finished || t.TaskID == "" {
				st.Feedback = append(st.Feedback, fb)
			}
			st.Sessions = append(st.Sessions, Session{ID: s.newID(), Bucket: t.Bucket, TaskID: t.TaskID,
				PlannedMin: t.PlannedMin, ActualMin: actual, Energy: energy, Outcome: outcome,
				EndedAt: now.Format(localLayout)})
			out = map[string]any{"logged_minutes": actual, "bucket": t.Bucket, "outcome": outcome,
				"bucket_logged_hours": round2(b.LoggedMinutes / 60), "bucket_target_hours": b.TargetHours}
			*t = Timer{State: "idle"}
			st.Meta.NeedsReplan = true
		default:
			return fmt.Errorf("action must be start, pause, resume, complete, or status")
		}
		if out == nil {
			el := timerElapsed(*t, now)
			out = map[string]any{"timer": *t, "elapsed_minutes": round2(el / 60)}
			if t.State != "idle" {
				out["remaining_minutes"] = round2(max(0, float64(t.PlannedMin)-el/60))
			}
		}
		return nil
	})
	return out, err
}

func round2(f float64) float64 { return float64(int(f*100+0.5)) / 100 }

// ------------------------------------------------------------------ extended MCP tools

func (s *Server) toolWeekOverview(startDate string, days int) (map[string]any, error) {
	if days <= 0 || days > 14 {
		days = 7
	}
	now := s.now()
	day := now
	if startDate != "" {
		d, err := time.ParseInLocation(dateLayout, startDate, s.loc)
		if err != nil {
			return nil, fmt.Errorf("start_date must be YYYY-MM-DD")
		}
		day = d
	}
	v, st, err := s.store.Get()
	if err != nil {
		return nil, err
	}
	st.normalizeWeek(now)
	dayList := make([]map[string]any, 0, days)
	for i := 0; i < days; i++ {
		d := day.AddDate(0, 0, i)
		ds := d.Format(dateLayout)
		blks := []Block{}
		mins := 0
		for _, b := range st.Blocks {
			if b.Date == ds {
				blks = append(blks, b)
				if sT, err1 := time.ParseInLocation(localLayout, b.Start, s.loc); err1 == nil {
					if eT, err2 := time.ParseInLocation(localLayout, b.End, s.loc); err2 == nil {
						mins += int(eT.Sub(sT).Minutes())
					}
				}
			}
		}
		evs := []Event{}
		for _, ev := range st.Events {
			if strings.HasPrefix(ev.Start, ds) {
				evs = append(evs, ev)
			}
		}
		dayList = append(dayList, map[string]any{
			"date":         ds,
			"weekday":      d.Weekday().String(),
			"planned_mins": mins,
			"blocks":       blks,
			"events":       evs,
		})
	}
	return map[string]any{"version": v, "days": dayList, "buckets": st.Buckets, "at_risk": st.Meta.AtRisk}, nil
}

func (s *Server) toolMarkTask(taskID, match, status string) (map[string]any, error) {
	if status == "" {
		status = "done"
	}
	if status != "done" && status != "open" {
		return nil, fmt.Errorf("status must be done or open")
	}
	var updated *Task
	_, _, err := s.store.Update(func(st *State) error {
		var target *Task
		if taskID != "" {
			target = st.task(taskID)
		} else if match != "" {
			q := strings.ToLower(match)
			for i := range st.Tasks {
				t := &st.Tasks[i]
				if strings.Contains(strings.ToLower(t.Title+" "+t.Course), q) {
					target = t
					break
				}
			}
		}
		if target == nil {
			return fmt.Errorf("matching task not found")
		}
		target.Status = status
		if status == "done" {
			for i := range st.Blocks {
				if st.Blocks[i].TaskID == target.ID && st.Blocks[i].Status == "planned" {
					st.Blocks[i].Status = "done"
				}
			}
		}
		st.Meta.NeedsReplan = true
		cp := *target
		updated = &cp
		return nil
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"task": updated, "needs_replan": true}, nil
}

type blockArgs struct {
	BlockID string `json:"block_id"`
	Match   string `json:"match"`
	Action  string `json:"action"`
	Date    string `json:"date"`
	Start   string `json:"start"`
	End     string `json:"end"`
}

func (s *Server) toolManageBlock(a blockArgs) (map[string]any, error) {
	var res map[string]any
	_, _, err := s.store.Update(func(st *State) error {
		idx := -1
		for i := range st.Blocks {
			b := &st.Blocks[i]
			if a.BlockID != "" && b.ID == a.BlockID {
				idx = i
				break
			}
			if a.Match != "" && b.Status == "planned" &&
				strings.Contains(strings.ToLower(b.Title+" "+b.Bucket), strings.ToLower(a.Match)) {
				idx = i
				break
			}
		}
		if idx < 0 {
			return fmt.Errorf("matching block not found")
		}
		b := &st.Blocks[idx]
		switch a.Action {
		case "pin":
			b.Locked = true
		case "unpin":
			b.Locked = false
		case "cancel":
			removed := *b
			st.Blocks = append(st.Blocks[:idx], st.Blocks[idx+1:]...)
			st.Meta.NeedsReplan = true
			res = map[string]any{"cancelled": removed, "needs_replan": true}
			return nil
		case "move":
			if a.Date == "" || a.Start == "" {
				return fmt.Errorf("date and start (HH:MM) are required for move")
			}
			ns, err := time.ParseInLocation(localLayout, a.Date+"T"+a.Start, s.loc)
			if err != nil {
				return fmt.Errorf("invalid date or start time")
			}
			dur := 45 * time.Minute
			if oldS, err1 := time.ParseInLocation(localLayout, b.Start, s.loc); err1 == nil {
				if oldE, err2 := time.ParseInLocation(localLayout, b.End, s.loc); err2 == nil && oldE.After(oldS) {
					dur = oldE.Sub(oldS)
				}
			}
			ne := ns.Add(dur)
			if a.End != "" {
				parsedEnd, err := time.ParseInLocation(localLayout, a.Date+"T"+a.End, s.loc)
				if err != nil || !parsedEnd.After(ns) {
					return fmt.Errorf("invalid end time")
				}
				ne = parsedEnd
			}
			b.Date = a.Date
			b.Start = ns.Format(localLayout)
			b.End = ne.Format(localLayout)
			b.Locked = true
		default:
			return fmt.Errorf("action must be move, pin, unpin, or cancel")
		}
		st.Meta.NeedsReplan = true
		res = map[string]any{"block": *b, "needs_replan": true}
		return nil
	})
	return res, err
}

func (s *Server) toolSetBucket(key string, targetHours, load *float64) (map[string]any, error) {
	if strings.TrimSpace(key) == "" {
		return nil, fmt.Errorf("bucket is required")
	}
	var updated Bucket
	_, _, err := s.store.Update(func(st *State) error {
		b := st.bucket(strings.ToUpper(strings.TrimSpace(key)))
		if targetHours != nil {
			if *targetHours < 0 || *targetHours > 40 {
				return fmt.Errorf("target_hours must be 0-40")
			}
			b.TargetHours = *targetHours
		}
		if load != nil {
			l := int(*load + 0.5)
			if l < 1 || l > 5 {
				return fmt.Errorf("cognitive_load must be 1-5")
			}
			b.Load = l
		}
		st.Meta.NeedsReplan = true
		updated = *b
		return nil
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"bucket": updated, "needs_replan": true}, nil
}

func (s *Server) toolCheckIn(mood float64, note string) (map[string]any, error) {
	m := int(mood + 0.5)
	if m < 1 || m > 5 {
		return nil, fmt.Errorf("mood must be 1-5")
	}
	now := s.now()
	mode := "steady"
	_, _, err := s.store.Update(func(st *State) error {
		mom := map[string]any{"fastHit": 0.75, "slowHit": 0.75, "streakMiss": 0, "checkins": []any{}}
		if len(st.Momentum) > 0 {
			_ = json.Unmarshal(st.Momentum, &mom)
		}
		list, _ := mom["checkins"].([]any)
		entry := map[string]any{"at": now.Format(localLayout), "mood": m}
		if note != "" {
			entry["note"] = note
		}
		list = append(list, entry)
		if len(list) > 30 {
			list = list[len(list)-30:]
		}
		mom["checkins"] = list
		if m <= 1 {
			mode = "lighter"
		} else if m == 2 {
			mode = "stretched"
		} else if m >= 4 {
			mode = "rolling"
		}
		mom["lastMcpMode"] = mode
		raw, _ := json.Marshal(mom)
		st.Momentum = raw
		st.Meta.NeedsReplan = true
		return nil
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"mood": m, "suggested_mode": mode, "at": now.Format(localLayout)}, nil
}

func (s *Server) toolMomentumAndSessions(limit int) (map[string]any, error) {
	if limit <= 0 || limit > 50 {
		limit = 15
	}
	v, st, err := s.store.Get()
	if err != nil {
		return nil, err
	}
	sessions := st.Sessions
	if len(sessions) > limit {
		sessions = sessions[len(sessions)-limit:]
	}
	var mom any
	if len(st.Momentum) > 0 {
		_ = json.Unmarshal(st.Momentum, &mom)
	}
	return map[string]any{
		"version":       v,
		"momentum":      mom,
		"sessions":      sessions,
		"feedback_wait": len(st.Feedback),
		"integrations":  s.integ.Status(),
	}, nil
}

type rulesArgs struct {
	AfterSchoolMin *int    `json:"after_school_min"`
	BreakMin       *int    `json:"break_min"`
	BlockMin       *int    `json:"block_min"`
	DinnerStart    *string `json:"dinner_start"`
	DinnerMin      *int    `json:"dinner_min"`
	SleepCutoff    *string `json:"sleep_cutoff"`
	SchoolStart    *string `json:"school_start"`
	SchoolEnd      *string `json:"school_end"`
	PreclearHours  *int    `json:"preclear_hours"`
}

func (s *Server) toolUpdateRules(a rulesArgs) (map[string]any, error) {
	var out Rules
	changed := false
	_, _, err := s.store.Update(func(st *State) error {
		r := &st.Rules
		if a.AfterSchoolMin != nil {
			r.AfterSchoolMin = *a.AfterSchoolMin
			changed = true
		}
		if a.BreakMin != nil {
			r.BreakMin = *a.BreakMin
			changed = true
		}
		if a.BlockMin != nil {
			r.BlockMin = *a.BlockMin
			changed = true
		}
		if a.DinnerStart != nil {
			r.DinnerStart = *a.DinnerStart
			changed = true
		}
		if a.DinnerMin != nil {
			r.DinnerMin = *a.DinnerMin
			changed = true
		}
		if a.SleepCutoff != nil {
			r.SleepCutoff = *a.SleepCutoff
			changed = true
		}
		if a.SchoolStart != nil {
			r.SchoolStart = *a.SchoolStart
			changed = true
		}
		if a.SchoolEnd != nil {
			r.SchoolEnd = *a.SchoolEnd
			changed = true
		}
		if a.PreclearHours != nil {
			r.PreclearHours = *a.PreclearHours
			changed = true
		}
		if changed {
			st.Meta.NeedsReplan = true
		}
		out = *r
		return nil
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"rules": out, "updated": changed}, nil
}

// ------------------------------------------------------------------ MCP resources & prompts

var mcpResources = []map[string]any{
	{"uri": "study://schedule/today", "name": "Today's Schedule & Buffers", "mimeType": "application/json",
		"description": "Today's study blocks, protected buffers (school, snack break, dinner, sleep), and active timer."},
	{"uri": "study://briefing/today", "name": "Daily Gemini Briefing", "mimeType": "application/json",
		"description": "One-shot daily context: today's blocks, free slots, grades, top Canvas ROI opportunities, and weak problem topics."},
	{"uri": "study://tasks/matrix", "name": "Task Estimation Matrix", "mimeType": "application/json",
		"description": "Open tasks with AI/human time estimates, cognitive load, and due dates."},
	{"uri": "study://buckets/summary", "name": "Weekly Buckets", "mimeType": "application/json",
		"description": "Weekly target and logged hours for AIME, USAAIO, RESEARCH, ACT, and PHYSICS."},
	{"uri": "study://grades/current", "name": "Current Canvas Grades & Flags", "mimeType": "application/json",
		"description": "Current Canvas course scores/grades and active missing or zero flags."},
	{"uri": "study://problems/weak-topics", "name": "Weak Problem-Set Topics", "mimeType": "application/json",
		"description": "Aggregated topic accuracy from logged competition problem sets."},
	{"uri": "study://rules", "name": "Scheduling Rules & Breaks", "mimeType": "application/json",
		"description": "School hours, after-school break, between-block break, dinner, sleep cutoff, and quiet windows."},
}

func (s *Server) readResource(uri string) (map[string]any, error) {
	var payload any
	switch uri {
	case "study://schedule/today":
		d, err := s.toolGetSchedule("")
		if err != nil {
			return nil, err
		}
		payload = map[string]any{"date": d["date"], "blocks": d["blocks"], "protected": d["protected"], "timer": d["timer"]}
	case "study://briefing/today":
		d, err := s.toolDailyBriefing("")
		if err != nil {
			return nil, err
		}
		payload = d
	case "study://tasks/matrix":
		d, err := s.toolGetSchedule("")
		if err != nil {
			return nil, err
		}
		payload = d["task_estimation_matrix"]
	case "study://buckets/summary":
		d, err := s.toolGetSchedule("")
		if err != nil {
			return nil, err
		}
		payload = d["buckets"]
	case "study://grades/current":
		_, st, err := s.store.Get()
		if err != nil {
			return nil, err
		}
		payload = map[string]any{"grades": st.Grades, "flags": st.Flags}
	case "study://problems/weak-topics":
		d, err := s.toolGetNextProblems("")
		if err != nil {
			return nil, err
		}
		payload = d
	case "study://rules":
		_, st, err := s.store.Get()
		if err != nil {
			return nil, err
		}
		payload = st.Rules
	default:
		return nil, fmt.Errorf("unknown resource: %s", uri)
	}
	b, _ := json.MarshalIndent(payload, "", "  ")
	return map[string]any{"contents": []map[string]any{{"uri": uri, "mimeType": "application/json", "text": string(b)}}}, nil
}

var mcpPrompts = []map[string]any{
	{"name": "morning_check_in", "description": "Load today's full briefing, highlight quiet windows and top grade-ROI items, and confirm today's plan."},
	{"name": "plan_tonight", "description": "Inspect today's schedule, at-risk tasks, and momentum, then propose an evening study plan."},
	{"name": "catch_up_after_miss", "description": "Clear missed planned blocks, find remaining free slots, and replan around what actually happened today."},
	{"name": "weekend_sprint", "description": "Plan high-impact competition (AIME/USAAIO/Physics) and Canvas catch-up blocks across weekend free slots."},
	{"name": "triage_inbox", "description": "Review unread Discord, email, and screenshot items and suggest tasks, events, or email drafts."},
	{"name": "exam_prep_plan", "description": "Check Canvas for upcoming tests/quizzes and allocate prep blocks across the week."},
	{"name": "competition_coach", "description": "Build a concrete study plan, pull research/references, and assign worksheets for AIME, USAAIO, or Research goals."},
}

func (s *Server) getPrompt(name string, _ map[string]string) (map[string]any, error) {
	prompts := map[string]string{
		"morning_check_in": "Call get_daily_briefing(). Summarize today's blocks, highlight quiet home-alone windows and the top grade-ROI Canvas opportunities, " +
			"surface the weakest competition topic from problem_next_step, and ask if any events changed today.",
		"plan_tonight": "Call get_schedule_and_buckets and get_momentum_and_sessions. Summarize what is scheduled tonight, " +
			"flag any at-risk deadlines, respect the 45-min after-school break, dinner, and 10:30 PM sleep cutoff, and propose next steps.",
		"catch_up_after_miss": "Call reschedule_missed_blocks() and find_free_slots(days=2). Re-anchor the rest of today without guilt, " +
			"prioritize any at-risk deadlines or high-ROI zero/EC items via triage_canvas_opportunities, and confirm the updated blocks.",
		"weekend_sprint": "Call get_week_overview(), find_free_slots(days=3, min_minutes=30), and get_next_problems(). " +
			"Allocate quiet high-load blocks for weak competition topics and clear open Canvas work.",
		"triage_inbox": "Call list_inbox(status='new', source='any') and propose which items should become tasks, calendar events " +
			"(via apply_event_override), or reply drafts (via draft_email — never send automatically).",
		"exam_prep_plan": "Call canvas_explore(what='assignments') and get_week_overview(). Identify upcoming exams/quizzes and " +
			"recommend spaced prep blocks or estimate overrides.",
		"competition_coach": "Call plan_competition_goal and get_study_resources for the student's target (e.g. AIME score 8, " +
			"USAAIO Round 2, or RESEARCH milestones via manage_research_milestone), then verify weekly hours with get_schedule_and_buckets.",
	}
	txt, ok := prompts[name]
	if !ok {
		return nil, fmt.Errorf("unknown prompt: %s", name)
	}
	return map[string]any{
		"description": name,
		"messages": []map[string]any{
			{"role": "user", "content": map[string]any{"type": "text", "text": txt}},
		},
	}, nil
}
