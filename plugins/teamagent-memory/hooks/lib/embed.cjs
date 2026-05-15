"use strict";

const MODEL_ID = "Xenova/multilingual-e5-small";
const EMBED_DIM = 384;

let _pipelinePromise = null;

async function getPipeline() {
  if (!_pipelinePromise) {
    _pipelinePromise = (async () => {
      const t = await import("@xenova/transformers");
      t.env.allowRemoteModels = true;
      return t.pipeline("feature-extraction", MODEL_ID, { quantized: true });
    })();
  }
  return _pipelinePromise;
}

// Returns Float32Array(384) L2-normalized for `text`. Truncates internally to model max.
async function embedText(text) {
  if (typeof text !== "string" || text.length === 0) {
    return new Float32Array(EMBED_DIM);
  }
  // e5 expects "query: " prefix; for our purposes rules and queries live in the same space.
  const input = "query: " + text;
  const pipeline = await getPipeline();
  const out = await pipeline(input, { pooling: "mean", normalize: true });
  return new Float32Array(out.data);
}

function packEmbedding(vec) {
  if (!vec || !(vec instanceof Float32Array)) return null;
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

function unpackEmbedding(buf) {
  if (!buf || !Buffer.isBuffer(buf)) return null;
  // Float32Array view over the buffer's bytes
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

module.exports = { embedText, packEmbedding, unpackEmbedding, cosine, EMBED_DIM, MODEL_ID };
