# Implementation Plan: Reliable Kiosk Attendance Stations

## Overview

Upgrade the SpringWave multi-station kiosk into a reliable operations tool for event staff. Students only present a student card or ticket; staff operate the kiosk. The system must support durable offline capture, idempotent synchronization, secure Worker ingestion, fast barcode/QR recognition, continuously refreshed participant data, and a restrained solid visual system. Each station can have a focused custom layout using a small drag-and-drop designer inspired by the certificate designer.

Repositories:
- Backend: `/home/ductai/Documents/springwave-backend`
- Frontend: `/home/ductai/Documents/springwave-frontend`

## Product Direction

### How might we

How might we let event staff process a continuous stream of student cards at multiple stations quickly and confidently, even during unreliable connectivity, while keeping the attendance ledger correct and the interface calm under pressure?

### Recommended direction

Use a durable browser outbox backed by IndexedDB. Every scan receives a client-generated operation ID before any network call. The Worker and backend treat that ID as an idempotency key, so lost responses, retries, duplicate queue delivery, multiple tabs, and Worker retries converge on one attendance result. Backend writes must be conditional/atomic; UI speed must come from local decoding and compact lookup, not from bypassing server truth.

Use SSE for participant-list and attendance changes scoped to one event, with reconnect using a monotonic event revision. Polling remains the fallback and reconciliation mechanism. The kiosk refreshes deltas or a bounded snapshot, never an unbounded roster.

Backend/database changes must refresh kiosk state automatically without a full page reload. Every participant, ticket, attendance, booth, or relevant event-config mutation advances an event revision and publishes a change event. The kiosk applies newer revisions in place; if a connection drops, it asks for changes since its last revision, then falls back to a bounded snapshot. Polling is also used as a periodic consistency check even when SSE is connected.

Keep the kiosk visual language solid and operational: opaque surfaces, clear status colors, modest radius, minimal shadow, no neon glow, no decorative gradients, and no full-screen success modal for every scan. Results use a compact non-blocking status row/toast with accessible live-region feedback. The designer initially supports logo, banner/background, welcome text, camera frame, sponsor QR, feedback copy, colors, visibility, and position.

### Key assumptions to validate

- [ ] Target devices can sustain camera decoding plus SSE/polling for a long session without thermal or memory degradation.
- [ ] Event staff prefer a compact acknowledged/queued/rejected status over a blocking confirmation dialog.
- [ ] The event roster can be represented by bounded deltas or opaque lookup identifiers without requiring full PII in the kiosk browser.
- [ ] Event organizers accept eventual consistency during offline periods when the kiosk clearly shows queue state.

### Not doing in the first release

- Full Canva-like freeform design tooling, arbitrary fonts, complex layers, or animation — these increase operational risk and are not needed to validate station customization.
- Client-side final authority for attendance — local cache and offline mode improve throughput but never replace server reconciliation.
- A new queue platform or database — IndexedDB plus the existing Worker/backend path is sufficient for the first reliable version.
- A visual redesign of unrelated pages — only kiosk and directly connected organizer surfaces change.

## Architecture Decisions

1. **Server-authoritative attendance:** local cache may identify a likely participant, but only the backend commits attendance.
2. **Durable idempotency:** add an operation ID to every check-in and persist a server-side result or unique operation field.
3. **Short-lived kiosk session:** issue a booth-bound expiring session. The client never sends a signing key as request data and never uses a universal fallback PIN. The Worker independently validates the session and request before forwarding; the backend independently validates the forwarded claims. Event creation accepts a kiosk exit PIN, which is stored as a strong hash and used as the default exit credential for stations in that event.
4. **Atomic station mutation:** conditionally append a station visit only when that booth has not already been visited; increment counters atomically.
5. **Versioned realtime contract:** events contain event ID, revision, event type, operation ID, and minimal payload. Consumers tolerate duplicates, late events, missing events, and out-of-order delivery.
6. **Bounded data:** cache, stats, stream replay, and export paths have explicit limits.
7. **Single layout contract:** event master config and station override use one validated schema with deterministic inheritance.
8. **Defense in depth at the Worker:** Worker authentication is mandatory, uses a server-verifiable session token (for example an asymmetric signed token or opaque token introspection), validates booth/event/expiry/nonce/operation ID/body limits, and authenticates backend forwarding with a secret unavailable to browsers. Backend never accepts the Worker as the sole authorization decision.

## Dependency Graph

```
Validated kiosk config + Booth session model
        ↓
Atomic/idempotent attendance application service
        ↓
Backend kiosk endpoints + Worker ingestion contract
        ↓
Durable IndexedDB outbox + bounded participant cache
        ↓
SSE event stream + polling reconciliation
        ↓
Fast scanner pipeline + compact result UI
        ↓
Station designer and organizer dashboard integration
        ↓
Security, concurrency, browser, failure and performance verification
```

## Task List

### Phase 0: Contract and baseline

- [ ] Task 1: Freeze kiosk domain contract and state machine
- [ ] Task 2: Add focused test harness and baseline measurements

### Checkpoint: Baseline

- [ ] Existing frontend build passes
- [ ] Existing attendance and booth behavior is captured by regression tests
- [ ] API/event schemas and compatibility rules are documented

### Phase 1: Secure and correct backend foundation

- [ ] Task 3: Implement booth-bound kiosk sessions
- [ ] Task 4: Implement atomic idempotent station check-in
- [ ] Task 5: Bound and minimize kiosk participant data
- [ ] Task 6: Add attendance change feed and reconciliation endpoint

### Checkpoint: Backend correctness

- [ ] Unsigned/expired/cross-booth writes are rejected
- [ ] Parallel duplicate operations produce one station visit
- [ ] Retry with the same operation ID returns the original result
- [ ] Cache and stream payloads contain no unnecessary PII

### Phase 2: Worker and offline reliability

- [ ] Task 7: Align Worker with the secure kiosk contract
- [ ] Task 8: Build durable IndexedDB outbox and sync engine
- [ ] Task 9: Add SSE event stream with polling fallback

### Checkpoint: Connectivity resilience

- [ ] Offline scans survive reload
- [ ] Reconnect and Worker retry do not duplicate attendance
- [ ] SSE disconnects recover through replay or polling reconciliation
- [ ] Worker/backend failures expose actionable status without false success

### Phase 3: Scanner and operations UI

- [ ] Task 10: Optimize continuous barcode/QR scanning pipeline
- [ ] Task 11: Replace full-screen result interruptions with compact status UI
- [ ] Task 12: Refresh kiosk participant state continuously

### Phase 4: Solid station customization

- [ ] Task 13: Define and validate station layout schema
- [ ] Task 14: Implement focused drag-and-drop kiosk designer
- [ ] Task 15: Wire master theme and per-station override lifecycle

### Checkpoint: Product flow

- [ ] Staff can configure a station, open it, scan continuously, and keep working without modal interruption
- [ ] A participant added/removed or checked in elsewhere appears consistently
- [ ] Station override does not corrupt event master theme
- [ ] Layout remains usable on kiosk tablet, laptop, and desktop sizes

### Phase 5: Verification and hardening

- [ ] Task 16: Add end-to-end and adversarial tests
- [ ] Task 17: Performance, accessibility, and visual QA
- [ ] Task 18: Observability, reconciliation, rollout, and documentation

### Checkpoint: Release readiness

- [ ] Backend tests and frontend build pass
- [ ] Worker contract tests pass
- [ ] Browser matrix and failure scenarios pass
- [ ] Security findings SEC-001 through SEC-004 are closed or explicitly accepted
- [ ] Rollback and data-repair procedures are documented

## Detailed Task Specifications

### Task 1: Freeze kiosk domain contract and state machine

**Description:** Define shared contracts and valid states for kiosk sessions, check-in operations, outbox items, participant snapshots, and station layout configuration.

**Acceptance criteria:**
- [ ] States documented: `queued → sending → acknowledged`, `queued → retryable`, `queued → rejected`, `acknowledged → reconciled`.
- [ ] Operation ID, event ID, booth ID/code, attendance ID, scanner value, createdAt, attempt count, and result status defined.
- [ ] Existing clients can omit new optional fields without server crashes.

**Verification:** Contract tests for valid/invalid payloads and legacy check-in compatibility.

**Dependencies:** None.

**Files likely touched:** `tasks/plan.md`, API documentation, contract notes.

**Estimated scope:** Small.

### Task 2: Add focused test harness and baseline measurements

**Description:** Establish test commands for booth/attendance controllers, Worker handlers, IndexedDB sync, and browser flows. Capture baseline scan latency, request volume, cache payload size, and build output.

**Acceptance criteria:**
- [ ] Focused backend tests run without production credentials.
- [ ] Worker tests mock bindings.
- [ ] Baseline metrics recorded for small and large event fixtures.

**Verification:** Focused tests and frontend `npm run build`.

**Dependencies:** None.

**Files likely touched:** backend/Worker test setup and frontend test utilities.

**Estimated scope:** Medium.

### Task 3: Implement booth-bound kiosk sessions and event kiosk PIN

**Description:** Replace the response-only signing key with a server-verifiable short-lived kiosk session bound to booth and event, with refresh/re-handshake and revocation. Extend event creation/editing to accept a kiosk exit PIN, validate its strength, store only a bcrypt/argon2 hash, and make it the default credential for all stations in the event. A station-specific override may be supported later, but no universal fallback is allowed.

**Acceptance criteria:**
- [ ] Cross-booth/event use is rejected.
- [ ] Missing, expired, revoked, malformed, and replayed credentials are rejected.
- [ ] No signing key or internal secret is accepted from JSON.
- [ ] Universal `1234` fallback is removed.
- [ ] Event creation/editing accepts a kiosk exit PIN with server-side strength validation.
- [ ] Plaintext PIN is never returned by API, stored in localStorage, logged, or included in kiosk configuration.
- [ ] Existing events receive a migration-safe disabled/rotation state and cannot silently fall back to `1234`.

**Verification:** Authorization tests for valid, cross-resource, expired, revoked, and unsigned requests.

**Dependencies:** Task 1.

**Files likely touched:** `src/models/Event.js`, `src/models/`, event create/update controllers, `src/controllers/booth.controller.js`, `src/routes/booth.route.js`, auth utilities, frontend event form/API, `js/api/booth.js`, `js/pages/kiosk.js`.

**Estimated scope:** Large; split model and endpoint/client wiring if needed.

### Task 4: Implement atomic idempotent station check-in

**Description:** Move station mutation into a focused service. Use operation IDs and conditional MongoDB updates so duplicate station visits cannot be appended concurrently. Increment counters only for a newly applied visit.

**Acceptance criteria:**
- [ ] Same operation ID is safe to retry and returns its original result.
- [ ] Parallel operations for the same participant/station produce one visit and one deterministic duplicate response.
- [ ] Timing/status rules match ordinary attendance scanning and certificate eligibility.
- [ ] Counter cannot drift under concurrency.

**Verification:** Parallel request, lost-response retry, duplicate Worker delivery, and reconciliation tests.

**Dependencies:** Tasks 1 and 3.

**Files likely touched:** `src/models/Attendance.js`, `src/models/Booth.js`, `src/services/`, `src/controllers/booth.controller.js`, indexes/migrations.

**Estimated scope:** Large.

### Task 5: Bound and minimize kiosk participant data

**Description:** Replace the public event-wide roster endpoint with a booth-session-authorized bounded snapshot/delta endpoint containing only scanner/UI fields.

**Acceptance criteria:**
- [ ] Cache access requires a valid booth session.
- [ ] Response is capped and paginated/delta-based.
- [ ] PII is minimized and event isolation enforced.
- [ ] Deleted/cancelled participants are represented by versioned deltas.

**Verification:** Unauthorized access, field allowlist, large payload, and stale-session tests.

**Dependencies:** Task 3.

**Files likely touched:** booth controller/routes, Worker proxy, User/Ticket/Attendance queries, frontend cache client.

**Estimated scope:** Medium.

### Task 6: Add database change tracking, attendance feed, and reconciliation endpoint

**Description:** Publish event-scoped participant, ticket, attendance, booth, and relevant event-config changes with monotonic revisions, plus a snapshot/reconcile endpoint for missed events. The source of truth remains the committed database mutation; events are delivery notifications, not the ledger.

**Acceptance criteria:**
- [ ] Participant registration/removal, ticket status, attendance/station check-in, booth activation/configuration, and kiosk theme changes advance the relevant event revision.
- [ ] Feed includes revision, operation ID, event type, and minimal payload.
- [ ] Reconciliation returns changes since revision or bounded snapshot.
- [ ] Events are emitted only after durable mutation succeeds.
- [ ] A periodic polling consistency check runs while SSE is connected.

**Verification:** Ordering, duplicate, missed-event, reconnect, and out-of-order tests.

**Dependencies:** Tasks 3, 4, and 5.

**Files likely touched:** realtime service, attendance/participant paths, routes, `index.js`.

**Estimated scope:** Large.

### Task 7: Make Worker an independent security boundary

**Description:** Make Worker authentication mandatory and independently verifiable, validate schema/size before R2 work, remove hardcoded secret fallbacks, propagate operation IDs, and make forwarding/retries safe. The browser receives only a short-lived booth-bound session credential; it never receives an internal sync secret or reusable signing key. Prefer an asymmetric backend-signed session token verified by a Worker-held public key, or opaque session introspection if revocation must be immediate. The backend must authenticate the Worker-to-backend call separately and re-derive event/booth authorization from trusted claims/database state.

**Acceptance criteria:**
- [ ] Unsigned, malformed, expired, revoked, cross-event, cross-booth, and replayed requests never reach backend forwarding.
- [ ] Worker validates signature/token claims, event/booth binding, operation ID format, timestamp/nonce, content type, body size, and photo limits before upload.
- [ ] Worker rejects a client-supplied internal secret, signing key, role, owner, or authorization claim.
- [ ] Worker-to-backend authentication uses a secret/service credential unavailable to browsers; missing production bindings fail closed.
- [ ] Backend independently validates Worker identity and rechecks the session/operation authorization.
- [ ] Retryable failures do not duplicate attendance.
- [ ] Photos have limits, access/retention policy, and orphan reconciliation.
- [ ] Stable error classes without internal details.

**Verification:** Worker tests for unsigned/tampered/replayed/cross-resource requests, key rotation, revoked sessions, malformed payloads, oversized photos, backend timeout/5xx/retry scenarios, and secret absence. Add an integration test proving a direct browser request cannot impersonate Worker forwarding.

**Dependencies:** Tasks 3 and 4.

**Files likely touched:** `cloudflare-worker/src/index.js`, `cloudflare-worker/wrangler.toml`, backend internal-auth/session middleware, key configuration/rotation docs, R2 utilities.

**Estimated scope:** Large.

### Task 8: Build durable IndexedDB outbox and sync engine

**Description:** Replace in-memory `offlineQueue` with IndexedDB. Persist before submission, retry with backoff, classify permanent errors, resume after reload, and reconcile unknown outcomes by operation ID.

**Acceptance criteria:**
- [ ] Offline scan survives close/reload.
- [ ] Sync is single-flight per kiosk and safe across duplicate timers/tabs.
- [ ] Unknown outcomes reconcile instead of blindly resubmitting.
- [ ] Queue health and operator action are visible.

**Verification:** Offline/online, refresh during sync, response loss, 4xx/5xx, quota exhaustion, duplicate-tab tests.

**Dependencies:** Tasks 4 and 7.

**Files likely touched:** `js/pages/kiosk.js`, new `js/lib/kioskOutbox.js`, `js/api/booth.js`, IndexedDB schema.

**Estimated scope:** Large.

### Task 9: Add realtime SSE client with polling fallback and auto-refresh

**Description:** Subscribe to event-scoped SSE, reconnect with backoff, apply newer revisions only, and reconcile through polling when SSE is unavailable or as a periodic consistency check. Update the kiosk in place; do not reload the page, camera, or current UI session for normal backend/database changes.

**Acceptance criteria:**
- [ ] Reconnect does not duplicate or regress participants.
- [ ] Missed events recover through replay or reconciliation.
- [ ] Polling is bounded and pauses when hidden/offline.
- [ ] Channel authorization is session-scoped.
- [ ] Backend/database changes refresh participant data, attendance status, booth status, and effective kiosk configuration without a page reload.
- [ ] Older SSE or polling responses cannot overwrite newer revisions.

**Verification:** Disconnect/reconnect, duplicate/late events, hidden tab, expired session, polling fallback.

**Dependencies:** Task 6.

**Files likely touched:** backend SSE service/controller, `index.js`, frontend realtime client and kiosk lifecycle.

**Estimated scope:** Large.

### Task 10: Optimize continuous barcode/QR scanning

**Description:** Tune ZXing for supported formats/device class, avoid unnecessary frame capture/object creation, pause decoding only during resolution, and reuse the camera stream.

**Acceptance criteria:**
- [ ] Supported formats are explicit and measured.
- [ ] No full-screen result animation blocks scanning.
- [ ] Camera stream is reused; AudioContext/canvas work is bounded.
- [ ] Duplicate frames are coalesced without weakening backend correctness.

**Verification:** Laptop/tablet benchmark, 100+ scans, low-light/blur, camera switch, reduced motion.

**Dependencies:** Tasks 4 and 8.

**Files likely touched:** `js/pages/kiosk.js`, `kiosk.html`, scanner utility, kiosk CSS.

**Estimated scope:** Medium.

### Task 11: Replace full-screen feedback with compact status UI

**Description:** Use a persistent operational layout with compact success/error status, recent activity, queue health, sync state, and accessible live region.

**Acceptance criteria:**
- [ ] Success, duplicate, queued, retrying, and rejected states are distinct without full-screen modals.
- [ ] UI never claims durable success before acknowledgement.
- [ ] Neon/glow/decorative gradients/excessive animation are removed.
- [ ] Keyboard/focus and reduced motion are supported.

**Verification:** Visual review, keyboard-only flow, screen-reader announcements, 320px–1920px widths.

**Dependencies:** Task 10.

**Files likely touched:** `kiosk.html`, kiosk CSS/style tokens, `js/pages/kiosk.js`.

**Estimated scope:** Medium.

### Task 12: Refresh kiosk participant and station state continuously

**Description:** Integrate bounded snapshot/delta cache with SSE and polling. Apply participant, ticket, attendance, booth, and effective-config updates atomically, preserve pending operations, and prevent stale HTTP responses from overwriting newer state. Re-render only affected operational UI regions.

**Acceptance criteria:**
- [ ] New registrations become scannable without restart.
- [ ] Removals/cancellations stop matching after revision applies.
- [ ] Database changes made through any supported API or worker path appear without manual refresh.
- [ ] Booth active/inactive and theme changes are reflected in the open kiosk according to the session policy.
- [ ] Out-of-order responses cannot regress cache.
- [ ] Refresh does not interrupt camera/current scan.

**Verification:** Add/remove while open, concurrent refresh, stale response injection, offline/reconnect.

**Dependencies:** Tasks 5, 6, 8, and 9.

**Files likely touched:** cache module, realtime client, `js/pages/kiosk.js`, participant mutation publishers.

**Estimated scope:** Medium.

### Task 13: Define and validate station layout schema

**Description:** Replace unrestricted `Mixed` kiosk config writes with a versioned, size-limited server allowlist supporting master config and station override inheritance.

**Acceptance criteria:**
- [ ] Invalid colors, URLs, dimensions, text lengths, positions, and unknown properties are rejected/normalized.
- [ ] Master/override merge is deterministic.
- [ ] Historical configs receive safe defaults.
- [ ] Remote URLs are constrained to approved schemes/origins or safely proxied.

**Verification:** Schema, malicious URL, oversized payload, and old-config migration tests.

**Dependencies:** Task 1.

**Files likely touched:** `src/models/Event.js`, `src/models/Booth.js`, validation utility, frontend defaults.

**Estimated scope:** Medium.

### Task 14: Implement focused drag-and-drop kiosk designer

**Description:** Reuse certificate-designer interaction patterns where practical, but create a smaller kiosk canvas. Support selecting, dragging, visibility, and basic sizing/positioning for core elements.

**Acceptance criteria:**
- [ ] Pointer and keyboard alternatives are available where feasible.
- [ ] Preview matches kiosk rendering on desktop/tablet ratios.
- [ ] Reset, safe cancel/undo, unsaved-change handling, and validation errors work.
- [ ] Designer is solid and restrained; no second design system.

**Verification:** Manual designer flow, keyboard movement, invalid input, reload/cancel, responsive canvas.

**Dependencies:** Task 13.

**Files likely touched:** `org-dashboard.html`, `js/pages/org-dashboard.js`, designer module/CSS, shared layout utilities.

**Estimated scope:** Large.

### Task 15: Wire master theme and station override lifecycle

**Description:** Connect designer to event/booth APIs, preserve inheritance, fix station launch to include selected booth, and reload effective config after save.

**Acceptance criteria:**
- [ ] Master config affects stations without overrides.
- [ ] Override affects only its station.
- [ ] Removing override restores master config.
- [ ] Selected station launches the correct kiosk code.
- [ ] Event kiosk exit PIN is configured during event creation/editing and applies to every station in that event.
- [ ] Exit flow verifies the PIN through the kiosk session without exposing the stored hash or plaintext PIN.

**Verification:** Two-station flow, master/override matrix, refresh/restart, authorization tests.

**Dependencies:** Tasks 3, 13, and 14.

**Files likely touched:** booth routes/controller, `js/api/booth.js`, `org-dashboard.js`, `kiosk.js`, `kiosk.html`.

**Estimated scope:** Medium.

### Task 16: Add end-to-end and adversarial tests

**Description:** Cover organizer setup through activation, scan, offline queue, Worker retry, realtime refresh, export/stats, and certificate/analytics effects.

**Acceptance criteria:**
- [ ] Security tests close unsigned ingestion, cache exposure, universal PIN, and cross-resource access.
- [ ] Concurrency proves one logical visit per participant/station.
- [ ] Failure tests cover lost responses, DB/Worker errors, refresh, and duplicate events.
- [ ] Timing and certificate eligibility regressions are covered.

**Verification:** Full focused suite and browser E2E suite.

**Dependencies:** Tasks 3–15.

**Estimated scope:** Large.

### Task 17: Performance, accessibility, and visual QA

**Description:** Validate continuous operation on target kiosk hardware and widths. Measure decode latency, memory growth, payloads, reconnects, and accessibility.

**Acceptance criteria:**
- [ ] No unbounded memory growth in a long session.
- [ ] P95 decode-to-local-result and server acknowledgement targets documented and met.
- [ ] Critical controls have labels, focus, keyboard operation, live-region status, and reduced-motion behavior.
- [ ] No overflow/clipped dialogs at target breakpoints.

**Verification:** DevTools performance, Lighthouse/accessibility, screenshots, 2-hour soak.

**Dependencies:** Tasks 10–12 and 14–15.

**Estimated scope:** Medium.

### Task 18: Observability, reconciliation, rollout, and documentation

**Description:** Add structured tracing across session → Worker → backend → result, create counter/photo/outbox reconciliation procedures, and document rollout/rollback.

**Acceptance criteria:**
- [ ] Logs include requestId, operationId, eventId, boothId, outcome, duration, error class without PII/secrets.
- [ ] Operators can identify stuck outbox items, Worker failures, and counter drift.
- [ ] Versioned/flagged rollout and safe rollback exist.
- [ ] API, kiosk operations, and recovery runbooks are documented.

**Verification:** Synthetic failure drill, reconciliation dry run, rollback rehearsal, log-redaction review.

**Dependencies:** Tasks 4, 7, 8, and 16.

**Estimated scope:** Medium.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Offline clock or long outage | Incorrect ordering/stale auth | Server timestamps, expiry, operation IDs, explicit queued state, reconciliation |
| Multiple kiosks process same student | Duplicate visits/counters | Conditional atomic update and idempotency |
| SSE unavailable | Stale participant list | Revisioned polling and bounded reconciliation |
| Client cache contains PII | Privacy incident | Session access, allowlist, opaque identifiers, short retention |
| R2 succeeds but attendance fails | Orphan public image | Private/object-scoped storage, operation-linked keys, cleanup |
| Designer breaks old kiosks | Rendering failure | Versioned schema, defaults, migration, fallback template |
| Continuous scanning grows memory | Kiosk degradation | Bounded feed, stream reuse, queue compaction, soak test |
| UI hides failed writes | False confidence | Explicit acknowledged/queued/rejected states |

## Open Questions

- What is the target kiosk hardware/browser matrix and minimum camera quality?
- Are photos mandatory, optional, or sampled per station?
- What offline window is acceptable before re-authentication?
- Should new participants become available immediately through SSE or require organizer confirmation?
- Should lookup use privacy-preserving keyed identifiers instead of raw student IDs?

## Definition of Done

- Security findings SEC-001 through SEC-004 are fixed and regression-tested.
- Worker and backend both enforce the kiosk trust boundary; neither layer relies only on frontend checks or a client-supplied secret.
- One logical check-in produces one durable station visit and counter increment despite retries/concurrency.
- Offline operations survive refresh and reconcile without false success or duplicates.
- Participant changes propagate through SSE or bounded polling without restart.
- Staff can scan continuously without full-screen interruption.
- Kiosk UI is solid, calm, accessible, responsive, and product-consistent.
- Station customization supports safe drag/drop of core elements with master/override inheritance.
- Build, backend/Worker tests, browser E2E, performance soak, and rollback rehearsal pass.
