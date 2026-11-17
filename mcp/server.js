// Prathipan Holdings HQ · MCP connector
// Exposes the group ERP to Claude, n8n and other agents as business tools.
// Signs in to Supabase as a member account, so Admin/Manager/Staff rules and the activity log apply.
import http from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

const env = (k, d) => process.env[k] ?? d;
const SUPABASE_URL = env("SUPABASE_URL"), SUPABASE_KEY = env("SUPABASE_KEY");
const AGENT_EMAIL = env("AGENT_EMAIL"), AGENT_PASSWORD = env("AGENT_PASSWORD");
const TOKEN = env("HQ_MCP_TOKEN"), PORT = Number(env("PORT", 8787));
for (const [k, v] of Object.entries({SUPABASE_URL, SUPABASE_KEY, AGENT_EMAIL, AGENT_PASSWORD, HQ_MCP_TOKEN: TOKEN})) if (!v) { console.error(`Missing ${k} in environment`); process.exit(1); }

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {auth:{persistSession:false, autoRefreshToken:true}});
let agentId = null;
async function signIn(){
  const {data, error} = await sb.auth.signInWithPassword({email:AGENT_EMAIL, password:AGENT_PASSWORD});
  if (error) throw new Error("Agent sign-in failed: " + error.message);
  agentId = data.user.id;
  try { await sb.rpc("hq_claim_membership"); } catch (e) {}
  try { await sb.from("profiles").upsert({id:agentId, name:"HQ Agent", email:AGENT_EMAIL.toLowerCase()}, {onConflict:"id"}); } catch (e) {}
}
async function ensureSession(){ const {data} = await sb.auth.getSession(); if (!data.session) await signIn(); }

/* ---------- data ---------- */
const MONTHS = ["Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar"];
const BLINES = ["opex","capex","marketing","people"];
const LSTAGES = ["Open","Under review","Replied","In proceedings","Closed"];
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const sum = (a, f, t) => { let s = 0; for (let i = Math.max(0, f); i < t; i++) s += num(a && a[i]); return s; };
const inr = v => { if (v == null) return "—"; const a = Math.abs(v), s = v < 0 ? "-" : ""; if (a >= 1e7) return s + "₹" + (a / 1e7).toFixed(2) + " Cr"; if (a >= 1e5) return s + "₹" + (a / 1e5).toFixed(2) + " L"; return s + "₹" + Math.round(a).toLocaleString("en-IN"); };
const pct = v => v == null ? "—" : Math.round(v * 100) + "%";
const relation = s => s > 50 ? "Subsidiary" : s === 50 ? "Joint venture" : s >= 20 ? "Associate" : "Minority stake";
const monthIndex = m => { if (typeof m === "number") return m - 1; const i = MONTHS.findIndex(x => x.toLowerCase() === String(m).slice(0, 3).toLowerCase()); return i; };

async function col(c){ await ensureSession(); const {data, error} = await sb.from("docs").select("id,data").eq("collection", c); if (error) throw new Error(error.message); return (data || []).map(r => ({id:r.id, ...r.data})); }
async function doc(c, id){ await ensureSession(); const {data, error} = await sb.from("docs").select("data").eq("collection", c).eq("id", id).maybeSingle(); if (error) throw new Error(error.message); return data ? {id, ...data.data} : null; }
async function merge(c, id, patch){ await ensureSession(); const {error} = await sb.rpc("hq_doc_merge", {p_collection:c, p_id:id, p_patch:patch}); if (error) throw new Error(error.code === "42501" ? "Not allowed for this agent's role" : error.message); }
async function put(c, id, data){ await ensureSession(); const {error} = await sb.from("docs").upsert({collection:c, id, data, updated_by:agentId, updated_at:new Date().toISOString()}, {onConflict:"collection,id"}); if (error) throw new Error(error.code === "42501" ? "Not allowed for this agent's role" : error.message); }
async function log(text, co, about){ try { await put("activity", randomUUID().replace(/-/g, "").slice(0, 20), {at:new Date().toISOString(), by:agentId, text:("via connector · " + text).slice(0, 300), co:co || null, about:about || null}); } catch(e) {} }
const newId = () => randomUUID().replace(/-/g, "").slice(0, 20);

async function meta(){ const m = await doc("meta", "group"); return Object.assign({name:"Prathipan Holdings", fyLabel:"FY", closedMonths:6, capitalPool:0, holdingCash:0}, m || {}); }
async function findCompany(ref){
  const cos = await col("companies"); const q = String(ref || "").trim().toLowerCase();
  return cos.find(c => c.id === q) || cos.find(c => String(c.name).toLowerCase() === q) || cos.find(c => String(c.name).toLowerCase().includes(q)) || null;
}
function metrics(c, n){
  const rev = sum(c.rev, 0, n), exp = sum(c.exp, 0, n), ebitda = rev - exp, frac = n / 12, ann = 12 / n;
  const tgt = num(c.revTarget) * frac, da = num(c.da), fin = num(c.finCost), tax = num(c.tax), ebit = ebitda - da, pat = ebit - fin - tax;
  const cash = num(c.cash), debt = num(c.debt), equity = num(c.equity), netDebt = debt - cash;
  const bud = BLINES.reduce((s, k) => s + num(c.budget && c.budget[k]), 0), spent = BLINES.reduce((s, k) => s + num(c.spent && c.spent[k]), 0);
  const burn = ebitda < 0 ? -ebitda / n : 0;
  const hasBooks = (c.rev || []).slice(0, n).some(v => v != null);
  return {hasBooks, rev, exp, ebitda, margin:rev ? ebitda / rev : null, revTargetYTD:tgt, pace:tgt ? rev / tgt : null, ebit, pat, cash, debt, equity, netDebt,
    netDebtToEBITDA:ebitda > 0 ? netDebt / (ebitda * ann) : null, interestCover:fin > 0 ? ebitda / fin : null, debtToEquity:equity > 0 ? debt / equity : null,
    dso:rev > 0 ? num(c.receivables) / rev * (n * 365 / 12) : null, runwayMonths:burn > 0 ? cash / burn : null, budget:bud, spent, budgetUtilisation:bud ? spent / bud : null,
    headcount:num(c.headcount), stake:num(c.stake), relation:relation(num(c.stake)), valuation:num(c.valuation)};
}
function scorecard(c, n){
  const rev = sum(c.rev, 0, n), tgt = num(c.revTarget) * n / 12;
  const kp = [{name:"Revenue vs target", t:tgt, a:rev, w:num(c.revWeight ?? 40), dir:"up"}].concat((c.kpis || []).map(k => ({name:k.name, t:num(k.t), a:(k.a === "" || k.a == null) ? null : num(k.a), w:num(k.w), dir:k.dir || "up", unit:k.unit || ""})));
  let sw = 0, s = 0;
  const rows = kp.map(k => { let att = null; if (k.t && k.a != null) { const r = k.dir === "down" ? (k.a > 0 ? k.t / k.a : 1.2) : k.a / k.t; att = Math.min(1.2, Math.max(0, r)); } if (att != null && k.w > 0) { sw += k.w; s += k.w * att; } return {kpi:k.name, target:k.t, actual:k.a, weight:k.w, attainment:att == null ? null : Math.round(att * 100) + "%"}; });
  const score = sw ? Math.round(s / sw * 100) : null;
  return {score, band:score == null ? "Not scored" : score >= 100 ? "Exceeds plan" : score >= 85 ? "On track" : score >= 70 ? "Needs attention" : "Off plan", kpis:rows};
}
const companyLine = (c, m, md) => ({id:c.id, name:c.name, vertical:c.vertical, status:c.status, ceo:c.ceo || null, stake:m.stake + "%", relation:m.relation, booksRecorded:m.hasBooks,
  [`revenue_${md.closedMonths}m`]:inr(m.rev), ebitda:inr(m.ebitda), margin:pct(m.margin), revenueVsTarget:pct(m.pace), cash:inr(m.cash), debt:inr(m.debt), netDebtToEBITDA:m.netDebtToEBITDA == null ? "—" : m.netDebtToEBITDA.toFixed(1) + "x", budgetUsed:pct(m.budgetUtilisation), headcount:m.headcount});
const text = o => ({content:[{type:"text", text:typeof o === "string" ? o : JSON.stringify(o, null, 2)}]});
const fail = e => ({content:[{type:"text", text:"Error: " + (e && e.message || e)}], isError:true});

/* ---------- tools ---------- */
function build(){
  const s = new McpServer({name:"Prathipan Holdings HQ", version:"1.0.0"}, {instructions:"Group ERP of Prathipan Holdings (parent of Umbrella Fashion Co., Sensoper Controls, Triagon Ventures, Dotindot, Clelia & Co, Minyfin, Gearshark, Chinnu Consumer Goods, Sellandiamman Trading and others). Financial year runs April→March; months are Apr..Mar. Money is INR. Read tools are safe; write tools change the live ledger and are logged — confirm with the person before writing."});
  const wrap = fn => async a => { try { return text(await fn(a || {})); } catch (e) { return fail(e); } };

  s.registerTool("group_snapshot", {title:"Group snapshot", description:"Consolidated view of the holding: revenue, EBITDA, cash, debt, pool, and every company's headline numbers for the closed months of the FY.", inputSchema:{}}, wrap(async () => {
    const md = await meta(), n = Math.min(12, Math.max(1, num(md.closedMonths) || 6)); const cos = await col("companies");
    const rows = cos.map(c => ({c, m:metrics(c, n)})); const cons = rows.filter(r => r.m.stake > 50);
    const t = k => cons.reduce((s, r) => s + r.m[k], 0);
    return {group:md.name, fy:md.fyLabel, closedMonths:n, through:MONTHS[n - 1], consolidated:{basis:"subsidiaries >50% fully consolidated", companies:cons.length, revenue:inr(t("rev")), ebitda:inr(t("ebitda")), cash:inr(t("cash")), debt:inr(t("debt")), netDebt:inr(t("debt") - t("cash"))},
      parent:{capitalPool:inr(num(md.capitalPool)), holdingCash:inr(num(md.holdingCash))}, companies:rows.map(r => companyLine(r.c, r.m, md))};
  }));

  s.registerTool("list_companies", {title:"List companies", description:"All portfolio companies with id, name, vertical, stake, status and CEO. Use the id in other tools.", inputSchema:{vertical:z.string().optional().describe("Filter: Energy, Consumer, Digital, Trade, Infra, Services")}}, wrap(async ({vertical}) => {
    const cos = await col("companies"); return cos.filter(c => !vertical || String(c.vertical).toLowerCase() === vertical.toLowerCase()).map(c => ({id:c.id, name:c.name, vertical:c.vertical, entity:c.entity, status:c.status, stake:num(c.stake) + "%", relation:relation(num(c.stake)), ceo:c.ceo || null}));
  }));

  s.registerTool("company_metrics", {title:"Company metrics", description:"Full financial picture of one company: monthly revenue/expense, EBITDA, PAT, balance sheet items, ratios, budget vs spend, CEO scorecard, open notices and compliance.", inputSchema:{company:z.string().describe("Company id or name")}}, wrap(async ({company}) => {
    const c = await findCompany(company); if (!c) throw new Error("No company matches " + company);
    const md = await meta(), n = Math.min(12, Math.max(1, num(md.closedMonths) || 6)); const m = metrics(c, n);
    const [legal, comp, brands] = await Promise.all([col("legal"), col("compliance"), col("brands")]);
    return {id:c.id, name:c.name, vertical:c.vertical, entity:c.entity, status:c.status, ceo:c.ceo, ceoSince:c.ceoSince, stake:m.stake, relation:m.relation, valuation:inr(m.valuation), headcount:m.headcount,
      monthly:MONTHS.map((mo, i) => ({month:mo, revenue:c.rev && c.rev[i], expense:c.exp && c.exp[i], closed:i < n})),
      period:{months:n, revenue:inr(m.rev), expense:inr(m.exp), ebitda:inr(m.ebitda), margin:pct(m.margin), ebit:inr(m.ebit), pat:inr(m.pat), revenueTargetYTD:inr(m.revTargetYTD), revenueVsTarget:pct(m.pace)},
      balance:{cash:inr(m.cash), receivables:inr(num(c.receivables)), payables:inr(num(c.payables)), inventory:inr(num(c.inventory)), debt:inr(m.debt), equity:inr(m.equity), netDebt:inr(m.netDebt)},
      ratios:{netDebtToEBITDA:m.netDebtToEBITDA, interestCover:m.interestCover, debtToEquity:m.debtToEquity, dsoDays:m.dso && Math.round(m.dso), runwayMonths:m.runwayMonths && +m.runwayMonths.toFixed(1)},
      budget:{lines:Object.fromEntries(BLINES.map(k => [k, {budget:num(c.budget && c.budget[k]), spent:num(c.spent && c.spent[k])}])), total:inr(m.budget), spent:inr(m.spent), utilisation:pct(m.budgetUtilisation)},
      ceoScorecard:scorecard(c, n), brands:brands.filter(b => b.company === c.id).map(b => ({id:b.id, name:b.name, status:b.status, revenue:inr(sum(b.rev, 0, n)), revenueVsTarget:pct(num(b.revTarget) ? sum(b.rev, 0, n) / (num(b.revTarget) * n / 12) : null)})),
      openLegalNotices:legal.filter(l => l.company === c.id && l.status !== "Closed").map(l => ({id:l.id, title:l.title, type:l.type, stage:l.status, due:l.due, risk:l.risk, amount:l.amount})),
      compliance:comp.filter(x => x.company === c.id && x.status !== "Done").map(x => ({id:x.id, title:x.title, category:x.cat, due:x.due, status:x.status}))};
  }));

  s.registerTool("ceo_scorecards", {title:"CEO scorecards", description:"Weighted KPI attainment score (0–120) for every company's CEO, best to worst.", inputSchema:{}}, wrap(async () => {
    const md = await meta(), n = Math.min(12, Math.max(1, num(md.closedMonths) || 6)); const cos = await col("companies");
    return cos.map(c => ({company:c.name, id:c.id, ceo:c.ceo || null, ...scorecard(c, n)})).sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  }));

  s.registerTool("brand_performance", {title:"Brand performance", description:"Brand-wise revenue, marketing spend, leads and customers for the closed months; optionally for one company.", inputSchema:{company:z.string().optional()}}, wrap(async ({company}) => {
    const md = await meta(), n = Math.min(12, Math.max(1, num(md.closedMonths) || 6)); const [brands, cos] = await Promise.all([col("brands"), col("companies")]);
    const c = company ? await findCompany(company) : null; const name = id => (cos.find(x => x.id === id) || {}).name || id;
    return brands.filter(b => !c || b.company === c.id).map(b => { const rev = sum(b.rev, 0, n), mk = sum(b.mktSpend, 0, n), leads = sum(b.leads, 0, n), cust = sum(b.customers, 0, n); return {id:b.id, brand:b.name, company:name(b.company), category:b.category, status:b.status, lead:b.lead || null, revenue:inr(rev), revenueVsTarget:pct(num(b.revTarget) ? rev / (num(b.revTarget) * n / 12) : null), marketingSpend:inr(mk), leads, customers:cust, costPerLead:leads ? inr(mk / leads) : "—", marketingPctOfRevenue:pct(rev ? mk / rev : null)}; });
  }));

  s.registerTool("legal_notices", {title:"Legal notices", description:"Legal notices being tracked: stage, due dates, hearings, risk and amount. Default: open ones only.", inputSchema:{includeClosed:z.boolean().optional(), company:z.string().optional()}}, wrap(async ({includeClosed, company}) => {
    const [legal, cos] = await Promise.all([col("legal"), col("companies")]); const c = company ? await findCompany(company) : null; const name = id => (cos.find(x => x.id === id) || {}).name || id || "Group";
    const today = new Date().toISOString().slice(0, 10);
    return legal.filter(l => (includeClosed || l.status !== "Closed") && (!c || l.company === c.id)).sort((a, b) => String(a.due || "9").localeCompare(String(b.due || "9")))
      .map(l => ({id:l.id, title:l.title, company:name(l.company), type:l.type, direction:l.direction, stage:l.status, received:l.date, replyDue:l.due, overdue:!!(l.due && l.due < today && l.status !== "Closed"), hearing:l.hearing || null, risk:l.risk, amount:l.amount ? inr(l.amount) : null, counsel:l.counsel, owner:l.owner, party:l.party, forum:l.forum, lastUpdate:(l.log || []).slice(-1)[0] || null}));
  }));

  s.registerTool("compliance_calendar", {title:"Compliance calendar", description:"Statutory filings and payments (GST, TDS, PF/ESI, ROC, audits…) with due dates and status.", inputSchema:{status:z.enum(["Open","Done","All"]).optional().describe("Default Open")}}, wrap(async ({status}) => {
    const [comp, cos] = await Promise.all([col("compliance"), col("companies")]); const name = id => (cos.find(x => x.id === id) || {}).name || id || "Group"; const today = new Date().toISOString().slice(0, 10);
    return comp.filter(x => (status || "Open") === "All" || (status || "Open") === (x.status === "Done" ? "Done" : "Open")).sort((a, b) => String(a.due).localeCompare(String(b.due))).map(x => ({id:x.id, title:x.title, category:x.cat, company:name(x.company), due:x.due, status:x.status, overdue:x.status !== "Done" && x.due < today}));
  }));

  s.registerTool("capital_and_holdings", {title:"Capital, allocations and holdings", description:"Capital pool, fund allocations to companies, external investments, shareholders of the parent and intercompany balances.", inputSchema:{}}, wrap(async () => {
    const [md, al, inv, sh, ic, cos] = await Promise.all([meta(), col("allocations"), col("investments"), col("shareholders"), col("intercompany"), col("companies")]); const name = id => (cos.find(x => x.id === id) || {}).name || id;
    const disbursed = al.filter(a => a.status === "Disbursed").reduce((s, a) => s + num(a.amount), 0);
    return {capitalPool:inr(num(md.capitalPool)), disbursed:inr(disbursed), available:inr(num(md.capitalPool) - disbursed), allocations:al.map(a => ({id:a.id, company:name(a.company), amount:inr(a.amount), kind:a.kind, purpose:a.purpose, date:a.date, status:a.status})),
      investments:inv.map(i => ({id:i.id, ...i})), shareholders:sh, intercompany:ic.map(x => ({id:x.id, from:name(x.from), to:name(x.to), amount:inr(x.amount), kind:x.kind, note:x.note}))};
  }));

  s.registerTool("alerts", {title:"Alerts", description:"What needs attention now: overdue notices and compliance, companies behind target, negative EBITDA, high leverage, short runway, overspent budgets.", inputSchema:{}}, wrap(async () => {
    const md = await meta(), n = Math.min(12, Math.max(1, num(md.closedMonths) || 6)); const [cos, legal, comp] = await Promise.all([col("companies"), col("legal"), col("compliance")]); const today = new Date().toISOString().slice(0, 10); const out = [];
    cos.forEach(c => { const m = metrics(c, n); if (!m.hasBooks) return; if (m.pace != null && m.pace < .85) out.push({sev:m.pace < .7 ? "critical" : "warning", company:c.name, text:"Revenue at " + pct(m.pace) + " of target"}); if (m.ebitda < 0) out.push({sev:"serious", company:c.name, text:"EBITDA " + inr(m.ebitda) + " for the period"}); if (m.netDebtToEBITDA > 2.5) out.push({sev:m.netDebtToEBITDA > 3.5 ? "serious" : "warning", company:c.name, text:"Net debt " + m.netDebtToEBITDA.toFixed(1) + "x EBITDA"}); if (m.runwayMonths != null && m.runwayMonths < 12) out.push({sev:m.runwayMonths < 6 ? "serious" : "warning", company:c.name, text:"Cash runway ~" + m.runwayMonths.toFixed(1) + " months"}); if (m.budgetUtilisation != null && m.budgetUtilisation > n / 12 + .1) out.push({sev:m.budgetUtilisation > n / 12 + .25 ? "serious" : "warning", company:c.name, text:pct(m.budgetUtilisation) + " of FY budget spent by " + MONTHS[n - 1]}); });
    legal.filter(l => l.status !== "Closed" && l.due && l.due < today).forEach(l => out.push({sev:"critical", company:(cos.find(x => x.id === l.company) || {}).name || "Group", text:"Legal reply overdue since " + l.due + ": " + l.title}));
    comp.filter(x => x.status !== "Done" && x.due < today).forEach(x => out.push({sev:"serious", company:(cos.find(c => c.id === x.company) || {}).name || "Group", text:"Compliance overdue since " + x.due + ": " + x.title}));
    return out.sort((a, b) => ["critical","serious","warning"].indexOf(a.sev) - ["critical","serious","warning"].indexOf(b.sev));
  }));

  s.registerTool("activity_log", {title:"Activity log", description:"Recent changes made in HQ (who did what, when).", inputSchema:{limit:z.number().int().min(1).max(200).optional()}}, wrap(async ({limit}) => {
    const [a, cos] = await Promise.all([col("activity"), col("companies")]); const name = id => (cos.find(x => x.id === id) || {}).name || id;
    return a.sort((x, y) => String(y.at).localeCompare(String(x.at))).slice(0, limit || 40).map(x => ({at:x.at, text:x.text, company:x.co ? name(x.co) : null}));
  }));

  /* ---- write tools ---- */
  s.registerTool("record_month", {title:"Record monthly books", description:"Write a month's revenue and/or expense for a company (INR, absolute amounts). Changes the live ledger.", inputSchema:{company:z.string(), month:z.string().describe("Apr..Mar"), revenue:z.number().optional(), expense:z.number().optional()}}, wrap(async ({company, month, revenue, expense}) => {
    const c = await findCompany(company); if (!c) throw new Error("No company matches " + company); const i = monthIndex(month); if (i < 0) throw new Error("Month must be Apr..Mar");
    const rev = Array.from({length:12}, (_, k) => (c.rev || [])[k] ?? null), exp = Array.from({length:12}, (_, k) => (c.exp || [])[k] ?? null);
    if (revenue != null) rev[i] = revenue; if (expense != null) exp[i] = expense;
    await merge("companies", c.id, {rev, exp}); await log(`Books for ${MONTHS[i]} · ${c.name}: revenue ${inr(rev[i])}, expense ${inr(exp[i])}`, c.id);
    return {ok:true, company:c.name, month:MONTHS[i], revenue:rev[i], expense:exp[i]};
  }));

  s.registerTool("update_company", {title:"Update company fields", description:"Set balance-sheet or profile fields of a company: cash, debt, equity, receivables, payables, inventory, headcount, valuation, revTarget, ceo, status, da, finCost, tax. Changes the live ledger.", inputSchema:{company:z.string(), fields:z.record(z.union([z.number(), z.string()])).describe("e.g. {\"cash\": 2500000, \"ceo\": \"Name\"}")}}, wrap(async ({company, fields}) => {
    const c = await findCompany(company); if (!c) throw new Error("No company matches " + company);
    const allowed = ["cash","debt","equity","receivables","payables","inventory","headcount","valuation","revTarget","ceo","ceoSince","status","da","finCost","tax","entity","vertical"];
    const patch = {}; for (const [k, v] of Object.entries(fields || {})) if (allowed.includes(k)) patch[k] = v; if (!Object.keys(patch).length) throw new Error("No allowed fields. Allowed: " + allowed.join(", "));
    await merge("companies", c.id, patch); await log(`Updated ${c.name}: ` + Object.entries(patch).map(([k, v]) => `${k}=${typeof v === "number" ? inr(v) : v}`).join(", "), c.id);
    return {ok:true, company:c.name, updated:patch};
  }));

  s.registerTool("set_budget", {title:"Set budget or spend", description:"Set the FY budget and/or spent amount for a company's budget line (opex, capex, marketing, people). Changes the live ledger.", inputSchema:{company:z.string(), line:z.enum(["opex","capex","marketing","people"]), budget:z.number().optional(), spent:z.number().optional()}}, wrap(async ({company, line, budget, spent}) => {
    const c = await findCompany(company); if (!c) throw new Error("No company matches " + company);
    const b = {...(c.budget || {})}, sp = {...(c.spent || {})}; if (budget != null) b[line] = budget; if (spent != null) sp[line] = spent;
    await merge("companies", c.id, {budget:b, spent:sp}); await log(`Budget line ${line} · ${c.name}: budget ${inr(b[line])}, spent ${inr(sp[line])}`, c.id);
    return {ok:true, company:c.name, line, budget:b[line], spent:sp[line]};
  }));

  s.registerTool("add_legal_notice", {title:"Log a legal notice", description:"Create a legal notice to track. Changes the live ledger.", inputSchema:{title:z.string(), company:z.string().describe("Company id/name, or 'group' for the parent"), type:z.string().describe("GST notice, Income tax notice, Legal notice (civil), Cheque bounce (Sec 138 NI Act), Consumer complaint, Court summons or suit, Trademark examination report, Trademark opposition, Labour, PF or ESI notice, Regulatory or licensing, Other"), direction:z.enum(["Received","Sent"]).optional(), date:z.string().describe("YYYY-MM-DD"), replyDue:z.string().optional(), party:z.string().optional(), forum:z.string().optional(), ref:z.string().optional(), amount:z.number().optional(), risk:z.enum(["Low","Medium","High"]).optional(), counsel:z.string().optional(), owner:z.string().optional(), summary:z.string().optional()}}, wrap(async a => {
    let coId = "group"; if (a.company && a.company.toLowerCase() !== "group") { const c = await findCompany(a.company); if (!c) throw new Error("No company matches " + a.company); coId = c.id; }
    const id = newId(); const d = {title:a.title, company:coId, brand:"", type:a.type, direction:a.direction || "Received", date:a.date, due:a.replyDue || "", hearing:"", party:a.party || "", forum:a.forum || "", ref:a.ref || "", amount:a.amount || 0, risk:a.risk || "Medium", status:"Open", counsel:a.counsel || "", owner:a.owner || "", outcome:"", created:new Date().toISOString().slice(0, 10), log:a.summary ? [{d:a.date, t:a.summary, by:agentId}] : []};
    await put("legal", id, d); await log(`Legal notice logged: ${a.title}`, coId === "group" ? null : coId, id); return {ok:true, id, ...d};
  }));

  s.registerTool("update_legal_notice", {title:"Update a legal notice", description:"Move a notice to a new stage, set hearing/due dates, risk, outcome, or append a log entry. Changes the live ledger.", inputSchema:{id:z.string(), stage:z.enum(LSTAGES).optional(), hearing:z.string().optional(), replyDue:z.string().optional(), risk:z.enum(["Low","Medium","High"]).optional(), outcome:z.string().optional(), note:z.string().optional().describe("Appended to the notice's log")}}, wrap(async a => {
    const l = await doc("legal", a.id); if (!l) throw new Error("No notice with id " + a.id);
    const patch = {}; if (a.stage) patch.status = a.stage; if (a.hearing != null) patch.hearing = a.hearing; if (a.replyDue != null) patch.due = a.replyDue; if (a.risk) patch.risk = a.risk; if (a.outcome != null) patch.outcome = a.outcome;
    if (a.note) patch.log = [...(l.log || []), {d:new Date().toISOString().slice(0, 10), t:a.note, by:agentId}];
    await merge("legal", a.id, patch); await log(`Notice "${l.title}": ` + (a.stage ? "stage → " + a.stage + "; " : "") + (a.note || "updated"), l.company === "group" ? null : l.company, a.id); return {ok:true, id:a.id, ...l, ...patch};
  }));

  s.registerTool("set_compliance_status", {title:"Set compliance status", description:"Mark a compliance item Open, In progress or Done. Changes the live ledger.", inputSchema:{id:z.string(), status:z.enum(["Open","In progress","Done"])}}, wrap(async ({id, status}) => {
    const x = await doc("compliance", id); if (!x) throw new Error("No compliance item " + id); await merge("compliance", id, {status}); await log(`Compliance "${x.title}" → ${status}`, x.company === "group" ? null : x.company, id); return {ok:true, id, title:x.title, status};
  }));

  s.registerTool("add_allocation", {title:"Allocate funds", description:"Record a capital allocation from the pool to a company. Changes the live ledger.", inputSchema:{company:z.string(), amount:z.number(), kind:z.string().describe("Working capital, Capex, Equity infusion, Loan, Marketing, Other"), purpose:z.string(), date:z.string(), status:z.enum(["Requested","Approved","Disbursed","Declined"]).optional()}}, wrap(async a => {
    const c = await findCompany(a.company); if (!c) throw new Error("No company matches " + a.company); const id = newId(); const d = {company:c.id, amount:a.amount, kind:a.kind, purpose:a.purpose, date:a.date, status:a.status || "Requested"};
    await put("allocations", id, d); await log(`Allocation ${d.status}: ${inr(a.amount)} to ${c.name} · ${a.purpose}`, c.id, id); return {ok:true, id, ...d};
  }));

  return s;
}

/* ---------- HTTP ---------- */
const sessions = new Map();
const authed = (req, url) => { const h = req.headers.authorization || ""; if (h === "Bearer " + TOKEN) return true; const seg = url.pathname.split("/").filter(Boolean); return seg[0] === TOKEN; };
const readBody = req => new Promise((res, rej) => { let b = ""; req.on("data", c => { b += c; if (b.length > 2e6) req.destroy(); }); req.on("end", () => { try { res(b ? JSON.parse(b) : undefined); } catch (e) { rej(e); } }); });
http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  res.setHeader("Access-Control-Allow-Origin", "*"); res.setHeader("Access-Control-Allow-Headers", "authorization, content-type, mcp-session-id, mcp-protocol-version"); res.setHeader("Access-Control-Expose-Headers", "mcp-session-id"); res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
  if (url.pathname === "/health") { res.writeHead(200, {"content-type":"application/json"}).end(JSON.stringify({ok:true, agent:AGENT_EMAIL, sessions:sessions.size})); return; }
  if (!authed(req, url)) { res.writeHead(401, {"content-type":"application/json"}).end(JSON.stringify({error:"unauthorized"})); return; }
  try {
    const sid = req.headers["mcp-session-id"];
    let t = sid && sessions.get(sid);
    if (!t) {
      if (req.method !== "POST") { res.writeHead(400).end("No session"); return; }
      t = new StreamableHTTPServerTransport({sessionIdGenerator:() => randomUUID(), onsessioninitialized:id => sessions.set(id, t)});
      t.onclose = () => { if (t.sessionId) sessions.delete(t.sessionId); };
      await build().connect(t);
    }
    await t.handleRequest(req, res, req.method === "POST" ? await readBody(req) : undefined);
  } catch (e) { console.error(e); if (!res.headersSent) res.writeHead(500, {"content-type":"application/json"}).end(JSON.stringify({error:String(e && e.message || e)})); }
}).listen(PORT, "127.0.0.1", async () => { try { await signIn(); console.log(`HQ MCP listening on 127.0.0.1:${PORT} as ${AGENT_EMAIL}`); } catch (e) { console.error(e.message); process.exit(1); } });
