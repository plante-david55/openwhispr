const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const debugLogger = require("./debugLogger");
const { isPortAvailable } = require("../utils/serverUtils");
const { broadcastToWindows } = require("./windowBroadcast");

const PORT_RANGE_START = 8200;
const PORT_RANGE_END = 8219;
const HOST = "127.0.0.1";
const BRIDGE_FILE_VERSION = 1;
const MAX_REQUEST_BODY_BYTES = 1 * 1024 * 1024;
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const SPEECH_EVENT_BUFFER_SIZE = 200;
const SPEECH_CLEANUP_MODES = new Set(["none", "incremental", "final"]);
const DEFAULT_STREAMING_MODEL = "parakeet-unified-en-0.6b-streaming-560ms";

const NO_CONTENT = Symbol("CliBridge.NoContent");

function getBridgeFilePath() {
  const explicitPath = process.env.OPENWHISPR_CLI_BRIDGE_FILE?.trim();
  if (explicitPath) return path.resolve(explicitPath);

  const channel = process.env.OPENWHISPR_CHANNEL?.trim().toLowerCase();
  const filename =
    channel && channel !== "production" ? `cli-bridge-${channel}.json` : "cli-bridge.json";
  return path.join(os.homedir(), ".openwhispr", filename);
}

async function findAvailablePort() {
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`No available ports in range ${PORT_RANGE_START}-${PORT_RANGE_END}`);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    // Buffer the raw chunks and decode once at the end: decoding per chunk
    // corrupts multibyte sequences split across chunk boundaries.
    const chunks = [];
    let receivedBytes = 0;
    let rejected = false;
    req.on("data", (chunk) => {
      if (rejected) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      receivedBytes += buffer.length;
      if (receivedBytes > MAX_REQUEST_BODY_BYTES) {
        rejected = true;
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => {
      if (rejected) return;
      const raw = Buffer.concat(chunks, receivedBytes).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON payload"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendNoContent(res) {
  res.writeHead(204);
  res.end();
}

function sendV1Error(res, statusCode, code, message) {
  sendJson(res, statusCode, { error: { code, message } });
}

function parseIdParam(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

function unwrapMutationResult(result, label) {
  if (!result?.success || !result[label]) {
    throw new Error(result?.error || `Failed to write ${label}`);
  }
  return result[label];
}

class CliBridge {
  constructor(ipcHandlers) {
    this.ipcHandlers = ipcHandlers;
    this.server = null;
    this.port = null;
    this.token = null;
    this.bridgeFilePath = getBridgeFilePath();
    this._speechSession = null;
    this._speechEvents = [];
    this._speechSequence = 0;
    this._speechClients = new Set();
    this.routes = this._buildRouteTable();
  }

  async start() {
    if (this.server) return;

    this.token = crypto.randomBytes(32).toString("hex");
    this.port = await findAvailablePort();
    this.server = http.createServer((req, res) => {
      this._handleRequest(req, res).catch((err) => {
        debugLogger.error("CLI bridge handler error", { error: err.message }, "cli-bridge");
        if (!res.headersSent) {
          sendV1Error(res, 500, "internal_error", "Internal server error");
        }
      });
    });

    await new Promise((resolve, reject) => {
      const onError = (err) => {
        this.server = null;
        reject(err);
      };
      this.server.once("error", onError);
      this.server.listen(this.port, HOST, () => {
        this.server.removeListener("error", onError);
        resolve();
      });
    });

    this._writeBridgeFile();
    debugLogger.info("CLI bridge started", { port: this.port }, "cli-bridge");
  }

  async stop() {
    if (!this.server) return;
    for (const client of this._speechClients) {
      clearInterval(client.keepAliveTimer);
      client.res.end();
    }
    this._speechClients.clear();
    await new Promise((resolve) => {
      this.server.close(() => resolve());
    });
    this.server = null;
    this.port = null;
    this.token = null;
    this._removeBridgeFile();
    debugLogger.info("CLI bridge stopped", {}, "cli-bridge");
  }

  _writeBridgeFile() {
    const dir = path.dirname(this.bridgeFilePath);
    fs.mkdirSync(dir, { recursive: true });
    const payload = JSON.stringify({
      version: BRIDGE_FILE_VERSION,
      port: this.port,
      token: this.token,
    });
    fs.writeFileSync(this.bridgeFilePath, payload, { mode: 0o600 });
    // Re-apply mode in case the filesystem ignored the mode arg on create.
    // No-op on Windows ACLs but harmless; swallow errors from exotic filesystems.
    try {
      fs.chmodSync(this.bridgeFilePath, 0o600);
    } catch (err) {
      debugLogger.debug("CLI bridge chmod failed", { error: err.message }, "cli-bridge");
    }
  }

  _removeBridgeFile() {
    try {
      fs.unlinkSync(this.bridgeFilePath);
    } catch (err) {
      if (err.code !== "ENOENT") {
        debugLogger.debug("CLI bridge file removal failed", { error: err.message }, "cli-bridge");
      }
    }
  }

  async _handleRequest(req, res) {
    const remote = req.socket?.remoteAddress;
    if (!remote || !LOOPBACK_ADDRESSES.has(remote)) {
      sendV1Error(res, 403, "forbidden", "Forbidden");
      return;
    }

    const auth = req.headers["authorization"] || "";
    const expected = `Bearer ${this.token}`;
    if (
      auth.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(expected))
    ) {
      sendV1Error(res, 401, "unauthorized", "Unauthorized");
      return;
    }

    const url = new URL(req.url || "/", `http://${HOST}:${this.port}`);
    const route = this._matchRoute(req.method, url.pathname);
    if (!route) {
      sendV1Error(res, 404, "not_found", "Not found");
      return;
    }

    let body = {};
    if (req.method !== "GET" && req.method !== "DELETE") {
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendV1Error(res, 400, "validation_error", err.message);
        return;
      }
    }

    try {
      if (route.stream) {
        await route.handler({ req, res, params: route.params, query: url.searchParams, body });
        return;
      }
      const result = await route.handler({ params: route.params, query: url.searchParams, body });
      if (result === NO_CONTENT) {
        sendNoContent(res);
        return;
      }
      const status = route.status || 200;
      sendJson(res, status, result);
    } catch (err) {
      this._sendError(res, err);
    }
  }

  _sendError(res, err) {
    if (err.code === "NOT_FOUND") {
      sendV1Error(res, 404, "not_found", err.message);
      return;
    }
    if (err.code === "VALIDATION") {
      sendV1Error(res, 400, "validation_error", err.message);
      return;
    }
    if (err.code === "CONFLICT") {
      sendV1Error(res, 409, "conflict", err.message);
      return;
    }
    debugLogger.error("CLI bridge route error", { error: err.message }, "cli-bridge");
    sendV1Error(res, 500, "internal_error", err.message || "Internal server error");
  }

  _matchRoute(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const params = route.match(pathname);
      if (params) return { ...route, params };
    }
    return null;
  }

  getActiveSpeechSession() {
    return this._speechSession;
  }

  publishSpeechEvent(payload = {}) {
    const sessionId = payload.sessionId || payload.session_id || this._speechSession?.id;
    if (!sessionId || typeof payload.type !== "string") return null;
    if (!this._speechSession || this._speechSession.id !== sessionId) return null;

    const event = {
      id: ++this._speechSequence,
      type: payload.type,
      session_id: sessionId,
      timestamp: new Date().toISOString(),
      ...payload,
    };
    delete event.sessionId;

    if (this._speechSession?.id === sessionId) {
      const nextState = {
        "dictation.started": "recording",
        "dictation.processing": "processing",
        "dictation.stopping": "stopping",
      }[event.type];
      if (nextState) this._speechSession.state = nextState;
    }

    this._speechEvents.push(event);
    if (this._speechEvents.length > SPEECH_EVENT_BUFFER_SIZE) this._speechEvents.shift();

    const encoded = `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of this._speechClients) {
      if (!client.sessionId || client.sessionId === sessionId) client.res.write(encoded);
    }

    if (["dictation.completed", "dictation.cancelled", "dictation.error"].includes(event.type)) {
      if (this._speechSession?.id === sessionId) this._speechSession = null;
    }
    return event;
  }

  _startSpeechSession(body = {}, sessionOptions = {}) {
    if (this._speechSession) {
      const err = new Error(`Speech session ${this._speechSession.id} is already active`);
      err.code = "CONFLICT";
      throw err;
    }

    const cleanup = body.cleanup ?? "incremental";
    if (!SPEECH_CLEANUP_MODES.has(cleanup)) {
      const err = new Error("'cleanup' must be one of: none, incremental, final");
      err.code = "VALIDATION";
      throw err;
    }
    if (body.provider != null && body.provider !== "nvidia") {
      const err = new Error("The speech API currently supports the 'nvidia' provider only");
      err.code = "VALIDATION";
      throw err;
    }

    if (body.model != null && typeof body.model !== "string") {
      const err = new Error("'model' must be a string");
      err.code = "VALIDATION";
      throw err;
    }
    if (body.language != null && typeof body.language !== "string") {
      const err = new Error("'language' must be a string");
      err.code = "VALIDATION";
      throw err;
    }
    const model = body.model || DEFAULT_STREAMING_MODEL;
    const modelInfo = this.ipcHandlers.getSpeechProviderModel?.(model);
    if (!modelInfo || modelInfo.runtime !== "online") {
      const err = new Error(`'${model}' is not a supported streaming Parakeet model`);
      err.code = "VALIDATION";
      throw err;
    }
    if (!modelInfo.downloaded) {
      const err = new Error(`Streaming model '${model}' is not downloaded`);
      err.code = "VALIDATION";
      throw err;
    }

    const interactive = sessionOptions.interactive === true;
    const id = crypto.randomUUID();
    const session = {
      id,
      state: "starting",
      activation: interactive ? "hotkey" : "provider",
      interactive,
      provider: "nvidia",
      model,
      language: body.language || "en",
      cleanup,
      display: body.display === true,
      persist: body.persist === true,
      created_at: new Date().toISOString(),
    };
    this._speechSession = session;

    const started = this.ipcHandlers.windowManager?.sendStartDictation({
      providerMode: true,
      sessionId: id,
      model,
      language: session.language,
      cleanupMode: cleanup,
      display: session.display,
      persist: session.persist,
      interactive,
    });
    if (started !== true) {
      this._speechSession = null;
      const err = new Error("Dictation is busy or the application is not ready");
      err.code = "CONFLICT";
      throw err;
    }

    this.publishSpeechEvent({ type: "dictation.accepted", sessionId: id, session: { ...session } });
    return session;
  }

  startInteractiveSpeechSession() {
    if (this._speechSession) {
      return {
        handled: true,
        action: "busy",
        session: this._speechSession,
      };
    }

    try {
      const session = this._startSpeechSession(
        {
          provider: "nvidia",
          model: DEFAULT_STREAMING_MODEL,
          language: "en",
          cleanup: "incremental",
          display: true,
          persist: true,
        },
        { interactive: true }
      );
      return { handled: true, action: "started", session };
    } catch (error) {
      debugLogger.warn(
        "Interactive streaming dictation unavailable",
        { error: error.message, code: error.code },
        "cli-bridge"
      );
      if (error.code === "VALIDATION") {
        return { handled: false, action: "fallback", reason: error.message };
      }
      return { handled: true, action: "busy", reason: error.message };
    }
  }

  toggleInteractiveSpeechSession() {
    const session = this._speechSession;
    if (!session) return this.startInteractiveSpeechSession();
    if (!session.interactive || !["starting", "recording"].includes(session.state)) {
      return { handled: true, action: "busy", session };
    }
    this._stopSpeechSession(session.id);
    return { handled: true, action: "stopped", session };
  }

  stopInteractiveSpeechSession() {
    const session = this._speechSession;
    if (!session) return { handled: false, action: "fallback" };
    if (!session.interactive || !["starting", "recording"].includes(session.state)) {
      return { handled: true, action: "busy", session };
    }
    this._stopSpeechSession(session.id);
    return { handled: true, action: "stopped", session };
  }

  cancelInteractiveSpeechSession() {
    const session = this._speechSession;
    if (!session) return { handled: false, action: "fallback" };
    if (!session.interactive) return { handled: true, action: "busy", session };
    this._cancelSpeechSession(session.id);
    return { handled: true, action: "cancelled", session };
  }

  _requireSpeechSession(id) {
    if (!this._speechSession || this._speechSession.id !== id) {
      const err = new Error(`Speech session ${id} not found`);
      err.code = "NOT_FOUND";
      throw err;
    }
    return this._speechSession;
  }

  _stopSpeechSession(id) {
    const session = this._requireSpeechSession(id);
    session.state = "stopping";
    this.publishSpeechEvent({ type: "dictation.stopping", sessionId: id });
    this.ipcHandlers.windowManager?.sendStopDictation({ providerMode: true });
    return session;
  }

  _cancelSpeechSession(id) {
    const session = this._requireSpeechSession(id);
    session.state = "cancelling";
    this.ipcHandlers.windowManager?.sendCancelDictation({ providerMode: true });
    return session;
  }

  _openSpeechEventStream(req, res, query) {
    const sessionId = query.get("session_id") || null;
    const lastEventId = Number(req.headers["last-event-id"] || query.get("after") || 0);
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();
    res.write(": connected\n\n");

    for (const event of this._speechEvents) {
      if (Number.isFinite(lastEventId) && event.id <= lastEventId) continue;
      if (sessionId && event.session_id !== sessionId) continue;
      res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }

    const client = {
      res,
      sessionId,
      keepAliveTimer: setInterval(() => res.write(": keep-alive\n\n"), 15_000),
    };
    client.keepAliveTimer.unref?.();
    this._speechClients.add(client);
    req.on("close", () => {
      clearInterval(client.keepAliveTimer);
      this._speechClients.delete(client);
    });
  }

  _buildRouteTable() {
    const exact = (method, path, handler, status, options = {}) => ({
      method,
      match: (p) => (p === path ? {} : null),
      handler,
      status,
      ...options,
    });
    const param = (method, prefix, suffix, paramName, handler, status) => ({
      method,
      match: (p) => {
        if (!p.startsWith(prefix)) return null;
        const rest = p.slice(prefix.length);
        if (suffix) {
          if (!rest.endsWith(suffix)) return null;
          const value = rest.slice(0, rest.length - suffix.length);
          if (!value || value.includes("/")) return null;
          return { [paramName]: value };
        }
        if (rest.includes("/")) return null;
        return { [paramName]: rest };
      },
      handler,
      status,
    });

    const db = this.ipcHandlers.databaseManager;
    const ipc = this.ipcHandlers;

    const requireId = (params, label) => {
      const id = parseIdParam(params.id);
      if (id == null) {
        const err = new Error(`Invalid ${label} id`);
        err.code = "NOT_FOUND";
        throw err;
      }
      return id;
    };

    const requireWordList = (value, field) => {
      if (value === undefined || value === null) return [];
      if (!Array.isArray(value) || value.some((w) => typeof w !== "string")) {
        const err = new Error(`'${field}' must be an array of strings`);
        err.code = "VALIDATION";
        throw err;
      }
      return value;
    };

    const requireSuccess = (result, message) => {
      if (!result?.success) {
        const err = new Error(result?.error || message);
        err.code = "NOT_FOUND";
        throw err;
      }
    };

    return [
      exact("GET", "/v1/health", async () => ({
        data: {
          ok: true,
          version: 1,
          speech: await ipc.getSpeechProviderStatus?.(),
        },
      })),
      exact("GET", "/v1/speech/status", async () => ({
        data: {
          ...(await ipc.getSpeechProviderStatus?.()),
          session: this._speechSession,
        },
      })),
      exact("GET", "/v1/speech/models", async () => ({
        data: (await ipc.getSpeechProviderModels?.()) || [],
      })),
      exact(
        "POST",
        "/v1/speech/dictations",
        ({ body }) => ({ data: this._startSpeechSession(body) }),
        202
      ),
      param("POST", "/v1/speech/dictations/", "/stop", "id", ({ params }) => ({
        data: this._stopSpeechSession(params.id),
      })),
      param("POST", "/v1/speech/dictations/", "/cancel", "id", ({ params }) => ({
        data: this._cancelSpeechSession(params.id),
      })),
      exact(
        "GET",
        "/v1/speech/events",
        ({ req, res, query }) => this._openSpeechEventStream(req, res, query),
        undefined,
        { stream: true }
      ),
      exact("GET", "/v1/notes/list", ({ query }) => {
        const noteType = query.get("note_type") || null;
        const limit = query.get("limit") ? Number(query.get("limit")) : 100;
        const folderId = query.get("folder_id") ? Number(query.get("folder_id")) : null;
        const notes = db.getNotes(noteType, limit, folderId);
        return { data: notes, has_more: false, next_cursor: null };
      }),
      exact("GET", "/v1/notes/search", ({ query }) => {
        const q = query.get("q") || "";
        if (!q.trim()) {
          const err = new Error("Search query is required");
          err.code = "VALIDATION";
          throw err;
        }
        const limit = query.get("limit") ? Number(query.get("limit")) : 20;
        const notes = db.searchNotes(q, limit);
        return { data: notes, has_more: false, next_cursor: null };
      }),
      param("GET", "/v1/notes/", "", "id", ({ params }) => {
        const id = requireId(params, "note");
        const note = db.getNote(id);
        if (!note || note.deleted_at) {
          const err = new Error(`Note ${id} not found`);
          err.code = "NOT_FOUND";
          throw err;
        }
        return { data: note };
      }),
      exact(
        "POST",
        "/v1/notes/create",
        ({ body }) => {
          const result = db.saveNote(
            body.title ?? "Untitled Note",
            body.content ?? "",
            body.note_type ?? "personal",
            body.source_file ?? null,
            body.audio_duration_seconds ?? null,
            body.folder_id ?? null
          );
          const note = unwrapMutationResult(result, "note");
          setImmediate(() => broadcastToWindows("note-added", note));
          ipc._asyncVectorUpsert(note);
          ipc._asyncMirrorWrite(note);
          return { data: note };
        },
        201
      ),
      param("PATCH", "/v1/notes/", "", "id", ({ params, body }) => {
        const id = requireId(params, "note");
        const result = db.updateNote(id, body || {});
        const note = unwrapMutationResult(result, "note");
        setImmediate(() => broadcastToWindows("note-updated", note));
        ipc._asyncVectorUpsert(note);
        ipc._asyncMirrorWrite(note);
        return { data: note };
      }),
      param("DELETE", "/v1/notes/", "", "id", ({ params }) => {
        const id = requireId(params, "note");
        const result = ipc.deleteNoteInternal(id);
        requireSuccess(result, `Note ${id} not found`);
        return NO_CONTENT;
      }),
      exact("GET", "/v1/folders/list", () => {
        return { data: db.getFolders(), has_more: false, next_cursor: null };
      }),
      exact(
        "POST",
        "/v1/folders/create",
        ({ body }) => {
          const result = db.createFolder(body?.name);
          const folder = unwrapMutationResult(result, "folder");
          setImmediate(() => broadcastToWindows("folder-created", folder));
          return { data: folder };
        },
        201
      ),
      exact("GET", "/v1/dictionary/list", () => {
        return { data: db.getDictionary(), has_more: false, next_cursor: null };
      }),
      // Bulk edits without writing to SQLite by hand, which lost rows on the
      // next launch and never reached the cloud (#1295). Takes a delta, so an
      // import cannot delete words it didn't name.
      exact("POST", "/v1/dictionary/update", ({ body }) => {
        const add = requireWordList(body?.add, "add");
        const remove = requireWordList(body?.remove, "remove");
        if (add.length === 0 && remove.length === 0) {
          const err = new Error("Provide at least one word in 'add' or 'remove'");
          err.code = "VALIDATION";
          throw err;
        }
        const result = db.applyDictionaryChanges({ add, remove });
        const words = db.getDictionary();
        setImmediate(() => broadcastToWindows("dictionary-updated", words));
        return { data: { words, added: result.added, removed: result.removed } };
      }),
      exact("GET", "/v1/transcriptions/list", ({ query }) => {
        const limit = query.get("limit") ? Number(query.get("limit")) : 50;
        return {
          data: db.getTranscriptions(limit),
          has_more: false,
          next_cursor: null,
        };
      }),
      param("GET", "/v1/transcriptions/", "", "id", ({ params }) => {
        const id = requireId(params, "transcription");
        const transcription = db.getTranscriptionById(id);
        if (!transcription || transcription.deleted_at) {
          const err = new Error(`Transcription ${id} not found`);
          err.code = "NOT_FOUND";
          throw err;
        }
        return { data: transcription };
      }),
      param("DELETE", "/v1/transcriptions/", "", "id", ({ params }) => {
        const id = requireId(params, "transcription");
        const result = ipc.deleteTranscriptionInternal(id);
        requireSuccess(result, `Transcription ${id} not found`);
        return NO_CONTENT;
      }),
      param("DELETE", "/v1/transcriptions/", "/audio", "id", ({ params }) => {
        const id = requireId(params, "transcription");
        const result = ipc.audioStorageManager.deleteAudio(id);
        if (!result?.success) {
          throw new Error(`Failed to delete audio for transcription ${id}`);
        }
        db.updateTranscriptionAudio(id, {
          hasAudio: 0,
          audioDurationMs: null,
          provider: null,
          model: null,
        });
        return NO_CONTENT;
      }),
    ];
  }
}

module.exports = CliBridge;
module.exports.getBridgeFilePath = getBridgeFilePath;
