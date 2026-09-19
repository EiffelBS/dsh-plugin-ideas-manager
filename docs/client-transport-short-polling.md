# Client transport: short-polling instead of SSE

## Why

The ideas board previously subscribed to `/api/ideas/events` with a
long-lived `EventSource`. That consumed **one permanent connection per tab**.
DSH's web server is plain HTTP/1.1, and browsers cap connections per origin
(Chrome/Edge: **6 per host:port, shared across all tabs**). With the shell's
own HMR stream (`/plugins/events`) plus the TaskBoard SSE, each tab already
holds two long-lived streams. (The web shell itself opens none: the frontend
bundle `index-*.js` contains zero `EventSource` and zero WebSocket.)

With **two tabs open** the pool fills (6/6). A page reload then cannot open
any connection — assets, `state` fetches, everything queues — and the ideas
client aborts its request after its 15 s timeout. The board surfaces exactly
that as:

```
Host operation failed: ideas Host request timed out after 15s   [Retry Host connection]
```

Closing one tab frees half the pool and the reload succeeds, which is the
user-reported symptom ("refreshing loops unless I close the other instance").
The server itself is not the bottleneck: a load test holding **12 concurrent
SSE streams** plus three `state` fetches answered in 0–2 ms.

## Fix

`HttpIdeasHostTransport.subscribe` no longer opens an `EventSource`. It polls
the listener on a short interval (2.5 s) **only while**:

- the page is visible (`document.visibilityState === 'visible'`), and
- the optional `isActive` gate returns true (the board is open).

`IdeasClient` passes `() => this.boardOpen`, so a closed board holds **zero
connections and zero traffic**. Opening the board triggers an immediate
`refresh()`, and returning to the tab triggers a poll via the
`visibilitychange` listener. Every polled `state` fetch is a short request
that returns its connection to the pool; no slot is ever pinned.

## Stability properties

- A closed board costs the server nothing (no connection, no polling).
- A visible open board costs one small `state` fetch (~6 KB) every 2.5 s —
  negligible against the previous always-on stream.
- Two tabs stay under the 6-connection cap: the ideas plugin no longer
  contributes any permanent stream (HMR + TaskBoard remain, at 2 per tab).
- Latency: cross-tab/agent updates appear within one poll interval (≤2.5 s)
  instead of instantly. This is the deliberate trade-off for pool safety.

## Verification

- `tests/host-api.test.ts`: polling ticks, `isActive` gating, dispose stops
  polling, and `IdeasClient` wires `boardOpen` as the gate + refreshes on
  toggle.
- Full suite: 152 tests green, `npm run typecheck` clean.

## Non-goals

- The TaskBoard plugin (`@linxin666/dsh-client-ui-task-board`) and the shell
  HMR (`/plugins/events`) keep their own SSE streams; they are outside this
  package's control. If 3+ tabs still starve, apply the same short-polling
  pattern there.
- The `/api/ideas/events` endpoint stays mounted on the Host (contract
  stability); only the client stopped consuming it.