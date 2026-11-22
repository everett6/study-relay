package main

// Integrations: Canvas deep access (server token), Discord (bot read + webhook post),
// email (IMAP read + SMTP send of user-approved drafts). Every credential comes from the
// environment (.env / systemd EnvironmentFile), is held in memory, and is never written to
// SQLite or logged. Nothing is ever sent without an explicit user action in the web UI.

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net"
	"net/http"
	"net/mail"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type InboxItem struct {
	ID         string   `json:"id"`
	Source     string   `json:"source"` // discord | email | screenshot | canvas
	ExternalID string   `json:"external_id"`
	From       string   `json:"from"`
	Subject    string   `json:"subject"`
	Text       string   `json:"text"`
	URL        string   `json:"url,omitempty"`
	ReceivedAt string   `json:"received_at"`
	Tags       []string `json:"tags"`
	Status     string   `json:"status"` // new | accepted | dismissed
}

type Draft struct {
	ID        string `json:"id"`
	To        string `json:"to"`
	Subject   string `json:"subject"`
	Body      string `json:"body"`
	Reason    string `json:"reason"`
	Status    string `json:"status"` // draft | sent | failed
	CreatedAt string `json:"created_at"`
	SentAt    string `json:"sent_at,omitempty"`
	Error     string `json:"error,omitempty"`
	InboxID   string `json:"inbox_id,omitempty"`
}

type Integrations struct {
	CanvasToken string
	Discord     DiscordConfig
	IMAP        IMAPConfig
	SMTP        SMTPConfig
	PollEvery   time.Duration

	mu       sync.Mutex
	lastPoll string
	lastErr  map[string]string
}

type DiscordConfig struct {
	BotToken   string
	ChannelIDs []string
	WebhookURL string
	APIBase    string // tests override
}

type IMAPConfig struct {
	Addr      string // host:port
	User      string
	Password  string
	Filters   []string // sender/subject keywords for clubs and the counselor
	Counselor []string // keywords that tag a message as counselor
	Plain     bool     // tests only: no TLS
}

type SMTPConfig struct {
	Addr     string
	User     string
	Password string
	From     string
}

func splitList(v string) []string {
	out := []string{}
	for _, p := range strings.Split(v, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func IntegrationsFromEnv() *Integrations {
	poll, _ := strconv.Atoi(env("POLL_MINUTES", "10"))
	return &Integrations{
		CanvasToken: os.Getenv("CANVAS_API_TOKEN"),
		Discord: DiscordConfig{BotToken: os.Getenv("DISCORD_BOT_TOKEN"), ChannelIDs: splitList(os.Getenv("DISCORD_CHANNEL_IDS")),
			WebhookURL: os.Getenv("DISCORD_WEBHOOK_URL"), APIBase: "https://discord.com/api/v10"},
		IMAP: IMAPConfig{Addr: os.Getenv("IMAP_ADDR"), User: os.Getenv("IMAP_USER"), Password: os.Getenv("IMAP_PASSWORD"),
			Filters: splitList(os.Getenv("IMAP_FILTERS")), Counselor: splitList(env("COUNSELOR_KEYWORDS", "counselor,college,naviance,scholarship"))},
		SMTP:      SMTPConfig{Addr: os.Getenv("SMTP_ADDR"), User: os.Getenv("SMTP_USER"), Password: os.Getenv("SMTP_PASSWORD"), From: os.Getenv("SMTP_FROM")},
		PollEvery: time.Duration(max(2, poll)) * time.Minute,
		lastErr:   map[string]string{},
	}
}

// loadDotEnv sets variables from a KEY=VALUE file without overriding the real environment.
func loadDotEnv(path string) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		k, v = strings.TrimSpace(k), strings.Trim(strings.TrimSpace(v), `"'`)
		if _, set := os.LookupEnv(k); !set {
			os.Setenv(k, v)
		}
	}
}

func (in *Integrations) Status() map[string]any {
	in.mu.Lock()
	defer in.mu.Unlock()
	errs := map[string]string{}
	for k, v := range in.lastErr {
		errs[k] = v
	}
	return map[string]any{
		"canvas_server_token": in.CanvasToken != "",
		"discord_read":        in.Discord.BotToken != "" && len(in.Discord.ChannelIDs) > 0,
		"discord_post":        in.Discord.WebhookURL != "",
		"email_read":          in.IMAP.Addr != "" && in.IMAP.User != "",
		"email_send":          in.SMTP.Addr != "" && in.SMTP.From != "",
		"last_poll":           in.lastPoll,
		"errors":              errs,
	}
}

func (in *Integrations) setErr(k string, err error) {
	in.mu.Lock()
	defer in.mu.Unlock()
	if err == nil {
		delete(in.lastErr, k)
	} else {
		in.lastErr[k] = err.Error()
	}
}

// ------------------------------------------------------------------ Canvas deep access

var tagRe = regexp.MustCompile(`(?s)<[^>]*>`)
var spaceRe = regexp.MustCompile(`[ \t\r\f]+|\n{3,}`)

func htmlText(s string, limit int) string {
	s = tagRe.ReplaceAllString(strings.NewReplacer("<br>", "\n", "</p>", "\n", "</li>", "\n", "&nbsp;", " ",
		"&amp;", "&", "&lt;", "<", "&gt;", ">", "&quot;", `"`, "&#39;", "'").Replace(s), "")
	s = strings.TrimSpace(spaceRe.ReplaceAllStringFunc(s, func(m string) string {
		if strings.Contains(m, "\n") {
			return "\n\n"
		}
		return " "
	}))
	if len(s) > limit {
		s = s[:limit] + "…"
	}
	return s
}

var courseCodeRe = regexp.MustCompile(`^[A-Z]{1,2}-([A-Z])`)

// cleanCourse turns "P-BIOLOGY - Q2000XX - NGUYEN - Period 04" into "Biology".
func cleanCourse(name string) string {
	n := courseCodeRe.ReplaceAllString(strings.TrimSpace(name), "$1")
	n = strings.TrimSpace(strings.SplitN(n, " - ", 2)[0])
	if n != strings.ToUpper(n) {
		return n
	}
	words := strings.Fields(n)
	for i, w := range words {
		parts := strings.Split(w, "/")
		for j, p := range parts {
			keep := strings.ContainsAny(p, "0123456789") || p == "AP" || p == "IB" || p == "BC" || p == "AB"
			if !keep && len(p) > 0 {
				parts[j] = p[:1] + strings.ToLower(p[1:])
			}
		}
		words[i] = strings.Join(parts, "/")
	}
	return strings.Join(words, " ")
}

type canvasETagEntry struct {
	etag string
	body []byte
}

var (
	canvasETagMu sync.Mutex
	canvasETags  = map[string]canvasETagEntry{}
)

func (s *Server) canvasGet(ctx context.Context, path string, out any) error {
	if s.integ.CanvasToken == "" {
		return fmt.Errorf("no server-side Canvas token: set CANVAS_API_TOKEN in the relay's .env")
	}
	fullURL := strings.TrimRight(s.cfg.CanvasBase, "/") + path
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fullURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+s.integ.CanvasToken)
	canvasETagMu.Lock()
	cached, hasCached := canvasETags[fullURL]
	canvasETagMu.Unlock()
	if hasCached && cached.etag != "" {
		req.Header.Set("If-None-Match", cached.etag)
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return fmt.Errorf("canvas unreachable")
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotModified && hasCached {
		return json.Unmarshal(cached.body, out)
	}
	if resp.StatusCode >= 300 {
		return fmt.Errorf("canvas returned %d for %s", resp.StatusCode, strings.SplitN(path, "?", 2)[0])
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return err
	}
	if etag := resp.Header.Get("ETag"); etag != "" {
		canvasETagMu.Lock()
		if len(canvasETags) > 64 {
			canvasETags = map[string]canvasETagEntry{}
		}
		canvasETags[fullURL] = canvasETagEntry{etag: etag, body: body}
		canvasETagMu.Unlock()
	}
	return json.Unmarshal(body, out)
}

type canvasCourse struct {
	ID          json.Number `json:"id"`
	Name        string      `json:"name"`
	Syllabus    string      `json:"syllabus_body"`
	Enrollments []struct {
		Score *float64 `json:"computed_current_score"`
		Grade *string  `json:"computed_current_grade"`
	} `json:"enrollments"`
}

type exploreArgs struct {
	What    string `json:"what"`
	Course  string `json:"course"`
	Search  string `json:"search"`
	Refresh bool   `json:"refresh"`
}

type canvasCacheEntry struct {
	at  time.Time
	out map[string]any
}

type canvasCoursesEntry struct {
	at      time.Time
	courses []canvasCourse
}

var (
	canvasCacheMu        sync.Mutex
	canvasCache          = map[string]canvasCacheEntry{}
	canvasCoursesCacheMu sync.Mutex
	canvasCoursesCache   = map[string]canvasCoursesEntry{}
)

// fetchCoursesParallel runs fn across pick with up to 4 concurrent workers, preserving course order.
func fetchCoursesParallel[T any](pick []canvasCourse, fn func(canvasCourse) ([]T, error)) ([]T, error) {
	type res struct {
		items []T
		err   error
	}
	results := make([]res, len(pick))
	sem := make(chan struct{}, 4)
	var wg sync.WaitGroup
	for i, c := range pick {
		wg.Add(1)
		go func(idx int, course canvasCourse) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			items, err := fn(course)
			results[idx] = res{items: items, err: err}
		}(i, c)
	}
	wg.Wait()
	var out []T
	for _, r := range results {
		if r.err != nil {
			return nil, r.err
		}
		out = append(out, r.items...)
	}
	return out, nil
}

// canvasExplore lets the AI dig through classes: courses+grades, assignments, announcements,
// modules, syllabus. Output is condensed text-friendly JSON, cached for 90s with concurrent course fetches.
func (s *Server) canvasExplore(ctx context.Context, a exploreArgs) (map[string]any, error) {
	cacheKey := strings.ToLower(s.cfg.CanvasBase + "|" + a.What + "|" + a.Course + "|" + a.Search)
	if !a.Refresh {
		canvasCacheMu.Lock()
		ent, ok := canvasCache[cacheKey]
		canvasCacheMu.Unlock()
		if ok && time.Since(ent.at) < 10*time.Minute {
			return ent.out, nil
		}
	}
	var courses []canvasCourse
	if !a.Refresh {
		canvasCoursesCacheMu.Lock()
		cent, ok := canvasCoursesCache[s.cfg.CanvasBase]
		canvasCoursesCacheMu.Unlock()
		if ok && time.Since(cent.at) < 60*time.Second {
			courses = cent.courses
		}
	}
	if courses == nil {
		if err := s.canvasGet(ctx, "/api/v1/courses?enrollment_state=active&include[]=total_scores&per_page=50", &courses); err != nil {
			return nil, err
		}
		canvasCoursesCacheMu.Lock()
		if len(canvasCoursesCache) > 20 {
			canvasCoursesCache = map[string]canvasCoursesEntry{}
		}
		canvasCoursesCache[s.cfg.CanvasBase] = canvasCoursesEntry{at: time.Now(), courses: courses}
		canvasCoursesCacheMu.Unlock()
	}
	pick := []canvasCourse{}
	for _, c := range courses {
		if a.Course == "" || strings.Contains(strings.ToLower(c.Name+" "+cleanCourse(c.Name)), strings.ToLower(a.Course)) {
			pick = append(pick, c)
		}
	}
	if len(pick) == 0 {
		return nil, fmt.Errorf("no active course matches %q", a.Course)
	}
	q := strings.ToLower(a.Search)
	match := func(parts ...string) bool {
		return q == "" || strings.Contains(strings.ToLower(strings.Join(parts, " ")), q)
	}
	what := a.What
	if what == "" {
		what = "courses"
	}
	out := map[string]any{"what": what}
	switch what {
	case "courses", "grades":
		list := []map[string]any{}
		for _, c := range pick {
			m := map[string]any{"id": c.ID, "course": cleanCourse(c.Name), "full_name": c.Name}
			if len(c.Enrollments) > 0 {
				m["current_score"], m["current_grade"] = c.Enrollments[0].Score, c.Enrollments[0].Grade
			}
			list = append(list, m)
		}
		out["courses"] = list
		if a.Course == "" && a.Search == "" {
			s.saveGradesFromCourses(list) // keeps the grade history the planner uses
		}
	case "assignments":
		list, err := fetchCoursesParallel(pick, func(course canvasCourse) ([]map[string]any, error) {
			var as []struct {
				Name       string   `json:"name"`
				Desc       string   `json:"description"`
				Due        *string  `json:"due_at"`
				Points     *float64 `json:"points_possible"`
				URL        string   `json:"html_url"`
				Submission *struct {
					State    string   `json:"workflow_state"`
					Score    *float64 `json:"score"`
					Late     bool     `json:"late"`
					Miss     bool     `json:"missing"`
					Comments []struct {
						Author  string `json:"author_name"`
						Comment string `json:"comment"`
					} `json:"submission_comments"`
				} `json:"submission"`
			}
			if err := s.canvasGet(ctx, "/api/v1/courses/"+course.ID.String()+"/assignments?include[]=submission&include[]=submission_comments&order_by=due_at&per_page=100", &as); err != nil {
				return nil, err
			}
			var items []map[string]any
			for _, x := range as {
				var cmtList []string
				if x.Submission != nil {
					for _, cm := range x.Submission.Comments {
						txt := strings.TrimSpace(cm.Comment)
						if txt != "" {
							if cm.Author != "" {
								cmtList = append(cmtList, cm.Author+": "+txt)
							} else {
								cmtList = append(cmtList, txt)
							}
						}
					}
				}
				if !match(x.Name, x.Desc, strings.Join(cmtList, " ")) {
					continue
				}
				dirs := htmlText(x.Desc, 1500)
				m := map[string]any{"course": cleanCourse(course.Name), "title": x.Name, "due_at": x.Due, "points": x.Points,
					"directions": dirs, "details": htmlText(x.Desc, 400), "comments": cmtList, "url": x.URL}
				if x.Submission != nil {
					m["status"], m["score"], m["late"], m["missing"] = x.Submission.State, x.Submission.Score, x.Submission.Late, x.Submission.Miss
				}
				items = append(items, m)
			}
			return items, nil
		})
		if err != nil {
			return nil, err
		}
		if list == nil {
			list = []map[string]any{}
		}
		if len(list) > 60 {
			list = list[len(list)-60:]
		}
		out["assignments"] = list
	case "announcements":
		params := url.Values{}
		for _, c := range pick {
			params.Add("context_codes[]", "course_"+c.ID.String())
		}
		params.Set("start_date", s.now().AddDate(0, 0, -30).Format(dateLayout))
		params.Set("per_page", "30")
		var anns []struct {
			Title   string `json:"title"`
			Message string `json:"message"`
			Posted  string `json:"posted_at"`
			Context string `json:"context_code"`
			URL     string `json:"html_url"`
		}
		if err := s.canvasGet(ctx, "/api/v1/announcements?"+params.Encode(), &anns); err != nil {
			return nil, err
		}
		names := map[string]string{}
		for _, c := range pick {
			names["course_"+c.ID.String()] = cleanCourse(c.Name)
		}
		list := []map[string]any{}
		for _, x := range anns {
			if match(x.Title, x.Message) {
				list = append(list, map[string]any{"course": names[x.Context], "title": x.Title, "posted_at": x.Posted,
					"text": htmlText(x.Message, 600), "url": x.URL})
			}
		}
		out["announcements"] = list
	case "modules":
		list, err := fetchCoursesParallel(pick, func(c canvasCourse) ([]map[string]any, error) {
			var mods []struct {
				Name  string `json:"name"`
				Items []struct {
					Title string `json:"title"`
					Type  string `json:"type"`
				} `json:"items"`
			}
			if err := s.canvasGet(ctx, "/api/v1/courses/"+c.ID.String()+"/modules?include[]=items&per_page=50", &mods); err != nil {
				return nil, err
			}
			var itemsOut []map[string]any
			for _, m := range mods {
				items := []string{}
				for _, it := range m.Items {
					if match(m.Name, it.Title) {
						items = append(items, it.Type+": "+it.Title)
					}
				}
				if len(items) > 0 || match(m.Name) {
					itemsOut = append(itemsOut, map[string]any{"course": cleanCourse(c.Name), "module": m.Name, "items": items})
				}
			}
			return itemsOut, nil
		})
		if err != nil {
			return nil, err
		}
		if list == nil {
			list = []map[string]any{}
		}
		out["modules"] = list
	case "syllabus":
		list, err := fetchCoursesParallel(pick, func(c canvasCourse) ([]map[string]any, error) {
			var full canvasCourse
			if err := s.canvasGet(ctx, "/api/v1/courses/"+c.ID.String()+"?include[]=syllabus_body", &full); err != nil {
				return nil, err
			}
			return []map[string]any{{"course": cleanCourse(c.Name), "syllabus": htmlText(full.Syllabus, 3000)}}, nil
		})
		if err != nil {
			return nil, err
		}
		if list == nil {
			list = []map[string]any{}
		}
		out["syllabus"] = list
	default:
		return nil, fmt.Errorf("what must be courses, grades, assignments, announcements, modules, or syllabus")
	}
	canvasCacheMu.Lock()
	if len(canvasCache) > 20 {
		canvasCache = map[string]canvasCacheEntry{}
	}
	canvasCache[cacheKey] = canvasCacheEntry{at: time.Now(), out: out}
	canvasCacheMu.Unlock()
	return out, nil
}

// ------------------------------------------------------------------ Discord

func (s *Server) pollDiscord(ctx context.Context) ([]InboxItem, error) {
	d := s.integ.Discord
	if d.BotToken == "" || len(d.ChannelIDs) == 0 {
		return nil, nil
	}
	items := []InboxItem{}
	for _, ch := range d.ChannelIDs {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, d.APIBase+"/channels/"+url.PathEscape(ch)+"/messages?limit=30", nil)
		req.Header.Set("Authorization", "Bot "+d.BotToken)
		resp, err := s.client.Do(req)
		if err != nil {
			return items, fmt.Errorf("discord unreachable")
		}
		var msgs []struct {
			ID        string `json:"id"`
			Content   string `json:"content"`
			Timestamp string `json:"timestamp"`
			Author    struct {
				Username string `json:"username"`
				Bot      bool   `json:"bot"`
			} `json:"author"`
		}
		err = json.NewDecoder(io.LimitReader(resp.Body, 2<<20)).Decode(&msgs)
		resp.Body.Close()
		if resp.StatusCode >= 300 || err != nil {
			return items, fmt.Errorf("%s", discordErr(resp.StatusCode, "channel "+ch))
		}
		for _, m := range msgs {
			if m.Author.Bot || strings.TrimSpace(m.Content) == "" {
				continue
			}
			text := m.Content
			if len(text) > 1500 {
				text = text[:1500] + "…"
			}
			items = append(items, InboxItem{Source: "discord", ExternalID: "discord:" + m.ID, From: m.Author.Username,
				Subject: firstLine(text, 80), Text: text, ReceivedAt: m.Timestamp, Tags: []string{"club"},
				URL: "https://discord.com/channels/@me/" + ch + "/" + m.ID})
		}
	}
	return items, nil
}

func (s *Server) postDiscord(ctx context.Context, content string) error {
	if s.integ.Discord.WebhookURL == "" {
		return fmt.Errorf("DISCORD_WEBHOOK_URL is not set")
	}
	if len(content) > 1900 {
		content = content[:1900] + "…"
	}
	body, _ := json.Marshal(map[string]any{"content": content, "allowed_mentions": map[string]any{"parse": []string{}}})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, s.integ.Discord.WebhookURL, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		return fmt.Errorf("discord unreachable")
	}
	resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("discord webhook returned %d", resp.StatusCode)
	}
	return nil
}

func firstLine(s string, n int) string {
	s = strings.TrimSpace(strings.SplitN(s, "\n", 2)[0])
	if len(s) > n {
		s = s[:n] + "…"
	}
	return s
}

// ------------------------------------------------------------------ IMAP (minimal client)

type imapConn struct {
	c   net.Conn
	r   *bufio.Reader
	seq int
}

func dialIMAP(cfg IMAPConfig) (*imapConn, error) {
	d := &net.Dialer{Timeout: 15 * time.Second}
	var c net.Conn
	var err error
	if cfg.Plain {
		c, err = d.Dial("tcp", cfg.Addr)
	} else {
		host, _, _ := net.SplitHostPort(cfg.Addr)
		c, err = tls.DialWithDialer(d, "tcp", cfg.Addr, &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12})
	}
	if err != nil {
		return nil, fmt.Errorf("imap connect failed")
	}
	_ = c.SetDeadline(time.Now().Add(60 * time.Second))
	ic := &imapConn{c: c, r: bufio.NewReaderSize(c, 8192)}
	if _, err := ic.r.ReadString('\n'); err != nil { // greeting
		c.Close()
		return nil, err
	}
	return ic, nil
}

func imapQuote(s string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s) + `"`
}

// cmd sends a command and returns untagged response lines with literals inlined as
// separate byte chunks.
func (ic *imapConn) cmd(format string, a ...any) ([][]byte, error) {
	ic.seq++
	tag := fmt.Sprintf("a%d", ic.seq)
	if _, err := fmt.Fprintf(ic.c, "%s %s\r\n", tag, fmt.Sprintf(format, a...)); err != nil {
		return nil, err
	}
	var out [][]byte
	for {
		line, err := ic.r.ReadString('\n')
		if err != nil {
			return out, err
		}
		if strings.HasPrefix(line, tag+" ") {
			if !strings.HasPrefix(line, tag+" OK") {
				return out, fmt.Errorf("imap: %s", strings.TrimSpace(strings.TrimPrefix(line, tag)))
			}
			return out, nil
		}
		out = append(out, []byte(line))
		for { // literal {n}
			trim := strings.TrimRight(line, "\r\n")
			if !strings.HasSuffix(trim, "}") {
				break
			}
			i := strings.LastIndex(trim, "{")
			n, err := strconv.Atoi(trim[i+1 : len(trim)-1])
			if err != nil || n > 1<<20 {
				break
			}
			buf := make([]byte, n)
			if _, err := io.ReadFull(ic.r, buf); err != nil {
				return out, err
			}
			out = append(out, buf)
			line, err = ic.r.ReadString('\n')
			if err != nil {
				return out, err
			}
			out = append(out, []byte(line))
		}
	}
}

func (s *Server) pollEmail() ([]InboxItem, error) {
	cfg := s.integ.IMAP
	if cfg.Addr == "" || cfg.User == "" {
		return nil, nil
	}
	ic, err := dialIMAP(cfg)
	if err != nil {
		return nil, err
	}
	defer ic.c.Close()
	if _, err := ic.cmd("LOGIN %s %s", imapQuote(cfg.User), imapQuote(cfg.Password)); err != nil {
		return nil, fmt.Errorf("imap login failed")
	}
	defer ic.cmd("LOGOUT") //nolint:errcheck
	if _, err := ic.cmd("EXAMINE INBOX"); err != nil {
		return nil, err
	}
	since := s.now().AddDate(0, 0, -14).Format("02-Jan-2006")
	lines, err := ic.cmd("UID SEARCH SINCE %s", since)
	if err != nil {
		return nil, err
	}
	var uids []string
	for _, l := range lines {
		if f := strings.Fields(string(l)); len(f) > 2 && f[1] == "SEARCH" {
			uids = append(uids, f[2:]...)
		}
	}
	if len(uids) > 25 {
		uids = uids[len(uids)-25:]
	}
	items := []InboxItem{}
	for _, uid := range uids {
		chunks, err := ic.cmd("UID FETCH %s (BODY.PEEK[]<0.65536>)", uid)
		if err != nil {
			continue
		}
		var raw []byte
		for _, c := range chunks {
			if len(c) > len(raw) && !bytes.HasPrefix(c, []byte("* ")) {
				raw = c
			}
		}
		it, ok := parseEmail(raw, cfg)
		if ok {
			it.ExternalID = "email:" + uid
			items = append(items, it)
		}
	}
	return items, nil
}

func parseEmail(raw []byte, cfg IMAPConfig) (InboxItem, bool) {
	msg, err := mail.ReadMessage(bytes.NewReader(raw))
	if err != nil {
		return InboxItem{}, false
	}
	dec := new(mime.WordDecoder)
	from, _ := dec.DecodeHeader(msg.Header.Get("From"))
	subj, _ := dec.DecodeHeader(msg.Header.Get("Subject"))
	hay := strings.ToLower(from + " " + subj)
	if len(cfg.Filters) > 0 {
		hit := false
		for _, f := range cfg.Filters {
			hit = hit || strings.Contains(hay, strings.ToLower(f))
		}
		if !hit {
			return InboxItem{}, false
		}
	}
	tags := []string{"club"}
	for _, k := range cfg.Counselor {
		if strings.Contains(hay, strings.ToLower(k)) {
			tags = []string{"counselor"}
		}
	}
	when := msg.Header.Get("Date")
	if t, err := mail.ParseDate(when); err == nil {
		when = t.Format(time.RFC3339)
	}
	text := bodyText(msg.Header.Get("Content-Type"), msg.Header.Get("Content-Transfer-Encoding"), msg.Body)
	if len(text) > 1500 {
		text = text[:1500] + "…"
	}
	return InboxItem{Source: "email", From: from, Subject: subj, Text: text, ReceivedAt: when, Tags: tags}, true
}

func decodeBody(enc string, r io.Reader) []byte {
	var rd io.Reader = r
	switch strings.ToLower(strings.TrimSpace(enc)) {
	case "quoted-printable":
		rd = quotedprintable.NewReader(r)
	case "base64":
		rd = base64.NewDecoder(base64.StdEncoding, newLineStripper(r))
	}
	b, _ := io.ReadAll(io.LimitReader(rd, 64<<10))
	return b
}

func bodyText(ctype, enc string, r io.Reader) string {
	mt, params, err := mime.ParseMediaType(ctype)
	if err != nil || ctype == "" {
		mt = "text/plain"
	}
	if strings.HasPrefix(mt, "multipart/") {
		mr := multipart.NewReader(r, params["boundary"])
		var html string
		for {
			p, err := mr.NextPart()
			if err != nil {
				break
			}
			t := bodyText(p.Header.Get("Content-Type"), p.Header.Get("Content-Transfer-Encoding"), p)
			pt, _, _ := mime.ParseMediaType(p.Header.Get("Content-Type"))
			if pt == "text/plain" && strings.TrimSpace(t) != "" {
				return t
			}
			if html == "" {
				html = t
			}
		}
		return html
	}
	b := string(decodeBody(enc, r))
	if mt == "text/html" {
		return htmlText(b, 4000)
	}
	return strings.TrimSpace(b)
}

type lineStripper struct{ r io.Reader }

func newLineStripper(r io.Reader) io.Reader { return &lineStripper{r} }
func (l *lineStripper) Read(p []byte) (int, error) {
	n, err := l.r.Read(p)
	j := 0
	for i := 0; i < n; i++ {
		if p[i] != '\r' && p[i] != '\n' {
			p[j] = p[i]
			j++
		}
	}
	return j, err
}

// ------------------------------------------------------------------ SMTP

var headerSafe = strings.NewReplacer("\r", " ", "\n", " ")

func (s *Server) sendEmail(d Draft) error {
	c := s.integ.SMTP
	if c.Addr == "" || c.From == "" {
		return fmt.Errorf("SMTP_ADDR / SMTP_FROM are not set")
	}
	to, err := mail.ParseAddressList(d.To)
	if err != nil || len(to) == 0 {
		return fmt.Errorf("bad recipient address")
	}
	rcpt := []string{}
	for _, a := range to {
		rcpt = append(rcpt, a.Address)
	}
	var msg bytes.Buffer
	fmt.Fprintf(&msg, "From: %s\r\nTo: %s\r\nSubject: %s\r\nDate: %s\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n%s\r\n",
		headerSafe.Replace(c.From), headerSafe.Replace(d.To), mime.QEncoding.Encode("utf-8", headerSafe.Replace(d.Subject)),
		s.now().Format(time.RFC1123Z), strings.ReplaceAll(d.Body, "\n", "\r\n"))
	return smtpSend(c, rcpt, msg.Bytes())
}

// ------------------------------------------------------------------ polling

// pollOnce fetches Discord + email and merges new items into the inbox (deduped).
func (s *Server) pollOnce(ctx context.Context) (int, error) {
	var all []InboxItem
	var firstErr error
	if items, err := s.pollDiscord(ctx); err != nil {
		s.integ.setErr("discord", err)
		firstErr = err
	} else {
		s.integ.setErr("discord", nil)
		all = append(all, items...)
	}
	if items, err := s.pollEmail(); err != nil {
		s.integ.setErr("email", err)
		if firstErr == nil {
			firstErr = err
		}
	} else {
		s.integ.setErr("email", nil)
		all = append(all, items...)
	}
	s.integ.mu.Lock()
	s.integ.lastPoll = s.now().Format(localLayout)
	s.integ.mu.Unlock()
	if len(all) == 0 {
		return 0, firstErr
	}
	added := 0
	var addedMsgs []string
	_, _, err := s.store.Update(func(st *State) error {
		seen := map[string]bool{}
		for _, it := range st.Inbox {
			seen[it.ExternalID] = true
		}
		for _, it := range all {
			if seen[it.ExternalID] {
				continue
			}
			it.ID, it.Status = s.newID(), "new"
			st.Inbox = append(st.Inbox, it)
			seen[it.ExternalID] = true
			if it.ExternalID != "" {
				addedMsgs = append(addedMsgs, it.Source+":"+it.ExternalID)
			}
			added++
		}
		sort.SliceStable(st.Inbox, func(i, j int) bool { return st.Inbox[i].ReceivedAt < st.Inbox[j].ReceivedAt })
		if added == 0 {
			return errNoChange
		}
		return nil
	})
	for _, k := range addedMsgs {
		_ = s.store.RecordInboxMsgID(k)
	}
	if err == errNoChange {
		err = nil
	}
	if err != nil {
		return 0, err
	}
	return added, firstErr
}

type noChange struct{}

func (noChange) Error() string { return "no change" }

var errNoChange error = noChange{}

func (s *Server) pollLoop(ctx context.Context) {
	st := s.integ.Status()
	hasInbox := st["discord_read"].(bool) || st["email_read"].(bool)
	hasCanvas := s.integ.CanvasToken != ""
	if !hasInbox && !hasCanvas {
		return
	}
	t := time.NewTicker(s.integ.PollEvery)
	defer t.Stop()
	for {
		pctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
		if hasInbox {
			_, _ = s.pollOnce(pctx)
		}
		if s.integ.CanvasToken != "" {
			_, _ = s.canvasExplore(pctx, exploreArgs{What: "courses", Refresh: true})
			_, _ = s.canvasExplore(pctx, exploreArgs{What: "assignments", Refresh: true})
		}
		cancel()
		s.triggerPiMatrixAsync()
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}
