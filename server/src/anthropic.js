import Anthropic from "@anthropic-ai/sdk";

if (!process.env.ANTHROPIC_API_KEY) {
  // Fail loudly at startup rather than on the first request — this is a research
  // system, silent misconfiguration wastes eval runs.
  console.warn(
    "[anthropic] ANTHROPIC_API_KEY is not set. Requests to /api/sessions will fail " +
      "until it is configured (see server/.env.example)."
  );
}

export const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";
