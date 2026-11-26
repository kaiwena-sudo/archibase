-- Supabase / Postgres schema for Archibase. Idempotent: safe to re-run.
--
-- Access model: the data IS the product, so nothing here is readable with Supabase's public
-- "anon" key (which is designed to be shareable). Row-level security is enabled with no
-- policies for anon/authenticated, so those roles see nothing. The API server reads with the
-- project's secret server key (service_role), which bypasses RLS and never leaves the server.

-- ---------- plans: one row per floor plan (src/db/client.ts, SupabasePlanStore) ----------
create table if not exists public.floor_plans (
  plan_id            text primary key,
  style              text         not null,
  total_area_m2      numeric(9,2) not null check (total_area_m2 > 0),  -- net interior m²
  bedrooms           integer      not null check (bedrooms >= 0),
  bedrooms_inferred  integer      not null default 0 check (bedrooms_inferred >= 0 and bedrooms_inferred <= bedrooms),
  bathrooms          numeric(3,1) not null check (bathrooms >= 0),
  adjacency_graph    jsonb        not null,
  -- provenance (served to buyers)
  source             text         not null check (source in ('synthetic','habs','commissioned','dataset','ai_generated')),
  built              boolean      not null,
  license            text         not null check (license in ('public-domain','CC0-1.0','CC-BY-4.0','HK-CSDI-TOU','owned')),
  author             text,
  source_url         text,
  attribution        text,
  -- internal only: signed agreement reference. Never selected by the API.
  rights_ref         text,
  created_at         timestamptz  not null default now(),
  constraint floor_plans_attribution_check check (license not in ('CC-BY-4.0','HK-CSDI-TOU') or attribution is not null),
  check (source <> 'commissioned' or rights_ref is not null),
  check (source not in ('synthetic','ai_generated') or built = false)
);
alter table public.floor_plans add column if not exists bedrooms_inferred integer not null default 0;

-- What the building is used for (src/db/validate.ts BUILDING_TYPES).
alter table public.floor_plans add column if not exists building_type text not null default 'residential';
alter table public.floor_plans drop constraint if exists floor_plans_building_type_check;
alter table public.floor_plans add constraint floor_plans_building_type_check check (building_type in
  ('residential','office','retail','transport','government','sports','hospitality','healthcare','cultural','education','industrial','mixed','other'));
create index if not exists floor_plans_building_type_idx on public.floor_plans (building_type);

-- Accepted licences (src/db/validate.ts COMMERCIAL_LICENSES). Kept in step with the table definition above.
alter table public.floor_plans drop constraint if exists floor_plans_license_check;
alter table public.floor_plans add constraint floor_plans_license_check check (license in ('public-domain','CC0-1.0','CC-BY-4.0','HK-CSDI-TOU','owned'));
-- Attribution rule, named. Older databases have it as an auto-named check (floor_plans_check1)
-- covering CC-BY only; drop that one by its definition, never by its generated name.
do $$
declare c record;
begin
  for c in select conname from pg_constraint
           where conrelid = 'public.floor_plans'::regclass and contype = 'c'
             and pg_get_constraintdef(oid) like '%license <> ''CC-BY-4.0''%attribution IS NOT NULL%'
  loop
    execute format('alter table public.floor_plans drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.floor_plans drop constraint if exists floor_plans_attribution_check;
alter table public.floor_plans add constraint floor_plans_attribution_check check (license not in ('CC-BY-4.0','HK-CSDI-TOU') or attribution is not null);

-- Repeated layouts and quality flags (src/db/layout.ts). layout_key is computed by the loader;
-- layout_rank/layout_copies by refresh_layout_ranks below. Search serves quality_flags = '{}' and
-- layout_rank = 1 unless the buyer asks for duplicates. New rows default to rank 1 until refreshed.
alter table public.floor_plans add column if not exists layout_key    text;
alter table public.floor_plans add column if not exists layout_rank   integer not null default 1;
alter table public.floor_plans add column if not exists layout_copies integer not null default 1;
alter table public.floor_plans add column if not exists quality_flags text[]  not null default '{}';
create index if not exists floor_plans_layout_idx  on public.floor_plans (layout_key);
create index if not exists floor_plans_serving_idx on public.floor_plans (bedrooms, total_area_m2) where layout_rank = 1 and quality_flags = '{}';

-- Rank identical layouts among unflagged plans: lowest plan_id is canonical (rank 1). Flagged plans
-- are ranked 1 of 1 so they never hide a good copy. Mirrors rankLayouts() in src/db/layout.ts.
create or replace function public.refresh_layout_ranks() returns integer language sql as $$
  with ranked as (
    select plan_id,
           case when quality_flags = '{}' and layout_key is not null
                then row_number() over (partition by layout_key, quality_flags = '{}' order by plan_id) else 1 end as rk,
           case when quality_flags = '{}' and layout_key is not null
                then count(*) over (partition by layout_key, quality_flags = '{}') else 1 end as n
    from public.floor_plans
  ), changed as (
    update public.floor_plans f set layout_rank = r.rk, layout_copies = r.n
    from ranked r
    where f.plan_id = r.plan_id and (f.layout_rank <> r.rk or f.layout_copies <> r.n)
    returning 1
  )
  select count(*)::integer from changed;
$$;
revoke all on function public.refresh_layout_ranks() from public, anon, authenticated;

create index if not exists floor_plans_search_idx     on public.floor_plans (bedrooms, total_area_m2);
create index if not exists floor_plans_style_idx      on public.floor_plans (lower(style));
create index if not exists floor_plans_provenance_idx on public.floor_plans (built, source);

-- ---------- geometry: one row per plan that has vector geometry (src/db/vectors.ts) ----------
create table if not exists public.floor_plan_vectors (
  plan_id     text primary key references public.floor_plans (plan_id) on delete cascade,
  vector      jsonb       not null,
  created_at  timestamptz not null default now()
);

-- ---------- live catalogue counts for the site (src/site/catalogue.ts) ----------
-- Materialized: counting scans every plan (seconds at 70k rows), too slow per page view.
-- Refreshed after each load by scripts/supabase-load.ts and scripts/supabase-layouts.ts.
do $$ begin  -- an older schema made this a plain view; replace only that, never the materialized one
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'public' and c.relname = 'catalogue_stats' and c.relkind = 'v') then
    drop view public.catalogue_stats;
  end if;
end $$;
create materialized view if not exists public.catalogue_stats as
  select split_part(plan_id, '-', 1)                                         as prefix,
         building_type,
         count(*) filter (where layout_rank = 1 and quality_flags = '{}')::int as served,
         count(*)::int                                                       as stored
  from public.floor_plans
  group by 1, 2;
refresh materialized view public.catalogue_stats;

-- ---------- prepaid credits: API keys for people who don't pay per call with a wallet ----------
-- A key is "ak_" + 43 base64url chars. Only its SHA-256 hash is stored, so a database leak does not leak
-- spendable keys and a lost key cannot be recovered (a new one can be issued). Balances are USDC base
-- units (6 decimals), the same unit as x402 prices: $0.02 = 20000. Test-labelled keys are only
-- honoured by testnet deployments.
create table if not exists public.api_keys (
  key_hash          text primary key,
  label             text,
  balance           bigint      not null default 0 check (balance >= 0),
  test              boolean     not null default false,
  disabled          boolean     not null default false,
  created_at        timestamptz not null default now(),
  last_used_at      timestamptz
);
-- Spend atomically; null when the key is unknown, disabled, or the balance is too low.
create or replace function public.spend_credits(p_hash text, p_amount bigint, p_allow_test boolean default false)
returns bigint language sql as $$
  update public.api_keys
     set balance = balance - p_amount, last_used_at = now()
   where key_hash = p_hash and p_amount > 0 and not disabled and balance >= p_amount and (p_allow_test or not test)
  returning balance;
$$;
create or replace function public.refund_credits(p_hash text, p_amount bigint)
returns bigint language sql as $$
  update public.api_keys set balance = balance + p_amount where key_hash = p_hash and p_amount > 0 returning balance;
$$;

-- ---------- access ----------
alter table public.floor_plans        enable row level security;
alter table public.floor_plan_vectors enable row level security;
drop policy if exists "floor_plans are readable" on public.floor_plans;  -- older schema granted anon reads
revoke all on public.floor_plans        from anon, authenticated;
revoke all on public.floor_plan_vectors from anon, authenticated;
revoke all on public.catalogue_stats    from anon, authenticated;
alter table public.api_keys         enable row level security;
revoke all on public.api_keys         from anon, authenticated;
revoke all on function public.spend_credits(text, bigint, boolean) from public, anon, authenticated;
revoke all on function public.refund_credits(text, bigint) from public, anon, authenticated;

-- Older schema notes (only if upgrading a table created before these columns existed):
--   vector_schema_url is no longer stored:   alter table public.floor_plans drop column if exists vector_schema_url;
--   from the sqft schema:                    add total_area_m2, set it to round(total_sqft * 0.09290304, 2), drop total_sqft;
--                                            room areas inside adjacency_graph also change, so re-seeding is simplest.

-- Load data with:  npm run supabase:load -- <plans.json ...> [--vectors <dir>]   (Management API; see scripts/supabase-load.ts)
