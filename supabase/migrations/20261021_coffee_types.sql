-- Run after schema.sql on a new database, or directly on the existing project.
-- Keeps all existing meetings and orders. Safe to rerun.
begin;

create table if not exists public.coffee_types (
  name text primary key check (char_length(btrim(name)) between 1 and 120),
  detail text not null default '',
  attendance_only boolean not null default false,
  active boolean not null default true,
  sort_order integer not null default 100
);

insert into public.coffee_types(name, detail, attendance_only, sort_order) values
  ('Czarna', 'Kawa bez mleka', false, 1),
  ('Biała', 'Kawa z mlekiem', false, 2),
  ('Herbata Zimowa', 'Rozgrzewająca herbata', false, 3),
  ('Inna (daj znać po spotkaniu)', 'Będę na spotkaniu, bez zamawiania napoju', true, 4)
on conflict (name) do nothing;

-- Preserve the labels of previous orders; don't guess which new drink they meant.
insert into public.coffee_types(name, detail, active)
select distinct coffee_type, 'Wcześniejsze zamówienie', false
from public.coffee_orders
on conflict (name) do nothing;

create table if not exists public.coffee_meeting_types (
  meeting_id uuid not null references public.coffee_meetings(id) on delete cascade,
  coffee_type text not null references public.coffee_types(name) on update cascade,
  primary key (meeting_id, coffee_type)
);

-- Backfill only meetings without a menu. Rerunning must not widen chosen menus.
insert into public.coffee_meeting_types(meeting_id, coffee_type)
select m.id, t.name from public.coffee_meetings m cross join public.coffee_types t
where t.active and not exists (
  select 1 from public.coffee_meeting_types mt where mt.meeting_id = m.id
)
on conflict do nothing;

insert into public.coffee_meeting_types(meeting_id, coffee_type)
select distinct meeting_id, coffee_type from public.coffee_orders
on conflict do nothing;

alter table public.coffee_orders drop constraint if exists coffee_orders_coffee_type_check;
alter table public.coffee_orders drop constraint if exists coffee_orders_offered_type_fkey;
alter table public.coffee_orders add constraint coffee_orders_offered_type_fkey
  foreign key (meeting_id, coffee_type)
  references public.coffee_meeting_types(meeting_id, coffee_type) on update cascade;

alter table public.coffee_types enable row level security;
alter table public.coffee_meeting_types enable row level security;
revoke all on public.coffee_types, public.coffee_meeting_types from public, anon, authenticated;

create or replace function public.coffee_state(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user public.coffee_users;
begin
  v_user := coffee_private.current_user(p_token);
  return jsonb_build_object(
    'user', jsonb_build_object('id', v_user.id, 'firstName', v_user.first_name, 'lastName', v_user.last_name, 'isAdmin', v_user.is_admin),
    'coffeeTypes', coalesce((select jsonb_agg(jsonb_build_object(
      'name', t.name, 'detail', t.detail, 'attendanceOnly', t.attendance_only, 'active', t.active)
      order by t.sort_order, t.name) from public.coffee_types t), '[]'::jsonb),
    'meetings', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name,
      'startsAt', (m.meeting_date + m.start_time) at time zone 'Europe/Warsaw',
      'coffeeTypes', coalesce((select jsonb_agg(mt.coffee_type order by t.sort_order, t.name)
        from public.coffee_meeting_types mt join public.coffee_types t on t.name = mt.coffee_type
        where mt.meeting_id = m.id), '[]'::jsonb)) order by m.meeting_date, m.start_time)
      from public.coffee_meetings m), '[]'::jsonb),
    'orders', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'coffeeType', o.coffee_type,
      'userId', o.user_id, 'meetingId', o.meeting_id) order by o.id)
      from public.coffee_orders o where v_user.is_admin or o.user_id = v_user.id), '[]'::jsonb),
    'users', case when v_user.is_admin then coalesce((select jsonb_agg(jsonb_build_object(
      'id', u.id, 'firstName', u.first_name, 'lastName', u.last_name, 'isAdmin', u.is_admin) order by u.last_name, u.first_name)
      from public.coffee_users u), '[]'::jsonb) else '[]'::jsonb end
  );
end;
$$;

-- Remove the old API signature so menu selection cannot be skipped accidentally.
drop function if exists public.coffee_create_meeting(text,text,timestamptz);
create or replace function public.coffee_create_meeting(
  p_token text, p_name text, p_starts_at timestamptz, p_coffee_types text[]
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user public.coffee_users; v_meeting_id uuid;
begin
  v_user := coffee_private.current_user(p_token);
  if not v_user.is_admin then raise exception 'Ta czynność jest dostępna tylko dla admina.'; end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 120 or p_starts_at is null or p_starts_at <= now() then
    raise exception 'Podaj nazwę i przyszłą datę spotkania.';
  end if;
  if p_coffee_types is null or exists (
    select 1 from unnest(p_coffee_types) choice(name)
    left join public.coffee_types t on t.name = choice.name
    where t.name is null or not t.active
  ) then raise exception 'Wybierz napoje z listy.'; end if;
  insert into public.coffee_meetings(name, meeting_date, start_time)
  values(btrim(p_name), (p_starts_at at time zone 'Europe/Warsaw')::date, (p_starts_at at time zone 'Europe/Warsaw')::time)
  returning id into v_meeting_id;
  insert into public.coffee_meeting_types(meeting_id, coffee_type)
  select v_meeting_id, choice.name from (
    select unnest(p_coffee_types) as name
    union select name from public.coffee_types where active and attendance_only
  ) choice;
  return '{}'::jsonb;
end;
$$;

create or replace function public.coffee_save_order(p_token text, p_meeting_id uuid, p_coffee_type text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user public.coffee_users; v_starts_at timestamptz;
begin
  v_user := coffee_private.current_user(p_token);
  select (meeting_date + start_time) at time zone 'Europe/Warsaw' into v_starts_at
  from public.coffee_meetings where id = p_meeting_id;
  if v_starts_at is null or v_starts_at <= now() then raise exception 'Zamówienia na to spotkanie są zamknięte.'; end if;
  if p_coffee_type is null or not exists (
    select 1 from public.coffee_meeting_types where meeting_id = p_meeting_id and coffee_type = p_coffee_type
  ) then raise exception 'Wybierz napój dostępny na tym spotkaniu z listy.'; end if;
  insert into public.coffee_orders (coffee_type, user_id, meeting_id) values (p_coffee_type, v_user.id, p_meeting_id)
  on conflict (user_id, meeting_id) do update set coffee_type = excluded.coffee_type;
  return '{}'::jsonb;
end;
$$;

revoke all on function public.coffee_state(text), public.coffee_save_order(text,uuid,text),
  public.coffee_create_meeting(text,text,timestamptz,text[]) from public, anon, authenticated;
grant execute on function public.coffee_state(text), public.coffee_save_order(text,uuid,text),
  public.coffee_create_meeting(text,text,timestamptz,text[]) to anon;

notify pgrst, 'reload schema';
commit;
