package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// ------------------------------------------------------------------ native high-context local LLM proxy

func localLLMConfig(cfg Config) (baseURL, model string, ctxLen int, apiKey string) {
	baseURL = strings.TrimRight(cfg.LocalLLMURL, "/")
	if baseURL == "" {
		baseURL = strings.TrimRight(os.Getenv("LOCAL_LLM_URL"), "/")
	}
	if baseURL == "" {
		baseURL = "http://127.0.0.1:11434/v1"
	}
	model = cfg.LocalLLMModel
	if model == "" {
		model = strings.TrimSpace(os.Getenv("LOCAL_LLM_MODEL"))
	}
	if model == "" {
		model = "lfm2.5"
	}
	ctxLen = cfg.LocalLLMCtx
	if ctxLen <= 0 {
		if n, err := strconv.Atoi(strings.TrimSpace(os.Getenv("LOCAL_LLM_CTX"))); err == nil && n > 0 {
			ctxLen = n
		}
	}
	if ctxLen <= 0 {
		ctxLen = 32768
	}
	switch {
	case strings.Contains(baseURL, "openrouter.ai"):
		apiKey = strings.TrimSpace(os.Getenv("OPENROUTER_API_KEY"))
	case strings.Contains(baseURL, "azure.com"):
		apiKey = strings.TrimSpace(os.Getenv("AZURE_OPENAI_API_KEY"))
	case strings.Contains(baseURL, "api.openai.com"):
		apiKey = strings.TrimSpace(os.Getenv("OPENAI_API_KEY"))
	}
	if apiKey == "" {
		apiKey = strings.TrimSpace(cfg.LocalLLMAPIKey)
	}
	if apiKey == "" {
		apiKey = strings.TrimSpace(os.Getenv("LOCAL_LLM_API_KEY"))
	}
	if apiKey == "" {
		apiKey = strings.TrimSpace(os.Getenv("OPENAI_API_KEY"))
	}
	return baseURL, model, ctxLen, apiKey
}

// isCloudLLM is true for model servers that aren't on this machine or the local network.
func isCloudLLM(baseURL string) bool {
	u, err := url.Parse(baseURL)
	if err != nil {
		return false
	}
	h := u.Hostname()
	if h == "localhost" || strings.HasSuffix(h, ".local") || strings.HasSuffix(h, ".lan") {
		return false
	}
	if ip := net.ParseIP(h); ip != nil {
		return !(ip.IsLoopback() || ip.IsPrivate())
	}
	return true
}

// pricingTierCtxCap caps cloud context windows below tiered-pricing cliffs (e.g. >128K/200K surcharges)
// while keeping full configured context for free local inference (apiKey == "").
func pricingTierCtxCap(baseURL, model string, configured int, isCloud bool) (int, string) {
	if configured <= 0 {
		configured = 32768
	}
	if !isCloud {
		return configured, "local"
	}
	m := strings.ToLower(model)
	switch {
	case strings.Contains(m, "claude") || strings.Contains(m, "anthropic/"):
		if configured > 190000 {
			return 190000, "capped at 190K (avoids >200K long-context surcharge)"
		}
		return configured, "standard tier"
	case strings.Contains(m, "gemini") || strings.Contains(m, "google/gemini"):
		if configured > 128000 {
			return 128000, "capped at 128K (avoids >128K/200K surcharge)"
		}
		return configured, "standard tier"
	default:
		// OpenRouter / OpenAI / open-weight cloud models: keep <= 32K to avoid long-context surcharges & TPM limits.
		if configured > 32768 {
			return 32768, "capped at 32K (cost-safe cloud window)"
		}
		return configured, "cost-safe cloud window"
	}
}

// trimMessagesToCtx drops middle history if total estimated tokens exceed ~85% of cap (preserving system + latest turn).
func trimMessagesToCtx(msgs []map[string]any, ctxCap int) []map[string]any {
	maxChars := int(float64(ctxCap) * 3.0)
	total := 0
	for _, m := range msgs {
		if s, ok := m["content"].(string); ok {
			total += len(s)
		}
	}
	if total <= maxChars || len(msgs) <= 2 {
		return msgs
	}
	out := make([]map[string]any, 0, len(msgs))
	// Always keep leading system message if present, and walk backwards from newest messages.
	start := 0
	used := 0
	if role, _ := msgs[0]["role"].(string); role == "system" {
		if s, ok := msgs[0]["content"].(string); ok {
			used += len(s)
		}
		out = append(out, msgs[0])
		start = 1
	}
	tail := []map[string]any{}
	for i := len(msgs) - 1; i >= start; i-- {
		s, _ := msgs[i]["content"].(string)
		if used+len(s) > maxChars && len(tail) > 0 {
			break
		}
		used += len(s)
		tail = append(tail, msgs[i])
	}
	for i := len(tail) - 1; i >= 0; i-- {
		out = append(out, tail[i])
	}
	return out
}

func (s *Server) localLLMStatusHTTP(w http.ResponseWriter, r *http.Request) {
	baseURL, model, ctxLen, apiKey := localLLMConfig(s.cfg)
	if apiKey == "" && isCloudLLM(baseURL) {
		// cloud model lists are public, so "reachable" would be misleading without a key
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "url": baseURL, "model": model, "context_window": ctxLen, "cloud": true,
			"error": "no API key yet: add it in Settings → Connections"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/models", nil)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "url": baseURL, "model": model, "context_window": ctxLen, "error": err.Error()})
		return
	}
	if apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
		req.Header.Set("api-key", apiKey)
	}
	resp, err := s.client.Do(req)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "url": baseURL, "model": model, "context_window": ctxLen, "error": err.Error()})
		return
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	var models []string
	var parsed struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if json.Unmarshal(body, &parsed) == nil {
		for _, m := range parsed.Data {
			models = append(models, m.ID)
		}
	}
	effCtx, ctxNote := pricingTierCtxCap(baseURL, model, ctxLen, apiKey != "")
	ok := resp.StatusCode == http.StatusOK || (apiKey != "" && resp.StatusCode == http.StatusNotFound)
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":             ok,
		"url":            baseURL,
		"model":          model,
		"context_window": effCtx,
		"context_note":   ctxNote,
		"cloud":          apiKey != "",
		"available":      models,
	})
}

var sharedLLMClient = &http.Client{
	Timeout: 120 * time.Second,
	Transport: &http.Transport{
		MaxIdleConns:      2,
		IdleConnTimeout:   30 * time.Second,
		DisableKeepAlives: false,
	},
}

func (s *Server) localLLMChatHTTP(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Messages       []map[string]any `json:"messages"`
		Temperature    *float64         `json:"temperature"`
		MaxTokens      int              `json:"max_tokens"`
		Model          string           `json:"model"`
		ResponseFormat map[string]any   `json:"response_format"`
		EnableThinking *bool            `json:"enable_thinking"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 2<<20)).Decode(&in); err != nil || len(in.Messages) == 0 {
		httpError(w, http.StatusBadRequest, "messages required")
		return
	}
	baseURL, model, ctxLen, apiKey := localLLMConfig(s.cfg)
	if strings.TrimSpace(in.Model) != "" && in.Model != "native" {
		model = strings.TrimSpace(in.Model)
	}
	effCtx, _ := pricingTierCtxCap(baseURL, model, ctxLen, apiKey != "")
	msgs := trimMessagesToCtx(in.Messages, effCtx)
	temp := 0.1
	if in.Temperature != nil {
		temp = *in.Temperature
	}
	maxTok := in.MaxTokens
	if maxTok <= 0 {
		maxTok = 800
	}
	payload := map[string]any{
		"model":       model,
		"messages":    msgs,
		"temperature": temp,
		"max_tokens":  maxTok,
		"stream":      false,
	}
	if len(in.ResponseFormat) > 0 {
		payload["response_format"] = in.ResponseFormat
		if strings.Contains(baseURL, "openrouter.ai") && maxTok < 1200 {
			payload["max_tokens"] = 1200
		}
	}
	if apiKey == "" {
		payload["options"] = map[string]any{"num_ctx": effCtx}
		// local thinking models (Qwen3/Jan) otherwise spend the whole token budget thinking and return no text
		if in.EnableThinking == nil || !*in.EnableThinking {
			payload["reasoning_effort"] = "none"
		}
	} else if strings.Contains(baseURL, "openrouter.ai") && (in.EnableThinking == nil || !*in.EnableThinking) {
		payload["reasoning"] = map[string]any{"exclude": true}
	}
	raw, _ := json.Marshal(payload)
	ctx, cancel := context.WithTimeout(r.Context(), 120*time.Second)
	defer cancel()
	sendReq := func(bodyBytes []byte) (*http.Response, []byte, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/chat/completions", bytes.NewReader(bodyBytes))
		if err != nil {
			return nil, nil, err
		}
		req.Header.Set("Content-Type", "application/json")
		if apiKey != "" {
			req.Header.Set("Authorization", "Bearer "+apiKey)
			if strings.Contains(baseURL, "azure.com") {
				req.Header.Set("api-key", apiKey)
			}
		}
		if strings.Contains(baseURL, "openrouter.ai") {
			req.Header.Set("HTTP-Referer", "http://localhost:8000")
			req.Header.Set("X-Title", "Study Flow")
		}
		resp, err := sharedLLMClient.Do(req)
		if err != nil {
			return nil, nil, err
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
		return resp, b, nil
	}

	resp, body, err := sendReq(raw)
	if err != nil {
		httpError(w, http.StatusBadGateway, "local LLM unreachable: "+err.Error())
		return
	}
	// Some OpenRouter / open-weight models reject response_format=json_object with 400/422; retry without it.
	if (resp.StatusCode == http.StatusBadRequest || resp.StatusCode == http.StatusUnprocessableEntity) && len(in.ResponseFormat) > 0 {
		delete(payload, "response_format")
		raw, _ = json.Marshal(payload)
		if resp2, body2, err2 := sendReq(raw); err2 == nil {
			resp, body = resp2, body2
		}
	}
	if resp.StatusCode >= 400 {
		log.Printf("llm: chat upstream %d (%s): %s", resp.StatusCode, model, string(body))
		httpError(w, http.StatusBadGateway, fmt.Sprintf("LLM error (%d): %s", resp.StatusCode, string(body)))
		return
	}
	var out struct {
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
		Choices []struct {
			Message struct {
				Content   string `json:"content"`
				Reasoning string `json:"reasoning"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		httpError(w, http.StatusBadGateway, "unexpected LLM response")
		return
	}
	if out.Error != nil && out.Error.Message != "" {
		httpError(w, http.StatusBadGateway, "LLM error: "+out.Error.Message)
		return
	}
	if len(out.Choices) == 0 {
		httpError(w, http.StatusBadGateway, "empty LLM choices")
		return
	}
	content := out.Choices[0].Message.Content
	if strings.TrimSpace(content) == "" {
		content = out.Choices[0].Message.Reasoning
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"content":        content,
		"model":          model,
		"context_window": ctxLen,
	})
}

// ------------------------------------------------------------------ research milestones & competition coach (MCP)

type researchArgs struct {
	Action      string   `json:"action"` // add | list | complete
	TaskID      string   `json:"task_id"`
	Match       string   `json:"match"`
	Title       string   `json:"title"`
	Phase       string   `json:"phase"`
	DueAt       string   `json:"due_at"`
	EstMinutes  *float64 `json:"estimated_minutes"`
	Load        *float64 `json:"cognitive_load"`
	AddDeadline bool     `json:"add_deadline_event"`
}

func (s *Server) toolManageResearchMilestone(a researchArgs) (map[string]any, error) {
	act := strings.ToLower(strings.TrimSpace(a.Action))
	if act == "" {
		act = "list"
	}
	switch act {
	case "list":
		_, st, err := s.store.Get()
		if err != nil {
			return nil, err
		}
		milestones := []Task{}
		for _, t := range st.Tasks {
			if strings.EqualFold(t.Course, "RESEARCH") || strings.Contains(strings.ToLower(t.Title), "research") ||
				strings.Contains(strings.ToLower(t.Title), "isef") || strings.Contains(strings.ToLower(t.Title), "synopsys") {
				milestones = append(milestones, t)
			}
		}
		return map[string]any{"milestones": milestones, "count": len(milestones)}, nil
	case "complete":
		return s.toolMarkTask(a.TaskID, a.Match, "done")
	case "add":
		if strings.TrimSpace(a.Title) == "" {
			return nil, fmt.Errorf("title is required")
		}
		est := 120
		if a.EstMinutes != nil && *a.EstMinutes >= 5 && *a.EstMinutes <= 1200 {
			est = int(*a.EstMinutes + 0.5)
		}
		load := 4
		if a.Load != nil && *a.Load >= 1 && *a.Load <= 5 {
			load = int(*a.Load + 0.5)
		}
		title := a.Title
		if a.Phase != "" && !strings.Contains(strings.ToLower(title), strings.ToLower(a.Phase)) {
			title = fmt.Sprintf("[%s] %s", strings.ToUpper(a.Phase), title)
		}
		var created Task
		_, _, err := s.store.Update(func(st *State) error {
			created = Task{
				ID:            "res-" + s.newID(),
				Source:        "mcp",
				Course:        "RESEARCH",
				Title:         title,
				Category:      "project",
				TaskType:      "Project",
				DueAt:         a.DueAt,
				CognitiveLoad: load,
				LLMMinutes:    est,
				EstMinutes:    est,
				Confidence:    0.85,
				Blocks:        blocksFor(est, st.Rules.BlockMin, st.Rules.MinBlockMin),
				EstSource:     "mcp",
				Status:        "open",
			}
			st.Tasks = append(st.Tasks, created)
			if a.AddDeadline && len(a.DueAt) >= 16 {
				if dueT, err := time.ParseInLocation(localLayout, a.DueAt[:16], s.loc); err == nil {
					st.Events = append(st.Events, Event{
						ID:    "ev-" + s.newID(),
						Title: "Deadline: " + title,
						Kind:  "event",
						Start: dueT.Add(-30 * time.Minute).Format(localLayout),
						End:   dueT.Format(localLayout),
					})
				}
			}
			st.Meta.NeedsReplan = true
			return nil
		})
		if err != nil {
			return nil, err
		}
		return map[string]any{"milestone": created, "needs_replan": true}, nil
	default:
		return nil, fmt.Errorf("action must be add, list, or complete")
	}
}

type compWorksheet struct {
	Title   string `json:"title"`
	Minutes int    `json:"minutes"`
	Load    int    `json:"load"`
	Cat     string `json:"category"`
	Type    string `json:"task_type"`
}

type compRoadmap struct {
	Bucket      string          `json:"bucket"`
	TargetHours float64         `json:"recommended_weekly_hours"`
	Strategy    string          `json:"strategy"`
	Topics      []string        `json:"topics"`
	Research    []string        `json:"research_and_references"`
	Worksheets  []compWorksheet `json:"worksheets"`
}

func roadmapFor(goal, target string) (compRoadmap, error) {
	g := strings.ToUpper(strings.TrimSpace(goal))
	switch g {
	case "AIME":
		hrs := 8.0
		strat := "Target 8+/15: achieve near-100% accuracy on #1-#7 (speed + zero silly errors), solve 2-3 of #8-#11 consistently, and run weekly 3-hour timed AIME mocks."
		if target != "" {
			strat = fmt.Sprintf("Target score %s/15 on AIME: %s", target, strat)
		}
		return compRoadmap{
			Bucket:      "AIME",
			TargetHours: hrs,
			Strategy:    strat,
			Topics: []string{
				"Number Theory: modular arithmetic, LTE, orders, CRT, Diophantine equations",
				"Combinatorics: bijections, recursion, PIE, expected value, generating functions",
				"Geometry: cyclic quadrilaterals, power of a point, radical axis, homothety, trig bash",
				"Algebra: Vieta jumping, polynomials/roots of unity, inequalities, telescoping sums",
			},
			Research: []string{
				"AoPS AIME Past Papers (2015-2025 I & II) — #1-#11 error-log review",
				"Evan Chen handouts: Lifting the Exponent (LTE), Power of a Point, Expected Value",
				"AoPS Volume 2 & Intermediate Counting/Probability selected chapters",
				"HMMT / PUMaC Theme/Guts targeted #4-#8 difficulty sets",
			},
			Worksheets: []compWorksheet{
				{Title: "AIME 2021-2025 #1-#8 Speed & Accuracy Drill (25 problems)", Minutes: 90, Load: 4, Cat: "homework", Type: "HW"},
				{Title: "AIME Number Theory Worksheet: LTE, Orders & CRT", Minutes: 75, Load: 5, Cat: "homework", Type: "HW"},
				{Title: "AIME Combinatorics Worksheet: States, Recursion & Expected Value", Minutes: 75, Load: 5, Cat: "homework", Type: "HW"},
				{Title: "AIME Geometry Worksheet: Power of a Point & Trig Bash", Minutes: 75, Load: 5, Cat: "homework", Type: "HW"},
				{Title: "Timed 3-Hour AIME Mock Exam + Error Log", Minutes: 180, Load: 5, Cat: "test", Type: "Exam"},
			},
		}, nil
	case "USAAIO", "USAIO":
		return compRoadmap{
			Bucket:      "USAAIO",
			TargetHours: 6.0,
			Strategy:    "Qualify for USAAIO Round 2: master Round 1 math (linear algebra, matrix calculus, probability) + fast PyTorch/NumPy implementation of core ML/DL architectures under time pressure.",
			Topics: []string{
				"Math for ML: SVD/eigendecomposition, Jacobians, chain rule, Bayes, MLE/MAP, KL divergence",
				"Classical ML: logistic/ridge regression, SVM, k-means, PCA, decision trees, bias-variance",
				"Deep Learning in PyTorch: custom autograd, MLP, CNNs, LayerNorm/BatchNorm, residual blocks",
				"Sequence & Attention: scaled dot-product self-attention, causal masking, positional encodings",
			},
			Research: []string{
				"USAAIO Official Syllabus & Round 1 Past Problems / Editorials",
				"IOAI (International Olympiad in AI) Practice Tasks & Scientific/Practical Tracks",
				"Andrej Karpathy: micrograd & makemore (backprop + Transformer from scratch)",
				"Stanford CS231n / CS229 concise notes on backprop, optimization, and attention",
			},
			Worksheets: []compWorksheet{
				{Title: "USAAIO Round 1 Past Paper Timed Practice + Editorial Review", Minutes: 120, Load: 5, Cat: "test", Type: "Exam"},
				{Title: "ML Math Worksheet: Matrix Calculus, SVD & Cross-Entropy Gradients", Minutes: 60, Load: 4, Cat: "homework", Type: "HW"},
				{Title: "PyTorch Coding Drill: Custom Training Loop, CNN & Residual Block", Minutes: 90, Load: 4, Cat: "lab", Type: "Lab"},
				{Title: "Transformer Self-Attention & Causal Masking From-Scratch Worksheet", Minutes: 90, Load: 5, Cat: "lab", Type: "Lab"},
			},
		}, nil
	case "RESEARCH", "ISEF", "SYNOPSYS":
		return compRoadmap{
			Bucket:      "RESEARCH",
			TargetHours: 6.0,
			Strategy:    "Execute a competition-grade research project (ISEF / Synopsys): lock down a crisp hypothesis, reproducible baseline, rigorous ablations, and clear visual storytelling.",
			Topics: []string{
				"Literature review & gap table (arXiv / PubMed / OpenAlex)",
				"Reproducible baseline + evaluation metrics",
				"Ablation study, statistical significance & error analysis",
				"Abstract, 12-page paper / quad chart & 5-minute judge pitch",
			},
			Research: []string{
				"arXiv / Semantic Scholar / OpenAlex: 10-paper synthesis matrix on core method",
				"ISEF / Synopsys Judging Rubric: novelty, engineering/scientific rigor, validation",
			},
			Worksheets: []compWorksheet{
				{Title: "[LITERATURE] 10-Paper Synthesis Matrix & Research Gap", Minutes: 90, Load: 4, Cat: "project", Type: "Project"},
				{Title: "[EXPERIMENT] Reproducible Baseline & Metric Harness", Minutes: 120, Load: 5, Cat: "project", Type: "Project"},
				{Title: "[ANALYSIS] Ablation Study & Error Analysis Tables", Minutes: 90, Load: 5, Cat: "project", Type: "Project"},
				{Title: "[PAPER] Abstract + Methods & Results Draft", Minutes: 120, Load: 4, Cat: "project", Type: "Project"},
			},
		}, nil
	case "ACT":
		return compRoadmap{
			Bucket:      "ACT",
			TargetHours: 4.0,
			Strategy:    "Maximize ACT composite with timed section pacing (English 45m/75q, Math 60m/60q, Reading 35m/40q, Science 35m/40q) and strict mistake-pattern tagging.",
			Topics:      []string{"English grammar/rhetoric", "Math #45-#60 pacing", "Reading passage mapping", "Science data/conflicting-viewpoints"},
			Research:    []string{"Official ACT Prep Guide (TIR released exams)", "Erica Meltzer English/Reading rules"},
			Worksheets: []compWorksheet{
				{Title: "ACT Timed Math + Science Double Section Drill", Minutes: 95, Load: 4, Cat: "quiz", Type: "Quiz"},
				{Title: "ACT English & Reading Error-Log Review", Minutes: 50, Load: 3, Cat: "homework", Type: "HW"},
			},
		}, nil
	case "PHYSICS":
		return compRoadmap{
			Bucket:      "PHYSICS",
			TargetHours: 4.0,
			Strategy:    "Build F=ma / AP Physics C Mechanics mastery through free-body diagrams, conservation laws, rotational dynamics, and calculus-based derivations.",
			Topics:      []string{"Rotational inertia & angular momentum", "Oscillations & gravitation", "Non-inertial frames & energy methods"},
			Research:    []string{"AAPT F=ma Past Exams (2015-2025)", "Morin 'Introduction to Classical Mechanics' selected problems"},
			Worksheets: []compWorksheet{
				{Title: "F=ma Past Exam 25-Problem Timed Set (75 min) + Solutions", Minutes: 90, Load: 5, Cat: "quiz", Type: "Quiz"},
				{Title: "Rotational Dynamics & Torque Derivation Worksheet", Minutes: 60, Load: 4, Cat: "homework", Type: "HW"},
			},
		}, nil
	default:
		return compRoadmap{}, fmt.Errorf("unknown goal %q (supported: AIME, USAAIO, RESEARCH, ACT, PHYSICS)", goal)
	}
}

func (s *Server) toolPlanCompetitionGoal(goal, target, deadline string, assign bool) (map[string]any, error) {
	rm, err := roadmapFor(goal, target)
	if err != nil {
		return nil, err
	}
	created := []Task{}
	if assign {
		now := s.now()
		_, _, err = s.store.Update(func(st *State) error {
			b := st.bucket(rm.Bucket)
			if b.TargetHours < rm.TargetHours {
				b.TargetHours = rm.TargetHours
			}
			existing := map[string]bool{}
			for _, t := range st.Tasks {
				if t.Status == "open" {
					existing[strings.ToLower(t.Title)] = true
				}
			}
			for i, w := range rm.Worksheets {
				if existing[strings.ToLower(w.Title)] {
					continue
				}
				due := now.AddDate(0, 0, (i+1)*2).Format("2006-01-02") + "T21:00"
				if deadline != "" && len(deadline) >= 10 {
					due = deadline[:10] + "T21:00"
				}
				t := Task{
					ID:            "goal-" + s.newID(),
					Source:        "mcp",
					Course:        rm.Bucket,
					Title:         w.Title,
					Category:      w.Cat,
					TaskType:      w.Type,
					DueAt:         due,
					CognitiveLoad: w.Load,
					LLMMinutes:    w.Minutes,
					EstMinutes:    w.Minutes,
					Confidence:    0.85,
					Blocks:        blocksFor(w.Minutes, st.Rules.BlockMin, st.Rules.MinBlockMin),
					EstSource:     "mcp",
					Status:        "open",
				}
				st.Tasks = append(st.Tasks, t)
				created = append(created, t)
			}
			st.Meta.NeedsReplan = true
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	return map[string]any{
		"roadmap":        rm,
		"assigned_tasks": created,
		"needs_replan":   len(created) > 0,
	}, nil
}
