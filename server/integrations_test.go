package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func fakeCanvas(t *testing.T) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer server-token" {
			w.WriteHeader(401)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/v1/courses":
			io.WriteString(w, `[{"id":11,"name":"P-BIOLOGY - Q2000XX - NGUYEN - Period 04","enrollments":[{"computed_current_score":93.4,"computed_current_grade":"A"}]},
			                  {"id":12,"name":"P-ENGLISH 1A - E1001X9 - LEE - Period 02","enrollments":[{"computed_current_score":88.1,"computed_current_grade":"B+"}]}]`)
		case r.URL.Path == "/api/v1/courses/11/assignments":
			io.WriteString(w, `[{"name":"Story Board Mitosis","description":"<p>Draw <b>6</b> panels</p>","due_at":"2026-12-02T07:59:00Z","points_possible":20,
			  "submission":{"workflow_state":"unsubmitted","missing":false}},
			  {"name":"SRY article","description":"","due_at":"2026-11-18T07:59:00Z","points_possible":10,"submission":{"workflow_state":"unsubmitted","missing":true}}]`)
		case r.URL.Path == "/api/v1/announcements":
			if !strings.Contains(r.URL.RawQuery, "context_codes%5B%5D=course_11") {
				w.WriteHeader(400)
				return
			}
			io.WriteString(w, `[{"title":"Unit 2 exam moved","message":"<p>Exam is now <b>Dec 1</b>.</p>","posted_at":"2026-11-18T20:00:00Z","context_code":"course_11"}]`)
		case r.URL.Path == "/api/v1/courses/11":
			io.WriteString(w, `{"id":11,"name":"P-BIOLOGY","syllabus_body":"<h2>Grading</h2><p>Tests 50%</p>"}`)
		default:
			w.WriteHeader(404)
		}
	}))
}

func TestCleanCourse(t *testing.T) {
	cases := map[string]string{
		"P-BIOLOGY - Q2000XX - NGUYEN - Period 04":        "Biology",
		"P-PRECALCULUS/AP - M4500XP - KUANG - Period 04":  "Precalculus/AP",
		"P-CHINESE 2/MANDARIN 2 - F7600XA - SHE - Per 05": "Chinese 2/Mandarin 2",
		"AP Physics C: Mechanics":                         "AP Physics C: Mechanics",
	}
	for in, want := range cases {
		if got := cleanCourse(in); got != want {
			t.Errorf("cleanCourse(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestCanvasExplore(t *testing.T) {
	canvas := fakeCanvas(t)
	defer canvas.Close()
	s, _, _ := newTestServer(t, Config{CanvasBase: canvas.URL})
	h := s.Routes()
	if out, isErr := callTool(t, h, "canvas_explore", map[string]any{"what": "grades"}); !isErr {
		t.Fatalf("no server token should fail: %v", out)
	}
	s.integ.CanvasToken = "server-token"
	out, isErr := callTool(t, h, "canvas_explore", map[string]any{"what": "grades"})
	if isErr {
		t.Fatal(out)
	}
	cs := out["courses"].([]any)
	first := cs[0].(map[string]any)
	if len(cs) != 2 || first["course"] != "Biology" || first["current_score"].(float64) != 93.4 {
		t.Fatalf("grades %v", cs)
	}
	out, _ = callTool(t, h, "canvas_explore", map[string]any{"what": "assignments", "course": "bio"})
	as := out["assignments"].([]any)
	if len(as) != 2 || as[0].(map[string]any)["details"] != "Draw 6 panels" || as[1].(map[string]any)["missing"] != true {
		t.Fatalf("assignments %v", as)
	}
	out, _ = callTool(t, h, "canvas_explore", map[string]any{"what": "announcements", "course": "biology"})
	an := out["announcements"].([]any)[0].(map[string]any)
	if an["title"] != "Unit 2 exam moved" || an["text"] != "Exam is now Dec 1." {
		t.Fatalf("announcements %v", an)
	}
	out, _ = callTool(t, h, "canvas_explore", map[string]any{"what": "syllabus", "course": "biology"})
	if !strings.Contains(out["syllabus"].([]any)[0].(map[string]any)["syllabus"].(string), "Tests 50%") {
		t.Fatal("syllabus")
	}
	// same data over plain HTTP for the browser's chat bar
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/api/canvas/explore?what=grades&course=english", nil))
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"English 1A"`) {
		t.Fatalf("explore http: %d %s", rec.Code, rec.Body.String())
	}
	// the proxy falls back to the relay-held token when the browser sends none
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("POST", "/api/canvas/proxy", strings.NewReader(`{"path":"/api/v1/courses"}`)))
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "BIOLOGY") {
		t.Fatalf("proxy fallback: %d", rec.Code)
	}
}

func TestDiscordPollAndPost(t *testing.T) {
	var posted string
	var mu sync.Mutex
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/hook" {
			b, _ := io.ReadAll(r.Body)
			mu.Lock()
			posted = string(b)
			mu.Unlock()
			w.WriteHeader(204)
			return
		}
		if r.Header.Get("Authorization") != "Bot bot-token" || r.URL.Path != "/channels/999/messages" {
			w.WriteHeader(403)
			return
		}
		io.WriteString(w, `[{"id":"1","content":"Robotics: CAD files due Friday 5pm!","timestamp":"2026-11-19T01:00:00Z","author":{"username":"captain"}},
		                    {"id":"2","content":"beep","timestamp":"2026-11-19T01:01:00Z","author":{"username":"MEE6","bot":true}}]`)
	}))
	defer api.Close()
	s, _, _ := newTestServer(t, Config{})
	s.integ.Discord = DiscordConfig{BotToken: "bot-token", ChannelIDs: []string{"999"}, APIBase: api.URL, WebhookURL: api.URL + "/hook"}
	n, err := s.pollOnce(t.Context())
	if err != nil || n != 1 {
		t.Fatalf("poll: %d %v", n, err)
	}
	if n, _ := s.pollOnce(t.Context()); n != 0 {
		t.Fatal("second poll must dedupe")
	}
	_, st, _ := s.store.Get()
	if len(st.Inbox) != 1 || st.Inbox[0].From != "captain" || st.Inbox[0].Source != "discord" || st.Inbox[0].Status != "new" {
		t.Fatalf("inbox %+v", st.Inbox)
	}
	out, _ := callTool(t, s.Routes(), "list_inbox", map[string]any{})
	if len(out["inbox"].([]any)) != 1 {
		t.Fatal("list_inbox")
	}
	rec := httptest.NewRecorder()
	s.Routes().ServeHTTP(rec, httptest.NewRequest("POST", "/api/discord/post", strings.NewReader(`{"content":"Today: AIME 45m, Bio 35m @everyone"}`)))
	mu.Lock()
	defer mu.Unlock()
	if rec.Code != 200 || !strings.Contains(posted, "AIME 45m") || !strings.Contains(posted, `"parse":[]`) {
		t.Fatalf("webhook: %d %s", rec.Code, posted)
	}
}

// fakeIMAP speaks just enough IMAP4rev1 for the client.
func fakeIMAP(t *testing.T, messages map[string]string) string {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				rd := bufio.NewReader(c)
				fmt.Fprint(c, "* OK fake IMAP ready\r\n")
				for {
					line, err := rd.ReadString('\n')
					if err != nil {
						return
					}
					f := strings.Fields(line)
					tag, cmd := f[0], strings.ToUpper(f[1])
					switch {
					case cmd == "LOGIN":
						if f[2] != `"me@school.org"` || f[3] != `"app-pass"` {
							fmt.Fprintf(c, "%s NO bad login\r\n", tag)
							continue
						}
						fmt.Fprintf(c, "%s OK logged in\r\n", tag)
					case cmd == "EXAMINE":
						fmt.Fprintf(c, "* 2 EXISTS\r\n%s OK [READ-ONLY]\r\n", tag)
					case cmd == "UID" && strings.ToUpper(f[2]) == "SEARCH":
						fmt.Fprintf(c, "* SEARCH 41 42\r\n%s OK\r\n", tag)
					case cmd == "UID" && strings.ToUpper(f[2]) == "FETCH":
						body := messages[f[3]]
						fmt.Fprintf(c, "* 1 FETCH (UID %s BODY[]<0> {%d}\r\n%s)\r\n%s OK\r\n", f[3], len(body), body, tag)
					case cmd == "LOGOUT":
						fmt.Fprintf(c, "* BYE\r\n%s OK\r\n", tag)
						return
					default:
						fmt.Fprintf(c, "%s BAD\r\n", tag)
					}
				}
			}(c)
		}
	}()
	return ln.Addr().String()
}

func TestEmailInbox(t *testing.T) {
	counselor := "From: Ms. Rivera <rivera@esuhsd.org>\r\nSubject: College counselor: =?utf-8?q?senior_meeting?=\r\n" +
		"Date: Wed, 18 Nov 2026 09:00:00 -0800\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary=XX\r\n\r\n" +
		"--XX\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n" +
		"Please book a 1:1 by Friday. Bring your college list =E2=80=94 thanks!\r\n--XX\r\nContent-Type: text/html\r\n\r\n<p>html</p>\r\n--XX--\r\n"
	spam := "From: Store <deals@shop.com>\r\nSubject: 50% off\r\nContent-Type: text/plain\r\n\r\nBuy now\r\n"
	addr := fakeIMAP(t, map[string]string{"41": counselor, "42": spam})
	s, _, _ := newTestServer(t, Config{})
	s.integ.IMAP = IMAPConfig{Addr: addr, User: "me@school.org", Password: "app-pass", Plain: true,
		Filters: []string{"esuhsd.org", "robotics"}, Counselor: []string{"counselor"}}
	n, err := s.pollOnce(t.Context())
	if err != nil || n != 1 {
		t.Fatalf("poll: %d %v", n, err)
	}
	_, st, _ := s.store.Get()
	it := st.Inbox[0]
	if it.Source != "email" || it.Subject != "College counselor: senior meeting" || it.Tags[0] != "counselor" ||
		!strings.Contains(it.Text, "college list — thanks") || it.ReceivedAt != "2026-11-18T09:00:00-08:00" {
		t.Fatalf("email item %+v", it)
	}
	s.integ.IMAP.Password = "wrong"
	if _, err := s.pollOnce(t.Context()); err == nil || !strings.Contains(err.Error(), "login") {
		t.Fatalf("bad password should surface: %v", err)
	}
}

func fakeSMTP(t *testing.T) (string, func() string) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	var mu sync.Mutex
	var data strings.Builder
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				rd := bufio.NewReader(c)
				fmt.Fprint(c, "220 fake ESMTP\r\n")
				inData := false
				for {
					line, err := rd.ReadString('\n')
					if err != nil {
						return
					}
					if inData {
						if line == ".\r\n" {
							inData = false
							fmt.Fprint(c, "250 queued\r\n")
							continue
						}
						mu.Lock()
						data.WriteString(line)
						mu.Unlock()
						continue
					}
					switch up := strings.ToUpper(line); {
					case strings.HasPrefix(up, "EHLO"):
						fmt.Fprint(c, "250-fake\r\n250 AUTH PLAIN\r\n")
					case strings.HasPrefix(up, "AUTH"):
						fmt.Fprint(c, "235 ok\r\n")
					case strings.HasPrefix(up, "MAIL"), strings.HasPrefix(up, "RCPT"):
						fmt.Fprint(c, "250 ok\r\n")
					case strings.HasPrefix(up, "DATA"):
						inData = true
						fmt.Fprint(c, "354 go\r\n")
					case strings.HasPrefix(up, "QUIT"):
						fmt.Fprint(c, "221 bye\r\n")
						return
					default:
						fmt.Fprint(c, "250 ok\r\n")
					}
				}
			}(c)
		}
	}()
	return ln.Addr().String(), func() string { mu.Lock(); defer mu.Unlock(); return data.String() }
}

func TestDraftsOnlySendWhenApproved(t *testing.T) {
	addr, sent := fakeSMTP(t)
	s, _, _ := newTestServer(t, Config{})
	s.integ.SMTP = SMTPConfig{Addr: addr, User: "me@school.org", Password: "x", From: "me@school.org"}
	h := s.Routes()
	out, isErr := callTool(t, h, "draft_email", map[string]any{"to": "rivera@esuhsd.org", "subject": "1:1 meeting",
		"body": "Hi Ms. Rivera,\nCould we meet Thursday?\nThanks", "reason": "counselor asked to book a 1:1"})
	if isErr {
		t.Fatal(out)
	}
	if sent() != "" {
		t.Fatal("draft_email must never send")
	}
	if _, isErr := callTool(t, h, "draft_email", map[string]any{"to": "not-an-address", "subject": "x", "body": "y"}); !isErr {
		t.Fatal("bad address should fail")
	}
	id := out["draft"].(map[string]any)["id"].(string)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("POST", "/api/email/send", strings.NewReader(`{"draft_id":"`+id+`","body":"Hi Ms. Rivera,\nCould we meet Thursday at lunch?\nThanks"}`)))
	if rec.Code != 200 {
		t.Fatalf("send: %d %s", rec.Code, rec.Body.String())
	}
	msg := sent()
	if !strings.Contains(msg, "To: rivera@esuhsd.org") || !strings.Contains(msg, "Thursday at lunch") {
		t.Fatalf("sent message: %q", msg)
	}
	_, st, _ := s.store.Get()
	if st.Drafts[0].Status != "sent" || st.Drafts[0].SentAt == "" {
		t.Fatalf("draft %+v", st.Drafts[0])
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("POST", "/api/email/send", strings.NewReader(`{"draft_id":"`+id+`"}`)))
	if rec.Code != 400 {
		t.Fatal("re-sending a sent draft must fail")
	}
}

func TestLoadDotEnv(t *testing.T) {
	p := filepath.Join(t.TempDir(), ".env")
	os.WriteFile(p, []byte("# comment\nRELAY_TEST_A=from-file\nRELAY_TEST_B=\"quoted\"\n"), 0o600)
	t.Setenv("RELAY_TEST_A", "from-env")
	os.Unsetenv("RELAY_TEST_B")
	loadDotEnv(p)
	if os.Getenv("RELAY_TEST_A") != "from-env" || os.Getenv("RELAY_TEST_B") != "quoted" {
		t.Fatal("dotenv")
	}
	os.Unsetenv("RELAY_TEST_B")
}

func TestConnectionSelfTest(t *testing.T) {
	var posted bool
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/hook" && r.Method == "GET":
			io.WriteString(w, `{"name":"Study bot"}`)
		case r.URL.Path == "/hook":
			posted = true
		case r.Header.Get("Authorization") != "Bot good-token":
			w.WriteHeader(401)
		case r.URL.Path == "/users/@me":
			io.WriteString(w, `{"username":"studyflow"}`)
		case r.URL.Path == "/channels/111/messages":
			io.WriteString(w, `[{"content":"","attachments":[]},{"content":"","attachments":[]}]`)
		case r.URL.Path == "/channels/222/messages":
			w.WriteHeader(403)
		default:
			w.WriteHeader(404)
		}
	}))
	defer api.Close()
	smtpAddr, sent := fakeSMTP(t)
	imapAddr := fakeIMAP(t, map[string]string{})
	s, _, _ := newTestServer(t, Config{})
	s.integ.Discord = DiscordConfig{BotToken: "good-token", ChannelIDs: []string{"111"}, APIBase: api.URL, WebhookURL: api.URL + "/hook"}
	s.integ.IMAP = IMAPConfig{Addr: imapAddr, User: "me@school.org", Password: "app-pass", Plain: true, Filters: []string{"esuhsd.org"}}
	s.integ.SMTP = SMTPConfig{Addr: smtpAddr, User: "me@school.org", Password: "app-pass", From: "Me <me@school.org>"}

	rec := httptest.NewRecorder()
	s.Routes().ServeHTTP(rec, httptest.NewRequest("POST", "/api/integrations/test", nil))
	body := rec.Body.String()
	var res map[string]Check
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil || rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, body)
	}
	for _, k := range []string{"discord_read", "discord_post", "email_read", "email_send"} {
		if !res[k].OK {
			t.Errorf("%s: %+v", k, res[k])
		}
	}
	if !strings.Contains(res["discord_read"].Detail, "Message Content") || !strings.Contains(res["email_read"].Detail, "2 messages") {
		t.Errorf("details: %+v", res)
	}
	if posted || sent() != "" {
		t.Fatal("the self-test must not post or send anything")
	}
	if strings.Contains(body, "good-token") || strings.Contains(body, "app-pass") {
		t.Fatal("secrets leaked into the test output")
	}

	// friendly failures
	s.integ.Discord.BotToken = "bad"
	s.integ.Discord.ChannelIDs = []string{"222"}
	s.integ.IMAP.Password = "wrong"
	r2 := s.testIntegrations(t.Context())
	if r2["discord_read"].OK || !strings.Contains(r2["discord_read"].Detail, "token rejected") {
		t.Errorf("bad token: %+v", r2["discord_read"])
	}
	if r2["email_read"].OK || !strings.Contains(r2["email_read"].Detail, "app password") {
		t.Errorf("bad password: %+v", r2["email_read"])
	}
	s.integ.Discord.BotToken = "good-token"
	if r3 := s.testIntegrations(t.Context()); !strings.Contains(r3["discord_read"].Detail, "can't see it") {
		t.Errorf("no access: %+v", r3["discord_read"])
	}
	s.integ.Discord = DiscordConfig{}
	if r4 := s.testIntegrations(t.Context()); r4["discord_read"].Configured || r4["discord_read"].Detail != "not set up" {
		t.Errorf("unconfigured: %+v", r4["discord_read"])
	}
}
