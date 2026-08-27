const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("useAudioRecording accepts an onboarding event handler on its initial render", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-audio-recording-initialization-",
    mockModules: {
      "/helpers/audioManager": "export default class AudioManager {}",
      "/helpers/incrementalCleanup.mjs": "export default class IncrementalCleanup {}",
      "/services/ReasoningService": "export default {}",
    },
  });
  const { useAudioRecording } = await vite.ssrLoadModule("/hooks/useAudioRecording.js");

  function InitialRenderProbe() {
    useAudioRecording(() => {}, { onDemoEvent: () => {} });
    return React.createElement("div");
  }

  assert.doesNotThrow(() => renderToStaticMarkup(React.createElement(InitialRenderProbe)));
});

test("interactive provider completion is promoted into the normal streaming result", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-audio-recording-interactive-provider-",
    mockModules: {
      "/helpers/audioManager": "export default class AudioManager {}",
      "/helpers/incrementalCleanup.mjs": "export default class IncrementalCleanup {}",
      "/services/ReasoningService": "export default {}",
    },
  });
  const {
    isSpeechSessionTranscriptionAllowed,
    promoteInteractiveSpeechResult,
    shouldPresentSpeechSessionLocally,
  } = await vite.ssrLoadModule("/hooks/useAudioRecording.js");

  assert.equal(shouldPresentSpeechSessionLocally(null), true);
  assert.equal(shouldPresentSpeechSessionLocally({ interactive: false }), false);
  assert.equal(shouldPresentSpeechSessionLocally({ interactive: true }), true);
  assert.deepEqual(
    promoteInteractiveSpeechResult(
      { success: true, text: "raw", source: "local-parakeet" },
      "raw",
      "Cleaned."
    ),
    {
      success: true,
      text: "Cleaned.",
      rawText: "raw",
      source: "local-parakeet-streaming",
    }
  );

  const localOnlyPolicy = {
    status: "managed",
    appVersion: "1.9.0",
    policy: {
      minAppVersion: null,
      transcription: { allowedModes: ["local"], allowedByokProviders: [] },
    },
  };
  const unrelatedSavedRoute = {
    transcriptionMode: "providers",
    cloudTranscriptionProvider: "custom",
  };
  assert.equal(
    isSpeechSessionTranscriptionAllowed(localOnlyPolicy, unrelatedSavedRoute, {
      interactive: true,
    }),
    true
  );
  assert.equal(
    isSpeechSessionTranscriptionAllowed(localOnlyPolicy, unrelatedSavedRoute, null),
    false
  );
});
