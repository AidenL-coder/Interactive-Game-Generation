const BASE = import.meta.env.VITE_API_URL || "/api";

// Turns arrive as server-sent events over a POST, so the narrative can be shown while
// the rest of the turn is still being generated. EventSource is GET-only and cannot
// carry a request body, so the stream is read off fetch().body by hand.

async function readSSE(res, handlers) {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      body.error ? `${body.error}${body.detail ? `: ${body.detail}` : ""}` : `HTTP ${res.status}`
    );
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Events are separated by a blank line; a partial event stays in the buffer until
    // the rest of it arrives.
    let split;
    while ((split = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);

      let event = "message";
      const dataLines = [];
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      if (!dataLines.length) continue;

      let data;
      try {
        data = JSON.parse(dataLines.join("\n"));
      } catch {
        continue;
      }
      handlers[event]?.(data);
    }
  }
}

/**
 * Starts a new game. Resolves with the first turn once it is complete; `handlers` fire
 * as it streams.
 *
 * @param {object} args
 * @param {object} args.profile
 * @param {string} args.sourceText
 * @param {object} [args.ablation]
 * @param {object} handlers - { status, style, prose, proseReset }
 */
export async function startStory({ profile, sourceText, ablation }, handlers = {}) {
  const res = await fetch(`${BASE}/2d/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile, sourceText, ablation }),
  });
  return consumeTurn(res, handlers);
}

/** Takes a turn. Same streaming contract as startStory. */
export async function sendChoice2D(sessionId, payload, handlers = {}) {
  const res = await fetch(`${BASE}/2d/sessions/${sessionId}/choice`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return consumeTurn(res, handlers);
}

async function consumeTurn(res, handlers) {
  let turn = null;
  let failure = null;

  await readSSE(res, {
    status: (d) => handlers.status?.(d.phase),
    style: (d) => handlers.style?.(d),
    prose: (d) => handlers.prose?.(d.delta),
    "prose-reset": () => handlers.proseReset?.(),
    turn: (d) => {
      turn = d;
    },
    failed: (d) => {
      failure = d.error;
    },
  });

  if (failure) throw new Error(failure);
  if (!turn) throw new Error("the connection closed before the turn finished");
  return turn;
}
