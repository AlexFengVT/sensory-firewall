# Architecture

Sensory Firewall is a stateful multimodal prototype built around a default-silent attention policy.

## Runtime loop

A scene-analysis cycle can capture a camera frame and a short audio segment in parallel. Audio is transcribed first; the current scene, transcript, recent raw context, compact memory, and recent decisions are then sent to the decision model.

The returned schema contains:

```json
{
  "level": 0,
  "mode": "silent",
  "speak": "",
  "card": "",
  "reason": "",
  "memorySummary": ""
}
```

`level=0` is a successful result: the user is not interrupted.

## Two-layer context

### Recent raw transcript

Preserves exact local wording and helps with:

- pronouns and references;
- incomplete sentences;
- sequential classroom explanations;
- short-range continuity.

### Minimal memory

Preserves compact facts likely to matter later, such as:

- deadlines;
- exam/assignment rules;
- room changes;
- required materials;
- unresolved action items.

Both layers are bounded by item count and character count.

## Recent-decision memory

The last few AI decisions are returned to the model so it can avoid repeating the same alert in consecutive cycles.

## Task archive

Precision mode can open a task session that records:

- raw transcript chunks;
- AI decisions;
- timestamps;
- title/tags;
- a short local summary.

The current prototype stores archives in AsyncStorage. SQLite is the preferred next step for long-running use.

## Trigger subsystem

Current trigger flow:

```text
short recording → cloud transcription → keyword substring match → Precision mode
```

This is deliberately simple but has three costs: network dependency, latency, and transcription spend. On-device keyword spotting is the intended replacement.

## Cost control

The app keeps an estimated daily spend counter. Automatic calls stop when the next estimated call would exceed the user-selected budget.

This is not billing-grade accounting; it is a user-facing rate limiter.

## Known architectural limitations

1. Runtime orchestration and UI are still concentrated in `App.js`.
2. API credentials live on-device for the active session in this prototype.
3. Archive storage is JSON/AsyncStorage rather than a database.
4. Trigger matching is lexical rather than acoustic/on-device.
