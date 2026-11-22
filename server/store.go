package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite" // pure-Go SQLite, CGO_ENABLED=0 friendly
)

var ErrConflict = errors.New("version conflict")

const maxStateBytes = 2 << 20 // 2 MB document cap

// Store keeps one versioned JSON document in SQLite.
type Store struct {
	db *sql.DB
	mu sync.Mutex
}

func OpenStore(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1) // one connection: tiny memory, serialised writes
	db.SetMaxIdleConns(1)
	for _, p := range []string{
		"PRAGMA journal_mode = WAL;",
		"PRAGMA synchronous = NORMAL;",
		"PRAGMA busy_timeout = 5000;",
		"PRAGMA foreign_keys = ON;",
		"PRAGMA cache_size = -2000;",
		"PRAGMA mmap_size = 0;",
		"PRAGMA temp_store = MEMORY;",
		`CREATE TABLE IF NOT EXISTS state (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			version INTEGER NOT NULL,
			doc TEXT NOT NULL,
			updated_at TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS audit_log (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			at TEXT NOT NULL,
			actor TEXT NOT NULL,
			action TEXT NOT NULL,
			detail TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS inbox_dedup (
			source_msg_id TEXT PRIMARY KEY,
			seen_at TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS correction_history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			task_id TEXT NOT NULL UNIQUE,
			course TEXT NOT NULL,
			title TEXT NOT NULL,
			category TEXT NOT NULL,
			estimated_minutes INTEGER NOT NULL,
			actual_minutes INTEGER NOT NULL,
			at TEXT NOT NULL)`,
	} {
		if _, err := db.Exec(p); err != nil {
			db.Close()
			return nil, fmt.Errorf("%s: %w", p, err)
		}
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

type AuditEntry struct {
	ID     int64  `json:"id"`
	At     string `json:"at"`
	Actor  string `json:"actor"`
	Action string `json:"action"`
	Detail string `json:"detail"`
}

func (s *Store) LogAudit(actor, action, detail string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	at := time.Now().UTC().Format(time.RFC3339)
	_, _ = s.db.Exec("INSERT INTO audit_log (at, actor, action, detail) VALUES (?, ?, ?, ?)", at, actor, action, detail)
	_, _ = s.db.Exec("DELETE FROM audit_log WHERE id NOT IN (SELECT id FROM audit_log ORDER BY id DESC LIMIT 500)")
}

func (s *Store) ListAudit(limit int) ([]AuditEntry, error) {
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.Query("SELECT id, at, actor, action, detail FROM audit_log ORDER BY id DESC LIMIT ?", limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AuditEntry{}
	for rows.Next() {
		var e AuditEntry
		if err := rows.Scan(&e.ID, &e.At, &e.Actor, &e.Action, &e.Detail); err == nil {
			out = append(out, e)
		}
	}
	return out, rows.Err()
}

func (s *Store) Reset() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec("DELETE FROM state")
	return err
}

// Get returns the current version and document (version 0 + default state when empty).
func (s *Store) Get() (int64, *State, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.getLocked()
}

func (s *Store) getLocked() (int64, *State, error) {
	var v int64
	var doc string
	err := s.db.QueryRow("SELECT version, doc FROM state WHERE id = 1").Scan(&v, &doc)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, DefaultState(), nil
	}
	if err != nil {
		return 0, nil, err
	}
	st := &State{}
	if err := json.Unmarshal([]byte(doc), st); err != nil {
		return 0, nil, err
	}
	st.fillDefaults()
	return v, st, nil
}

func (s *Store) putLocked(base int64, st *State) (int64, error) {
	st.fillDefaults()
	doc, err := json.Marshal(st)
	if err != nil {
		return 0, err
	}
	if len(doc) > maxStateBytes/2 {
		if len(st.Sessions) > 200 {
			st.Sessions = st.Sessions[len(st.Sessions)-200:]
		}
		if len(st.Inbox) > 200 {
			st.Inbox = st.Inbox[len(st.Inbox)-200:]
		}
		doc, err = json.Marshal(st)
		if err != nil {
			return 0, err
		}
	}
	if len(doc) > maxStateBytes {
		return 0, fmt.Errorf("state too large (%d bytes > %d)", len(doc), maxStateBytes)
	}
	now := time.Now().UTC().Format(time.RFC3339)
	next := base + 1
	if base == 0 {
		res, err := s.db.Exec("INSERT OR IGNORE INTO state (id, version, doc, updated_at) VALUES (1, 1, ?, ?)",
			string(doc), now)
		if err != nil {
			return 0, err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return 0, ErrConflict
		}
		return 1, nil
	}
	res, err := s.db.Exec("UPDATE state SET version = ?, doc = ?, updated_at = ? WHERE id = 1 AND version = ?",
		next, string(doc), now, base)
	if err != nil {
		return 0, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return 0, ErrConflict
	}
	return next, nil
}

// Put stores a client document if base matches the stored version (optimistic concurrency).
func (s *Store) Put(base int64, st *State) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.putLocked(base, st)
}

// Update applies fn to the current document atomically (used by MCP tools).
func (s *Store) Update(fn func(*State) error) (int64, *State, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, st, err := s.getLocked()
	if err != nil {
		return 0, nil, err
	}
	if err := fn(st); err != nil {
		return v, nil, err
	}
	nv, err := s.putLocked(v, st)
	return nv, st, err
}

// RecordCorrection persists a human -/+ stepper estimate correction for few-shot LFM calibration.
func (s *Store) RecordCorrection(t Task) {
	if t.HumanMinutes == nil || *t.HumanMinutes <= 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, _ = s.db.Exec(
		`INSERT INTO correction_history (task_id, course, title, category, estimated_minutes, actual_minutes, at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(task_id) DO UPDATE SET actual_minutes = excluded.actual_minutes, at = excluded.at`,
		t.ID, t.Course, t.Title, t.Category, t.LLMMinutes, *t.HumanMinutes, time.Now().UTC().Format(time.RFC3339),
	)
}

type CorrectionExample struct {
	Course    string
	Title     string
	Estimated int
	Actual    int
}

// RecentCorrections returns the latest human estimate corrections (same course prioritized).
func (s *Store) RecentCorrections(course string, limit int) []CorrectionExample {
	if limit <= 0 {
		limit = 4
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.Query(
		`SELECT course, title, estimated_minutes, actual_minutes
		 FROM correction_history
		 ORDER BY (LOWER(course) = LOWER(?)) DESC, id DESC
		 LIMIT ?`, course, limit)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []CorrectionExample
	for rows.Next() {
		var c CorrectionExample
		if rows.Scan(&c.Course, &c.Title, &c.Estimated, &c.Actual) == nil {
			out = append(out, c)
		}
	}
	return out
}

// RecordInboxMsgID atomically records a source message ID; returns false if already seen.
func (s *Store) RecordInboxMsgID(id string) bool {
	if id == "" {
		return true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	res, err := s.db.Exec("INSERT OR IGNORE INTO inbox_dedup (source_msg_id, seen_at) VALUES (?, ?)", id, time.Now().UTC().Format(time.RFC3339))
	if err != nil {
		return true
	}
	n, _ := res.RowsAffected()
	return n > 0
}

// MergeLWWState merges incoming Tasks, Blocks, and Events into base using entity-level
// Last-Write-Wins timestamps (updated_at / deleted_at tombstones).
func MergeLWWState(base, inc *State) *State {
	if base == nil {
		return inc
	}
	if inc == nil {
		return base
	}
	out := *base
	if inc.Timer.StartedAt >= base.Timer.StartedAt {
		out.Timer = inc.Timer
	}

	taskMap := map[string]Task{}
	for _, t := range base.Tasks {
		taskMap[t.ID] = t
	}
	for _, t := range inc.Tasks {
		cur, ok := taskMap[t.ID]
		if !ok || t.UpdatedAt >= cur.UpdatedAt {
			taskMap[t.ID] = t
		}
	}
	out.Tasks = make([]Task, 0, len(taskMap))
	for _, t := range taskMap {
		if t.DeletedAt == 0 {
			out.Tasks = append(out.Tasks, t)
		}
	}

	blockMap := map[string]Block{}
	for _, b := range base.Blocks {
		blockMap[b.ID] = b
	}
	for _, b := range inc.Blocks {
		cur, ok := blockMap[b.ID]
		if !ok || b.UpdatedAt >= cur.UpdatedAt {
			blockMap[b.ID] = b
		}
	}
	out.Blocks = make([]Block, 0, len(blockMap))
	for _, b := range blockMap {
		if b.DeletedAt == 0 {
			out.Blocks = append(out.Blocks, b)
		}
	}

	evMap := map[string]Event{}
	for _, e := range base.Events {
		evMap[e.ID] = e
	}
	for _, e := range inc.Events {
		cur, ok := evMap[e.ID]
		if !ok || e.UpdatedAt >= cur.UpdatedAt {
			evMap[e.ID] = e
		}
	}
	out.Events = make([]Event, 0, len(evMap))
	for _, e := range evMap {
		if e.DeletedAt == 0 {
			out.Events = append(out.Events, e)
		}
	}
	return &out
}

// PutLWW merges incoming state entity-by-entity on version mismatch instead of overwriting.
func (s *Store) PutLWW(base int64, inc *State) (int64, *State, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, cur, err := s.getLocked()
	if err != nil {
		return 0, nil, err
	}
	if v == base {
		nv, err := s.putLocked(base, inc)
		return nv, inc, err
	}
	merged := MergeLWWState(cur, inc)
	nv, err := s.putLocked(v, merged)
	return nv, merged, err
}

// BackupOnce writes a zero-downtime SQLite snapshot via VACUUM INTO and prunes backups > 7 days old.
func (s *Store) BackupOnce(dir string, now time.Time) error {
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return err
	}
	dst := filepath.Join(dir, "study-"+now.Format("2006-01-02")+".db")
	_ = os.Remove(dst)
	s.mu.Lock()
	_, err := s.db.Exec("VACUUM INTO '" + strings.ReplaceAll(dst, "'", "''") + "'")
	s.mu.Unlock()
	if err != nil {
		return err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var names []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasPrefix(e.Name(), "study-") && strings.HasSuffix(e.Name(), ".db") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	for len(names) > 7 {
		_ = os.Remove(filepath.Join(dir, names[0]))
		names = names[1:]
	}
	return nil
}

// BackupLoop runs a daily zero-downtime SQLite backup while ctx is active.
func (s *Store) BackupLoop(ctx context.Context, dbPath string) {
	if dbPath == "" || dbPath == ":memory:" || strings.HasPrefix(dbPath, "file:") {
		return
	}
	dir := filepath.Join(filepath.Dir(dbPath), "backups")
	if err := s.BackupOnce(dir, time.Now()); err != nil {
		log.Printf("sqlite backup warning: %v", err)
	}
	t := time.NewTicker(24 * time.Hour)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-t.C:
			if err := s.BackupOnce(dir, now); err != nil {
				log.Printf("sqlite backup warning: %v", err)
			}
		}
	}
}
