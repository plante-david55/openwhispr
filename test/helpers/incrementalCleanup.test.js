const test = require("node:test");
const assert = require("node:assert/strict");

const loadIncrementalCleanup = async () =>
  (await import("../../src/helpers/incrementalCleanup.mjs")).default;

async function* tokenized(text) {
  yield text.slice(0, 2).toUpperCase();
  yield text.slice(2).toUpperCase();
}

test("incremental cleanup holds the newest finalized segment", async () => {
  const IncrementalCleanup = await loadIncrementalCleanup();
  const events = [];
  const cleanup = new IncrementalCleanup({
    cleanSegment: tokenized,
    emit: (event) => events.push(event),
  });

  cleanup.observe({ finalizedSegments: [{ segment: 0, text: "hello" }] });
  await cleanup.queue;
  assert.equal(events.length, 0);

  cleanup.observe({
    finalizedSegments: [
      { segment: 0, text: "hello" },
      { segment: 1, text: "world" },
    ],
  });
  await cleanup.queue;
  assert.equal(events.filter((event) => event.type === "cleanup.committed").length, 1);
  assert.equal(await cleanup.finalize("hello world"), "HELLO WORLD");
});

test("incremental cleanup fails open for a segment error", async () => {
  const IncrementalCleanup = await loadIncrementalCleanup();
  const cleanup = new IncrementalCleanup({
    cleanSegment: async function* () {
      yield "partial";
      throw new Error("offline");
    },
  });
  cleanup.observe({
    finalizedSegments: [
      { segment: 0, text: "keep this" },
      { segment: 1, text: "too" },
    ],
  });
  assert.equal(await cleanup.finalize("keep this too"), "keep this too");
});

test("incremental cleanup uses the authoritative final after a late revision", async () => {
  const IncrementalCleanup = await loadIncrementalCleanup();
  const cleanup = new IncrementalCleanup({ cleanSegment: tokenized });
  cleanup.observe({
    finalizedSegments: [
      { segment: 0, text: "first" },
      { segment: 1, text: "draft" },
    ],
  });
  assert.equal(await cleanup.finalize("first revised"), "first revised");
});
