package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

var la, _ = time.LoadLocation("America/Los_Angeles")

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) Now() time.Time      { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *fakeClock) Add(d time.Duration) { c.mu.Lock(); c.t = c.t.Add(d); c.mu.Unlock() }
func ptr[T any](v T) *T                  { return &v }
func mustJSON(t *testing.T, v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// Thursday 2026-11-19 15:00 local: school just ended.
func newTestServer(t *testing.T, cfg Config) (*Server, *fakeClock, string) {
	t.Helper()
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "relay.db")
	store, err := OpenStore(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	clock := &fakeClock{t: time.Date(2026, 11, 19, 15, 0, 0, 0, la)}
	if cfg.CanvasBase == "" {
		cfg.CanvasBase = "https://esuhsd.instructure.com"
	}
	s := NewServer(store, cfg, la, clock.Now)
	st := DefaultState()
	st.Tasks = []Task{
		{ID: "phys", Course: "AP Physics C: Mechanics", Title: "Ch. 7 Problem Set", Category: "homework",
			TaskType: "HW", DueAt: "2026-11-20T23:59", CognitiveLoad: 4, LLMMinutes: 40, EstMinutes: 40, Status: "open"},
		{ID: "calc", Course: "AP Calculus BC", Title: "6.4 Homework", Category: "homework",
			TaskType: "HW", DueAt: "2026-11-20T23:59", CognitiveLoad: 4, LLMMinutes: 50, EstMinutes: 50, Status: "open"},
		{ID: "essay", Course: "AP English Language", Title: "Rhetorical Analysis Essay", Category: "project",
			TaskType: "Project", DueAt: "2026-11-23T23:59", CognitiveLoad: 4, LLMMinutes: 180, EstMinutes: 180, Status: "open"},
	}
	st.Blocks = []Block{
		{ID: "b1", Date: "2026-11-19", Start: "2026-11-19T16:15", End: "2026-11-19T17:00", Kind: "bucket", Bucket: "AIME", Title: "AIME", Status: "planned"},
		{ID: "b2", Date: "2026-11-19", Start: "2026-11-19T20:30", End: "2026-11-19T21:15", Kind: "task", TaskID: "phys", Bucket: school, Title: "Physics", Status: "planned"},
		{ID: "b3", Date: "2026-11-19", Start: "2026-11-19T21:25", End: "2026-11-19T22:15", Kind: "task", TaskID: "calc", Bucket: school, Title: "Calc", Status: "planned"},
		{ID: "b4", Date: "2026-11-20", Start: "2026-11-20T16:15", End: "2026-11-20T17:00", Kind: "bucket", Bucket: "USAAIO", Title: "USAAIO", Status: "planned"},
	}
	if _, err := store.Put(0, st); err != nil {
		t.Fatal(err)
	}
	return s, clock, dbPath
}

func rpc(t *testing.T, h http.Handler, body string) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest("POST", "/mcp", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	var out map[string]any
	if rec.Body.Len() > 0 && rec.Body.Bytes()[0] == '{' {
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatalf("bad json %s", rec.Body.String())
		}
	}
	return rec.Code, out
}

func callTool(t *testing.T, h http.Handler, name string, args any) (map[string]any, bool) {
	t.Helper()
	body := string(mustJSON(t, map[string]any{"jsonrpc": "2.0", "id": 7, "method": "tools/call",
		"params": map[string]any{"name": name, "arguments": args}}))
	code, out := rpc(t, h, body)
	if code != 200 {
		t.Fatalf("status %d", code)
	}
	res, ok := out["result"].(map[string]any)
	if !ok {
		t.Fatalf("no result: %v", out)
	}
	isErr, _ := res["isError"].(bool)
	sc, _ := res["structuredContent"].(map[string]any)
	if isErr {
		content := res["content"].([]any)[0].(map[string]any)
		return map[string]any{"error": content["text"]}, true
	}
	return sc, false
}

func TestMCPHandshake(t *testing.T) {
	s, _, _ := newTestServer(t, Config{})
	h := s.Routes()
	_, out := rpc(t, h, `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"claude-code","version":"x"}}}`)
	res := out["result"].(map[string]any)
	if res["protocolVersion"] != "2025-03-26" {
		t.Fatalf("protocol not negotiated: %v", res)
	}
	if res["serverInfo"].(map[string]any)["name"] != "study-relay" {
		t.Fatal("serverInfo")
	}
	if code, _ := rpc(t, h, `{"jsonrpc":"2.0","method":"notifications/initialized"}`); code != 202 {
		t.Fatalf("notification should be 202, got %d", code)
	}
	_, out = rpc(t, h, `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
	names := []string{}
	for _, tl := range out["result"].(map[string]any)["tools"].([]any) {
		m := tl.(map[string]any)
		names = append(names, m["name"].(string))
		if m["inputSchema"].(map[string]any)["type"] != "object" {
			t.Fatal("schema must be an object")
		}
	}
	want := "get_schedule_and_buckets,add_or_override_task,apply_event_override,control_study_timer,canvas_explore,get_grades,list_inbox,draft_email,get_week_overview,mark_task_done,manage_block,set_bucket_target,check_in_mood,get_momentum_and_sessions,update_rules_and_breaks,manage_research_milestone,plan_competition_goal,get_study_resources,get_counselor_digest,apply_school_preset,get_audit_log,set_recurring_schedule,batch_update_schedule,replan_now,triage_canvas_opportunities,log_problem_set,get_next_problems,swap_block_focus,get_daily_briefing,find_free_slots,reschedule_missed_blocks,search_tasks,delete_task_or_event,get_assignment_details"
	if strings.Join(names, ",") != want {
		t.Fatalf("tools = %v", names)
	}
	for _, rawT := range out["result"].(map[string]any)["tools"].([]any) {
		m := rawT.(map[string]any)
		ann := m["annotations"].(map[string]any)
		if m["name"] == "get_daily_briefing" && ann["readOnlyHint"] != true {
			t.Fatalf("expected get_daily_briefing readOnlyHint=true, got %v", ann)
		}
	}
	_, out = rpc(t, h, `{"jsonrpc":"2.0","id":3,"method":"nope"}`)
	if out["error"].(map[string]any)["code"].(float64) != -32601 {
		t.Fatal("expected method not found")
	}
	_, out = rpc(t, h, `{not json`)
	if out["error"].(map[string]any)["code"].(float64) != -32700 {
		t.Fatal("expected parse error")
	}
	_, out = rpc(t, h, `{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"rm_rf","arguments":{}}}`)
	if out["error"].(map[string]any)["code"].(float64) != -32602 {
		t.Fatal("unknown tool should be invalid params")
	}
	// batch
	req := httptest.NewRequest("POST", "/mcp", strings.NewReader(`[{"jsonrpc":"2.0","id":5,"method":"ping"},{"jsonrpc":"2.0","method":"notifications/x"}]`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	var batch []map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &batch)
	if len(batch) != 1 || batch[0]["id"].(float64) != 5 {
		t.Fatalf("batch = %s", rec.Body.String())
	}
}

func TestGetScheduleAndBuckets(t *testing.T) {
	s, _, _ := newTestServer(t, Config{})
	out, isErr := callTool(t, s.Routes(), "get_schedule_and_buckets", map[string]any{})
	if isErr {
		t.Fatal(out)
	}
	if out["date"] != "2026-11-19" || len(out["blocks"].([]any)) != 3 {
		t.Fatalf("blocks: %v", out["blocks"])
	}
	keys := []string{}
	for _, b := range out["buckets"].([]any) {
		keys = append(keys, b.(map[string]any)["key"].(string))
	}
	if strings.Join(keys, ",") != "AIME,USAAIO,RESEARCH,ACT,PHYSICS,SCHOOL" {
		t.Fatalf("buckets %v", keys)
	}
	found := false
	for _, f := range out["protected"].([]any) {
		m := f.(map[string]any)
		if m["kind"] == "dinner" && m["start"] == "2026-11-19T19:00" && m["end"] == "2026-11-19T20:30" {
			found = true
		}
	}
	if !found {
		t.Fatal("dinner block missing")
	}
	if len(out["task_estimation_matrix"].([]any)) != 3 {
		t.Fatal("matrix")
	}
}

func TestAddOrOverrideTask(t *testing.T) {
	s, _, _ := newTestServer(t, Config{})
	h := s.Routes()
	out, isErr := callTool(t, h, "add_or_override_task", map[string]any{"match": "physics", "estimated_minutes": 70, "cognitive_load": 5})
	if isErr || out["action"] != "override" {
		t.Fatal(out)
	}
	_, st, _ := s.store.Get()
	p := st.task("phys")
	if p.HumanMinutes == nil || *p.HumanMinutes != 70 || p.CognitiveLoad != 5 || p.EstSource != "human" {
		t.Fatalf("override not stored: %+v", p)
	}
	if len(st.Feedback) != 1 || st.Feedback[0].AIMinutes != 40 || st.Feedback[0].RealMinutes != 70 {
		t.Fatalf("feedback %+v", st.Feedback)
	}
	if !st.Meta.NeedsReplan {
		t.Fatal("needs replan")
	}
	out, isErr = callTool(t, h, "add_or_override_task", map[string]any{"title": "Robotics write-up", "course": "Engineering", "category": "project", "due_at": "2026-11-24T23:59"})
	if isErr || out["action"] != "added" {
		t.Fatal(out)
	}
	if _, isErr = callTool(t, h, "add_or_override_task", map[string]any{"task_id": "phys", "estimated_minutes": 2}); !isErr {
		t.Fatal("2 minutes should be rejected")
	}
	if _, isErr = callTool(t, h, "add_or_override_task", map[string]any{"match": "AP"}); !isErr {
		t.Fatal("ambiguous match should fail")
	}
}

func TestEventOverrideBanquet(t *testing.T) {
	s, _, _ := newTestServer(t, Config{})
	out, isErr := callTool(t, s.Routes(), "apply_event_override", map[string]any{
		"title": "Banquet", "start": "18:30", "preclear_course": "physics", "preclear_before": "17:00"})
	if isErr {
		t.Fatal(out)
	}
	_, st, _ := s.store.Get()
	physMin, calcMin := 0, 0
	for _, b := range st.Blocks {
		if err := ValidateBlock(st.Rules, st.Events, b, la); err != nil && b.Status == "planned" {
			t.Fatalf("block violates buffers: %+v: %v", b, err)
		}
		if b.Date == "2026-11-19" && b.End > "2026-11-19T18:00" {
			t.Fatalf("study after get-ready time on banquet night: %+v", b)
		}
		if b.End > b.Date+"T22:30" {
			t.Fatalf("past sleep cutoff: %+v", b)
		}
		switch b.TaskID {
		case "phys":
			physMin += minutesOf(b, la)
			if b.End > "2026-11-19T17:00" {
				t.Fatalf("physics must be done by 17:00: %+v", b)
			}
		case "calc":
			calcMin += minutesOf(b, la)
		}
	}
	if physMin != 40 {
		t.Fatalf("physics minutes before 5 = %d", physMin)
	}
	// 17:10-18:00 leaves 50 min: calc fits exactly before the get-ready time.
	if calcMin != 50 {
		t.Fatalf("calc minutes = %d", calcMin)
	}
	if st.task("phys").PreclearBy != "2026-11-19T17:00" || st.task("calc").PreclearBy != "2026-11-19T18:00" {
		t.Fatal("preclear deadlines")
	}
	if st.task("essay").PreclearBy != "" {
		t.Fatal("essay is not due by tomorrow")
	}
	if len(st.Events) != 2 || st.Events[1].Kind != "blackout" || st.Events[1].End != "2026-11-19T22:30" {
		t.Fatalf("events %+v", st.Events)
	}
	if st.block("b4") == nil {
		t.Fatal("tomorrow's block must survive")
	}
	if !st.Meta.NeedsReplan {
		t.Fatal("needs replan")
	}
}

func TestEventOverrideReportsWhatDoesNotFit(t *testing.T) {
	s, clock, _ := newTestServer(t, Config{})
	clock.Add(2*time.Hour + 30*time.Minute) // 17:30: only 30 minutes before the 18:00 get-ready time
	out, isErr := callTool(t, s.Routes(), "apply_event_override", map[string]any{"title": "Banquet", "start": "18:30"})
	if isErr {
		t.Fatal(out)
	}
	risk := out["at_risk"].([]any)
	if len(risk) == 0 {
		t.Fatal("expected at-risk work")
	}
	_, st, _ := s.store.Get()
	for _, b := range st.Blocks {
		if b.Date == "2026-11-19" && b.End > "2026-11-19T18:00" {
			t.Fatalf("late block survived: %+v", b)
		}
	}
}

func TestStudyTimer(t *testing.T) {
	s, clock, _ := newTestServer(t, Config{})
	h := s.Routes()
	if out, isErr := callTool(t, h, "control_study_timer", map[string]any{"action": "start", "bucket": "aime"}); isErr {
		t.Fatal(out)
	}
	if _, isErr := callTool(t, h, "control_study_timer", map[string]any{"action": "start", "bucket": "ACT"}); !isErr {
		t.Fatal("second start should fail")
	}
	clock.Add(30 * time.Minute)
	callTool(t, h, "control_study_timer", map[string]any{"action": "pause"})
	clock.Add(20 * time.Minute) // paused time is not counted
	callTool(t, h, "control_study_timer", map[string]any{"action": "resume"})
	clock.Add(15 * time.Minute)
	st, _ := callTool(t, h, "control_study_timer", map[string]any{"action": "status"})
	if st["elapsed_minutes"].(float64) != 45 {
		t.Fatalf("elapsed %v", st["elapsed_minutes"])
	}
	out, isErr := callTool(t, h, "control_study_timer", map[string]any{"action": "complete", "energy": "high"})
	if isErr || out["logged_minutes"].(float64) != 45 || out["bucket"] != "AIME" || out["outcome"] != "done" {
		t.Fatal(out)
	}
	_, state, _ := s.store.Get()
	if state.bucket("AIME").LoggedMinutes != 45 || len(state.Sessions) != 1 || state.Timer.State != "idle" {
		t.Fatalf("not logged: %+v", state.bucket("AIME"))
	}
	if fb := state.Feedback[len(state.Feedback)-1]; fb.Kind != "session" || fb.RealMinutes != 45 {
		t.Fatalf("feedback %+v", fb)
	}
	// Tier 1 task via block: logs to SCHOOL and closes the task
	callTool(t, h, "control_study_timer", map[string]any{"action": "start", "block_id": "b2"})
	clock.Add(35 * time.Minute)
	out, _ = callTool(t, h, "control_study_timer", map[string]any{"action": "complete"})
	if out["bucket"] != school || out["outcome"] != "done_early" {
		t.Fatal(out)
	}
	_, state, _ = s.store.Get()
	if state.task("phys").Status != "done" || state.block("b2").Status != "done" {
		t.Fatal("task/block not closed")
	}
	if _, isErr := callTool(t, h, "control_study_timer", map[string]any{"action": "complete"}); !isErr {
		t.Fatal("complete with no timer should fail")
	}
}

func TestSSETransport(t *testing.T) {
	s, _, _ := newTestServer(t, Config{})
	ts := httptest.NewServer(s.Routes())
	defer ts.Close()
	resp, err := http.Get(ts.URL + "/mcp/sse")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	rd := bufio.NewReader(resp.Body)
	readEvent := func() (string, string) {
		var ev, data string
		for {
			line, err := rd.ReadString('\n')
			if err != nil {
				t.Fatal(err)
			}
			line = strings.TrimRight(line, "\n")
			switch {
			case strings.HasPrefix(line, "event: "):
				ev = line[7:]
			case strings.HasPrefix(line, "data: "):
				data = line[6:]
			case line == "" && ev != "":
				return ev, data
			}
		}
	}
	ev, endpoint := readEvent()
	if ev != "endpoint" || !strings.HasPrefix(endpoint, "/mcp?sessionId=") {
		t.Fatalf("endpoint event: %s %s", ev, endpoint)
	}
	r, err := http.Post(ts.URL+endpoint, "application/json", strings.NewReader(`{"jsonrpc":"2.0","id":9,"method":"tools/list"}`))
	if err != nil || r.StatusCode != 202 {
		t.Fatalf("post: %v %v", err, r.StatusCode)
	}
	ev, data := readEvent()
	if ev != "message" || !strings.Contains(data, "apply_event_override") || !strings.Contains(data, `"id":9`) {
		t.Fatalf("message event: %s", data)
	}
}

func TestCanvasProxy(t *testing.T) {
	var gotAuth, gotPath string
	canvas := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth, gotPath = r.Header.Get("Authorization"), r.URL.RequestURI()
		if strings.HasSuffix(r.URL.Path, ".ics") {
			w.Header().Set("Content-Type", "text/calendar")
			_, _ = io.WriteString(w, "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n")
			return
		}
		if r.Header.Get("Authorization") != "Bearer secret-token" {
			w.WriteHeader(401)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Link", `<`+"http://"+r.Host+`/api/v1/courses?page=2>; rel="next", <x>; rel="last"`)
		_, _ = io.WriteString(w, `[{"id":1,"name":"AP Physics C"}]`)
	}))
	defer canvas.Close()
	s, _, dbPath := newTestServer(t, Config{CanvasBase: canvas.URL})
	h := s.Routes()
	post := func(body, auth string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("POST", "/api/canvas/proxy", strings.NewReader(body))
		if auth != "" {
			req.Header.Set("Authorization", auth)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}
	rec := post(`{"path":"/api/v1/courses?enrollment_state=active"}`, "Bearer secret-token")
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "AP Physics C") {
		t.Fatalf("proxy: %d %s", rec.Code, rec.Body.String())
	}
	if gotAuth != "Bearer secret-token" || gotPath != "/api/v1/courses?enrollment_state=active" {
		t.Fatalf("forwarded %q %q", gotAuth, gotPath)
	}
	if next := rec.Header().Get("X-Canvas-Next"); !strings.HasSuffix(next, "/api/v1/courses?page=2") {
		t.Fatalf("next link %q", next)
	}
	if rec := post(`{"path":"/api/v1/courses"}`, "Bearer wrong"); rec.Code != 401 {
		t.Fatalf("canvas 401 must pass through, got %d", rec.Code)
	}
	if rec := post(`{"url":"`+canvas.URL+`/api/v1/courses?page=2"}`, "Bearer secret-token"); rec.Code != 200 {
		t.Fatalf("pagination url: %d", rec.Code)
	}
	rec = post(`{"ics_url":"`+canvas.URL+`/feeds/calendars/user_abc.ics"}`, "Bearer secret-token")
	if rec.Code != 200 || gotAuth != "" || !strings.Contains(rec.Body.String(), "VCALENDAR") {
		t.Fatalf("ics: %d auth=%q", rec.Code, gotAuth)
	}
	for _, bad := range []string{
		`{"path":"/login/oauth2/token"}`,
		`{"path":"/api/v1/../../etc/passwd"}`,
		`{"url":"https://evil.example.com/api/v1/courses"}`,
		`{"ics_url":"https://evil.example.com/x.ics"}`,
		`{}`,
	} {
		if rec := post(bad, "Bearer secret-token"); rec.Code != 400 {
			t.Fatalf("%s should be rejected, got %d", bad, rec.Code)
		}
	}
	// credentials never touch disk
	s.store.Close()
	for _, p := range []string{dbPath, dbPath + "-wal"} {
		raw, _ := os.ReadFile(p)
		if bytes.Contains(raw, []byte("secret-token")) {
			t.Fatalf("token found in %s", p)
		}
	}
}

func TestSyncVersioning(t *testing.T) {
	s, _, _ := newTestServer(t, Config{})
	h := s.Routes()
	get := httptest.NewRecorder()
	h.ServeHTTP(get, httptest.NewRequest("GET", "/api/sync", nil))
	var cur struct {
		Version int64  `json:"version"`
		State   *State `json:"state"`
	}
	_ = json.Unmarshal(get.Body.Bytes(), &cur)
	if cur.Version != 1 || len(cur.State.Tasks) != 3 {
		t.Fatalf("get: %s", get.Body.String())
	}
	cur.State.Buckets[0].TargetHours = 8
	cur.State.CfC = json.RawMessage(`{"weights":[0.1,0.2],"updates":3}`)
	post := func(base int64) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("POST", "/api/sync",
			bytes.NewReader(mustJSON(t, map[string]any{"base_version": base, "state": cur.State}))))
		return rec
	}
	if rec := post(1); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"version":2`) {
		t.Fatalf("post: %d %s", rec.Code, rec.Body.String())
	}
	if rec := post(1); rec.Code != 409 || !strings.Contains(rec.Body.String(), `"version":2`) {
		t.Fatalf("stale write must conflict: %d", rec.Code)
	}
	_, st, _ := s.store.Get()
	if st.Buckets[0].TargetHours != 8 || !strings.Contains(string(st.CfC), `"updates":3`) {
		t.Fatal("state or CfC weights not persisted")
	}
	big := DefaultState()
	big.Tasks = []Task{{ID: "x", Title: strings.Repeat("a", maxStateBytes+10)}}
	cur.State = big
	if rec := post(2); rec.Code != 400 {
		t.Fatalf("oversized state should be rejected, got %d", rec.Code)
	}
}

func TestBufferRules(t *testing.T) {
	r := DefaultState().Rules
	b := func(s, e string) Block { return Block{Start: "2026-11-19T" + s, End: "2026-11-19T" + e} }
	for _, bad := range []Block{b("15:00", "15:45"), b("15:45", "16:15"), b("18:45", "19:30"),
		b("19:30", "20:00"), b("22:00", "22:45"), b("10:00", "10:45")} {
		if ValidateBlock(r, nil, bad, la) == nil {
			t.Fatalf("%v should be rejected", bad)
		}
	}
	for _, ok := range []Block{b("16:15", "17:00"), b("20:30", "21:15"), b("21:45", "22:30")} {
		if err := ValidateBlock(r, nil, ok, la); err != nil {
			t.Fatalf("%v: %v", ok, err)
		}
	}
	day := time.Date(2026, 11, 19, 0, 0, 0, 0, la)
	gaps := FreeGaps(r, day, nil, nil, day)
	got := []string{}
	for _, g := range gaps {
		got = append(got, g.s.Format("15:04")+"-"+g.e.Format("15:04"))
	}
	if strings.Join(got, ",") != "16:15-19:00,20:30-22:30" {
		t.Fatalf("weekday gaps %v", got)
	}
	sat := time.Date(2026, 11, 21, 0, 0, 0, 0, la)
	if g := FreeGaps(r, sat, nil, nil, sat); g[0].s.Format("15:04") != "09:00" {
		t.Fatal("weekend start")
	}
}

func TestSecurityGuards(t *testing.T) {
	s, _, _ := newTestServer(t, Config{Token: "relay-secret"})
	h := s.Routes()
	req := httptest.NewRequest("POST", "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"ping"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 401 {
		t.Fatalf("missing token should be 401, got %d", rec.Code)
	}
	req = httptest.NewRequest("POST", "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"ping"}`))
	req.Header.Set("Authorization", "Bearer relay-secret")
	req.Header.Set("Origin", "https://evil.example.com")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 403 {
		t.Fatalf("foreign origin should be 403, got %d", rec.Code)
	}
	req.Header.Del("Origin")
	req.Body = io.NopCloser(strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"ping"}`))
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("authorised ping: %d", rec.Code)
	}

	// Standard MCP OAuth 2.1 + PKCE + Dynamic Client Registration flow.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("POST", "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"ping"}`)))
	if rec.Code != 401 || !strings.Contains(rec.Header().Get("WWW-Authenticate"), "oauth-protected-resource") {
		t.Fatalf("expected WWW-Authenticate on 401: code=%d hdr=%q", rec.Code, rec.Header().Get("WWW-Authenticate"))
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/.well-known/oauth-authorization-server", nil))
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "/oauth/token") {
		t.Fatalf("oauth metadata: %d %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("POST", "/oauth/register", strings.NewReader(`{"client_name":"Gemini","redirect_uris":["https://gemini.google.com/callback"]}`)))
	if rec.Code != 201 {
		t.Fatalf("oauth register: %d %s", rec.Code, rec.Body.String())
	}
	var reg map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &reg)
	verifier := "pkce-verifier-1234567890"
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])

	form := url.Values{
		"client_id":             {reg["client_id"].(string)},
		"redirect_uri":          {"https://gemini.google.com/callback"},
		"state":                 {"st1"},
		"code_challenge":        {challenge},
		"code_challenge_method": {"S256"},
		"relay_token":           {"relay-secret"},
	}
	authReq := httptest.NewRequest("POST", "/oauth/authorize", strings.NewReader(form.Encode()))
	authReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, authReq)
	if rec.Code != 302 {
		t.Fatalf("oauth authorize: %d %s", rec.Code, rec.Body.String())
	}
	loc, _ := url.Parse(rec.Header().Get("Location"))
	code := loc.Query().Get("code")

	tokForm := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {"https://gemini.google.com/callback"},
		"code_verifier": {verifier},
	}
	tokReq := httptest.NewRequest("POST", "/oauth/token", strings.NewReader(tokForm.Encode()))
	tokReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, tokReq)
	if rec.Code != 200 {
		t.Fatalf("oauth token: %d %s", rec.Code, rec.Body.String())
	}
	var tokResp map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &tokResp)

	mcpReq := httptest.NewRequest("POST", "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"ping"}`))
	mcpReq.Header.Set("Authorization", "Bearer "+tokResp["access_token"].(string))
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, mcpReq)
	if rec.Code != 200 {
		t.Fatalf("oauth bearer ping: %d %s", rec.Code, rec.Body.String())
	}
}

func TestStaticAndHealth(t *testing.T) {
	s, _, _ := newTestServer(t, Config{})
	h := s.Routes()
	for _, p := range []string{"/", "/some/spa/route"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", p, nil))
		if rec.Code != 200 || !strings.Contains(strings.ToLower(rec.Body.String()), "<!doctype html>") {
			t.Fatalf("%s: %d", p, rec.Code)
		}
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/healthz", nil))
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"ok":true`) {
		t.Fatal(rec.Body.String())
	}
	_ = ptr(1)
}

func TestMCPExtendedToolsResourcesPrompts(t *testing.T) {
	s, _, _ := newTestServer(t, Config{})
	h := s.Routes()

	if res, isErr := callTool(t, h, "get_week_overview", map[string]any{"days": 3}); isErr || len(res["days"].([]any)) != 3 {
		t.Fatalf("get_week_overview: %v", res)
	}
	if res, isErr := callTool(t, h, "mark_task_done", map[string]any{"match": "6.4 Homework"}); isErr || res["task"].(map[string]any)["status"] != "done" {
		t.Fatalf("mark_task_done: %v", res)
	}
	if res, isErr := callTool(t, h, "manage_block", map[string]any{"block_id": "b1", "action": "move", "date": "2026-11-21", "start": "10:00"}); isErr || res["block"].(map[string]any)["locked"] != true {
		t.Fatalf("manage_block move: %v", res)
	}
	if res, isErr := callTool(t, h, "set_bucket_target", map[string]any{"bucket": "AIME", "target_hours": 8}); isErr || res["bucket"].(map[string]any)["target_hours"] != float64(8) {
		t.Fatalf("set_bucket_target: %v", res)
	}
	if res, isErr := callTool(t, h, "check_in_mood", map[string]any{"mood": 2, "note": "sleepy"}); isErr || res["suggested_mode"] != "stretched" {
		t.Fatalf("check_in_mood: %v", res)
	}
	if res, isErr := callTool(t, h, "get_momentum_and_sessions", map[string]any{}); isErr || res["momentum"] == nil {
		t.Fatalf("get_momentum_and_sessions: %v", res)
	}
	if res, isErr := callTool(t, h, "update_rules_and_breaks", map[string]any{"break_min": 15, "after_school_min": 45}); isErr || res["rules"].(map[string]any)["break_min"] != float64(15) {
		t.Fatalf("update_rules_and_breaks: %v", res)
	}

	_, out := rpc(t, h, `{"jsonrpc":"2.0","id":10,"method":"resources/list"}`)
	if len(out["result"].(map[string]any)["resources"].([]any)) != 7 {
		t.Fatalf("resources/list: %v", out)
	}
	_, out = rpc(t, h, `{"jsonrpc":"2.0","id":11,"method":"resources/read","params":{"uri":"study://briefing/today"}}`)
	if len(out["result"].(map[string]any)["contents"].([]any)) != 1 {
		t.Fatalf("resources/read briefing: %v", out)
	}
	_, out = rpc(t, h, `{"jsonrpc":"2.0","id":12,"method":"prompts/list"}`)
	if len(out["result"].(map[string]any)["prompts"].([]any)) != 7 {
		t.Fatalf("prompts/list: %v", out)
	}
	_, out = rpc(t, h, `{"jsonrpc":"2.0","id":13,"method":"prompts/get","params":{"name":"morning_check_in"}}`)
	if len(out["result"].(map[string]any)["messages"].([]any)) != 1 {
		t.Fatalf("prompts/get: %v", out)
	}

	if res, isErr := callTool(t, h, "manage_research_milestone", map[string]any{
		"action": "add", "title": "Ablation Matrix", "phase": "analysis", "due_at": "2026-11-28T21:00", "add_deadline_event": true,
	}); isErr || res["milestone"] == nil {
		t.Fatalf("manage_research_milestone add: %v", res)
	}
	if res, isErr := callTool(t, h, "manage_research_milestone", map[string]any{"action": "list"}); isErr || res["count"].(float64) < 1 {
		t.Fatalf("manage_research_milestone list: %v", res)
	}
	if res, isErr := callTool(t, h, "plan_competition_goal", map[string]any{"goal": "AIME", "target": "8"}); isErr || len(res["assigned_tasks"].([]any)) == 0 {
		t.Fatalf("plan_competition_goal AIME: %v", res)
	}
	if res, isErr := callTool(t, h, "plan_competition_goal", map[string]any{"goal": "USAAIO", "target": "round 2"}); isErr || len(res["assigned_tasks"].([]any)) == 0 {
		t.Fatalf("plan_competition_goal USAAIO: %v", res)
	}
	if res, isErr := callTool(t, h, "get_study_resources", map[string]any{"goal": "USAAIO"}); isErr || len(res["assigned_tasks"].([]any)) != 0 {
		t.Fatalf("get_study_resources should not assign tasks: %v", res)
	}
	if res, isErr := callTool(t, h, "get_daily_briefing", map[string]any{}); isErr || res["today_blocks"] == nil {
		t.Fatalf("get_daily_briefing: %v", res)
	}
	if res, isErr := callTool(t, h, "find_free_slots", map[string]any{"days": 2, "min_minutes": 15}); isErr || res["slots"] == nil {
		t.Fatalf("find_free_slots: %v", res)
	}
	if res, isErr := callTool(t, h, "search_tasks", map[string]any{"query": "Ablation", "status": "open"}); isErr || res["count"].(float64) < 1 {
		t.Fatalf("search_tasks: %v", res)
	} else {
		tid := res["tasks"].([]any)[0].(map[string]any)["id"].(string)
		if dres, disErr := callTool(t, h, "delete_task_or_event", map[string]any{"task_id": tid}); disErr || len(dres["removed"].([]any)) != 1 {
			t.Fatalf("delete_task_or_event: %v", dres)
		}
	}
	if res, isErr := callTool(t, h, "reschedule_missed_blocks", map[string]any{}); isErr || res["cleared_missed"] == nil {
		t.Fatalf("reschedule_missed_blocks: %v", res)
	}
	if res, isErr := callTool(t, h, "get_assignment_details", map[string]any{"match": "AIME"}); isErr || res["assignments"] == nil {
		t.Fatalf("get_assignment_details: %v", res)
	}
	if res, isErr := callTool(t, h, "apply_school_preset", map[string]any{"preset_id": "finals_week"}); isErr || res["rules"].(map[string]any)["break_min"] != float64(15) {
		t.Fatalf("apply_school_preset: %v", res)
	}
	if res, isErr := callTool(t, h, "get_counselor_digest", map[string]any{}); isErr || res["workload_mode"] == nil {
		t.Fatalf("get_counselor_digest: %v", res)
	}
	if res, isErr := callTool(t, h, "get_audit_log", map[string]any{"limit": 10}); isErr || len(res["audit"].([]any)) == 0 {
		t.Fatalf("get_audit_log: %v", res)
	}

	// Test v2 MCP tools: recurring schedule, batch update + replan, swap, triage, problem sets.
	if res, isErr := callTool(t, h, "set_recurring_schedule", map[string]any{"kind": "quiet_home_alone", "days": []int{1, 3, 5}, "start": "16:00", "end": "18:30"}); isErr || res["today_blocks"] == nil {
		t.Fatalf("set_recurring_schedule: %v", res)
	}
	if res, isErr := callTool(t, h, "batch_update_schedule", map[string]any{
		"actions": []any{
			map[string]any{"op": "complete", "match": "Ch. 7 Problem Set"},
			map[string]any{"op": "add", "title": "Vocab Practice", "course": "English", "estimated_minutes": 30},
		},
	}); isErr || len(res["applied"].([]any)) != 2 {
		t.Fatalf("batch_update_schedule: %v", res)
	}
	if res, isErr := callTool(t, h, "replan_now", map[string]any{}); isErr || res["today_blocks"] == nil {
		t.Fatalf("replan_now: %v", res)
	}
	if res, isErr := callTool(t, h, "swap_block_focus", map[string]any{"match": "USAAIO", "new_title": "ISEF Coding"}); isErr || res["block"].(map[string]any)["title"] != "ISEF Coding" {
		t.Fatalf("swap_block_focus: %v", res)
	}
	if res, isErr := callTool(t, h, "log_problem_set", map[string]any{"bucket": "AIME", "topic": "Combinatorics", "attempted": 10, "solved": 6, "error_type": "concept", "minutes": 45}); isErr || res["review_scheduled"] == nil {
		t.Fatalf("log_problem_set: %v", res)
	}
	if res, isErr := callTool(t, h, "get_next_problems", map[string]any{"bucket": "AIME"}); isErr || len(res["topics"].([]any)) != 1 {
		t.Fatalf("get_next_problems: %v", res)
	}
	if res, isErr := callTool(t, h, "triage_canvas_opportunities", map[string]any{"auto_slot": false}); isErr || res["opportunities"] == nil {
		t.Fatalf("triage_canvas_opportunities: %v", res)
	}

	// Verify institutional HTTP endpoints & security headers.
	for _, ep := range []string{"/api/presets", "/api/counselor/digest", "/api/export/csv", "/api/report/transcript", "/api/integrations/config"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", ep, nil))
		if rec.Code != 200 || rec.Header().Get("X-Frame-Options") != "DENY" {
			t.Fatalf("%s: code=%d xfo=%q", ep, rec.Code, rec.Header().Get("X-Frame-Options"))
		}
	}

	// Verify saving integration config to a temp .env without returning secrets.
	tmpEnv := filepath.Join(t.TempDir(), ".env")
	t.Setenv("RELAY_ENV_FILE", tmpEnv)
	t.Setenv("OPENROUTER_API_KEY", "")
	t.Setenv("OPENAI_API_KEY", "")
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/integrations/config", strings.NewReader(`{"email_provider":"gmail","email_user":"student@gmail.com","email_password":"app-pw","discord_bot_token":"bot-tok","discord_channel_ids":"111,222","llm_provider":"openrouter","local_llm_api_key":"sk-or-saved"}`))
	h.ServeHTTP(rec, req)
	if rec.Code != 200 || strings.Contains(rec.Body.String(), "app-pw") || strings.Contains(rec.Body.String(), "bot-tok") || strings.Contains(rec.Body.String(), "sk-or-saved") {
		t.Fatalf("saveIntegrationsConfigHTTP: code=%d body=%s", rec.Code, rec.Body.String())
	}
	rawEnv, err := os.ReadFile(tmpEnv)
	if err != nil || !strings.Contains(string(rawEnv), "IMAP_ADDR=imap.gmail.com:993") || !strings.Contains(string(rawEnv), "DISCORD_CHANNEL_IDS=111,222") || !strings.Contains(string(rawEnv), "OPENROUTER_API_KEY=sk-or-saved") {
		t.Fatalf("env file contents: err=%v %s", err, string(rawEnv))
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("POST", "/api/integrations/config", strings.NewReader(`{"llm_provider":"openai","local_llm_api_key":"sk-openai-saved"}`)))
	if rec.Code != 200 {
		t.Fatalf("save second provider key: code=%d body=%s", rec.Code, rec.Body.String())
	}
	rawEnv, err = os.ReadFile(tmpEnv)
	if err != nil || !strings.Contains(string(rawEnv), "OPENROUTER_API_KEY=sk-or-saved") || !strings.Contains(string(rawEnv), "OPENAI_API_KEY=sk-openai-saved") {
		t.Fatalf("provider keys should persist independently: err=%v %s", err, string(rawEnv))
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/api/integrations/config", nil))
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"openrouter_key_configured":true`) || !strings.Contains(rec.Body.String(), `"openai_key_configured":true`) || strings.Contains(rec.Body.String(), "sk-or-saved") || strings.Contains(rec.Body.String(), "sk-openai-saved") {
		t.Fatalf("provider key status response: code=%d body=%s", rec.Code, rec.Body.String())
	}

	// Verify cloud gpt-6-luna proxy sends Bearer auth + response_format without Ollama options.
	var gotAuth string
	var gotBody map[string]any
	llmSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"{\"calls\":[],\"reply\":\"ok\"}"}}]}`)
	}))
	defer llmSrv.Close()
	s.cfg.LocalLLMURL = llmSrv.URL
	s.cfg.LocalLLMModel = "gpt-6-luna"
	s.cfg.LocalLLMAPIKey = "sk-test-luna"
	rec = httptest.NewRecorder()
	req = httptest.NewRequest("POST", "/api/llm/chat", strings.NewReader(`{"messages":[{"role":"user","content":"hi"}],"response_format":{"type":"json_object"}}`))
	h.ServeHTTP(rec, req)
	if rec.Code != 200 || gotAuth != "Bearer sk-test-luna" || gotBody["model"] != "gpt-6-luna" || gotBody["options"] != nil {
		t.Fatalf("cloud llm proxy: code=%d auth=%q body=%v", rec.Code, gotAuth, gotBody)
	}
	if gotBody["reasoning_effort"] != nil {
		t.Fatalf("cloud models keep their own reasoning setting: %v", gotBody)
	}
	if c, _ := pricingTierCtxCap("https://openrouter.ai/api/v1", "anthropic/claude-sonnet-4", 1000000, true); c != 190000 {
		t.Fatalf("claude cap = %d", c)
	}
	if c, _ := pricingTierCtxCap("https://openrouter.ai/api/v1", "google/gemini-2.5-pro", 1000000, true); c != 128000 {
		t.Fatalf("gemini cap = %d", c)
	}
	if c, _ := pricingTierCtxCap("https://openrouter.ai/api/v1", "google/gemma-4-31b-it:free", 131072, true); c != 32768 {
		t.Fatalf("openrouter cap = %d", c)
	}
	if c, _ := pricingTierCtxCap("http://127.0.0.1:11434/v1", "lfm2.5", 65536, false); c != 65536 {
		t.Fatalf("local cap = %d", c)
	}

	// Local Ollama: thinking is switched off unless asked for, so thinking models still return text.
	t.Setenv("OPENAI_API_KEY", "")
	t.Setenv("OPENROUTER_API_KEY", "")
	t.Setenv("LOCAL_LLM_API_KEY", "")
	s.cfg.LocalLLMAPIKey = ""
	s.cfg.LocalLLMModel = "jan"
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("POST", "/api/llm/chat", strings.NewReader(`{"messages":[{"role":"user","content":"hi"}],"enable_thinking":false}`)))
	if rec.Code != 200 || gotBody["reasoning_effort"] != "none" || gotBody["options"] == nil {
		t.Fatalf("local llm proxy should turn thinking off: code=%d body=%v", rec.Code, gotBody)
	}
}

func TestPiMatrixEstimatorParsesDirectionsAndComments(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		msgs := body["messages"].([]any)
		user := msgs[1].(map[string]any)["content"].(string)
		if !strings.Contains(user, "Problems 1-10") || !strings.Contains(user, "Teacher: skip #9") {
			t.Fatalf("expected directions and comments in prompt, got: %s", user)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{
				"message": map[string]any{"content": `{"task_type":"HW","cognitive_load":4,"minutes":43,"confidence":0.85,"why":"9 physics problems"}`},
			}},
		})
	}))
	defer srv.Close()

	pts := 20.0
	task := Task{
		ID:          "t1",
		Course:      "AP Physics 1",
		Title:       "Rotational Set",
		Description: "Problems 1-10",
		Comments:    []string{"Teacher: skip #9"},
		Category:    "homework",
		Points:      &pts,
		Status:      "open",
		EstSource:   "heuristic",
	}
	todo := unestimatedOpenTasks(&State{Tasks: []Task{task}})
	if len(todo) != 1 {
		t.Fatalf("expected 1 unestimated task, got %d", len(todo))
	}
	est, err := estimateTaskViaEndpoint(context.Background(), srv.Client(), srv.URL, "lfm3", task)
	if err != nil {
		t.Fatalf("estimateTaskViaEndpoint: %v", err)
	}
	if est.Minutes != 45 || est.CognitiveLoad != 4 {
		t.Fatalf("unexpected estimate: %+v", est)
	}
}

func TestSchoolHolidaysOpenFullDay(t *testing.T) {
	r := DefaultState().Rules
	la, _ := time.LoadLocation("America/Los_Angeles")
	// Thanksgiving (Thu Nov 26, 2026) and Friday after (Nov 27, 2026) are not school days.
	for _, ds := range []string{"2026-11-26", "2026-11-27", "2026-01-19", "2026-12-28"} {
		d, _ := time.ParseInLocation(dateLayout, ds, la)
		if isSchoolDay(r, d) {
			t.Fatalf("%s (%s) should be a school holiday", ds, schoolHolidayName(d))
		}
	}
	normal, _ := time.ParseInLocation(dateLayout, "2026-11-23", la)
	if !isSchoolDay(r, normal) {
		t.Fatalf("2026-11-23 should be a normal school day")
	}
}

func TestPasswordLogin(t *testing.T) {
	store, err := OpenStore(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	la, _ := time.LoadLocation("America/Los_Angeles")
	s := NewServer(store, Config{
		Token:     "tok-secret-123",
		RelayUser: "testuser",
		RelayPass: "testpass",
	}, la, time.Now)
	h := s.Routes()

	bad := httptest.NewRecorder()
	h.ServeHTTP(bad, httptest.NewRequest("POST", "/api/login", strings.NewReader(`{"username":"testuser","password":"wrong"}`)))
	if bad.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for wrong password, got %d", bad.Code)
	}

	ok := httptest.NewRecorder()
	h.ServeHTTP(ok, httptest.NewRequest("POST", "/api/login", strings.NewReader(`{"username":"testuser","password":"testpass"}`)))
	if ok.Code != http.StatusOK || !strings.Contains(ok.Body.String(), "tok-secret-123") {
		t.Fatalf("expected 200 with token, got %d %s", ok.Code, ok.Body.String())
	}
}

func TestEmbeddedPresetsLWWAndBackup(t *testing.T) {
	if p := findSchoolPreset("default"); p == nil || p.CanvasBaseURL != "https://instructure.com" {
		t.Fatalf("default preset missing: %+v", p)
	}
	if p := findSchoolPreset("esuhsd"); p == nil || p.CanvasBaseURL != "https://esuhsd.instructure.com" {
		t.Fatalf("esuhsd preset missing: %+v", p)
	}

	dir := t.TempDir()
	store, err := OpenStore(filepath.Join(dir, "study.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	// Idempotent inbox dedup
	if !store.RecordInboxMsgID("discord:123") || store.RecordInboxMsgID("discord:123") {
		t.Fatal("expected second RecordInboxMsgID to return false")
	}

	// Entity-level LWW merge
	base := &State{Tasks: []Task{{ID: "t1", Title: "Old", UpdatedAt: 100}, {ID: "t2", Title: "Keep", UpdatedAt: 200}}}
	inc := &State{Tasks: []Task{{ID: "t1", Title: "New", UpdatedAt: 300}, {ID: "t2", Title: "Stale", UpdatedAt: 50}}}
	merged := MergeLWWState(base, inc)
	titles := map[string]string{}
	for _, tk := range merged.Tasks {
		titles[tk.ID] = tk.Title
	}
	if titles["t1"] != "New" || titles["t2"] != "Keep" {
		t.Fatalf("unexpected LWW merge: %+v", titles)
	}

	// Zero-downtime SQLite backup via VACUUM INTO
	if err := store.BackupOnce(filepath.Join(dir, "backups"), time.Now()); err != nil {
		t.Fatalf("BackupOnce: %v", err)
	}

	// Demo seed populates realistic tasks and planned blocks
	la, _ := time.LoadLocation("America/Los_Angeles")
	s := NewServer(store, Config{}, la, time.Now)
	seedDemoState(s)
	_, st, err := store.Get()
	if err != nil || len(st.Tasks) == 0 || len(st.Blocks) == 0 {
		t.Fatalf("seedDemoState failed: err=%v tasks=%d blocks=%d", err, len(st.Tasks), len(st.Blocks))
	}
}

func TestMCPSessionID(t *testing.T) {
	dir := t.TempDir()
	store, err := OpenStore(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	la, _ := time.LoadLocation("America/Los_Angeles")
	s := NewServer(store, Config{}, la, time.Now)
	ts := httptest.NewServer(s.Routes())
	defer ts.Close()

	// 1. initialize returns Mcp-Session-Id
	resp, err := http.Post(ts.URL+"/mcp", "application/json", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}`))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("initialize status = %d", resp.StatusCode)
	}
	sid := resp.Header.Get("Mcp-Session-Id")
	if sid == "" {
		t.Fatal("expected Mcp-Session-Id header on initialize response")
	}

	// 2. tools/list with Mcp-Session-Id echoes it
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Mcp-Session-Id", sid)
	resp2, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp2.Body.Close()
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("tools/list status = %d", resp2.StatusCode)
	}
	if got := resp2.Header.Get("Mcp-Session-Id"); got != sid {
		t.Fatalf("echoed Mcp-Session-Id = %q, want %q", got, sid)
	}

	// 3. DELETE /mcp terminates session with 204
	delReq, _ := http.NewRequest(http.MethodDelete, ts.URL+"/mcp", nil)
	delReq.Header.Set("Mcp-Session-Id", sid)
	resp3, err := http.DefaultClient.Do(delReq)
	if err != nil {
		t.Fatal(err)
	}
	resp3.Body.Close()
	if resp3.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE /mcp status = %d, want 204", resp3.StatusCode)
	}
}

func TestOAuthAuthorizeUsernamePassword(t *testing.T) {
	dir := t.TempDir()
	store, err := OpenStore(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	la, _ := time.LoadLocation("America/Los_Angeles")
	s := NewServer(store, Config{
		Token:     "secret-relay-tok",
		RelayUser: "EverettS12",
		RelayPass: "@Shopping20",
	}, la, time.Now)
	ts := httptest.NewServer(s.Routes())
	defer ts.Close()

	// GET renders username + password login form
	resp, err := http.Get(ts.URL + "/oauth/authorize?client_id=c1&redirect_uri=https://example.com/cb&state=st1")
	if err != nil {
		t.Fatal(err)
	}
	bodyBytes, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !strings.Contains(string(bodyBytes), `name="username"`) || !strings.Contains(string(bodyBytes), `name="password"`) {
		t.Fatalf("expected username/password form, got status=%d body=%s", resp.StatusCode, string(bodyBytes))
	}

	// Wrong password returns 401
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	badResp, err := client.Post(ts.URL+"/oauth/authorize", "application/x-www-form-urlencoded",
		strings.NewReader("client_id=c1&redirect_uri=https%3A%2F%2Fexample.com%2Fcb&state=st1&username=EverettS12&password=wrong"))
	if err != nil {
		t.Fatal(err)
	}
	badResp.Body.Close()
	if badResp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 on bad password, got %d", badResp.StatusCode)
	}

	// Correct credentials redirect with authorization code
	okResp, err := client.Post(ts.URL+"/oauth/authorize", "application/x-www-form-urlencoded",
		strings.NewReader("client_id=c1&redirect_uri=https%3A%2F%2Fexample.com%2Fcb&state=st1&username=EverettS12&password=%40Shopping20"))
	if err != nil {
		t.Fatal(err)
	}
	okResp.Body.Close()
	if okResp.StatusCode != http.StatusFound {
		t.Fatalf("expected 302 redirect on valid login, got %d", okResp.StatusCode)
	}
	if loc := okResp.Header.Get("Location"); !strings.Contains(loc, "code=code-") || !strings.Contains(loc, "state=st1") {
		t.Fatalf("unexpected redirect location: %q", loc)
	}
}
