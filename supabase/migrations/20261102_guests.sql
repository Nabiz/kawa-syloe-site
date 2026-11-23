-- Run after the coffee-types migration. Safe to rerun; never deletes existing data.
begin;

-- One row per guest, including cancelled orders. Ten numbered slots per meeting
-- make the lifetime limit a database constraint, not just an application counter.
create table if not exists coffee_private.guests (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.coffee_meetings(id),
  slot smallint not null check (slot between 1 and 10),
  display_name text not null check (char_length(btrim(display_name)) between 1 and 80),
  token_hash bytea not null unique,
  expires_at timestamptz not null,
  coffee_type text,
  unique (meeting_id, slot),
  foreign key (meeting_id, coffee_type)
    references public.coffee_meeting_types(meeting_id, coffee_type) on update cascade
);
alter table coffee_private.guests enable row level security;
revoke all on coffee_private.guests from public, anon, authenticated;

create or replace function coffee_private.meeting_json(p_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', m.id, 'name', m.name,
    'startsAt', (m.meeting_date + m.start_time) at time zone 'Europe/Warsaw',
    'status', case
      when now() >= ((m.meeting_date + m.start_time) at time zone 'Europe/Warsaw') + interval '4 hours' then 'finished'
      when now() >= (m.meeting_date + m.start_time) at time zone 'Europe/Warsaw' then 'ongoing'
      else 'upcoming' end,
    'coffeeTypes', coalesce((select jsonb_agg(mt.coffee_type order by t.sort_order, t.name)
      from public.coffee_meeting_types mt join public.coffee_types t on t.name = mt.coffee_type
      where mt.meeting_id = m.id), '[]'::jsonb))
  from public.coffee_meetings m where m.id = p_id;
$$;

create or replace function coffee_private.catalog_json(p_meeting_id uuid default null)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('name', t.name, 'detail', t.detail,
    'attendanceOnly', t.attendance_only, 'active', t.active) order by t.sort_order, t.name), '[]'::jsonb)
  from public.coffee_types t where p_meeting_id is null or exists (
    select 1 from public.coffee_meeting_types mt where mt.meeting_id = p_meeting_id and mt.coffee_type = t.name
  );
$$;

create or replace function coffee_private.guest_state(p_guest_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'user', jsonb_build_object('id', g.id, 'firstName', g.display_name, 'lastName', '', 'isAdmin', false, 'isGuest', true),
    'guest', jsonb_build_object('meetingId', g.meeting_id, 'expiresAt', g.expires_at),
    'coffeeTypes', coffee_private.catalog_json(g.meeting_id),
    'meetings', jsonb_build_array(coffee_private.meeting_json(g.meeting_id)),
    'orders', case when g.coffee_type is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object(
      'id', g.id, 'userId', g.id, 'meetingId', g.meeting_id, 'coffeeType', g.coffee_type)) end,
    'users', '[]'::jsonb)
  from coffee_private.guests g where g.id = p_guest_id;
$$;

create or replace function public.coffee_guest_menu()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_meeting public.coffee_meetings;
begin
  select * into v_meeting from public.coffee_meetings
  where ((meeting_date + start_time) at time zone 'Europe/Warsaw') + interval '4 hours' > clock_timestamp()
  order by meeting_date, start_time, id limit 1;
  if v_meeting.id is null or v_meeting.meeting_date <> (clock_timestamp() at time zone 'Europe/Warsaw')::date then
    return jsonb_build_object('meeting', null, 'coffeeTypes', '[]'::jsonb);
  end if;
  return jsonb_build_object('meeting', coffee_private.meeting_json(v_meeting.id),
    'coffeeTypes', coffee_private.catalog_json(v_meeting.id));
end;
$$;

create or replace function public.coffee_guest_state(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_guest coffee_private.guests;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then raise exception 'Sesja gościa wygasła.'; end if;
  select * into v_guest from coffee_private.guests where token_hash = extensions.digest(p_token, 'sha256');
  -- A pending first write may not have reached the server. No row is created by reading.
  if not found then return null; end if;
  if v_guest.expires_at <= clock_timestamp() then raise exception 'Sesja gościa wygasła.'; end if;
  return coffee_private.guest_state(v_guest.id);
end;
$$;

create or replace function public.coffee_guest_save_order(
  p_token text, p_meeting_id uuid, p_name text, p_coffee_type text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_guest coffee_private.guests; v_meeting public.coffee_meetings; v_nearest uuid; v_slot integer;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then raise exception 'Nieprawidłowa sesja gościa.'; end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 80 then raise exception 'Podaj imię (do 80 znaków).'; end if;
  -- Serialize creations and cancellations for this meeting. Recheck the token after
  -- obtaining the lock, so concurrent retries cannot consume two slots.
  select * into v_meeting from public.coffee_meetings where id = p_meeting_id for update;
  if not found or ((v_meeting.meeting_date + v_meeting.start_time) at time zone 'Europe/Warsaw') + interval '4 hours' <= clock_timestamp() then
    raise exception 'Zamówienia na to spotkanie są zamknięte.';
  end if;
  select * into v_guest from coffee_private.guests where token_hash = extensions.digest(p_token, 'sha256');
  if found then
    if v_guest.expires_at <= clock_timestamp() then raise exception 'Sesja gościa wygasła.'; end if;
    if v_guest.meeting_id <> p_meeting_id then raise exception 'Sesja gościa dotyczy innego spotkania.'; end if;
  else
    select id into v_nearest from public.coffee_meetings
    where ((meeting_date + start_time) at time zone 'Europe/Warsaw') + interval '4 hours' > clock_timestamp()
    order by meeting_date, start_time, id limit 1;
    if v_nearest is distinct from p_meeting_id or v_meeting.meeting_date <> (clock_timestamp() at time zone 'Europe/Warsaw')::date then
      raise exception 'Gość może zamawiać tylko w dniu najbliższego spotkania.';
    end if;
    select coalesce(max(slot), 0) + 1 into v_slot from coffee_private.guests where meeting_id = p_meeting_id;
    if v_slot > 10 then raise exception 'Osiągnięto limit zamówień gości'; end if;
  end if;
  if p_coffee_type is null or not exists (
    select 1 from public.coffee_meeting_types where meeting_id = p_meeting_id and coffee_type = p_coffee_type
  ) then raise exception 'Wybierz napój dostępny na tym spotkaniu z listy.'; end if;
  if v_guest.id is null then
    insert into coffee_private.guests(meeting_id, slot, display_name, token_hash, expires_at, coffee_type)
    values(p_meeting_id, v_slot, btrim(p_name), extensions.digest(p_token, 'sha256'), clock_timestamp() + interval '12 hours', p_coffee_type)
    returning * into v_guest;
  else
    update coffee_private.guests set coffee_type = p_coffee_type where id = v_guest.id;
  end if;
  return '{}'::jsonb;
end;
$$;

create or replace function public.coffee_guest_delete_order(p_token text, p_meeting_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_guest coffee_private.guests; v_starts_at timestamptz;
begin
  select (meeting_date + start_time) at time zone 'Europe/Warsaw' into v_starts_at
    from public.coffee_meetings where id = p_meeting_id for update;
  select * into v_guest from coffee_private.guests where token_hash = extensions.digest(p_token, 'sha256');
  if not found or v_guest.expires_at <= clock_timestamp() then raise exception 'Sesja gościa wygasła.'; end if;
  if v_guest.meeting_id <> p_meeting_id then raise exception 'Sesja gościa dotyczy innego spotkania.'; end if;
  if v_starts_at is null or v_starts_at + interval '4 hours' <= clock_timestamp() then raise exception 'Zamówienia na to spotkanie są zamknięte.'; end if;
  update coffee_private.guests set coffee_type = null where id = v_guest.id;
  return '{}'::jsonb;
end;
$$;

create or replace function public.coffee_guest_logout(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  update coffee_private.guests set expires_at = least(expires_at, clock_timestamp())
  where token_hash = extensions.digest(p_token, 'sha256');
  return '{}'::jsonb;
end;
$$;

create or replace function public.coffee_state(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user public.coffee_users;
begin
  v_user := coffee_private.current_user(p_token);
  return jsonb_build_object(
    'user', jsonb_build_object('id', v_user.id, 'firstName', v_user.first_name, 'lastName', v_user.last_name, 'isAdmin', v_user.is_admin),
    'coffeeTypes', coffee_private.catalog_json(),
    'meetings', coalesce((select jsonb_agg(coffee_private.meeting_json(m.id) order by m.meeting_date, m.start_time, m.id)
      from public.coffee_meetings m), '[]'::jsonb),
    'orders', coalesce((select jsonb_agg(o.item) from (
      select jsonb_build_object('id', id, 'coffeeType', coffee_type, 'userId', user_id, 'meetingId', meeting_id) as item
        from public.coffee_orders where v_user.is_admin or user_id = v_user.id
      union all
      select jsonb_build_object('id', id, 'coffeeType', coffee_type, 'userId', id, 'meetingId', meeting_id, 'guestName', display_name)
        from coffee_private.guests where v_user.is_admin and coffee_type is not null
    ) o), '[]'::jsonb),
    'users', case when v_user.is_admin then coalesce((select jsonb_agg(jsonb_build_object(
      'id', u.id, 'firstName', u.first_name, 'lastName', u.last_name, 'isAdmin', u.is_admin) order by u.last_name, u.first_name)
      from public.coffee_users u), '[]'::jsonb) else '[]'::jsonb end);
end;
$$;

create or replace function public.coffee_save_order(p_token text, p_meeting_id uuid, p_coffee_type text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user public.coffee_users; v_starts_at timestamptz;
begin
  v_user := coffee_private.current_user(p_token);
  select (meeting_date + start_time) at time zone 'Europe/Warsaw' into v_starts_at
    from public.coffee_meetings where id = p_meeting_id;
  if v_starts_at is null or v_starts_at + interval '4 hours' <= clock_timestamp() then raise exception 'Zamówienia na to spotkanie są zamknięte.'; end if;
  if p_coffee_type is null or not exists (
    select 1 from public.coffee_meeting_types where meeting_id = p_meeting_id and coffee_type = p_coffee_type
  ) then raise exception 'Wybierz napój dostępny na tym spotkaniu z listy.'; end if;
  insert into public.coffee_orders(coffee_type, user_id, meeting_id) values(p_coffee_type, v_user.id, p_meeting_id)
  on conflict(user_id, meeting_id) do update set coffee_type = excluded.coffee_type;
  return '{}'::jsonb;
end;
$$;

create or replace function public.coffee_delete_order(p_token text, p_meeting_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user public.coffee_users; v_starts_at timestamptz;
begin
  v_user := coffee_private.current_user(p_token);
  select (meeting_date + start_time) at time zone 'Europe/Warsaw' into v_starts_at
    from public.coffee_meetings where id = p_meeting_id;
  if v_starts_at is null or v_starts_at + interval '4 hours' <= clock_timestamp() then raise exception 'Zamówienia na to spotkanie są zamknięte.'; end if;
  delete from public.coffee_orders where user_id = v_user.id and meeting_id = p_meeting_id;
  return '{}'::jsonb;
end;
$$;

revoke all on function coffee_private.meeting_json(uuid), coffee_private.catalog_json(uuid), coffee_private.guest_state(uuid)
  from public, anon, authenticated;
revoke all on function public.coffee_guest_menu(), public.coffee_guest_state(text),
  public.coffee_guest_save_order(text,uuid,text,text), public.coffee_guest_delete_order(text,uuid), public.coffee_guest_logout(text),
  public.coffee_state(text), public.coffee_save_order(text,uuid,text), public.coffee_delete_order(text,uuid)
  from public, anon, authenticated;
grant execute on function public.coffee_guest_menu(), public.coffee_guest_state(text),
  public.coffee_guest_save_order(text,uuid,text,text), public.coffee_guest_delete_order(text,uuid), public.coffee_guest_logout(text),
  public.coffee_state(text), public.coffee_save_order(text,uuid,text), public.coffee_delete_order(text,uuid) to anon;

notify pgrst, 'reload schema';
commit;
