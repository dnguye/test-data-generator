-- Storage for the Test Data Generator API (Supabase / Postgres).
--
-- The API has no auth: a schema id is a capability, and the only thing keeping
-- one schema out of a stranger's hands is that the id cannot be guessed. That
-- model collapses the moment the table is readable through Supabase's public
-- anon key, because PostgREST would happily return every id in one request.
--
-- So RLS is enabled and NO policy is created. With RLS on and no policies, the
-- anon and authenticated roles can do nothing at all, while the service role
-- key -- which lives only in the API's environment -- bypasses RLS entirely.
-- That is the whole access control design, and it is one setting.

create table if not exists public.schemas (
  id          text primary key,
  definition  jsonb       not null,
  created_at  timestamptz not null default now()
);

alter table public.schemas enable row level security;

-- Deliberately no policies. Do not add one for anon.
-- Verify with:  select relrowsecurity from pg_class where relname = 'schemas';

-- Schemas are immutable by contract; enforce it in the database too, so a bug
-- in the API cannot rewrite a schema that callers have already pinned an id to.
create or replace function public.schemas_are_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'schemas are immutable: register a new schema instead of editing %', old.id;
end $$;

drop trigger if exists schemas_no_update on public.schemas;
create trigger schemas_no_update
  before update or delete on public.schemas
  for each row execute function public.schemas_are_immutable();
