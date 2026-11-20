package main

import (
	"testing"
	"time"
)

func fp(f float64) *float64 { return &f }

func TestRecordGradesHistoryAndFocus(t *testing.T) {
	loc := time.UTC
	d0 := time.Date(2026, 11, 5, 18, 0, 0, 0, loc)
	g := recordGrades(nil, []gradeIn{{Course: "Chemistry H", Score: fp(90)}, {Course: "Precalculus/AP", Score: fp(95.04)}}, d0)
	g = recordGrades(g, []gradeIn{{Course: "Chemistry H", Score: fp(89.5)}}, d0.Add(time.Hour)) // same day: replaced
	if len(g[0].History) != 1 || g[0].History[0].Score != 89.5 {
		t.Fatalf("same-day point should be replaced: %+v", g[0].History)
	}
	d1 := d0.AddDate(0, 0, 14)
	g = recordGrades(g, []gradeIn{{Course: "Chemistry H", Score: fp(85)}, {Course: "Precalculus/AP", Score: fp(96)}}, d1)
	if tr, ok := gradeTrend(g[0], d1); !ok || tr != -4.5 {
		t.Fatalf("trend = %v %v", tr, ok)
	}
	f := gradeFocus(g, d1)
	if f[0]["course"] != "Chemistry H" || f[0]["level"] != "focus" {
		t.Fatalf("chem should be first and need focus: %v", f[0])
	}
	if f[0]["weekly_review_minutes"].(float64) < 30 || f[0]["homework_time_multiplier"].(float64) <= 1 {
		t.Fatalf("chem should get review time and more homework time: %v", f[0])
	}
	if f[1]["level"] != "improving" || f[1]["weekly_review_minutes"].(float64) != 0 {
		t.Fatalf("precalc at goal needs nothing extra: %v", f[1])
	}
	g[1].Ignore = true
	if gradeFocus(g, d1)[1]["level"] != "not planned" {
		t.Fatal("ignored class should not be planned")
	}
}
