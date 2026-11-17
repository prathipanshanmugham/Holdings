/* Prathipan Holdings HQ — Supabase runtime for the ERP.
   Exposes window.claude.use(name) for db, user, sample, downloads, so the ERP page runs unchanged on your own domain. */
(() => {
  "use strict";
  const CFG = window.HQ_CONFIG || {};
  const ok = CFG.supabaseUrl && CFG.supabaseAnonKey && window.supabase && typeof window.supabase.createClient === "function";
  if (!ok) { window.HQ_SETUP_NEEDED = true; return; }
  const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {auth:{persistSession:true, autoRefreshToken:true, detectSessionInUrl:true}});
  window.HQ = {sb};

  const uid = () => { const a = "abcdefghijklmnopqrstuvwxyz0123456789"; let s = ""; const r = crypto.getRandomValues(new Uint8Array(20)); for (let i = 0; i < 20; i++) s += a[r[i] % a.length]; return s; };
  const err = (e) => { const x = new Error((e && e.message) || "write failed"); const code = e && (e.code || e.status); x.code = code === "42501" || code === 401 || code === 403 ? "permission_denied" : code === "PGRST301" ? "unavailable" : "unknown"; x.cause = e; return x; };

  /* ---------- auth state ---------- */
  let session = null, me = null, memberRow = null;
  const authListeners = new Set();
  async function loadMe(){
    const u = session && session.user;
    if (!u) { me = null; memberRow = null; return; }
    const email = (u.email || "").toLowerCase();
    const name = (u.user_metadata && (u.user_metadata.full_name || u.user_metadata.name)) || email.split("@")[0];
    const avatar = (u.user_metadata && (u.user_metadata.avatar_url || u.user_metadata.picture)) || "";
    try { await sb.from("profiles").upsert({id:u.id, name, email, avatar_url:avatar}, {onConflict:"id"}); } catch(e) {}
    let isOwner = false;
    try { await sb.rpc("hq_claim_membership"); } catch(e) {}
    try { const {data} = await sb.rpc("hq_is_owner"); isOwner = !!data; } catch(e) {}
    me = {id:u.id, name, email, avatarUrl:avatar, isOwner};
    try { const {data} = await sb.from("members").select("*").eq("user_id", u.id).maybeSingle(); memberRow = data || null; } catch(e) { memberRow = null; }
  }
  const ready = (async () => { const {data} = await sb.auth.getSession(); session = data && data.session; await loadMe(); })();
  sb.auth.onAuthStateChange(async (_ev, s) => { session = s; await loadMe(); authListeners.forEach(f => f()); });
  window.HQ.onAuth = f => authListeners.add(f);
  window.HQ.whenReady = () => ready;
  window.HQ.session = () => session;
  window.HQ.signIn = (email, password) => sb.auth.signInWithPassword({email, password});
  window.HQ.signUp = (email, password, name) => sb.auth.signUp({email, password, options:{data:{full_name:name}, emailRedirectTo:location.origin + location.pathname}});
  window.HQ.magicLink = email => sb.auth.signInWithOtp({email, options:{emailRedirectTo:location.origin + location.pathname}});
  window.HQ.reset = email => sb.auth.resetPasswordForEmail(email, {redirectTo:location.origin + location.pathname});
  window.HQ.signOut = () => sb.auth.signOut();

  /* ---------- docs cache + realtime ---------- */
  const cache = new Map();      // collection -> Map(id -> data)
  const listeners = new Map();  // collection -> Set(fn)
  const memListeners = new Set(), myMemListeners = new Set();
  let channel = null;
  function ensureChannel(){
    if (channel) return;
    channel = sb.channel("hq-docs")
      .on("postgres_changes", {event:"*", schema:"public", table:"docs"}, p => { const row = p.new && p.new.collection ? p.new : p.old; if (!row) return; const col = row.collection; if (!cache.has(col)) return; const m = cache.get(col); if (p.eventType === "DELETE") m.delete(row.id); else m.set(row.id, row.data || {}); emit(col); })
      .on("postgres_changes", {event:"*", schema:"public", table:"members"}, () => { refreshMembers(); })
      .subscribe();
  }
  function emit(col){ (listeners.get(col) || []).forEach(f => { try { f(snapOf(col)); } catch(e) { console.error(e); } }); }
  function snapOf(col){ const m = cache.get(col) || new Map(); const docs = [...m.entries()].map(([id, data]) => ({id, exists:true, data:() => data, metadata:{}})); return {docs, size:docs.length, empty:!docs.length, docChanges:() => [], metadata:{}}; }
  async function load(col){
    const {data, error} = await sb.from("docs").select("id,data").eq("collection", col);
    if (error) throw err(error);
    const m = new Map(); (data || []).forEach(r => m.set(r.id, r.data || {})); cache.set(col, m);
  }
  async function refreshMembers(){
    if (memListeners.size && me && me.isOwner) { const {data} = await sb.from("members").select("*"); const rows = (data || []).map(r => ({id:r.user_id || ("email:" + r.email), exists:true, data:() => ({role:r.role, companies:r.companies, since:r.since, email:r.email}), metadata:{}})); memListeners.forEach(f => f({docs:rows, size:rows.length, empty:!rows.length, docChanges:() => [], metadata:{}})); }
    if (myMemListeners.size && me) { const {data} = await sb.from("members").select("*").eq("user_id", me.id).maybeSingle(); memberRow = data || null; myMemListeners.forEach(f => f({id:me.id, exists:!!memberRow, data:() => memberRow ? {role:memberRow.role, companies:memberRow.companies, since:memberRow.since} : null, metadata:{}})); }
  }
  const writeDoc = async (col, id, data, merge) => {
    const {error} = merge ? await sb.rpc("hq_doc_merge", {p_collection:col, p_id:id, p_patch:data}) : await sb.from("docs").upsert({collection:col, id, data, updated_by:me && me.id, updated_at:new Date().toISOString()}, {onConflict:"collection,id"});
    if (error) throw err(error);
    if (cache.has(col)) { const m = cache.get(col); m.set(id, merge ? Object.assign({}, m.get(id) || {}, data) : data); emit(col); }
  };
  const deleteDoc = async (col, id) => { const {error} = await sb.from("docs").delete().eq("collection", col).eq("id", id); if (error) throw err(error); if (cache.has(col)) { cache.get(col).delete(id); emit(col); } };
  function docRef(col, id){
    id = id || uid();
    return {id, set:d => writeDoc(col, id, d, false), update:d => writeDoc(col, id, d, true), delete:() => deleteDoc(col, id),
      onSnapshot:(next, onErr) => { ensureChannel(); (cache.has(col) ? Promise.resolve() : load(col)).then(() => { const f = () => { const m = cache.get(col); next({id, exists:m.has(id), data:() => m.get(id), metadata:{}}); }; const set = listeners.get(col) || new Set(); set.add(f); listeners.set(col, set); f(); }).catch(e => onErr && onErr(e)); return () => {}; }};
  }
  function colRef(col){
    let order = null, lim = null;
    const ref = {
      orderBy(f, dir){ order = [f, dir || "asc"]; return ref; }, limit(n){ lim = n; return ref; },
      doc:id => docRef(col, id),
      add:async d => { const id = uid(); await writeDoc(col, id, d, false); return {id}; },
      onSnapshot:(next, onErr) => {
        if (col === "members") { memListeners.add(next); refreshMembers(); ensureChannel(); return () => memListeners.delete(next); }
        ensureChannel();
        const wrap = snap => { let docs = snap.docs; if (order) { const [f, dir] = order; docs = docs.slice().sort((a, b) => { const x = a.data()[f], y = b.data()[f]; return (x < y ? -1 : x > y ? 1 : 0) * (dir === "desc" ? -1 : 1); }); } if (lim) docs = docs.slice(0, lim); next({...snap, docs, size:docs.length, empty:!docs.length}); };
        (cache.has(col) ? Promise.resolve() : load(col)).then(() => { const set = listeners.get(col) || new Set(); set.add(wrap); listeners.set(col, set); wrap(snapOf(col)); }).catch(e => onErr && onErr(e));
        return () => { const set = listeners.get(col); if (set) set.delete(wrap); };
      }
    };
    return ref;
  }
  const dbNS = {
    collection: colRef,
    doc: path => {
      const [col, id] = String(path).split("/");
      if (col === "members") {
        const byEmail = id.startsWith("email:"); const key = byEmail ? id.slice(6).toLowerCase() : id;
        const where = q => byEmail ? q.eq("email", key) : q.eq("user_id", key);
        return {id, onSnapshot:(next) => { myMemListeners.add(next); refreshMembers(); ensureChannel(); return () => myMemListeners.delete(next); },
          set:async d => { const {error} = await sb.rpc("hq_member_set", {p_user_id:byEmail ? null : key, p_email:byEmail ? key : null, p_role:d.role, p_companies:d.companies, p_since:d.since || null}); if (error) throw err(error); refreshMembers(); },
          update:async d => { const {error} = await where(sb.from("members").update(d)); if (error) throw err(error); refreshMembers(); },
          delete:async () => { const {error} = await where(sb.from("members").delete()); if (error) throw err(error); refreshMembers(); }};
      }
      return docRef(col, id);
    }
  };

  /* ---------- user ---------- */
  const userNS = {
    me: async () => { await ready; return me ? {id:me.id, name:me.name, avatarUrl:me.avatarUrl, isOwner:me.isOwner, guest:false} : {id:null, name:"", avatarUrl:"", isOwner:false}; },
    id: async () => { await ready; return me && me.id; },
    isOwner: async () => { await ready; return !!(me && me.isOwner); },
    canEdit: async () => { await ready; return !!me; },
    can: async (what) => { await ready; if (what === "data.write") return !!me; return null; },
    profiles: async ids => { const out = {}; const all = [...new Set([].concat(ids).filter(Boolean))]; all.filter(i => String(i).startsWith("email:")).forEach(i => out[i] = {id:i, name:i.slice(6) + " (not signed in yet)", avatarUrl:"", guest:false}); const list = all.filter(i => !String(i).startsWith("email:")); if (!list.length) return out; const {data} = await sb.from("profiles").select("id,name,email,avatar_url").in("id", list); (data || []).forEach(p => out[p.id] = {id:p.id, name:p.name || p.email || "", avatarUrl:p.avatar_url || "", guest:false}); return out; },
    search: async q => { const s = String(q || "").trim(); let qq = sb.from("profiles").select("id,name,email,avatar_url").limit(12); if (s) qq = qq.or(`name.ilike.%${s.replace(/[%,()]/g, "")}%,email.ilike.%${s.replace(/[%,()]/g, "")}%`); const {data} = await qq; const hits = (data || []).map(p => ({id:p.id, name:(p.name || "") + (p.email ? " · " + p.email : ""), avatarUrl:p.avatar_url || "", guest:false})); if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) && !hits.some(h => h.name.toLowerCase().includes(s.toLowerCase()))) hits.push({id:"email:" + s.toLowerCase(), name:s.toLowerCase() + " · invite by email (they sign up, then get this role)", avatarUrl:"", guest:false}); return hits; }
  };

  /* ---------- sample (Claude narration via Edge Function) ---------- */
  function makeSample(){
    if (!CFG.narrateUrl) return null;
    const fn = async (input, opts = {}) => {
      const {data:{session:s}} = await sb.auth.getSession();
      if (!s) { const e = new Error("not signed in"); e.code = "not_granted"; throw e; }
      const ctl = new AbortController(); if (opts.signal) opts.signal.addEventListener("abort", () => ctl.abort());
      let res;
      try { res = await fetch(CFG.narrateUrl, {method:"POST", headers:{"Content-Type":"application/json", Authorization:"Bearer " + s.access_token, apikey:CFG.supabaseAnonKey}, body:JSON.stringify({input, modelTier:opts.modelTier || "default"}), signal:ctl.signal}); }
      catch (e) { const x = new Error("cancelled"); x.code = e.name === "AbortError" ? "cancelled" : "unknown"; throw x; }
      if (res.status === 429) { const e = new Error("rate limited"); e.code = "rate_limited"; throw e; }
      if (res.status === 401 || res.status === 403) { const e = new Error("not allowed"); e.code = "not_granted"; throw e; }
      if (!res.ok) { const e = new Error("failed"); e.code = "unknown"; throw e; }
      const j = await res.json(); const text = j.text || "";
      if (opts.onText) opts.onText({text, delta:text});
      return {text, truncated:!!j.truncated};
    };
    fn.json = async (input, opts) => { const r = await fn(input, opts); try { return JSON.parse(r.text); } catch(e) { return null; } };
    fn.limits = async () => ({images:false});
    return fn;
  }
  const downloadsNS = {save: async ({filename, data}) => { const blob = data instanceof Blob ? data : new Blob([data], {type:"text/csv;charset=utf-8"}); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename || "download"; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); return {status:"saved"}; }};

  window.claude = {use: async name => { await ready; if (!session) return null; if (name === "db") return dbNS; if (name === "user") return userNS; if (name === "sample") return makeSample(); if (name === "downloads") return downloadsNS; return null; }};
})();
