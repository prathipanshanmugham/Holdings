-- Prathipan Holdings HQ · database schema
-- Run once in Supabase → SQL Editor (then run seed.sql).

create extension if not exists pgcrypto;

-- ---------- settings ----------
create table if not exists public.hq_config (
  key   text primary key,
  value text not null
);
-- The owner is the Admin who can never be locked out. Change the email if needed.
insert into public.hq_config (key, value) values ('owner_email', 'prathipanshanmugham33@gmail.com')
  on conflict (key) do update set value = excluded.value;

-- ---------- documents (the ledger) ----------
create table if not exists public.docs (
  collection  text        not null,
  id          text        not null,
  data        jsonb       not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  primary key (collection, id)
);
create index if not exists docs_collection_idx on public.docs (collection);
create index if not exists docs_at_idx on public.docs (collection, ((data->>'at')) desc);

-- ---------- people ----------
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  name        text,
  email       text,
  avatar_url  text,
  updated_at  timestamptz not null default now()
);

create table if not exists public.members (
  email      text primary key,
  user_id    uuid unique references auth.users (id) on delete set null,
  role       text not null check (role in ('Admin','Manager','Staff')),
  companies  jsonb not null default '"all"'::jsonb,   -- "all" or ["companyId", ...]
  since      text,
  created_at timestamptz not null default now()
);

-- ---------- helper functions ----------
create or replace function public.hq_email() returns text
language sql stable as $$ select lower(coalesce(auth.jwt()->>'email', '')) $$;

create or replace function public.hq_is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null
     and public.hq_email() = lower((select value from public.hq_config where key = 'owner_email'));
$$;

create or replace function public.hq_is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select public.hq_is_owner()
      or exists (select 1 from public.members m where m.user_id = auth.uid() or m.email = public.hq_email());
$$;

-- links a pre-invited email row to the user once they sign in, and keeps profiles fresh
create or replace function public.hq_claim_membership() returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return; end if;
  update public.members set user_id = auth.uid() where email = public.hq_email() and user_id is null;
end $$;

-- owner-only: create or change a member by user id or by email
create or replace function public.hq_member_set(p_user_id uuid, p_email text, p_role text, p_companies jsonb, p_since text)
returns void language plpgsql security definer set search_path = public as $$
declare v_email text;
begin
  if not public.hq_is_owner() then raise exception 'only the owner can change access' using errcode = '42501'; end if;
  if p_user_id is not null then
    select lower(email) into v_email from auth.users where id = p_user_id;
  else
    v_email := lower(p_email);
  end if;
  if v_email is null then raise exception 'unknown person'; end if;
  insert into public.members (email, user_id, role, companies, since)
    values (v_email, p_user_id, p_role, coalesce(p_companies, '"all"'::jsonb), coalesce(p_since, to_char(now(), 'YYYY-MM-DD')))
  on conflict (email) do update
    set user_id = coalesce(excluded.user_id, public.members.user_id), role = excluded.role, companies = excluded.companies,
        since = coalesce(public.members.since, excluded.since);
end $$;

-- partial update of a document (merge patch), honours RLS of the caller
create or replace function public.hq_doc_merge(p_collection text, p_id text, p_patch jsonb)
returns void language plpgsql security invoker set search_path = public as $$
begin
  insert into public.docs (collection, id, data, updated_by)
    values (p_collection, p_id, coalesce(p_patch, '{}'::jsonb), auth.uid())
  on conflict (collection, id) do update
    set data = public.docs.data || excluded.data, updated_at = now(), updated_by = auth.uid();
end $$;

-- ---------- row-level security ----------
alter table public.docs     enable row level security;
alter table public.profiles enable row level security;
alter table public.members  enable row level security;
alter table public.hq_config enable row level security;

drop policy if exists docs_read   on public.docs;
drop policy if exists docs_write  on public.docs;
drop policy if exists docs_update on public.docs;
drop policy if exists docs_delete on public.docs;
create policy docs_read   on public.docs for select to authenticated using (public.hq_is_member());
create policy docs_write  on public.docs for insert to authenticated with check (public.hq_is_member());
create policy docs_update on public.docs for update to authenticated using (public.hq_is_member()) with check (public.hq_is_member());
create policy docs_delete on public.docs for delete to authenticated using (public.hq_is_member());

drop policy if exists profiles_read on public.profiles;
drop policy if exists profiles_self_ins on public.profiles;
drop policy if exists profiles_self_upd on public.profiles;
create policy profiles_read     on public.profiles for select to authenticated using (public.hq_is_member() or id = auth.uid());
create policy profiles_self_ins on public.profiles for insert to authenticated with check (id = auth.uid());
create policy profiles_self_upd on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists members_read  on public.members;
drop policy if exists members_owner on public.members;
create policy members_read  on public.members for select to authenticated using (public.hq_is_owner() or user_id = auth.uid() or email = public.hq_email());
create policy members_owner on public.members for all to authenticated using (public.hq_is_owner()) with check (public.hq_is_owner());

drop policy if exists config_owner on public.hq_config;
create policy config_owner on public.hq_config for select to authenticated using (public.hq_is_owner());

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.docs, public.profiles, public.members to authenticated;
grant select on public.hq_config to authenticated;
grant execute on function public.hq_is_owner, public.hq_is_member, public.hq_claim_membership, public.hq_member_set, public.hq_doc_merge to authenticated;

-- ---------- realtime ----------
alter table public.docs    replica identity full;
alter table public.members replica identity full;
do $$ begin
  begin alter publication supabase_realtime add table public.docs;    exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.members; exception when duplicate_object then null; end;
end $$;
