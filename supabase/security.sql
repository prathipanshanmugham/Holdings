-- Prathipan Holdings HQ · security upgrade
-- Run in Supabase → SQL Editor AFTER schema.sql (fresh install: schema.sql → security.sql → seed.sql).
-- Safe to run more than once.
--
-- What this adds
--   • Roles and company scope enforced by the database itself (not only by the screens)
--   • Staff see only names of their companies, never financials; non-Admins never see parent treasury
--   • Field-level guards: Managers can't change stake/targets/CEO; Staff can only record brand months,
--     add legal updates and change compliance status
--   • Only confirmed email addresses count (stops anyone claiming an invited email)
--   • Two-step sign-in (TOTP) required for Owner and Admin; once anyone enrols, it's required for them
--   • Tamper-proof audit trail of every change (owner-readable, nobody can edit or delete it)
--   • Activity log is append-only and its author/time are stamped by the server
--   • Input limits: known collections only, id format, 256 KB per record
--   • Anonymous (not signed-in) access removed from every table and function

-- ---------- settings ----------
insert into public.hq_config (key, value) values
  ('mfa_required_roles', 'Owner,Admin'),
  ('mfa_exempt_emails',  'agent@prathipanholdings.cloud')
on conflict (key) do nothing;

-- ---------- input limits ----------
alter table public.docs drop constraint if exists docs_collection_chk;
alter table public.docs add constraint docs_collection_chk check (collection in
  ('companies','brands','allocations','investments','shareholders','compliance','legal','intercompany','ventures','meta','activity'));
alter table public.docs drop constraint if exists docs_id_chk;
alter table public.docs add constraint docs_id_chk check (id ~ '^[A-Za-z0-9_-]{1,64}$');
alter table public.docs drop constraint if exists docs_size_chk;
alter table public.docs add constraint docs_size_chk check (jsonb_typeof(data) = 'object' and pg_column_size(data) <= 262144);
alter table public.members drop constraint if exists members_email_chk;
alter table public.members add constraint members_email_chk check (email = lower(email) and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$');
alter table public.members drop constraint if exists members_companies_chk;
alter table public.members add constraint members_companies_chk check (companies = '"all"'::jsonb or jsonb_typeof(companies) = 'array');
alter table public.profiles drop constraint if exists profiles_len_chk;
alter table public.profiles add constraint profiles_len_chk check (length(coalesce(name, '')) <= 120 and length(coalesce(avatar_url, '')) <= 500);

-- ---------- identity ----------
-- Only a confirmed email address counts.
create or replace function public.hq_user_email() returns text
language sql stable security definer set search_path = public, auth as $$
  select lower(u.email) from auth.users u where u.id = auth.uid() and u.email_confirmed_at is not null
$$;
create or replace function public.hq_email() returns text
language sql stable security definer set search_path = public as $$ select coalesce(public.hq_user_email(), '') $$;

create or replace function public.hq_cfg_list(p_key text) returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_remove(regexp_split_to_array(lower(trim(coalesce((select value from public.hq_config where key = p_key), ''))), '\s*,\s*'), ''), '{}')
$$;

-- Role before the two-step check: Owner / Admin / Manager / Staff / null
create or replace function public.hq_base_role() returns text
language sql stable security definer set search_path = public as $$
  select case
    when public.hq_user_email() is null then null
    when public.hq_user_email() = lower((select value from public.hq_config where key = 'owner_email')) then 'Owner'
    else (select m.role from public.members m where m.user_id = auth.uid() or m.email = public.hq_user_email() order by (m.user_id = auth.uid()) desc nulls last limit 1)
  end
$$;

create or replace function public.hq_mfa_needed() returns boolean
language sql stable security definer set search_path = public, auth as $$
  select exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status = 'verified')
      or (lower(coalesce(public.hq_base_role(), '')) = any (public.hq_cfg_list('mfa_required_roles'))
          and not (coalesce(public.hq_user_email(), '') = any (public.hq_cfg_list('mfa_exempt_emails'))))
$$;

-- Effective role: null unless signed in with two-step when two-step is needed
create or replace function public.hq_role() returns text
language sql stable security definer set search_path = public as $$
  select case
    when public.hq_base_role() is null then null
    when public.hq_mfa_needed() and coalesce(auth.jwt() ->> 'aal', 'aal1') <> 'aal2' then null
    else public.hq_base_role()
  end
$$;

create or replace function public.hq_scope() returns jsonb
language sql stable security definer set search_path = public as $$
  select case
    when public.hq_role() in ('Owner', 'Admin') then '"all"'::jsonb
    when public.hq_role() is null then '[]'::jsonb
    else coalesce((select m.companies from public.members m where m.user_id = auth.uid() or m.email = public.hq_user_email() order by (m.user_id = auth.uid()) desc nulls last limit 1), '[]'::jsonb)
  end
$$;

create or replace function public.hq_in_scope(p_company text) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when public.hq_role() in ('Owner', 'Admin') then true
    when public.hq_role() is null or coalesce(p_company, '') in ('', 'group') then false
    else (select s = '"all"'::jsonb or (jsonb_typeof(s) = 'array' and s ? p_company) from (select public.hq_scope() as s) x)
  end
$$;

create or replace function public.hq_is_owner() returns boolean
language sql stable security definer set search_path = public as $$ select coalesce(public.hq_role() = 'Owner', false) $$;
create or replace function public.hq_is_member() returns boolean
language sql stable security definer set search_path = public as $$ select public.hq_role() is not null $$;

-- What the sign-in screen needs to know about the current user (only about themselves)
create or replace function public.hq_mfa_status() returns jsonb
language sql stable security definer set search_path = public, auth as $$
  select jsonb_build_object(
    'emailConfirmed', public.hq_user_email() is not null,
    'member', public.hq_base_role() is not null,
    'required', public.hq_mfa_needed(),
    'enrolled', exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status = 'verified'),
    'aal', coalesce(auth.jwt() ->> 'aal', 'aal1'))
$$;

create or replace function public.hq_claim_membership() returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or public.hq_user_email() is null then return; end if;
  update public.members set user_id = auth.uid() where email = public.hq_user_email() and user_id is null;
end $$;

-- ---------- permission matrix ----------
create or replace function public.hq_can(p_op text, p_col text, p_id text, p_data jsonb) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare r text := public.hq_role(); co text;
begin
  if r is null then return false; end if;
  if r in ('Owner', 'Admin') then return true; end if;
  co := case when p_col = 'companies' then p_id else p_data ->> 'company' end;
  if p_op = 'read' then
    return case p_col
      when 'companies'    then r = 'Manager' and public.hq_in_scope(co)
      when 'allocations'  then r = 'Manager' and public.hq_in_scope(co)
      when 'brands'       then public.hq_in_scope(co)
      when 'legal'        then public.hq_in_scope(co)
      when 'compliance'   then public.hq_in_scope(co)
      when 'ventures'     then r = 'Manager'
      when 'intercompany' then r = 'Manager' and (public.hq_in_scope(p_data ->> 'from') or public.hq_in_scope(p_data ->> 'to'))
      when 'activity'     then p_data ->> 'by' = auth.uid()::text or public.hq_in_scope(p_data ->> 'co')
      else false end;
  elsif p_op = 'insert' then
    return case p_col
      when 'brands'      then r = 'Manager' and public.hq_in_scope(co)
      when 'legal'       then r = 'Manager' and public.hq_in_scope(co)
      when 'compliance'  then r = 'Manager' and public.hq_in_scope(co)
      when 'allocations' then r = 'Manager' and public.hq_in_scope(co) and p_data ->> 'status' = 'Requested'
      when 'activity'    then true
      else false end;
  elsif p_op = 'update' then
    return case p_col
      when 'companies'  then r = 'Manager' and public.hq_in_scope(co)
      when 'brands'     then public.hq_in_scope(co)
      when 'legal'      then public.hq_in_scope(co)
      when 'compliance' then public.hq_in_scope(co)
      else false end;
  elsif p_op = 'delete' then
    return case p_col
      when 'brands'     then r = 'Manager' and public.hq_in_scope(co)
      when 'compliance' then r = 'Manager' and public.hq_in_scope(co)
      else false end;
  end if;
  return false;
end $$;

-- Reduced views: Staff see only the names of their companies; non-Admins never see parent treasury
create or replace function public.hq_read_data(p_col text, p_id text, p_data jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r text := public.hq_role();
begin
  if r is null then return null; end if;
  if public.hq_can('read', p_col, p_id, p_data) then return p_data; end if;
  if p_col = 'meta' then
    return jsonb_strip_nulls(jsonb_build_object('name', p_data -> 'name', 'fyLabel', p_data -> 'fyLabel', 'closedMonths', p_data -> 'closedMonths',
      'sample', p_data -> 'sample', 'capitalPool', case when r = 'Manager' then p_data -> 'capitalPool' end));
  end if;
  if p_col = 'companies' and r = 'Staff' and public.hq_in_scope(p_id) then
    return jsonb_strip_nulls(jsonb_build_object('name', p_data -> 'name', 'vertical', p_data -> 'vertical', 'entity', p_data -> 'entity',
      'status', p_data -> 'status', 'stake', p_data -> 'stake'));
  end if;
  return null;
end $$;

create or replace function public.hq_read(p_collection text) returns table (id text, data jsonb)
language sql stable security definer set search_path = public as $$
  select d.id, x.data
  from public.docs d cross join lateral (select public.hq_read_data(d.collection, d.id, d.data) as data) x
  where d.collection = p_collection and x.data is not null
  order by case when p_collection = 'activity' then d.data ->> 'at' end desc nulls last, d.id
  limit case when p_collection = 'activity' then 500 end
$$;

-- ---------- field guards ----------
create or replace function public.hq_kpi_defs(j jsonb) returns jsonb
language sql immutable as $$
  select case when jsonb_typeof(j) = 'array'
    then (select coalesce(jsonb_agg(case when jsonb_typeof(e) = 'object' then e - 'a' else e end order by i), '[]'::jsonb) from jsonb_array_elements(j) with ordinality t(e, i))
    else coalesce(j, '[]'::jsonb) end
$$;
create or replace function public.hq_is_prefix(a jsonb, b jsonb) returns boolean
language sql immutable as $$
  select case
    when a is null or jsonb_typeof(a) <> 'array' or jsonb_array_length(a) = 0 then true
    when b is null or jsonb_typeof(b) <> 'array' or jsonb_array_length(b) < jsonb_array_length(a) then false
    else (select coalesce(jsonb_agg(e order by i), '[]'::jsonb) from jsonb_array_elements(b) with ordinality t(e, i) where i <= jsonb_array_length(a)) = a
  end
$$;

create or replace function public.hq_docs_guard() returns trigger
language plpgsql security invoker set search_path = public as $$
declare r text; changed text[]; allowed text[]; extra text; n int; i int; lg jsonb;
begin
  -- Direct database sessions (SQL editor, service role) are not limited by app roles
  if coalesce(current_setting('role', true), 'none') not in ('authenticated', 'anon') then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.collection = 'activity' then raise exception 'The activity log cannot be changed' using errcode = '42501'; end if;
    return old;
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  if new.collection = 'activity' then
    if tg_op = 'UPDATE' then raise exception 'The activity log cannot be changed' using errcode = '42501'; end if;
    new.data := new.data || jsonb_build_object('by', auth.uid()::text, 'at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
    return new;
  end if;
  r := public.hq_role();
  if tg_op = 'UPDATE' then
    if new.collection <> old.collection or new.id <> old.id then raise exception 'Records cannot be moved' using errcode = '42501'; end if;
    if r in ('Owner', 'Admin') then return new; end if;
    select coalesce(array_agg(k), '{}') into changed from (
      select n2.key as k from jsonb_each(new.data) n2 where not (old.data ? n2.key) or (old.data -> n2.key) is distinct from n2.value
      union
      select o.key from jsonb_each(old.data) o where not (new.data ? o.key)) z;
    allowed := case
      when r = 'Manager' and new.collection = 'companies' then array['rev','exp','spent','kpis','cash','receivables','payables','inventory','debt','equity','da','finCost','tax','headcount']
      when r = 'Manager' then null
      when r = 'Staff' and new.collection = 'brands' then array['rev','mktSpend','leads','customers']
      when r = 'Staff' and new.collection = 'legal' then array['log']
      when r = 'Staff' and new.collection = 'compliance' then array['status']
      else array[]::text[] end;
    if allowed is not null and not (changed <@ allowed) then
      select string_agg(x, ', ') into extra from (select unnest(changed) except select unnest(allowed)) q(x);
      raise exception 'Your role cannot change: %', extra using errcode = '42501';
    end if;
    if new.collection = 'companies' and 'kpis' = any (changed) and public.hq_kpi_defs(new.data -> 'kpis') is distinct from public.hq_kpi_defs(old.data -> 'kpis') then
      raise exception 'Only KPI actuals can be changed with your role' using errcode = '42501';
    end if;
    if new.collection = 'compliance' and r = 'Staff' and coalesce(new.data ->> 'status', '') not in ('Open', 'In progress', 'Filed') then
      raise exception 'Unknown compliance status' using errcode = '42501';
    end if;
    if new.collection = 'legal' and 'log' = any (changed) then
      if not public.hq_is_prefix(old.data -> 'log', new.data -> 'log') then
        raise exception 'Legal notice history can only be added to, not edited' using errcode = '42501';
      end if;
      -- stamp the author of every new entry
      n := coalesce(jsonb_array_length(case when jsonb_typeof(old.data -> 'log') = 'array' then old.data -> 'log' end), 0);
      lg := new.data -> 'log';
      if jsonb_typeof(lg) = 'array' then
        for i in n .. jsonb_array_length(lg) - 1 loop
          if jsonb_typeof(lg -> i) = 'object' then lg := jsonb_set(lg, array[i::text, 'by'], to_jsonb(auth.uid()::text)); end if;
        end loop;
        new.data := jsonb_set(new.data, '{log}', lg);
      end if;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists hq_docs_guard on public.docs;
create trigger hq_docs_guard before insert or update or delete on public.docs for each row execute function public.hq_docs_guard();

create or replace function public.hq_profiles_guard() returns trigger
language plpgsql security definer set search_path = public, auth as $$
begin
  if coalesce(current_setting('role', true), 'none') in ('authenticated', 'anon') then
    new.id := auth.uid();
    new.email := (select lower(email) from auth.users where id = auth.uid());
    new.updated_at := now();
  end if;
  return new;
end $$;
drop trigger if exists hq_profiles_guard on public.profiles;
create trigger hq_profiles_guard before insert or update on public.profiles for each row execute function public.hq_profiles_guard();

-- ---------- audit trail ----------
create table if not exists public.audit_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  actor       uuid,
  actor_email text,
  actor_role  text,
  action      text not null,
  tbl         text not null,
  collection  text,
  doc_id      text,
  old_data    jsonb,
  new_data    jsonb
);
create index if not exists audit_log_at_idx on public.audit_log (at desc);
alter table public.audit_log enable row level security;

create or replace function public.hq_audit() returns trigger
language plpgsql security definer set search_path = public, auth as $$
declare o jsonb; n jsonb;
begin
  if tg_op <> 'INSERT' then o := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then n := to_jsonb(new); end if;
  if coalesce(n, o) ->> 'collection' = 'activity' then return null; end if;
  insert into public.audit_log (actor, actor_email, actor_role, action, tbl, collection, doc_id, old_data, new_data)
  values (auth.uid(), (select lower(email) from auth.users where id = auth.uid()),
          coalesce(public.hq_base_role(), nullif(current_setting('role', true), 'none'), 'database'),
          tg_op, tg_table_name, coalesce(n, o) ->> 'collection', coalesce(n ->> 'id', n ->> 'email', o ->> 'id', o ->> 'email'),
          case when tg_table_name = 'docs' then o -> 'data' else o end,
          case when tg_table_name = 'docs' then n -> 'data' else n end);
  return null;
end $$;
drop trigger if exists hq_audit_docs on public.docs;
create trigger hq_audit_docs after insert or update or delete on public.docs for each row execute function public.hq_audit();
drop trigger if exists hq_audit_members on public.members;
create trigger hq_audit_members after insert or update or delete on public.members for each row execute function public.hq_audit();
drop trigger if exists hq_audit_config on public.hq_config;
create trigger hq_audit_config after insert or update or delete on public.hq_config for each row execute function public.hq_audit();

-- ---------- access management (owner only) ----------
create or replace function public.hq_member_set(p_user_id uuid, p_email text, p_role text, p_companies jsonb, p_since text)
returns void language plpgsql security definer set search_path = public, auth as $$
declare v_email text;
begin
  if not public.hq_is_owner() then raise exception 'Only the owner can change access' using errcode = '42501'; end if;
  if p_role not in ('Admin', 'Manager', 'Staff') then raise exception 'Unknown role'; end if;
  if p_companies is not null and p_companies <> '"all"'::jsonb and jsonb_typeof(p_companies) <> 'array' then raise exception 'Companies must be "all" or a list'; end if;
  if p_user_id is not null then select lower(email) into v_email from auth.users where id = p_user_id;
  else v_email := lower(trim(p_email)); end if;
  if v_email is null or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise exception 'Unknown person'; end if;
  if v_email = lower((select value from public.hq_config where key = 'owner_email')) then raise exception 'The owner already has full access'; end if;
  insert into public.members (email, user_id, role, companies, since)
    values (v_email, p_user_id, p_role, coalesce(p_companies, '[]'::jsonb), coalesce(nullif(p_since, ''), to_char(now(), 'YYYY-MM-DD')))
  on conflict (email) do update
    set user_id = coalesce(excluded.user_id, public.members.user_id), role = excluded.role, companies = excluded.companies,
        since = coalesce(public.members.since, excluded.since);
end $$;

-- ---------- writes (run with the caller's rights, so every rule above applies) ----------
-- update-then-insert: an update is checked only against the update rules
create or replace function public.hq_doc_exists(p_collection text, p_id text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.docs where collection = p_collection and id = p_id)
$$;
create or replace function public.hq_doc_merge(p_collection text, p_id text, p_patch jsonb)
returns void language plpgsql security invoker set search_path = public as $$
begin
  if jsonb_typeof(p_patch) <> 'object' then raise exception 'Patch must be an object'; end if;
  update public.docs set data = data || p_patch where collection = p_collection and id = p_id;
  if not found then
    if public.hq_doc_exists(p_collection, p_id) then raise exception 'Not allowed for your role' using errcode = '42501'; end if;
    insert into public.docs (collection, id, data) values (p_collection, p_id, p_patch);
  end if;
end $$;
create or replace function public.hq_doc_set(p_collection text, p_id text, p_data jsonb)
returns void language plpgsql security invoker set search_path = public as $$
begin
  if jsonb_typeof(p_data) <> 'object' then raise exception 'Record must be an object'; end if;
  update public.docs set data = p_data where collection = p_collection and id = p_id;
  if not found then
    if public.hq_doc_exists(p_collection, p_id) then raise exception 'Not allowed for your role' using errcode = '42501'; end if;
    insert into public.docs (collection, id, data) values (p_collection, p_id, p_data);
  end if;
end $$;

-- ---------- policies ----------
drop policy if exists docs_read on public.docs;
drop policy if exists docs_write on public.docs;
drop policy if exists docs_update on public.docs;
drop policy if exists docs_delete on public.docs;
drop policy if exists docs_select on public.docs;
drop policy if exists docs_insert on public.docs;
create policy docs_select on public.docs for select to authenticated using (public.hq_can('read', collection, id, data));
create policy docs_insert on public.docs for insert to authenticated with check (public.hq_can('insert', collection, id, data));
create policy docs_update on public.docs for update to authenticated using (public.hq_can('update', collection, id, data)) with check (public.hq_can('update', collection, id, data));
create policy docs_delete on public.docs for delete to authenticated using (public.hq_can('delete', collection, id, data));

drop policy if exists profiles_read on public.profiles;
drop policy if exists profiles_self_ins on public.profiles;
drop policy if exists profiles_self_upd on public.profiles;
create policy profiles_read     on public.profiles for select to authenticated using (id = auth.uid() or public.hq_role() is not null);
create policy profiles_self_ins on public.profiles for insert to authenticated with check (id = auth.uid());
create policy profiles_self_upd on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists members_read on public.members;
drop policy if exists members_owner on public.members;
drop policy if exists members_owner_ins on public.members;
drop policy if exists members_owner_upd on public.members;
drop policy if exists members_owner_del on public.members;
create policy members_read      on public.members for select to authenticated using (public.hq_is_owner() or user_id = auth.uid() or email = public.hq_email());
create policy members_owner_ins on public.members for insert to authenticated with check (public.hq_is_owner());
create policy members_owner_upd on public.members for update to authenticated using (public.hq_is_owner()) with check (public.hq_is_owner());
create policy members_owner_del on public.members for delete to authenticated using (public.hq_is_owner());

drop policy if exists config_owner on public.hq_config;

drop policy if exists audit_owner_read on public.audit_log;
create policy audit_owner_read on public.audit_log for select to authenticated using (public.hq_is_owner());

-- ---------- grants: nothing for anonymous visitors ----------
revoke all on public.docs, public.profiles, public.members, public.hq_config, public.audit_log from anon;
revoke all on public.hq_config from authenticated;
revoke all on public.audit_log from authenticated;
grant select on public.audit_log to authenticated;
grant select, insert, update, delete on public.docs, public.profiles, public.members to authenticated;
revoke truncate, references, trigger on public.docs, public.profiles, public.members from authenticated;

revoke execute on all functions in schema public from public, anon;
grant execute on function
  public.hq_user_email(), public.hq_email(), public.hq_cfg_list(text), public.hq_base_role(), public.hq_mfa_needed(), public.hq_role(),
  public.hq_scope(), public.hq_in_scope(text), public.hq_is_owner(), public.hq_is_member(), public.hq_mfa_status(),
  public.hq_claim_membership(), public.hq_can(text, text, text, jsonb), public.hq_read_data(text, text, jsonb), public.hq_read(text),
  public.hq_kpi_defs(jsonb), public.hq_is_prefix(jsonb, jsonb), public.hq_member_set(uuid, text, text, jsonb, text),
  public.hq_doc_merge(text, text, jsonb), public.hq_doc_set(text, text, jsonb), public.hq_doc_exists(text, text)
to authenticated;
-- keep future objects private by default
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke execute on functions from anon, public;
