# Graph Report - web  (2026-11-19)

## Corpus Check
- Corpus is ~29,151 words - fits in a single context window. You may not need a graph.

## Summary
- 413 nodes · 1164 edges · 11 communities (10 shown, 1 thin omitted)
- Extraction: 95% EXTRACTED · 5% INFERRED · 0% AMBIGUOUS · INFERRED: 62 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Community 0
- Community 1
- Community 2
- Community 3
- Community 4
- Community 5
- Community 6
- Community 7
- Community 8
- Community 9
- Community 10

## God Nodes (most connected - your core abstractions)
1. `Engine` - 36 edges
2. `h()` - 26 edges
3. `fmtLocal()` - 25 edges
4. `parseLocal()` - 23 edges
5. `fmtDate()` - 22 edges
6. `State` - 22 edges
7. `toast()` - 21 edges
8. `Today()` - 21 edges
9. `plan()` - 19 edges
10. `CfCScheduler` - 17 edges

## Surprising Connections (you probably didn't know these)
- `buildState()` --calls--> `mockESUHSD()`  [EXTRACTED]
  bench/cases.ts → src/core/canvas.ts
- `buildState()` --calls--> `defaultState()`  [EXTRACTED]
  bench/cases.ts → src/core/types.ts
- `taskIs()` --calls--> `matchTasks()`  [EXTRACTED]
  bench/cases.ts → src/ai/heuristics.ts
- `bucketIs()` --calls--> `resolveBucket()`  [EXTRACTED]
  bench/cases.ts → src/ai/heuristics.ts
- `Case` --references--> `State`  [EXTRACTED]
  bench/cases.ts → src/core/types.ts

## Import Cycles
- None detected.

## Communities (11 total, 1 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.08
Nodes (61): ADJUST, checkIn(), classifyMode(), emptyMomentum(), ENERGY, MODE_COPY, r3(), recentRecord() (+53 more)

### Community 1 - "Community 1"
Cohesion: 0.06
Nodes (51): log(), q, run(), A, bucketIs(), buildState(), Case, CASES (+43 more)

### Community 2 - "Community 2"
Cohesion: 0.10
Nodes (63): append(), Child, confetti(), confirmSheet(), h(), ICON, Props, ring() (+55 more)

### Community 3 - "Community 3"
Cohesion: 0.08
Nodes (26): add(), backward(), CfCScheduler, ENERGY, expV(), FEATURES, features(), Layout (+18 more)

### Community 4 - "Community 4"
Cohesion: 0.13
Nodes (7): Engine, summarizeCanvas(), uid(), CfCSnapshot, Draft, InboxItem, State

### Community 5 - "Community 5"
Cohesion: 0.07
Nodes (28): dependencies, @huggingface/transformers@^4.3.2, @mlc-ai/web-llm@^0.2.89, onnxruntime-web@^1.31.1, tesseract.js@^5.1.1, devDependencies, typescript@^7.0.2, vite@^8.3.8 (+20 more)

### Community 6 - "Community 6"
Cohesion: 0.15
Nodes (12): httpTransport(), idb(), kvGet(), kvSet(), Mutation, normalize(), Store, SyncStatus (+4 more)

### Community 7 - "Community 7"
Cohesion: 0.20
Nodes (15): TASK_TYPE, classify(), cleanCourse(), Fetcher, KEEP, mockESUHSD(), parseAssignments(), parseICS() (+7 more)

### Community 8 - "Community 8"
Cohesion: 0.17
Nodes (10): DAYS, extractItems(), fileFromClipboard(), findDate(), Found, MONTHS, nowLocal(), stripDate() (+2 more)

### Community 9 - "Community 9"
Cohesion: 0.14
Nodes (13): compilerOptions, isolatedModules, lib, module, moduleResolution, noEmit, noUnusedLocals, noUnusedParameters (+5 more)

## Knowledge Gaps
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `vitest` connect `Community 1` to `Community 0`, `Community 3`, `Community 5`, `Community 6`, `Community 7`, `Community 8`?**
  _High betweenness centrality (0.111) - this node is a cross-community bridge._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.0762680488707886 - nodes in this community are weakly interconnected._
- **Why does `Engine` connect `Community 4` to `Community 0`, `Community 2`, `Community 3`, `Community 6`?**
  _High betweenness centrality (0.064) - this node is a cross-community bridge._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.056338028169014086 - nodes in this community are weakly interconnected._
- **Why does `State` connect `Community 4` to `Community 0`, `Community 1`, `Community 2`, `Community 6`?**
  _High betweenness centrality (0.050) - this node is a cross-community bridge._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.09633418584825235 - nodes in this community are weakly interconnected._
- **Should `Community 3` be split into smaller, more focused modules?**
  _Cohesion score 0.080338266384778 - nodes in this community are weakly interconnected._