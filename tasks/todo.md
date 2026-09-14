# Tasks: Reliable Kiosk Attendance Stations

## Phase 0: Contract and baseline
- [ ] Task 1: Freeze kiosk domain contract and state machine
- [ ] Task 2: Add focused test harness and baseline measurements

## Checkpoint: Baseline
- [ ] Existing build and regression tests pass
- [ ] API/event schemas documented
- [ ] Baseline latency, payload, and memory measurements recorded

## Phase 1: Secure and correct backend foundation
- [ ] Task 3: Implement booth-bound kiosk sessions and event kiosk PIN
- [ ] Task 4: Implement atomic idempotent station check-in
- [ ] Task 5: Bound and minimize kiosk participant data
- [ ] Task 6: Add database change tracking, attendance feed, and reconciliation endpoint

## Checkpoint: Backend correctness
- [ ] Unsigned and cross-resource writes rejected
- [ ] Parallel duplicate operations collapse to one result
- [ ] Cache/stream payloads are minimized

## Phase 2: Worker and offline reliability
- [ ] Task 7: Make Worker an independent security boundary
- [ ] Task 8: Build durable IndexedDB outbox and sync engine
- [ ] Task 9: Add realtime SSE client with polling fallback and auto-refresh

## Checkpoint: Connectivity resilience
- [ ] Offline scans survive reload
- [ ] Worker retries do not duplicate attendance
- [ ] Realtime reconnect reconciles missed events
- [ ] Backend/database updates refresh kiosk state without a page reload
- [ ] Worker and backend independently authenticate kiosk writes

## Phase 3: Scanner and operations UI
- [ ] Task 10: Optimize continuous barcode/QR scanning
- [ ] Task 11: Replace full-screen results with compact status UI
- [ ] Task 12: Refresh kiosk participant and station state continuously

## Phase 4: Solid station customization
- [ ] Task 13: Define and validate station layout schema
- [ ] Task 14: Implement focused drag-and-drop kiosk designer
- [ ] Task 15: Wire master theme and per-station override lifecycle

## Checkpoint: Product flow
- [ ] Staff can configure and launch the correct station
- [ ] Continuous scanning does not block on modal feedback
- [ ] Station overrides and master theme inherit correctly
- [ ] Event kiosk exit PIN is configured at event creation and works for all event stations

## Phase 5: Verification and hardening
- [ ] Task 16: Add end-to-end and adversarial tests
- [ ] Task 17: Performance, accessibility, and visual QA
- [ ] Task 18: Observability, reconciliation, rollout, and documentation

## Checkpoint: Release readiness
- [ ] All tests/builds pass
- [ ] Security findings SEC-001–SEC-004 closed or accepted
- [ ] Failure drills and rollback rehearsal pass
