// Prathipan Holdings HQ · "narrate" Edge Function
// Proxies the CFO desk / report narration to the Claude API so the API key never reaches the browser.
// Deploy:  supabase functions deploy narrate
// Secrets: supabase secrets set ANTHROPIC_API_KEY=sk-ant-...   (optional: ANTHROPIC_MODEL, MAX_TOKENS)

import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  const auth = req.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return json({ error: "sign in" }, 401);

  // Who is calling? Use the caller's own JWT so RLS applies.
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } },
  });
  const { data: user } = await sb.auth.getUser();
  if (!user?.user) return json({ error: "sign in" }, 401);
  const { data: isMember } = await sb.rpc("hq_is_member");
  if (!isMember) return json({ error: "no access" }, 403);

  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return json({ error: "ANTHROPIC_API_KEY not set" }, 500);

  let body: { input?: unknown; modelTier?: string } = {};
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const prompt = typeof body.input === "string" ? body.input : JSON.stringify(body.input ?? "");
  if (!prompt.trim()) return json({ error: "empty" }, 400);
  if (prompt.length > 400_000) return json({ error: "too long" }, 413);

  const model = Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-5-5";
  const maxTokens = Number(Deno.env.get("MAX_TOKENS") || 1200);

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
  });
  if (r.status === 429) return json({ error: "rate limited" }, 429);
  if (!r.ok) return json({ error: "upstream", detail: (await r.text()).slice(0, 500) }, 502);
  const data = await r.json();
  const text = (data.content || []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("\n");
  return json({ text, truncated: data.stop_reason === "max_tokens" });
});
