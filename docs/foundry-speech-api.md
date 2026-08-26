# Foundry speech-provider API

The fork exposes a loopback-only, bearer-authenticated speech API for Foundry. It reuses OpenWhispr's microphone capture and local Parakeet sidecar while leaving paste, clipboard, history, and dictation UI under the caller's control.

## Isolation

- The normal OpenWhispr build remains the `production` channel and keeps `~/.openwhispr/cli-bridge.json`.
- Development runs use `cli-bridge-development.json` and Electron's `OpenWhispr-development` user-data directory.
- The optional Foundry build uses `cli-bridge-foundry.json`, the `OpenWhispr-foundry` user-data directory, a distinct application ID, executable, protocol, artifact name, and update feed.
- Models remain in OpenWhispr's shared model cache so a side-by-side build does not duplicate multi-gigabyte model files.

Application settings are intentionally isolated by channel. Configure the cleanup model once in the development or Foundry build; an already-downloaded local Qwen/Nemotron model remains available from the shared cache and does not need to be downloaded again.

Building the Foundry AppImage does not install it:

```sh
npm run build:linux:foundry
```

## Discovery and authentication

Read the channel's bridge file. It contains a loopback port and a freshly generated bearer token with owner-only file permissions:

```json
{ "version": 1, "port": 8200, "token": "..." }
```

Every request must use `Authorization: Bearer <token>`. The server rejects non-loopback clients.

## Endpoints

### `GET /v1/health`

Returns bridge health and speech capabilities.

### `GET /v1/speech/status`

Returns dictation lifecycle, Parakeet server warm state, capabilities, and the active provider session.

### `GET /v1/speech/models`

Lists installed status for streaming-runtime Parakeet and Nemotron models.

### `POST /v1/speech/dictations`

Starts one headless session. Only one normal or provider dictation can run at a time.

```json
{
  "provider": "nvidia",
  "model": "parakeet-unified-en-0.6b-streaming-560ms",
  "language": "en",
  "cleanup": "incremental",
  "display": false,
  "persist": false
}
```

`cleanup` accepts:

- `none`: stream and return raw ASR only.
- `incremental`: clean stable recognizer segments while recording and clean only the tail at stop.
- `final`: run OpenWhispr's existing whole-transcript cleanup after stop.

The response is `202 Accepted` with the session ID.

### `POST /v1/speech/dictations/{session_id}/stop`

Stops capture and allows transcription and cleanup to finish.

### `POST /v1/speech/dictations/{session_id}/cancel`

Cancels capture or processing and discards the session.

### `GET /v1/speech/events?session_id={session_id}`

An SSE stream. Reconnect with `Last-Event-ID` or `?after=<event_id>` to replay buffered events.

Events can include:

- `dictation.accepted`, `dictation.started`, `dictation.processing`, `dictation.stopping`
- `transcript.partial`, `transcript.final`
- `cleanup.started`, `cleanup.delta`, `cleanup.committed`, `cleanup.final`
- `cleanup.unavailable`, `cleanup.failed`, `cleanup.resynced`
- `dictation.completed`, `dictation.cancelled`, `dictation.error`

Partial transcript events include both mutable `partialText` and stable `committedText`, plus recognizer segment IDs. Foundry should render partial text as replaceable and only append committed text or cleanup commits to durable state.

## Latency behavior

The streaming model decodes audio during capture. Incremental cleanup holds the newest finalized ASR segment because Sherpa can still refine it; once a later segment arrives, the older segment is cleaned through the configured dictation-cleanup model and emitted token-by-token. The final event remains authoritative if the recognizer revises earlier segment boundaries.
