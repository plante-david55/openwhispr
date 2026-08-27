class IncrementalCleanup {
  constructor({ cleanSegment, emit = () => {} }) {
    if (typeof cleanSegment !== "function") {
      throw new TypeError("IncrementalCleanup requires a cleanSegment function");
    }
    this.cleanSegment = cleanSegment;
    this.emit = emit;
    this.finalizedSegments = [];
    this.queuedSegmentIds = new Set();
    this.processedSegments = new Map();
    this.cleanedParts = [];
    this.queue = Promise.resolve();
  }

  observe(snapshot = {}) {
    if (!Array.isArray(snapshot.finalizedSegments)) return;
    this.finalizedSegments = snapshot.finalizedSegments.map((entry, index) => ({
      id: String(entry.segment ?? index),
      text: String(entry.text || "").trim(),
    }));

    // Sherpa may refine its newest finalized segment. Hold that one until a
    // later segment arrives, then clean only text that has become stable.
    for (const segment of this.finalizedSegments.slice(0, -1)) {
      this._enqueueSegment(segment);
    }
  }

  _enqueueSegment(segment) {
    if (
      !segment.text ||
      this.processedSegments.has(segment.id) ||
      this.queuedSegmentIds.has(segment.id)
    ) {
      return;
    }
    this.queuedSegmentIds.add(segment.id);
    this.queue = this.queue.then(() => this._clean(segment));
  }

  async _clean(segment) {
    this.emit({ type: "cleanup.started", segment_id: segment.id, text: segment.text });
    let cleaned = "";
    try {
      for await (const delta of this.cleanSegment(segment.text)) {
        if (!delta) continue;
        cleaned += delta;
        this.emit({
          type: "cleanup.delta",
          segment_id: segment.id,
          delta,
          text: cleaned,
        });
      }
      cleaned = cleaned.trim() || segment.text;
    } catch (error) {
      cleaned = segment.text;
      this.emit({
        type: "cleanup.failed",
        segment_id: segment.id,
        message: error?.message || String(error),
        fallback_text: segment.text,
      });
    }

    this.queuedSegmentIds.delete(segment.id);
    this.processedSegments.set(segment.id, segment.text);
    this.cleanedParts.push(cleaned);
    this.emit({
      type: "cleanup.committed",
      segment_id: segment.id,
      text: cleaned,
      cleaned_text: this.cleanedParts.join(" "),
    });
  }

  async finalize(rawText = "") {
    for (const segment of this.finalizedSegments) this._enqueueSegment(segment);
    await this.queue;

    const raw = String(rawText || "").trim();
    const segmentedRaw = this.finalizedSegments
      .map((segment) => segment.text)
      .filter(Boolean)
      .join(" ")
      .trim();

    if (raw && !segmentedRaw) {
      this._enqueueSegment({ id: "final", text: raw });
      await this.queue;
    } else if (raw && raw !== segmentedRaw) {
      // A late recognizer revision invalidates already-streamed segment
      // boundaries. Final output fails open to the authoritative transcript.
      this.emit({ type: "cleanup.resynced", text: raw });
      return raw;
    }

    return this.cleanedParts.join(" ").trim() || raw;
  }
}

export default IncrementalCleanup;
