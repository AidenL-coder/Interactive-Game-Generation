const BASE = import.meta.env.VITE_API_URL || "/api";

async function handle(res) {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ? `${body.error}${body.detail ? `: ${body.detail}` : ""}` : `HTTP ${res.status}`);
  }
  return res.json();
}

export function startSession({ profile, sourceText, ablation, packId }) {
  return fetch(`${BASE}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile, sourceText, ablation, packId }),
  }).then(handle);
}

/** Pre-generated games that have a 3D world. Empty on any failure — the screen still works. */
export async function fetchPacks3d() {
  try {
    const res = await fetch(`${BASE}/packs`);
    if (!res.ok) return [];
    const { packs = [] } = await res.json();
    return packs.filter((p) => p.engines?.includes("3d"));
  } catch {
    return [];
  }
}

export function sendChoice(sessionId, { choiceId, freeText }) {
  return fetch(`${BASE}/sessions/${sessionId}/choice`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ choiceId, freeText }),
  }).then(handle);
}
