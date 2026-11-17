// Changes the agent's password using its own current session (no password ever shown).
// Called by deploy/rotate-secrets.sh with AGENT_* and SUPABASE_* in the environment and NEW_PASSWORD set.
import { createClient } from "@supabase/supabase-js";
const { SUPABASE_URL, SUPABASE_KEY, AGENT_EMAIL, AGENT_PASSWORD, NEW_PASSWORD } = process.env;
const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const a = await sb.auth.signInWithPassword({ email: AGENT_EMAIL, password: AGENT_PASSWORD });
if (a.error) { console.error("Agent sign-in failed: " + a.error.message); process.exit(2); }
const b = await sb.auth.updateUser({ password: NEW_PASSWORD });
if (b.error) { console.error("Password change failed: " + b.error.message); process.exit(3); }
const c = await sb.auth.signInWithPassword({ email: AGENT_EMAIL, password: NEW_PASSWORD });
if (c.error) { console.error("New password check failed: " + c.error.message); process.exit(4); }
await sb.auth.signOut();
console.log("ok");
