package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os/exec"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

var matrixRunning atomic.Bool

type matrixEstimateJSON struct {
	TaskType      string  `json:"task_type"`
	CognitiveLoad int     `json:"cognitive_load"`
	Minutes       int     `json:"minutes"`
	Confidence    float64 `json:"confidence"`
	Why           string  `json:"why"`
}

func unestimatedOpenTasks(st *State) []Task {
	out := []Task{}
	for _, t := range st.Tasks {
		if t.Status == "open" && t.HumanMinutes == nil && (t.EstSource == "" || t.EstSource == "heuristic") {
			out = append(out, t)
		}
	}
	return out
}

// estimateTaskViaEndpoint queries an OpenAI-compatible /v1/chat/completions endpoint
// (ephemeral Pi llama-server or Relay AI) for a task's time estimate using directions & comments.
func estimateTaskViaEndpoint(ctx context.Context, client *http.Client, baseURL, model string, t Task) (*matrixEstimateJSON, error) {
	dirs := t.Description
	if len(dirs) > 1200 {
		dirs = dirs[:1200]
	}
	if dirs == "" {
		dirs = "(none)"
	}
	cmts := strings.Join(t.Comments, " | ")
	if len(cmts) > 600 {
		cmts = cmts[:600]
	}
	pts := "?"
	if t.Points != nil {
		pts = strconv.FormatFloat(*t.Points, 'f', -1, 64)
	}
	userMsg := fmt.Sprintf("Course: %s\nTitle: %s\nCategory: %s\nPoints: %s\nDirections: %s",
		t.Course, t.Title, t.Category, pts, dirs)
	if cmts != "" {
		userMsg += "\nTeacher/Submission Comments: " + cmts
	}

	body, _ := json.Marshal(map[string]any{
		"model": model,
		"messages": []map[string]string{
			{"role": "system", "content": `Estimate high-school homework workload. Reply with compact JSON only: {"task_type":"HW|Quiz|Exam|Project|Lab","cognitive_load":1,"minutes":30,"confidence":0.8,"why":"<=12 words"}.`},
			{"role": "user", "content": userMsg},
		},
		"max_tokens":  96,
		"temperature": 0.1,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(baseURL, "/")+"/v1/chat/completions", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("llm status %d", resp.StatusCode)
	}
	var res struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 256<<10)).Decode(&res); err != nil {
		return nil, err
	}
	if len(res.Choices) == 0 {
		return nil, fmt.Errorf("empty llm response")
	}
	raw := strings.TrimSpace(res.Choices[0].Message.Content)
	if s := strings.IndexByte(raw, '{'); s >= 0 {
		if e := strings.LastIndexByte(raw, '}'); e > s {
			raw = raw[s : e+1]
		}
	}
	var est matrixEstimateJSON
	if err := json.Unmarshal([]byte(raw), &est); err != nil {
		return nil, err
	}
	if est.Minutes < 5 || est.Minutes > 1200 {
		return nil, fmt.Errorf("out-of-range minutes %d", est.Minutes)
	}
	if est.CognitiveLoad < 1 || est.CognitiveLoad > 5 {
		est.CognitiveLoad = 3
	}
	est.Minutes = ((est.Minutes + 2) / 5) * 5
	if est.Minutes < 5 {
		est.Minutes = 5
	}
	if est.Confidence <= 0 || est.Confidence > 0.95 {
		est.Confidence = 0.78
	}
	return &est, nil
}

// runPiMatrixBatch temporarily spins up llama-server on CPU core 3 (nice 19, ionice idle),
// refines heuristic-only open tasks using LFM3 GGUF weights, saves to SQLite, and kills the server
// immediately so 0 MB of weights stay resident and PiQuant is never impacted.
func (s *Server) runPiMatrixBatch(ctx context.Context) (int, error) {
	if s.cfg.MatrixLlamaBin == "" || s.cfg.MatrixGGUFPath == "" {
		return 0, nil
	}
	if !matrixRunning.CompareAndSwap(false, true) {
		return 0, nil
	}
	defer matrixRunning.Store(false)

	_, st, err := s.store.Get()
	if err != nil {
		return 0, err
	}
	todo := unestimatedOpenTasks(st)
	if len(todo) == 0 {
		return 0, nil
	}

	bCtx, cancel := context.WithTimeout(ctx, 20*time.Minute)
	defer cancel()

	port := s.cfg.MatrixLlamaPort
	if port <= 0 {
		port = 18089
	}
	portStr := strconv.Itoa(port)
	cmd := exec.CommandContext(bCtx, "ionice", "-c", "3", "nice", "-n", "19", "taskset", "-c", "3",
		s.cfg.MatrixLlamaBin, "-m", s.cfg.MatrixGGUFPath,
		"--host", "127.0.0.1", "--port", portStr,
		"-c", "1024", "-t", "1", "--log-disable")
	if err := cmd.Start(); err != nil {
		return 0, fmt.Errorf("start ephemeral llama-server: %w", err)
	}
	defer func() {
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		_ = cmd.Wait()
	}()

	baseURL := "http://127.0.0.1:" + portStr
	hc := &http.Client{Timeout: 90 * time.Second}
	ready := false
	for i := 0; i < 60; i++ {
		if bCtx.Err() != nil {
			return 0, bCtx.Err()
		}
		r, err := hc.Get(baseURL + "/health")
		if err == nil {
			_ = r.Body.Close()
			if r.StatusCode == http.StatusOK {
				ready = true
				break
			}
		}
		time.Sleep(1 * time.Second)
	}
	if !ready {
		return 0, fmt.Errorf("ephemeral llama-server did not become ready")
	}

	results := map[string]*matrixEstimateJSON{}
	for _, t := range todo {
		if bCtx.Err() != nil {
			break
		}
		est, err := estimateTaskViaEndpoint(bCtx, hc, baseURL, "lfm3", t)
		if err != nil {
			continue
		}
		results[t.ID] = est
	}
	if len(results) == 0 {
		return 0, nil
	}

	now := s.now()
	_, _, err = s.store.Update(func(st *State) error {
		for i := range st.Tasks {
			t := &st.Tasks[i]
			est, ok := results[t.ID]
			if !ok || t.HumanMinutes != nil {
				continue
			}
			t.LLMMinutes = est.Minutes
			t.EstMinutes = est.Minutes
			t.CognitiveLoad = est.CognitiveLoad
			t.Confidence = est.Confidence
			t.EstSource = "llm"
			if est.Why != "" {
				if len(est.Why) > 120 {
					t.EstWhy = est.Why[:120]
				} else {
					t.EstWhy = est.Why
				}
			}
			t.Blocks = blocksFor(est.Minutes, st.Rules.BlockMin, st.Rules.MinBlockMin)
		}
		ReplanServer(st, now, s.newID, s.loc)
		return nil
	})
	if err != nil {
		return 0, err
	}
	log.Printf("matrix_llm: refined %d/%d tasks on Pi core 3 and unloaded weights", len(results), len(todo))
	return len(results), nil
}

func (s *Server) triggerPiMatrixAsync() {
	if s.cfg.MatrixLlamaBin == "" || s.cfg.MatrixGGUFPath == "" {
		return
	}
	go func() {
		_, _ = s.runPiMatrixBatch(context.Background())
	}()
}
