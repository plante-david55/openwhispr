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
      sendStopDictation() {
        stops.push(true);
      },
      sendCancelDictation() {
        cancels.push(true);
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
  assert.equal(bridge.getActiveSpeechSession().state, "stopping");

  bridge.publishSpeechEvent({ type: "dictation.completed", sessionId: session.id, text: "done" });
  assert.equal(bridge.getActiveSpeechSession(), null);
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
