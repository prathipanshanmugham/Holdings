// Prathipan Holdings HQ · MCP connector
// Exposes the group ERP to Claude, n8n and other agents as business tools.
// Signs in to Supabase as a member account and reads/writes only through the database's own rules
// (hq_read / hq_doc_set / hq_doc_merge), so roles, company scope, field guards and the audit trail all apply.
import http from "node:http";
import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

const env = (k, d) => process.env[k] ?? d;
const SUPABASE_URL = env("SUPABASE_URL"), SUPABASE_KEY = env("SUPABASE_KEY");
const AGENT_EMAIL = env("AGENT_EMAIL"), AGENT_PASSWORD = env("AGENT_PASSWORD");
const TOKEN = env("HQ_MCP_TOKEN"), PORT = Number(env("PORT", 8787));
const WRITES = !/^(off|false|0|no)$/i.test(env("HQ_MCP_WRITES", "on"));
const HOSTS = env("HQ_MCP_ALLOWED_HOSTS", "mcp.prathipanholdings.cloud,127.0.0.1:" + PORT + ",localhost:" + PORT).split(",").map(s => s.trim()).filter(Boolean);
const MAX_SESSIONS = 50, SESSION_IDLE_MS = 30 * 60000;
for (const [k, v] of Object.entries({SUPABASE_URL, SUPABASE_KEY, AGENT_EMAIL, AGENT_PASSWORD, HQ_MCP_TOKEN:TOKEN})) if (!v) { console.error(`Missing ${k} in environment`); process.exit(1); }
if (String(TOKEN).length < 32) { console.error("HQ_MCP_TOKEN must be at least 32 characters"); process.exit(1); }
if (/^sb_secret_|service_role/.test(SUPABASE_KEY)) { console.error("Use the publishable key, never a secret/service key"); process.exit(1); }

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {auth:{persistSession:false, autoRefreshToken:true}});
let agentId = null;
async function signIn(){
  const {data, error} = await sb.auth.signInWithPassword({email:AGENT_EMAIL, password:AGENT_PASSWORD});
  if (error) throw new Error("Agent sign-in failed: " + error.message);
  agentId = data.user.id;
  try { await sb.rpc("hq_claim_membership"); } catch (e) {}
  try { await sb.from("profiles").upsert({id:agentId, name:"HQ Agent"}, {onConflict:"id"}); } catch (e) {}
}
async function ensureSession(){ const {data} = await sb.auth.getSession(); if (!data.session) await signIn(); }

/* ---------- vocabulary (must match the ERP) ---------- */
const MONTHS = ["Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar"];
const BLINES = ["opex","capex","marketing","people"];
const VERTICALS = ["Energy","Consumer","Digital","Trade","Infra","Services"];
const CSTATUS = ["Operating","Scaling","Early stage","Turnaround","Dormant"];
const LSTAGES = ["Open","Under review","Replied","In proceedings","Closed"];
const COMP_STATUS = ["Open","In progress","Filed"];
const ALLOC_STATUS = ["Requested","Approved","Disbursed","Rejected"];
const AKIND = ["Growth capital","Working capital","Capex","Marketing","Inter-corporate loan"];
const LTYPES = ["GST notice","Income tax notice","Legal notice (civil)","Cheque bounce (Sec 138 NI Act)","Consumer complaint","Court summons or suit","Trademark examination report","Trademark opposition","Labour, PF or ESI notice","Regulatory or licensing","Other"];

/* ---------- helpers ---------- */
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const sum = (a, f, t) => { let s = 0; for (let i = Math.max(0, f); i < t; i++) s += num(a && a[i]); return s; };
const inr = v => { if (v == null) return "—"; const a = Math.abs(v), s = v < 0 ? "-" : ""; if (a >= 1e7) return s + "₹" + (a / 1e7).toFixed(2) + " Cr"; if (a >= 1e5) return s + "₹" + (a / 1e5).toFixed(2) + " L"; return s + "₹" + Math.round(a).toLocaleString("en-IN"); };
const pct = v => v == null ? "—" : Math.round(v * 100) + "%";
const relation = s => s > 50 ? "Subsidiary" : s === 50 ? "Joint venture" : s >= 20 ? "Associate" : "Minority stake";
const today = () => new Date().toISOString().slice(0, 10);
const newId = () => crypto.randomBytes(10).toString("hex");
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const TXT = (n = 300) => z.string().trim().max(n);
const AMOUNT = z.number().finite().min(0).max(1e13);
const MONEY = z.number().finite().min(-1e13).max(1e13);
const friendlyErr = e => { const m = String(e && e.message || e); return /42501|permission|not allowed|row-level|cannot change|can only/i.test(m) ? "Not allowed for the connector's role: " + m.replace(/^.*?:\s*/, "") : m; };

async function col(c){ await ensureSession(); const {data, error} = await sb.rpc("hq_read", {p_collection:c}); if (error) throw new Error(error.message); return (data || []).map(r => ({id:r.id, ...r.data})); }
async function doc(c, id){ return (await col(c)).find(x => x.id === id) || null; }
async function merge(c, id, patch){ await ensureSession(); const {error} = await sb.rpc("hq_doc_merge", {p_collection:c, p_id:id, p_patch:patch}); if (error) throw new Error(friendlyErr(error)); }
async function put(c, id, data){ await ensureSession(); const {error} = await sb.rpc("hq_doc_set", {p_collection:c, p_id:id, p_data:data}); if (error) throw new Error(friendlyErr(error)); }
async function log(text, co, about){ try { await ensureSession(); await sb.from("docs").insert({collection:"activity", id:newId(), data:{text:("via connector · " + text).slice(0, 300), co:co || null, about:about || null}}); } catch (e) {} }

async function meta(){ const m = await doc("meta", "group"); return Object.assign({name:"Prathipan Holdings", fyLabel:"FY", closedMonths:6, capitalPool:0}, m || {}); }
const monthsClosed = md => Math.min(12, Math.max(1, Math.round(num(md.closedMonths)) || 6));
// Exact id or exact name always wins. Partial matches are allowed for reads only, and only when unique.
async function findCompany(ref, {exact = false} = {}){
  const cos = await col("companies"); const q = String(ref || "").trim().toLowerCase();
  if (!q) throw new Error("Name a company");
  const hit = cos.find(c => c.id.toLowerCase() === q) || cos.find(c => String(c.name || "").toLowerCase() === q);
  if (hit) return hit;
  const part = cos.filter(c => String(c.name || "").toLowerCase().includes(q));
  if (part.length === 1 && !exact) return part[0];
  if (part.length) throw new Error(`"${ref}" matches ${part.length > 1 ? "several companies" : "a company only partly"}: ${part.map(c => `${c.name} (id ${c.id})`).join(", ")}. Use the exact name or id.`);
  throw new Error(`No company matches "${ref}". Use list_companies to see names and ids.`);
}
function metrics(c, n){
  const rev = sum(c.rev, 0, n), exp = sum(c.exp, 0, n), ebitda = rev - exp, ann = 12 / n;
  const tgt = num(c.revTarget) * n / 12, da = num(c.da), fin = num(c.finCost), tax = num(c.tax), ebit = ebitda - da, pat = ebit - fin - tax;
  const cash = num(c.cash), debt = num(c.debt), equity = num(c.equity), netDebt = debt - cash;
  const bud = BLINES.reduce((s, k) => s + num(c.budget && c.budget[k]), 0), spent = BLINES.reduce((s, k) => s + num(c.spent && c.spent[k]), 0);
  const burn = ebitda < 0 ? -ebitda / n : 0;
  return {hasBooks:(c.rev || []).slice(0, n).some(v => v != null), rev, exp, ebitda, margin:rev ? ebitda / rev : null, revTargetYTD:tgt, pace:tgt ? rev / tgt : null, ebit, pat, cash, debt, equity, netDebt,
    netDebtToEBITDA:ebitda > 0 ? netDebt / (ebitda * ann) : null, interestCover:fin > 0 ? ebitda / fin : null, debtToEquity:equity > 0 ? debt / equity : null,
    dso:rev > 0 ? num(c.receivables) / rev * (n * 365 / 12) : null, runwayMonths:burn > 0 ? cash / burn : null, budget:bud, spent, budgetUtilisation:bud ? spent / bud : null,
    headcount:num(c.headcount), stake:num(c.stake), relation:relation(num(c.stake)), valuation:num(c.valuation)};
}
function scorecard(c, n){
  const kp = [{name:"Revenue vs target", t:num(c.revTarget) * n / 12, a:sum(c.rev, 0, n), w:num(c.revWeight ?? 40), dir:"up"}]
    .concat((c.kpis || []).map(k => ({name:k.name, t:num(k.t), a:(k.a === "" || k.a == null) ? null : num(k.a), w:num(k.w), dir:k.dir || "up"})));
  let sw = 0, s = 0;
  const rows = kp.map(k => { let att = null; if (k.t && k.a != null) { const r = k.dir === "down" ? (k.a > 0 ? k.t / k.a : 1.2) : k.a / k.t; att = Math.min(1.2, Math.max(0, r)); } if (att != null && k.w > 0) { sw += k.w; s += k.w * att; } return {kpi:k.name, target:k.t, actual:k.a, weight:k.w, attainment:att == null ? null : Math.round(att * 100) + "%"}; });
  const score = sw ? Math.round(s / sw * 100) : null;
  return {score, band:score == null ? "Not scored" : score >= 100 ? "Exceeds plan" : score >= 85 ? "On track" : score >= 70 ? "Needs attention" : "Off plan", kpis:rows};
}
const companyLine = (c, m, n) => ({id:c.id, name:c.name, vertical:c.vertical, status:c.status, ceo:c.ceo || null, stake:m.stake + "%", relation:m.relation, booksRecorded:m.hasBooks,
  [`revenue_${n}m`]:inr(m.rev), ebitda:inr(m.ebitda), margin:pct(m.margin), revenueVsTarget:pct(m.pace), cash:inr(m.cash), debt:inr(m.debt),
  netDebtToEBITDA:m.netDebtToEBITDA == null ? "—" : m.netDebtToEBITDA.toFixed(1) + "x", budgetUsed:pct(m.budgetUtilisation), headcount:m.headcount});
const out = o => ({content:[{type:"text", text:typeof o === "string" ? o : JSON.stringify(o, null, 2)}]});
const fail = e => ({content:[{type:"text", text:"Error: " + friendlyErr(e)}], isError:true});
const nameOf = cos => id => (cos.find(x => x.id === id) || {}).name || (id === "group" ? "Group (parent)" : id || "Group (parent)");

/* ---------- tools ---------- */
const READ = {readOnlyHint:true, openWorldHint:false};
const ADD = {readOnlyHint:false, destructiveHint:false, idempotentHint:false, openWorldHint:false};
const OVERWRITE = {readOnlyHint:false, destructiveHint:true, idempotentHint:true, openWorldHint:false};
function build(){
  const s = new McpServer({name:"Prathipan Holdings HQ", version:"1.1.0"}, {instructions:"Group ERP of Prathipan Holdings (parent of Umbrella Fashion Co., Sensoper Controls, Triagon Ventures, Dotindot, Clelia & Co, Minyfin, Gearshark, Chinnu Consumer Goods, Sellandiamman Trading and others). Financial year runs April→March; months are Apr..Mar. Money is INR. Read tools are safe. Write tools change the live ledger, are recorded in the audit trail, and must be confirmed with the person first. Use exact company names or ids for writes."});
  const wrap = fn => async a => { try { return out(await fn(a || {})); } catch (e) { return fail(e); } };
  const tool = (name, def, fn) => s.registerTool(name, def, wrap(fn));

  tool("group_snapshot", {title:"Group snapshot", description:"Consolidated view of the holding: revenue, EBITDA, cash, debt, capital pool, and each company's headline numbers for the closed months of the FY.", inputSchema:{}, annotations:READ}, async () => {
    const md = await meta(), n = monthsClosed(md); const cos = await col("companies");
    const rows = cos.map(c => ({c, m:metrics(c, n)})); const cons = rows.filter(r => r.m.stake > 50);
    const t = k => cons.reduce((a, r) => a + r.m[k], 0);
    return {group:md.name, fy:md.fyLabel, closedMonths:n, through:MONTHS[n - 1],
      consolidated:{basis:"subsidiaries (>50% stake) fully consolidated", companies:cons.length, revenue:inr(t("rev")), ebitda:inr(t("ebitda")), cash:inr(t("cash")), debt:inr(t("debt")), netDebt:inr(t("debt") - t("cash"))},
      parent:{capitalPool:inr(num(md.capitalPool)), holdingCash:md.holdingCash == null ? "not visible to this role" : inr(num(md.holdingCash))}, companies:rows.map(r => companyLine(r.c, r.m, n))};
  });
  tool("list_companies", {title:"List companies", description:"All portfolio companies with id, name, vertical, stake, status and CEO. Use the id or exact name in other tools.", inputSchema:{vertical:z.enum(VERTICALS).optional()}, annotations:READ}, async ({vertical}) => {
    const cos = await col("companies");
    return cos.filter(c => !vertical || c.vertical === vertical).map(c => ({id:c.id, name:c.name, vertical:c.vertical, entity:c.entity, status:c.status, stake:num(c.stake) + "%", relation:relation(num(c.stake)), ceo:c.ceo || null}));
  });
  tool("company_metrics", {title:"Company metrics", description:"Full financial picture of one company: monthly revenue/expense, EBITDA, PAT, balance sheet, ratios, budget vs spend, CEO scorecard, brands, open legal notices and compliance.", inputSchema:{company:TXT(120).describe("Company id or name")}, annotations:READ}, async ({company}) => {
    const c = await findCompany(company); const md = await meta(), n = monthsClosed(md); const m = metrics(c, n);
    const [legal, comp, brands] = await Promise.all([col("legal"), col("compliance"), col("brands")]);
    return {id:c.id, name:c.name, vertical:c.vertical, entity:c.entity, status:c.status, ceo:c.ceo, ceoSince:c.ceoSince, stake:m.stake, relation:m.relation, valuation:inr(m.valuation), headcount:m.headcount,
      monthly:MONTHS.map((mo, i) => ({month:mo, revenue:c.rev ? c.rev[i] ?? null : null, expense:c.exp ? c.exp[i] ?? null : null, closed:i < n})),
      period:{months:n, revenue:inr(m.rev), expense:inr(m.exp), ebitda:inr(m.ebitda), margin:pct(m.margin), ebit:inr(m.ebit), pat:inr(m.pat), revenueTargetYTD:inr(m.revTargetYTD), revenueVsTarget:pct(m.pace)},
      balance:{cash:inr(m.cash), receivables:inr(num(c.receivables)), payables:inr(num(c.payables)), inventory:inr(num(c.inventory)), debt:inr(m.debt), equity:inr(m.equity), netDebt:inr(m.netDebt)},
      ratios:{netDebtToEBITDA:m.netDebtToEBITDA, interestCover:m.interestCover, debtToEquity:m.debtToEquity, dsoDays:m.dso && Math.round(m.dso), runwayMonths:m.runwayMonths && +m.runwayMonths.toFixed(1)},
      budget:{lines:Object.fromEntries(BLINES.map(k => [k, {budget:num(c.budget && c.budget[k]), spent:num(c.spent && c.spent[k])}])), total:inr(m.budget), spent:inr(m.spent), utilisation:pct(m.budgetUtilisation)},
      ceoScorecard:scorecard(c, n),
      brands:brands.filter(b => b.company === c.id).map(b => ({id:b.id, name:b.name, status:b.status, revenue:inr(sum(b.rev, 0, n)), revenueVsTarget:pct(num(b.revTarget) ? sum(b.rev, 0, n) / (num(b.revTarget) * n / 12) : null)})),
      openLegalNotices:legal.filter(l => l.company === c.id && l.status !== "Closed").map(l => ({id:l.id, title:l.title, type:l.type, stage:l.status, due:l.due, risk:l.risk, amount:l.amount})),
      openCompliance:comp.filter(x => x.company === c.id && x.status !== "Filed").map(x => ({id:x.id, title:x.title, category:x.cat, due:x.due, status:x.status}))};
  });
  tool("ceo_scorecards", {title:"CEO scorecards", description:"Weighted KPI attainment score (0–120) for every company's CEO, best to worst.", inputSchema:{}, annotations:READ}, async () => {
    const md = await meta(), n = monthsClosed(md); const cos = await col("companies");
    return cos.map(c => ({company:c.name, id:c.id, ceo:c.ceo || null, ...scorecard(c, n)})).sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  });
  tool("brand_performance", {title:"Brand performance", description:"Brand-wise revenue, marketing spend, leads and customers for the closed months; optionally for one company.", inputSchema:{company:TXT(120).optional()}, annotations:READ}, async ({company}) => {
    const md = await meta(), n = monthsClosed(md); const [brands, cos] = await Promise.all([col("brands"), col("companies")]);
    const c = company ? await findCompany(company) : null; const name = nameOf(cos);
    return brands.filter(b => !c || b.company === c.id).map(b => { const rev = sum(b.rev, 0, n), mk = sum(b.mktSpend, 0, n), leads = sum(b.leads, 0, n), cust = sum(b.customers, 0, n);
      return {id:b.id, brand:b.name, company:name(b.company), category:b.category, status:b.status, lead:b.lead || null, revenue:inr(rev), revenueVsTarget:pct(num(b.revTarget) ? rev / (num(b.revTarget) * n / 12) : null),
        marketingSpend:inr(mk), leads, customers:cust, costPerLead:leads ? inr(mk / leads) : "—", marketingPctOfRevenue:pct(rev ? mk / rev : null)}; });
  });
  tool("legal_notices", {title:"Legal notices", description:"Legal notices being tracked: stage, reply due date, hearings, risk, amount, latest update. Default: open ones only.", inputSchema:{includeClosed:z.boolean().optional(), company:TXT(120).optional()}, annotations:READ}, async ({includeClosed, company}) => {
    const [legal, cos] = await Promise.all([col("legal"), col("companies")]); const c = company ? await findCompany(company) : null; const name = nameOf(cos); const t = today();
    return legal.filter(l => (includeClosed || l.status !== "Closed") && (!c || l.company === c.id)).sort((a, b) => String(a.due || "9").localeCompare(String(b.due || "9")))
      .map(l => ({id:l.id, title:l.title, company:name(l.company), type:l.type, direction:l.direction, stage:l.status, received:l.date, replyDue:l.due || null, overdue:!!(l.due && l.due < t && !["Replied", "Closed"].includes(l.status)),
        hearing:l.hearing || null, risk:l.risk, amount:l.amount ? inr(l.amount) : null, counsel:l.counsel, owner:l.owner, party:l.party, forum:l.forum, latestUpdate:(l.log || []).slice(-1)[0] || null}));
  });
  tool("compliance_calendar", {title:"Compliance calendar", description:"Statutory filings and payments (GST, TDS, ROC, PF…) with due dates and status. Status values: Open, In progress, Filed.", inputSchema:{status:z.enum(["Pending", "Filed", "All"]).optional().describe("Pending = Open or In progress (default)")}, annotations:READ}, async ({status}) => {
    const [comp, cos] = await Promise.all([col("compliance"), col("companies")]); const name = nameOf(cos); const t = today(); const want = status || "Pending";
    return comp.filter(x => want === "All" || (want === "Filed") === (x.status === "Filed")).sort((a, b) => String(a.due).localeCompare(String(b.due)))
      .map(x => ({id:x.id, title:x.title, category:x.cat, company:name(x.company), due:x.due, status:x.status, overdue:x.status !== "Filed" && String(x.due) < t}));
  });
  tool("capital_and_holdings", {title:"Capital, allocations and holdings", description:"Capital pool, fund allocations to companies, treasury investments, parent shareholders and intercompany balances (what the connector's role may see).", inputSchema:{}, annotations:READ}, async () => {
    const [md, al, inv, sh, ic, cos] = await Promise.all([meta(), col("allocations"), col("investments"), col("shareholders"), col("intercompany"), col("companies")]); const name = nameOf(cos);
    const disbursed = al.filter(a => a.status === "Disbursed").reduce((a, x) => a + num(x.amount), 0);
    return {capitalPool:inr(num(md.capitalPool)), disbursed:inr(disbursed), available:inr(num(md.capitalPool) - disbursed),
      allocations:al.map(a => ({id:a.id, company:name(a.company), amount:inr(a.amount), kind:a.kind, purpose:a.purpose, date:a.date, status:a.status})),
      investments:inv.map(i => ({id:i.id, name:i.name, class:i.cls, invested:inr(num(i.invested)), value:inr(num(i.value)), since:i.since})),
      shareholders:sh.map(x => ({name:x.name, role:x.role, shares:x.shares, faceValue:x.faceValue})),
      intercompany:ic.map(x => ({id:x.id, from:name(x.from), to:name(x.to), amount:inr(x.amount), kind:x.kind, status:x.status, note:x.note}))};
  });
  tool("alerts", {title:"Alerts", description:"What needs attention now: overdue legal replies and compliance, companies behind target, negative EBITDA, leverage, short runway, overspent budgets.", inputSchema:{}, annotations:READ}, async () => {
    const md = await meta(), n = monthsClosed(md); const [cos, legal, comp] = await Promise.all([col("companies"), col("legal"), col("compliance")]); const t = today(); const name = nameOf(cos); const res = [];
    cos.forEach(c => { const m = metrics(c, n); if (!m.hasBooks) return;
      if (m.pace != null && m.pace < .85) res.push({sev:m.pace < .7 ? "critical" : "warning", company:c.name, text:"Revenue at " + pct(m.pace) + " of target"});
      if (m.ebitda < 0) res.push({sev:c.status === "Early stage" ? "warning" : "serious", company:c.name, text:"EBITDA " + inr(m.ebitda) + " for the period"});
      if (m.debt > 0 && m.ebitda <= 0) res.push({sev:"serious", company:c.name, text:"Borrowings of " + inr(m.debt) + " with negative EBITDA"});
      else if (m.netDebtToEBITDA != null && m.netDebtToEBITDA > 2.5) res.push({sev:m.netDebtToEBITDA > 3.5 ? "serious" : "warning", company:c.name, text:"Net debt " + m.netDebtToEBITDA.toFixed(1) + "x EBITDA"});
      if (m.runwayMonths != null && m.runwayMonths < 12) res.push({sev:m.runwayMonths < 6 ? "serious" : "warning", company:c.name, text:"Cash runway ~" + m.runwayMonths.toFixed(1) + " months"});
      if (m.budgetUtilisation != null && m.budgetUtilisation > n / 12 + .1) res.push({sev:m.budgetUtilisation > n / 12 + .25 ? "serious" : "warning", company:c.name, text:pct(m.budgetUtilisation) + " of FY budget spent by " + MONTHS[n - 1]}); });
    legal.filter(l => !["Replied", "Closed"].includes(l.status) && l.due && l.due < t).forEach(l => res.push({sev:"critical", company:name(l.company), text:"Legal reply overdue since " + l.due + ": " + l.title}));
    comp.filter(x => x.status !== "Filed" && String(x.due) < t).forEach(x => res.push({sev:"serious", company:name(x.company), text:"Compliance overdue since " + x.due + ": " + x.title}));
    const order = ["critical", "serious", "warning"]; return res.sort((a, b) => order.indexOf(a.sev) - order.indexOf(b.sev));
  });
  tool("activity_log", {title:"Activity log", description:"Recent changes made in HQ (what was done, when, for which company).", inputSchema:{limit:z.number().int().min(1).max(200).optional()}, annotations:READ}, async ({limit}) => {
    const [a, cos] = await Promise.all([col("activity"), col("companies")]); const name = nameOf(cos);
    return a.sort((x, y) => String(y.at).localeCompare(String(x.at))).slice(0, limit || 40).map(x => ({at:x.at, text:x.text, company:x.co ? name(x.co) : null}));
  });

  if (!WRITES) return s;
  /* ---- write tools: exact names only, validated, logged ---- */
  tool("record_month", {title:"Record monthly books", description:"Write one month's revenue and/or expense for a company (INR, absolute amounts). Overwrites that month. Confirm with the person first.", inputSchema:{company:TXT(120).describe("Exact company name or id"), month:z.enum(MONTHS), revenue:AMOUNT.optional(), expense:AMOUNT.optional()}, annotations:OVERWRITE}, async ({company, month, revenue, expense}) => {
    if (revenue == null && expense == null) throw new Error("Give revenue and/or expense");
    const c = await findCompany(company, {exact:true}); const i = MONTHS.indexOf(month);
    const rev = Array.from({length:12}, (_, k) => (c.rev || [])[k] ?? null), exp = Array.from({length:12}, (_, k) => (c.exp || [])[k] ?? null);
    if (revenue != null) rev[i] = revenue; if (expense != null) exp[i] = expense;
    await merge("companies", c.id, {rev, exp}); await log(`Recorded ${month} books for ${c.name}: revenue ${inr(rev[i])}, expense ${inr(exp[i])}`, c.id);
    return {ok:true, company:c.name, month, revenue:rev[i], expense:exp[i]};
  });
  const CO_FIELDS = {cash:MONEY, debt:AMOUNT, equity:MONEY, receivables:AMOUNT, payables:AMOUNT, inventory:AMOUNT, headcount:z.number().int().min(0).max(1e6), valuation:AMOUNT, revTarget:AMOUNT,
    da:AMOUNT, finCost:AMOUNT, tax:MONEY, ceo:TXT(120), ceoSince:TXT(40), status:z.enum(CSTATUS), vertical:z.enum(VERTICALS)};
  tool("update_company", {title:"Update company fields", description:"Set balance-sheet or profile fields of a company. Allowed: " + Object.keys(CO_FIELDS).join(", ") + ". Overwrites those values. Confirm with the person first.", inputSchema:{company:TXT(120).describe("Exact company name or id"), fields:z.object(Object.fromEntries(Object.entries(CO_FIELDS).map(([k, v]) => [k, v.optional()]))).strict()}, annotations:OVERWRITE}, async ({company, fields}) => {
    const c = await findCompany(company, {exact:true}); const patch = Object.fromEntries(Object.entries(fields || {}).filter(([, v]) => v !== undefined));
    if (!Object.keys(patch).length) throw new Error("Nothing to update");
    await merge("companies", c.id, patch); await log(`Updated ${c.name}: ` + Object.entries(patch).map(([k, v]) => `${k}=${typeof v === "number" && k !== "headcount" ? inr(v) : v}`).join(", "), c.id);
    return {ok:true, company:c.name, updated:patch};
  });
  tool("set_budget", {title:"Set budget or spend", description:"Set the FY budget and/or amount spent so far for one budget line of a company. Confirm with the person first.", inputSchema:{company:TXT(120).describe("Exact company name or id"), line:z.enum(BLINES), budget:AMOUNT.optional(), spent:AMOUNT.optional()}, annotations:OVERWRITE}, async ({company, line, budget, spent}) => {
    if (budget == null && spent == null) throw new Error("Give budget and/or spent");
    const c = await findCompany(company, {exact:true}); const patch = {};
    if (budget != null) patch.budget = {...(c.budget || {}), [line]:budget}; if (spent != null) patch.spent = {...(c.spent || {}), [line]:spent};
    await merge("companies", c.id, patch); await log(`Budget line ${line} for ${c.name}: ` + [budget != null ? "budget " + inr(budget) : "", spent != null ? "spent " + inr(spent) : ""].filter(Boolean).join(", "), c.id);
    return {ok:true, company:c.name, line, budget:(patch.budget || c.budget || {})[line] ?? null, spent:(patch.spent || c.spent || {})[line] ?? null};
  });
  tool("add_legal_notice", {title:"Log a legal notice", description:"Create a legal notice to track. Confirm with the person first.", inputSchema:{title:TXT(200).min(3), company:TXT(120).describe("Exact company name/id, or 'group' for the parent"), type:z.enum(LTYPES), direction:z.enum(["Received", "Sent"]).optional(), date:DATE.describe("Date received/sent"), replyDue:DATE.optional(), party:TXT(200).optional(), forum:TXT(200).optional(), ref:TXT(120).optional(), amount:AMOUNT.optional(), risk:z.enum(["Low", "Medium", "High"]).optional(), counsel:TXT(200).optional(), owner:TXT(120).optional(), summary:TXT(2000).optional()}, annotations:ADD}, async a => {
    let coId = "group"; if (a.company.toLowerCase() !== "group") coId = (await findCompany(a.company, {exact:true})).id;
    const id = newId(); const d = {title:a.title, company:coId, brand:"", type:a.type, direction:a.direction || "Received", date:a.date, due:a.replyDue || "", hearing:"", party:a.party || "", forum:a.forum || "", ref:a.ref || "",
      amount:a.amount || 0, risk:a.risk || "Medium", status:"Open", counsel:a.counsel || "", owner:a.owner || "", outcome:"", summary:a.summary || "", created:today(), log:a.summary ? [{d:a.date, t:a.summary, by:agentId}] : []};
    await put("legal", id, d); await log(`Logged legal notice: ${a.title}`, coId === "group" ? null : coId, id); return {ok:true, id, ...d};
  });
  tool("update_legal_notice", {title:"Update a legal notice", description:"Move a notice to a new stage, set hearing/reply dates, risk or outcome, and/or add an update to its history. Confirm with the person first.", inputSchema:{id:TXT(64), stage:z.enum(LSTAGES).optional(), hearing:DATE.or(z.literal("")).optional(), replyDue:DATE.or(z.literal("")).optional(), risk:z.enum(["Low", "Medium", "High"]).optional(), outcome:TXT(1000).optional(), note:TXT(2000).optional().describe("Added to the notice's history")}, annotations:ADD}, async a => {
    const l = await doc("legal", a.id); if (!l) throw new Error("No notice with id " + a.id);
    const patch = {}; if (a.stage) { patch.status = a.stage; if (a.stage === "Closed") patch.closedOn = today(); }
    if (a.hearing !== undefined) patch.hearing = a.hearing; if (a.replyDue !== undefined) patch.due = a.replyDue; if (a.risk) patch.risk = a.risk; if (a.outcome !== undefined) patch.outcome = a.outcome;
    if (a.note) patch.log = [...(Array.isArray(l.log) ? l.log : []), {d:today(), t:a.note, by:agentId}];
    if (!Object.keys(patch).length) throw new Error("Nothing to update");
    await merge("legal", a.id, patch); await log(`Notice "${l.title}": ` + (a.stage ? "moved to " + a.stage + (a.note ? "; " : "") : "") + (a.note || (a.stage ? "" : "updated")), l.company === "group" ? null : l.company, a.id);
    return {ok:true, id:a.id, title:l.title, ...patch};
  });
  tool("set_compliance_status", {title:"Set compliance status", description:"Mark a compliance item Open, In progress or Filed. Confirm with the person first.", inputSchema:{id:TXT(64), status:z.enum(COMP_STATUS)}, annotations:OVERWRITE}, async ({id, status}) => {
    const x = await doc("compliance", id); if (!x) throw new Error("No compliance item " + id);
    await merge("compliance", id, {status}); await log(`Compliance "${x.title}" → ${status}`, x.company === "group" ? null : x.company, id); return {ok:true, id, title:x.title, status};
  });
  tool("add_allocation", {title:"Request or record a capital allocation", description:"Record a capital allocation from the pool to a company. Kinds: " + AKIND.join(", ") + ". Statuses: " + ALLOC_STATUS.join(", ") + " (non-Admin roles can only create Requested). Confirm with the person first.", inputSchema:{company:TXT(120).describe("Exact company name or id"), amount:AMOUNT.positive(), kind:z.enum(AKIND), purpose:TXT(300).min(3), date:DATE, status:z.enum(ALLOC_STATUS).optional()}, annotations:ADD}, async a => {
    const c = await findCompany(a.company, {exact:true}); const id = newId(); const st = a.status || "Requested";
    const d = {company:c.id, amount:a.amount, kind:a.kind, purpose:a.purpose, date:a.date, status:st, ...(st === "Approved" ? {approvedOn:today()} : st === "Disbursed" ? {disbursedOn:today()} : {})};
    await put("allocations", id, d); await log(`Capital ${st.toLowerCase()}: ${inr(a.amount)} to ${c.name} · ${a.purpose}`, c.id, id); return {ok:true, id, ...d};
  });
  return s;
}

/* ---------- HTTP ---------- */
const sessions = new Map(); // id -> {t, last}
const TOKEN_BUF = Buffer.from(TOKEN);
const sameToken = v => { const b = Buffer.from(String(v || "")); return b.length === TOKEN_BUF.length && crypto.timingSafeEqual(b, TOKEN_BUF); };
function authorize(req, url){
  const h = String(req.headers.authorization || "");
  if (h.startsWith("Bearer ") && sameToken(h.slice(7))) return url.pathname;
  const seg = url.pathname.split("/").filter(Boolean);
  if (seg.length && sameToken(seg[0])) return "/" + seg.slice(1).join("/");
  return null;
}
const readBody = req => new Promise((res, rej) => { let b = "", n = 0; req.on("data", c => { n += c.length; if (n > 1e6) { rej(Object.assign(new Error("Body too large"), {status:413})); req.destroy(); } else b += c; }); req.on("end", () => { try { res(b ? JSON.parse(b) : undefined); } catch (e) { rej(Object.assign(e, {status:400})); } }); });
setInterval(() => { const now = Date.now(); for (const [id, s] of sessions) if (now - s.last > SESSION_IDLE_MS) { try { s.t.close(); } catch (e) {} sessions.delete(id); } }, 60000).unref();

const server = http.createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Cache-Control", "no-store"); res.setHeader("Referrer-Policy", "no-referrer");
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/health" && req.method === "GET") { res.writeHead(200, {"content-type":"application/json"}).end('{"ok":true}'); return; }
  const route = authorize(req, url);
  if (!route) { await new Promise(r => setTimeout(r, 250)); res.writeHead(401, {"content-type":"application/json"}).end('{"error":"unauthorized"}'); return; }
  if (route !== "/mcp") { res.writeHead(404).end(); return; }
  try {
    const sid = req.headers["mcp-session-id"];
    let entry = sid && sessions.get(sid);
    if (sid && !entry) { res.writeHead(404, {"content-type":"application/json"}).end('{"jsonrpc":"2.0","error":{"code":-32001,"message":"Session not found"},"id":null}'); return; }
    if (!entry) {
      if (req.method !== "POST") { res.writeHead(400).end("No session"); return; }
      if (sessions.size >= MAX_SESSIONS) { const oldest = [...sessions.entries()].sort((a, b) => a[1].last - b[1].last)[0]; try { oldest[1].t.close(); } catch (e) {} sessions.delete(oldest[0]); }
      const t = new StreamableHTTPServerTransport({sessionIdGenerator:() => crypto.randomUUID(), enableDnsRebindingProtection:true, allowedHosts:HOSTS,
        onsessioninitialized:id => sessions.set(id, entry = {t, last:Date.now()})});
      t.onclose = () => { if (t.sessionId) sessions.delete(t.sessionId); };
      entry = {t, last:Date.now()};
      await build().connect(t);
    }
    entry.last = Date.now();
    await entry.t.handleRequest(req, res, req.method === "POST" ? await readBody(req) : undefined);
  } catch (e) {
    if (!res.headersSent) res.writeHead(e.status || 500, {"content-type":"application/json"}).end(JSON.stringify({error:e.status ? e.message : "Internal error"}));
    if (!e.status) console.error("[hq-mcp]", e && e.message);
  }
});
server.headersTimeout = 30000; server.requestTimeout = 120000;
server.listen(PORT, "127.0.0.1", async () => {
  try { await signIn(); console.log(`HQ MCP listening on 127.0.0.1:${PORT} (writes ${WRITES ? "on" : "off"})`); }
  catch (e) { console.error(e.message); process.exit(1); }
});
