const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return { app: { isReady: () => false } };
  }
  if (request === "./windowBroadcast") return { broadcastToWindows() {} };
  return originalLoad.call(this, request, parent, isMain);
};
const CliBridge = require("../../src/helpers/cliBridge");
const { getBridgeFilePath } = CliBridge;
Module._load = originalLoad;

function createBridge({ downloaded = true } = {}) {
  const starts = [];
  const stops = [];
  const cancels = [];
  const ipcHandlers = {
    databaseManager: {},
    getSpeechProviderModel(model) {
      return { id: model, runtime: "online", downloaded };
    },
    windowManager: {
      sendStartDictation(options) {
        starts.push(options);
        return true;
      },
      sendStopDictation(options) {
        stops.push(options);
      },
      sendCancelDictation(options) {
        cancels.push(options);
      },
    },
  };
  return { bridge: new CliBridge(ipcHandlers), starts, stops, cancels };
}

test("speech provider starts a headless streaming session", () => {
  const { bridge, starts } = createBridge();
  const session = bridge._startSpeechSession({ cleanup: "incremental" });

  assert.equal(session.model, "parakeet-unified-en-0.6b-streaming-560ms");
  assert.equal(starts[0].providerMode, true);
  assert.equal(starts[0].display, false);
  assert.equal(bridge.getActiveSpeechSession().id, session.id);
  assert.equal(bridge._speechEvents[0].type, "dictation.accepted");
});

test("speech provider rejects overlapping sessions and missing models", () => {
  const { bridge } = createBridge();
  bridge._startSpeechSession({ cleanup: "none" });
  assert.throws(() => bridge._startSpeechSession({}), { code: "CONFLICT" });

  const missing = createBridge({ downloaded: false }).bridge;
  assert.throws(() => missing._startSpeechSession({}), { code: "VALIDATION" });
});

test("terminal speech events release the active session", () => {
  const { bridge, stops } = createBridge();
  const session = bridge._startSpeechSession({ cleanup: "final" });
  bridge._stopSpeechSession(session.id);
  assert.equal(stops.length, 1);
  assert.equal(stops[0].providerMode, true);
  assert.equal(bridge.getActiveSpeechSession().state, "stopping");

  bridge.publishSpeechEvent({ type: "dictation.completed", sessionId: session.id, text: "done" });
  assert.equal(bridge.getActiveSpeechSession(), null);
});

test("interactive hotkey sessions use streaming cleanup and normal dictation presentation", () => {
  const { bridge, starts, stops } = createBridge();
  const started = bridge.startInteractiveSpeechSession();

  assert.equal(started.handled, true);
  assert.equal(started.action, "started");
  assert.equal(started.session.activation, "hotkey");
  assert.equal(started.session.interactive, true);
  assert.equal(started.session.cleanup, "incremental");
  assert.equal(started.session.display, true);
  assert.equal(started.session.persist, true);
  assert.deepEqual(
    {
      providerMode: starts[0].providerMode,
      model: starts[0].model,
      cleanupMode: starts[0].cleanupMode,
      display: starts[0].display,
      persist: starts[0].persist,
      interactive: starts[0].interactive,
    },
    {
      providerMode: true,
      model: "parakeet-unified-en-0.6b-streaming-560ms",
      cleanupMode: "incremental",
      display: true,
      persist: true,
      interactive: true,
    }
  );

  const stopped = bridge.toggleInteractiveSpeechSession();
  assert.equal(stopped.action, "stopped");
  assert.equal(stops.length, 1);
  assert.equal(stops[0].providerMode, true);
});

test("provider and hotkey activations coexist without stealing each other's session", () => {
  const { bridge, stops } = createBridge();
  const providerSession = bridge._startSpeechSession({ cleanup: "none" });

  const hotkeyAttempt = bridge.toggleInteractiveSpeechSession();
  assert.equal(hotkeyAttempt.handled, true);
  assert.equal(hotkeyAttempt.action, "busy");
  assert.equal(hotkeyAttempt.session.id, providerSession.id);
  assert.equal(stops.length, 0);
});

test("interactive hotkey falls back when its streaming model is unavailable", () => {
  const { bridge, starts } = createBridge({ downloaded: false });
  const result = bridge.startInteractiveSpeechSession();

  assert.equal(result.handled, false);
  assert.equal(result.action, "fallback");
  assert.equal(starts.length, 0);
});

test("non-production channels use an isolated discovery file", () => {
  const previous = process.env.OPENWHISPR_CHANNEL;
  process.env.OPENWHISPR_CHANNEL = "foundry";
  try {
    assert.match(getBridgeFilePath(), /cli-bridge-foundry\.json$/);
  } finally {
    if (previous === undefined) delete process.env.OPENWHISPR_CHANNEL;
    else process.env.OPENWHISPR_CHANNEL = previous;
  }
});
