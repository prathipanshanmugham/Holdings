/* Prathipan Holdings HQ — Supabase runtime for the ERP.
   Exposes window.claude.use(name) for db, user, sample, downloads, so the ERP page runs unchanged on your own domain.
   All reads go through hq_read() and all writes through hq_doc_set()/hq_doc_merge(), so the database enforces roles,
   company scope, field rules and the audit trail — the browser is never trusted. */
(() => {
  "use strict";
  const CFG = window.HQ_CONFIG || {};
  const ok = CFG.supabaseUrl && CFG.supabaseAnonKey && window.supabase && typeof window.supabase.createClient === "function";
  if (!ok) { window.HQ_SETUP_NEEDED = true; return; }
  const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {auth:{persistSession:true, autoRefreshToken:true, detectSessionInUrl:true}});
  const HQ = window.HQ = {sb};

  const uid = () => { const a = "abcdefghijklmnopqrstuvwxyz0123456789"; let s = ""; const r = crypto.getRandomValues(new Uint8Array(20)); for (let i = 0; i < 20; i++) s += a[r[i] % a.length]; return s; };
  const err = e => {
    const x = new Error((e && e.message) || "Request failed");
    const code = e && (e.code || e.status);
    x.code = (code === "42501" || code === 401 || code === 403 || /permission|not allowed|row-level security|cannot change|can only/i.test(x.message)) ? "permission_denied" : code === "PGRST301" ? "unavailable" : "unknown";
    x.cause = e; return x;
  };

  /* ---------- auth state ---------- */
  let session = null, me = null, memberRow = null, loadSeq = 0;
  const authListeners = new Set();
  async function loadMe(){
    const seq = ++loadSeq;
    const u = session && session.user;
    if (!u) { me = null; memberRow = null; return; }
    const email = (u.email || "").toLowerCase();
    const meta = u.user_metadata || {};
    const name = String(meta.full_name || meta.name || email.split("@")[0]).slice(0, 120);
    const avatar = String(meta.avatar_url || meta.picture || "").slice(0, 500);
    try { await sb.from("profiles").upsert({id:u.id, name, avatar_url:avatar}, {onConflict:"id"}); } catch(e) {}
    try { await sb.rpc("hq_claim_membership"); } catch(e) {}
    let isOwner = false;
    try { const {data} = await sb.rpc("hq_is_owner"); isOwner = data === true; } catch(e) {}
    let row = null;
    try { const {data} = await sb.from("members").select("role,companies,since,email,user_id").eq("user_id", u.id).maybeSingle(); row = data || null; } catch(e) {}
    if (seq !== loadSeq) return;            // a newer auth event superseded this one
    me = {id:u.id, name, email, avatarUrl:avatar, isOwner}; memberRow = row;
  }
  const ready = (async () => { try { const {data} = await sb.auth.getSession(); session = data && data.session; await loadMe(); } catch(e) { console.warn("[HQ] session", e); } })();
  // Never await Supabase calls inside this callback: it runs while the auth lock is held (that deadlocks sign-in).
  sb.auth.onAuthStateChange((ev, s) => {
    session = s;
    setTimeout(async () => { await loadMe(); authListeners.forEach(f => { try { f(ev); } catch(e) { console.error(e); } }); }, 0);
  });
  HQ.onAuth = f => authListeners.add(f);
  HQ.whenReady = () => ready;
  HQ.refresh = () => loadMe();
  HQ.session = () => session;
  const back = location.origin + location.pathname;
  HQ.signIn = (email, password) => sb.auth.signInWithPassword({email, password});
  HQ.signUp = (email, password, name) => sb.auth.signUp({email, password, options:{data:{full_name:name}, emailRedirectTo:back}});
  HQ.magicLink = email => sb.auth.signInWithOtp({email, options:{emailRedirectTo:back, shouldCreateUser:false}});
  HQ.reset = email => sb.auth.resetPasswordForEmail(email, {redirectTo:back});
  HQ.updatePassword = password => sb.auth.updateUser({password});
  HQ.signOut = () => sb.auth.signOut();
  HQ.mfa = {
    status: async () => { const {data, error} = await sb.rpc("hq_mfa_status"); if (error) throw err(error); return data || {}; },
    level: async () => { const {data} = await sb.auth.mfa.getAuthenticatorAssuranceLevel(); return data || {}; },
    verified: async () => { const {data} = await sb.auth.mfa.listFactors(); return ((data && data.totp) || []).filter(f => f.status === "verified"); },
    enroll: async () => {
      const {data:l} = await sb.auth.mfa.listFactors();
      for (const f of ((l && l.all) || []).filter(f => f.status !== "verified")) { try { await sb.auth.mfa.unenroll({factorId:f.id}); } catch(e) {} }
      const {data, error} = await sb.auth.mfa.enroll({factorType:"totp", friendlyName:"HQ " + new Date().toISOString().slice(0, 16).replace("T", " ")});
      if (error) throw error; return data;
    },
    verify: async (factorId, code) => { const {data, error} = await sb.auth.mfa.challengeAndVerify({factorId, code}); if (error) throw error; return data; }
  };

  /* ---------- docs cache + realtime ---------- */
  const cache = new Map();      // collection -> Map(id -> data)
  const listeners = new Map();  // collection -> Set(fn)
  const loading = new Map();    // collection -> Promise
  const memListeners = new Set(), myMemListeners = new Set();
  let channel = null;
  function ensureChannel(){
    if (channel) return;
    channel = sb.channel("hq-docs")
      .on("postgres_changes", {event:"*", schema:"public", table:"docs"}, p => {
        const row = p.new && p.new.collection ? p.new : p.old; if (!row || !row.collection) return;
        const m = cache.get(row.collection); if (!m) return;
        if (p.eventType === "DELETE") m.delete(row.id); else if (row.data) m.set(row.id, row.data);
        emit(row.collection);
      })
      .on("postgres_changes", {event:"*", schema:"public", table:"members"}, () => { refreshMembers(); })
      .subscribe();
  }
  function emit(col){ (listeners.get(col) || []).forEach(f => { try { f(snapOf(col)); } catch(e) { console.error(e); } }); }
  function snapOf(col){ const m = cache.get(col) || new Map(); const docs = [...m.entries()].map(([id, data]) => ({id, exists:true, data:() => data, metadata:{}})); return {docs, size:docs.length, empty:!docs.length, docChanges:() => [], metadata:{}}; }
  function load(col){
    if (cache.has(col)) return Promise.resolve();
    if (!loading.has(col)) loading.set(col, (async () => {
      const {data, error} = await sb.rpc("hq_read", {p_collection:col});
      if (error) { loading.delete(col); throw err(error); }
      const m = new Map(); (data || []).forEach(r => m.set(r.id, r.data || {})); cache.set(col, m); loading.delete(col);
    })());
    return loading.get(col);
  }
  async function refreshMembers(){
    if (memListeners.size && me && me.isOwner) {
      const {data} = await sb.from("members").select("email,user_id,role,companies,since");
      const rows = (data || []).map(r => ({id:r.user_id || ("email:" + r.email), exists:true, data:() => ({role:r.role, companies:r.companies, since:r.since, email:r.email}), metadata:{}}));
      memListeners.forEach(f => f({docs:rows, size:rows.length, empty:!rows.length, docChanges:() => [], metadata:{}}));
    }
    if (myMemListeners.size && me) {
      const {data} = await sb.from("members").select("role,companies,since").eq("user_id", me.id).maybeSingle(); memberRow = data || null;
      myMemListeners.forEach(f => f({id:me.id, exists:!!memberRow, data:() => memberRow ? {role:memberRow.role, companies:memberRow.companies, since:memberRow.since} : null, metadata:{}}));
    }
  }
  const writeDoc = async (col, id, data, mode) => {
    let res;
    if (mode === "add" && col === "activity") res = await sb.from("docs").insert({collection:col, id, data});
    else if (mode === "merge") res = await sb.rpc("hq_doc_merge", {p_collection:col, p_id:id, p_patch:data});
    else res = await sb.rpc("hq_doc_set", {p_collection:col, p_id:id, p_data:data});
    if (res.error) throw err(res.error);
    const m = cache.get(col);
    if (m) { m.set(id, mode === "merge" ? Object.assign({}, m.get(id) || {}, data) : (col === "activity" ? Object.assign({}, data, {by:me && me.id, at:new Date().toISOString()}) : data)); emit(col); }
  };
  const deleteDoc = async (col, id) => {
    const {data, error} = await sb.from("docs").delete().eq("collection", col).eq("id", id).select("id");
    if (error) throw err(error);
    if (!data || !data.length) { const e = new Error("Not allowed for your role"); e.code = "permission_denied"; throw e; }
    const m = cache.get(col); if (m) { m.delete(id); emit(col); }
  };
  function subscribe(col, fn, onErr){
    ensureChannel();
    let live = true;
    load(col).then(() => { if (!live) return; const set = listeners.get(col) || new Set(); set.add(fn); listeners.set(col, set); fn(snapOf(col)); }).catch(e => onErr && onErr(e));
    return () => { live = false; const set = listeners.get(col); if (set) set.delete(fn); };
  }
  function docRef(col, id){
    id = id || uid();
    return {id, set:d => writeDoc(col, id, d, "set"), update:d => writeDoc(col, id, d, "merge"), delete:() => deleteDoc(col, id),
      onSnapshot:(next, onErr) => subscribe(col, snap => { const d = snap.docs.find(x => x.id === id); next({id, exists:!!d, data:() => d ? d.data() : undefined, metadata:{}}); }, onErr)};
  }
  function colRef(col){
    let order = null, lim = null;
    const ref = {
      orderBy(f, dir){ order = [f, dir || "asc"]; return ref; }, limit(n){ lim = n; return ref; },
      doc:id => docRef(col, id),
      add:async d => { const id = uid(); await writeDoc(col, id, d, "add"); return {id}; },
      onSnapshot:(next, onErr) => {
        if (col === "members") { memListeners.add(next); refreshMembers(); ensureChannel(); return () => memListeners.delete(next); }
        return subscribe(col, snap => {
          let docs = snap.docs;
          if (order) { const [f, dir] = order; docs = docs.slice().sort((a, b) => { const x = a.data()[f], y = b.data()[f]; return (x < y ? -1 : x > y ? 1 : 0) * (dir === "desc" ? -1 : 1); }); }
          if (lim) docs = docs.slice(0, lim);
          next({...snap, docs, size:docs.length, empty:!docs.length});
        }, onErr);
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
        return {id, onSnapshot:next => { myMemListeners.add(next); refreshMembers(); ensureChannel(); return () => myMemListeners.delete(next); },
          set:async d => { const {error} = await sb.rpc("hq_member_set", {p_user_id:byEmail ? null : key, p_email:byEmail ? key : null, p_role:d.role, p_companies:d.companies, p_since:d.since || null}); if (error) throw err(error); refreshMembers(); },
          update:async d => { const {error} = await where(sb.from("members").update({role:d.role, companies:d.companies})); if (error) throw err(error); refreshMembers(); },
          delete:async () => { const {data, error} = await where(sb.from("members").delete()).select("email"); if (error) throw err(error); if (!data || !data.length) { const e = new Error("Only the owner can change access"); e.code = "permission_denied"; throw e; } refreshMembers(); }};
      }
      return docRef(col, id);
    }
  };

  /* ---------- user ---------- */
  const clean = s => String(s || "").replace(/[%,()"\\*:]/g, "").trim().slice(0, 80);
  const userNS = {
    me: async () => { await ready; return me ? {id:me.id, name:me.name, avatarUrl:me.avatarUrl, isOwner:me.isOwner, guest:false} : {id:null, name:"", avatarUrl:"", isOwner:false}; },
    id: async () => { await ready; return me && me.id; },
    isOwner: async () => { await ready; return !!(me && me.isOwner); },
    canEdit: async () => { await ready; return !!me; },
    can: async what => { await ready; if (what === "data.write") return !!me; return null; },
    profiles: async ids => {
      const out = {}; const all = [...new Set([].concat(ids).filter(Boolean))];
      all.filter(i => String(i).startsWith("email:")).forEach(i => out[i] = {id:i, name:i.slice(6) + " (not signed in yet)", avatarUrl:"", guest:false});
      const list = all.filter(i => /^[0-9a-f-]{36}$/i.test(String(i))); if (!list.length) return out;
      const {data} = await sb.from("profiles").select("id,name,email,avatar_url").in("id", list);
      (data || []).forEach(p => out[p.id] = {id:p.id, name:p.name || p.email || "", avatarUrl:p.avatar_url || "", guest:false});
      return out;
    },
    search: async q => {
      const raw = String(q || "").trim().toLowerCase(), s = clean(raw);
      let qq = sb.from("profiles").select("id,name,email,avatar_url").limit(12);
      if (s) qq = qq.or(`name.ilike."%${s}%",email.ilike."%${s}%"`);
      const {data} = await qq;
      const hits = (data || []).map(p => ({id:p.id, name:(p.name || "") + (p.email ? " · " + p.email : ""), avatarUrl:p.avatar_url || "", guest:false}));
      if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw) && raw.length <= 254 && !hits.some(h => h.name.toLowerCase().includes(raw))) hits.push({id:"email:" + raw, name:raw + " · invite by email (they sign up, then get this role)", avatarUrl:"", guest:false});
      return hits;
    }
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
      const j = await res.json(); const text = String(j.text || "");
      if (opts.onText) opts.onText({text, delta:text});
      return {text, truncated:!!j.truncated};
    };
    fn.json = async (input, opts) => { const r = await fn(input, opts); try { return JSON.parse(r.text); } catch(e) { return null; } };
    fn.limits = async () => ({images:false});
    return fn;
  }
  const downloadsNS = {save: async ({filename, data}) => {
    const blob = data instanceof Blob ? data : new Blob([data], {type:"text/csv;charset=utf-8"});
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = String(filename || "download").replace(/[\\/:*?"<>|]/g, "_");
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); return {status:"saved"};
  }};

  window.claude = {use: async name => { await ready; if (!session) return null; if (name === "db") return dbNS; if (name === "user") return userNS; if (name === "sample") return makeSample(); if (name === "downloads") return downloadsNS; return null; }};
})();
