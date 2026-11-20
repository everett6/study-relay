package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
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
		"PRAGMA cache_size=-2000;", // 2 MB page cache
		"PRAGMA journal_mode=WAL;",
		"PRAGMA synchronous=NORMAL;",
		"PRAGMA mmap_size=0;",
		"PRAGMA temp_store=MEMORY;",
		"PRAGMA busy_timeout=3000;",
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
