// study-relay: tiny Go server for the client-heavy study scheduler.
//
// It serves the compiled web app from the binary, proxies Canvas requests (no stored
// credentials), stores the shared JSON state in SQLite, and exposes an MCP tool server so
// Claude Code / Claude Desktop can read and edit the schedule over Tailscale.
package main

import (
	"compress/gzip"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"
	"syscall"
	"time"
	_ "time/tzdata" // the Pi image may lack zoneinfo
)

// version is set at build time by `make release VERSION=x.y.z`.
var version = "1.1.0"

//go:embed all:dist
var distFS embed.FS

type Config struct {
	CanvasBase      string
	Token           string // optional shared secret for /api/sync and /mcp
	AllowedOrigins  []string
	LocalLLMURL     string
	LocalLLMModel   string
	LocalLLMCtx     int
	LocalLLMAPIKey  string
	MatrixLlamaBin  string
	MatrixGGUFPath  string
	MatrixLlamaPort int
	RelayUser       string
	RelayPass       string
}

type Server struct {
	store  *Store
	cfg    Config
	loc    *time.Location
	clock  func() time.Time
	client *http.Client
	sse    *mcpSessions
	static fs.FS
	integ  *Integrations
	oauth  *oauthStore
}

func NewServer(store *Store, cfg Config, loc *time.Location, clock func() time.Time) *Server {
	if clock == nil {
		clock = time.Now
	}
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		panic(err)
	}
	return &Server{
		store: store, cfg: cfg, loc: loc, clock: clock, static: sub,
		client: &http.Client{Timeout: 25 * time.Second, Transport: &http.Transport{
			MaxIdleConns: 8, MaxIdleConnsPerHost: 4, ForceAttemptHTTP2: true,
			IdleConnTimeout: 30 * time.Second, ResponseHeaderTimeout: 20 * time.Second,
		}},
		sse:   &mcpSessions{m: map[string]*sseSession{}},
		integ: &Integrations{lastErr: map[string]string{}, PollEvery: 10 * time.Minute},
		oauth: newOAuthStore(),
	}
}

func (s *Server) now() time.Time { return s.clock().In(s.loc) }

func (s *Server) newID() string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func httpError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// Routes wires every endpoint.
func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/sync", s.auth(s.getSync))
	mux.HandleFunc("POST /api/sync", s.auth(s.postSync))
	mux.HandleFunc("POST /api/canvas/proxy", s.auth(s.canvasProxy))
	mux.HandleFunc("POST /mcp", s.auth(s.originCheck(s.mcpPost)))
	mux.HandleFunc("GET /mcp/sse", s.auth(s.originCheck(s.mcpSSE)))
	mux.HandleFunc("GET /mcp", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Allow", "POST")
		httpError(w, http.StatusMethodNotAllowed, "use POST /mcp (or GET /mcp/sse for the SSE transport)")
	})
	mux.HandleFunc("GET /api/canvas/explore", s.auth(s.exploreHTTP))
	mux.HandleFunc("GET /api/integrations", s.auth(s.integrationsHTTP))
	mux.HandleFunc("GET /api/integrations/config", s.auth(s.getIntegrationsConfigHTTP))
	mux.HandleFunc("POST /api/integrations/config", s.auth(s.saveIntegrationsConfigHTTP))
	mux.HandleFunc("POST /api/integrations/poll", s.auth(s.pollHTTP))
	mux.HandleFunc("POST /api/integrations/test", s.auth(s.testHTTP))
	mux.HandleFunc("POST /api/email/send", s.auth(s.sendDraftHTTP))
	mux.HandleFunc("POST /api/discord/post", s.auth(s.discordPostHTTP))
	mux.HandleFunc("GET /api/llm/status", s.auth(s.localLLMStatusHTTP))
	mux.HandleFunc("POST /api/llm/chat", s.auth(s.localLLMChatHTTP))
	mux.HandleFunc("GET /api/presets", s.auth(s.presetsHTTP))
	mux.HandleFunc("POST /api/presets/apply", s.auth(s.applyPresetHTTP))
	mux.HandleFunc("GET /api/audit", s.auth(s.auditHTTP))
	mux.HandleFunc("GET /api/export/json", s.auth(s.exportJSONHTTP))
	mux.HandleFunc("GET /api/export/csv", s.auth(s.exportCSVHTTP))
	mux.HandleFunc("POST /api/account/reset", s.auth(s.accountResetHTTP))
	mux.HandleFunc("GET /api/counselor/digest", s.auth(s.counselorDigestHTTP))
	mux.HandleFunc("GET /api/report/transcript", s.auth(s.transcriptHTTP))
	mux.HandleFunc("GET /.well-known/oauth-protected-resource", s.oauthProtectedResourceHTTP)
	mux.HandleFunc("GET /.well-known/oauth-protected-resource/mcp", s.oauthProtectedResourceHTTP)
	mux.HandleFunc("GET /.well-known/oauth-authorization-server", s.oauthServerMetadataHTTP)
	mux.HandleFunc("POST /oauth/register", s.oauthRegisterHTTP)
	mux.HandleFunc("GET /oauth/authorize", s.oauthAuthorizeHTTP)
	mux.HandleFunc("POST /oauth/authorize", s.oauthAuthorizeHTTP)
	mux.HandleFunc("POST /oauth/token", s.oauthTokenHTTP)
	mux.HandleFunc("POST /api/login", s.loginHTTP)
	mux.HandleFunc("GET /healthz", s.health)
	mux.HandleFunc("GET /", s.serveStatic)
	return withSecurityHeaders(mux)
}

// auth enforces RELAY_TOKEN when set. The Canvas proxy uses X-Relay-Token because its
// Authorization header belongs to Canvas.
func (s *Server) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.cfg.Token != "" {
			got := r.Header.Get("X-Relay-Token")
			if got == "" && !strings.HasPrefix(r.URL.Path, "/api/canvas") {
				got = strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
			}
			if !s.verifyTokenOrOAuth(got) {
				if strings.HasPrefix(r.URL.Path, "/mcp") {
					w.Header().Set("WWW-Authenticate", fmt.Sprintf(`Bearer resource_metadata="%s/.well-known/oauth-protected-resource"`, externalBaseURL(r)))
				}
				httpError(w, http.StatusUnauthorized, "missing or bad relay token")
				return
			}
		}
		next(w, r)
	}
}

// originCheck blocks browser pages on other origins from driving MCP (DNS-rebinding guard).
func (s *Server) originCheck(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if o := r.Header.Get("Origin"); o != "" {
			u, err := url.Parse(o)
			ok := err == nil && u.Host == r.Host
			for _, a := range s.cfg.AllowedOrigins {
				ok = ok || o == a
			}
			if !ok {
				httpError(w, http.StatusForbidden, "origin not allowed")
				return
			}
		}
		next(w, r)
	}
}

func (s *Server) getSync(w http.ResponseWriter, _ *http.Request) {
	v, st, err := s.store.Get()
	if err != nil {
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}
	st.normalizeWeek(s.now())
	writeJSON(w, http.StatusOK, map[string]any{"version": v, "state": st, "server_time": s.now().Format(localLayout)})
}

func (s *Server) postSync(w http.ResponseWriter, r *http.Request) {
	var body struct {
		BaseVersion int64  `json:"base_version"`
		State       *State `json:"state"`
		LWW         bool   `json:"lww,omitempty"`
	}
	dec := json.NewDecoder(io.LimitReader(r.Body, maxStateBytes+1024))
	if err := dec.Decode(&body); err != nil || body.State == nil {
		httpError(w, http.StatusBadRequest, "body must be {base_version, state}")
		return
	}
	body.State.Meta.UpdatedBy = "browser"
	body.State.Meta.UpdatedAt = s.now().Format(localLayout)
	s.touchPresence()
	for _, t := range body.State.Tasks {
		if t.HumanMinutes != nil && t.EstSource == "human" {
			s.store.RecordCorrection(t)
		}
	}
	if body.LWW || r.URL.Query().Get("lww") == "1" {
		nv, merged, err := s.store.PutLWW(body.BaseVersion, body.State)
		if err != nil {
			httpError(w, http.StatusBadRequest, err.Error())
			return
		}
		if len(unestimatedOpenTasks(merged)) > 0 {
			s.triggerPiMatrixAsync()
		}
		writeJSON(w, http.StatusOK, map[string]any{"version": nv, "state": merged})
		return
	}
	nv, err := s.store.Put(body.BaseVersion, body.State)
	if errors.Is(err, ErrConflict) {
		v, cur, _ := s.store.Get()
		writeJSON(w, http.StatusConflict, map[string]any{"error": "version conflict", "version": v, "state": cur})
		return
	}
	if err != nil {
		httpError(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(unestimatedOpenTasks(body.State)) > 0 {
		s.triggerPiMatrixAsync()
	}
	writeJSON(w, http.StatusOK, map[string]any{"version": nv})
}

func (s *Server) loginHTTP(w http.ResponseWriter, r *http.Request) {
	if s.cfg.RelayUser == "" || s.cfg.RelayPass == "" {
		httpError(w, http.StatusForbidden, "password login not configured")
		return
	}
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body); err != nil {
		httpError(w, http.StatusBadRequest, "invalid json")
		return
	}
	uOK := subtle.ConstantTimeCompare([]byte(strings.TrimSpace(body.Username)), []byte(s.cfg.RelayUser)) == 1
	pOK := subtle.ConstantTimeCompare([]byte(body.Password), []byte(s.cfg.RelayPass)) == 1
	if !uOK || !pOK {
		httpError(w, http.StatusUnauthorized, "invalid username or password")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "token": s.cfg.Token})
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	v, _, _ := s.store.Get()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "version": version, "state_version": v,
		"heap_mb": round2(float64(m.HeapAlloc) / (1 << 20)), "sys_mb": round2(float64(m.Sys) / (1 << 20)),
		"goroutines": runtime.NumGoroutine()})
}

func (s *Server) serveStatic(w http.ResponseWriter, r *http.Request) {
	p := strings.TrimPrefix(r.URL.Path, "/")
	if p == "" {
		p = "index.html"
	}
	if _, err := fs.Stat(s.static, p); err != nil {
		p = "index.html" // single-page app fallback
	}
	if strings.HasPrefix(p, "assets/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable") // hashed by Vite
	} else {
		w.Header().Set("Cache-Control", "no-cache")
	}
	if r.Method == http.MethodGet && strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") &&
		(strings.HasSuffix(p, ".js") || strings.HasSuffix(p, ".css") || strings.HasSuffix(p, ".html")) {
		if data, err := fs.ReadFile(s.static, p); err == nil {
			ct := "application/octet-stream"
			switch {
			case strings.HasSuffix(p, ".js"):
				ct = "text/javascript; charset=utf-8"
			case strings.HasSuffix(p, ".css"):
				ct = "text/css; charset=utf-8"
			case strings.HasSuffix(p, ".html"):
				ct = "text/html; charset=utf-8"
			}
			w.Header().Set("Content-Type", ct)
			w.Header().Set("Content-Encoding", "gzip")
			w.Header().Set("Vary", "Accept-Encoding")
			gz, _ := gzip.NewWriterLevel(w, gzip.BestSpeed)
			_, _ = gz.Write(data)
			_ = gz.Close()
			return
		}
	}
	http.ServeFileFS(w, r, s.static, p)
}

func (s *Server) exploreHTTP(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	out, err := s.canvasExplore(r.Context(), exploreArgs{What: q.Get("what"), Course: q.Get("course"), Search: q.Get("search")})
	if err != nil {
		httpError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) integrationsHTTP(w http.ResponseWriter, r *http.Request) {
	st := s.integ.Status()
	// the https address of this relay, so plain-http pages can move there (WebGPU needs https)
	pub := strings.TrimRight(os.Getenv("RELAY_PUBLIC_URL"), "/")
	if pub == "" && strings.HasSuffix(r.Host, ".ts.net") {
		pub = "https://" + r.Host
	}
	st["public_url"] = pub
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) pollHTTP(w http.ResponseWriter, r *http.Request) {
	added, err := s.pollOnce(r.Context())
	resp := map[string]any{"added": added}
	if err != nil {
		resp["error"] = err.Error()
	}
	writeJSON(w, http.StatusOK, resp)
}

// sendDraftHTTP sends one draft the user approved in the UI (the only path that sends email).
func (s *Server) sendDraftHTTP(w http.ResponseWriter, r *http.Request) {
	var body struct {
		DraftID string `json:"draft_id"`
		To      string `json:"to"`
		Subject string `json:"subject"`
		Body    string `json:"body"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&body); err != nil || body.DraftID == "" {
		httpError(w, http.StatusBadRequest, "draft_id required")
		return
	}
	var d Draft
	_, _, err := s.store.Update(func(st *State) error { // apply the user's final edits first
		for i := range st.Drafts {
			if st.Drafts[i].ID == body.DraftID {
				if st.Drafts[i].Status == "sent" {
					return fmt.Errorf("already sent")
				}
				if body.To != "" {
					st.Drafts[i].To = body.To
				}
				if body.Subject != "" {
					st.Drafts[i].Subject = body.Subject
				}
				if body.Body != "" {
					st.Drafts[i].Body = body.Body
				}
				d = st.Drafts[i]
				return nil
			}
		}
		return fmt.Errorf("no draft %s", body.DraftID)
	})
	if err != nil {
		httpError(w, http.StatusBadRequest, err.Error())
		return
	}
	sendErr := s.sendEmail(d)
	_, _, _ = s.store.Update(func(st *State) error {
		for i := range st.Drafts {
			if st.Drafts[i].ID == d.ID {
				if sendErr != nil {
					st.Drafts[i].Status, st.Drafts[i].Error = "failed", sendErr.Error()
				} else {
					st.Drafts[i].Status, st.Drafts[i].SentAt, st.Drafts[i].Error = "sent", s.now().Format(localLayout), ""
				}
			}
		}
		return nil
	})
	if sendErr != nil {
		httpError(w, http.StatusBadGateway, sendErr.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sent": true, "to": d.To})
}

func (s *Server) discordPostHTTP(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Content string `json:"content"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 16<<10)).Decode(&body); err != nil || strings.TrimSpace(body.Content) == "" {
		httpError(w, http.StatusBadRequest, "content required")
		return
	}
	if err := s.postDiscord(r.Context(), body.Content); err != nil {
		httpError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"posted": true})
}

func env(k, d string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return d
}

func main() {
	// Keep the Go heap small on a 1 GB Raspberry Pi: soft limit + eager GC.
	debug.SetMemoryLimit(20 << 20)
	debug.SetGCPercent(50)
	loadDotEnv(env("RELAY_ENV_FILE", ".env")) // credentials stay in memory, never in SQLite
	if len(os.Args) > 1 && os.Args[1] == "pair" {
		os.Exit(pairCommand(os.Args[2:]))
	}
	demoMode := false
	for _, a := range os.Args[1:] {
		if a == "--demo" {
			demoMode = true
		}
	}

	loc, err := time.LoadLocation(env("TZ_NAME", "America/Los_Angeles"))
	if err != nil {
		log.Fatalf("timezone: %v", err)
	}
	dbPath := env("RELAY_DB", "study-relay.db")
	if demoMode {
		dbPath = ":memory:"
	}
	store, err := OpenStore(dbPath)
	if err != nil {
		log.Fatalf("db: %v", err)
	}
	defer store.Close()

	presetID := env("SCHOOL_PRESET", "default")
	preset := findSchoolPreset(presetID)
	canvasDefault := "https://instructure.com"
	if preset != nil {
		if preset.CanvasBaseURL != "" {
			canvasDefault = preset.CanvasBaseURL
		}
		if os.Getenv("IMAP_FILTERS") == "" && preset.IMAPFilters != "" {
			_ = os.Setenv("IMAP_FILTERS", preset.IMAPFilters)
		}
	}

	var origins []string
	if o := os.Getenv("RELAY_ALLOWED_ORIGINS"); o != "" {
		origins = strings.Split(o, ",")
	}
	addr := env("RELAY_ADDR", "127.0.0.1:8000") // this machine only unless asked; see relayToken
	token, tokenFile, err := relayToken(addr, dbPath)
	if err != nil {
		log.Fatalf("relay token: %v", err)
	}
	if tokenFile != "" {
		log.Printf("relay is reachable from the network, so it requires a token (saved in %s). "+
			"Run `study-relay pair` to print a link that signs a device in. Set RELAY_TOKEN to choose your own.", tokenFile)
	}
	matrixPort, _ := strconv.Atoi(env("MATRIX_LLAMA_PORT", "18089"))
	srv := NewServer(store, Config{
		CanvasBase:      env("CANVAS_BASE_URL", canvasDefault),
		Token:           token,
		AllowedOrigins:  origins,
		MatrixLlamaBin:  os.Getenv("MATRIX_LLAMA_BIN"),
		MatrixGGUFPath:  os.Getenv("MATRIX_GGUF_PATH"),
		MatrixLlamaPort: matrixPort,
		RelayUser:       os.Getenv("RELAY_USER"),
		RelayPass:       os.Getenv("RELAY_PASS"),
	}, loc, nil)
	srv.integ = IntegrationsFromEnv()
	if presetID != "" {
		if v, cur, gerr := store.Get(); gerr == nil && v == 0 && len(cur.Tasks) == 0 {
			_, _ = srv.toolApplyPreset(presetID)
		}
	}
	if demoMode {
		seedDemoState(srv)
	}
	hs := &http.Server{Addr: addr, Handler: srv.Routes(),
		ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32 << 10}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = hs.Shutdown(sctx)
	}()
	go srv.pollLoop(ctx)
	go srv.gradesLoop(ctx)
	go srv.idleUnloadLoop(ctx)
	go srv.hourlyBatchLoop(ctx)
	go store.BackupLoop(ctx, dbPath)
	log.Printf("study-relay %s listening on %s (demo=%v preset=%s integrations: %v)", version, hs.Addr, demoMode, presetID, srv.integ.Status())
	if err := hs.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

// seedDemoState populates an in-memory demo DB with realistic sample Canvas tasks,
// mock club announcements, and a pre-planned week for --demo testing.
func seedDemoState(s *Server) {
	now := s.now()
	_, _, _ = s.store.Update(func(st *State) error {
		pts20, pts40, pts100 := 20.0, 40.0, 100.0
		st.Tasks = []Task{
			{
				ID: "demo-1", Source: "canvas", Course: "AP Physics 1", Title: "Problem Set 7: Rotational Dynamics",
				Description: "Problems 1-14, show free-body diagrams.", Category: "homework", TaskType: "HW",
				Points: &pts20, DueAt: now.AddDate(0, 0, 1).Format(dateLayout) + "T23:59",
				CognitiveLoad: 4, LLMMinutes: 45, EstMinutes: 45, Confidence: 0.85,
				Blocks: []int{45}, EstSource: "llm", EstWhy: "14 rotational dynamics problems", Status: "open",
			},
			{
				ID: "demo-2", Source: "canvas", Course: "AP Calculus BC", Title: "Unit 6 Integration Review",
				Description: "Complete #1-25 odd.", Category: "homework", TaskType: "HW",
				Points: &pts40, DueAt: now.AddDate(0, 0, 2).Format(dateLayout) + "T08:30",
				CognitiveLoad: 4, LLMMinutes: 40, EstMinutes: 40, Confidence: 0.82,
				Blocks: []int{40}, EstSource: "llm", EstWhy: "13 integration problems", Status: "open",
			},
			{
				ID: "demo-3", Source: "canvas", Course: "English 1A", Title: "Essay Draft: Argument Synthesis",
				Description: "1000 words, MLA citations.", Category: "project", TaskType: "Project",
				Points: &pts100, DueAt: now.AddDate(0, 0, 4).Format(dateLayout) + "T23:59",
				CognitiveLoad: 3, LLMMinutes: 90, EstMinutes: 90, Confidence: 0.8,
				Blocks: []int{45, 45}, EstSource: "llm", EstWhy: "1000-word essay draft", Status: "open",
			},
		}
		st.Inbox = []InboxItem{
			{
				ID: "demo-in-1", Source: "discord", From: "Robotics Club", Subject: "Build session moved to Thursday 4-6 PM",
				Text:       "Heads up team — drivetrain CAD review is Thursday 4:00-6:00 PM in Room E12.",
				ReceivedAt: now.Format(localLayout), Status: "new",
			},
		}
		ReplanServer(st, now, s.newID, s.loc)
		return nil
	})
}
