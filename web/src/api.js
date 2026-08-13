const BASE = import.meta.env.VITE_API_URL || "/api";

async function handle(res) {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ? `${body.error}${body.detail ? `: ${body.detail}` : ""}` : `HTTP ${res.status}`);
  }
  return res.json();
}

export function startSession({ profile, sourceText, ablation }) {
  return fetch(`${BASE}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile, sourceText, ablation }),
  }).then(handle);
}

export function sendChoice(sessionId, { choiceId, freeText }) {
  return fetch(`${BASE}/sessions/${sessionId}/choice`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ choiceId, freeText }),
  }).then(handle);
}
