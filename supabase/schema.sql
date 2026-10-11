-- Run once in the SQL Editor of a new Supabase project.
-- The frontend uses only the public coffee_* RPC functions, not direct table access.
begin;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create schema if not exists coffee_private;
revoke all on schema coffee_private from public, anon, authenticated;

create table public.coffee_users (
  id uuid primary key default gen_random_uuid(),
  first_name text not null check (char_length(btrim(first_name)) between 1 and 80),
  last_name text not null check (char_length(btrim(last_name)) between 1 and 80),
  password_hash text not null,
  is_admin boolean not null default false,
  failed_logins integer not null default 0,
  locked_until timestamptz
);
create unique index coffee_users_name_key on public.coffee_users (lower(btrim(first_name)), lower(btrim(last_name)));

create table public.coffee_meetings (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  meeting_date date not null,
  start_time time not null
);

create table public.coffee_orders (
  id uuid primary key default gen_random_uuid(),
  coffee_type text not null check (coffee_type in ('Cappuccino', 'Latte', 'Americano', 'Espresso')),
  user_id uuid not null references public.coffee_users(id),
  meeting_id uuid not null references public.coffee_meetings(id),
  unique (user_id, meeting_id)
);

-- One small technical table remembers logins. Only a digest of a session token is stored.
create table coffee_private.sessions (
  token_hash bytea primary key,
  user_id uuid not null references public.coffee_users(id) on delete cascade,
  expires_at timestamptz not null
);
create index on coffee_private.sessions(user_id);

alter table public.coffee_users enable row level security;
alter table public.coffee_meetings enable row level security;
alter table public.coffee_orders enable row level security;
alter table coffee_private.sessions enable row level security;
revoke all on public.coffee_users, public.coffee_meetings, public.coffee_orders from public, anon, authenticated;
revoke all on coffee_private.sessions from public, anon, authenticated;

create function coffee_private.current_user(p_token text)
returns public.coffee_users
language plpgsql stable security definer set search_path = '' as $$
declare v_user public.coffee_users;
begin
  select u.* into v_user
  from coffee_private.sessions s join public.coffee_users u on u.id = s.user_id
  where s.token_hash = extensions.digest(p_token, 'sha256') and s.expires_at > now();
  if not found then raise exception 'Sesja wygasła. Zaloguj się ponownie.'; end if;
  return v_user;
end;
$$;
revoke all on function coffee_private.current_user(text) from public, anon, authenticated;

create function public.coffee_login(p_first_name text, p_last_name text, p_password text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user public.coffee_users;
  v_token text;
  v_error jsonb := jsonb_build_object('error', 'Nieprawidłowe imię, nazwisko lub hasło.');
begin
  if p_password is null or octet_length(p_password) > 72 or p_first_name is null or p_last_name is null then return v_error; end if;
  select * into v_user from public.coffee_users
  where lower(btrim(first_name)) = lower(btrim(p_first_name))
    and lower(btrim(last_name)) = lower(btrim(p_last_name)) for update;
  if not found or v_user.locked_until > now() then return v_error; end if;
  if v_user.locked_until <= now() then v_user.failed_logins := 0; end if;
  if extensions.crypt(p_password, v_user.password_hash) is distinct from v_user.password_hash then
    update public.coffee_users set failed_logins = v_user.failed_logins + 1,
      locked_until = case when v_user.failed_logins + 1 >= 5 then now() + interval '15 minutes' else null end
    where id = v_user.id;
    -- Return instead of throwing, so the failure counter is committed.
    return v_error;
  end if;
  update public.coffee_users set failed_logins = 0, locked_until = null where id = v_user.id;
  delete from coffee_private.sessions where expires_at <= now();
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into coffee_private.sessions values (extensions.digest(v_token, 'sha256'), v_user.id, now() + interval '7 days');
  return jsonb_build_object('token', v_token, 'user', jsonb_build_object(
    'id', v_user.id, 'firstName', v_user.first_name, 'lastName', v_user.last_name, 'isAdmin', v_user.is_admin));
end;
$$;

create function public.coffee_state(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user public.coffee_users;
begin
  v_user := coffee_private.current_user(p_token);
  return jsonb_build_object(
    'user', jsonb_build_object('id', v_user.id, 'firstName', v_user.first_name, 'lastName', v_user.last_name, 'isAdmin', v_user.is_admin),
    'meetings', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name,
      'startsAt', (m.meeting_date + m.start_time) at time zone 'Europe/Warsaw') order by m.meeting_date, m.start_time)
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

create function public.coffee_save_order(p_token text, p_meeting_id uuid, p_coffee_type text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user public.coffee_users; v_starts_at timestamptz;
begin
  v_user := coffee_private.current_user(p_token);
  select (meeting_date + start_time) at time zone 'Europe/Warsaw' into v_starts_at
  from public.coffee_meetings where id = p_meeting_id;
  if v_starts_at is null or v_starts_at <= now() then raise exception 'Zamówienia na to spotkanie są zamknięte.'; end if;
  if p_coffee_type is null or p_coffee_type not in ('Cappuccino', 'Latte', 'Americano', 'Espresso') then raise exception 'Wybierz kawę z listy.'; end if;
  insert into public.coffee_orders (coffee_type, user_id, meeting_id) values (p_coffee_type, v_user.id, p_meeting_id)
  on conflict (user_id, meeting_id) do update set coffee_type = excluded.coffee_type;
  return '{}'::jsonb;
end;
$$;

create function public.coffee_delete_order(p_token text, p_meeting_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user public.coffee_users; v_starts_at timestamptz;
begin
  v_user := coffee_private.current_user(p_token);
  select (meeting_date + start_time) at time zone 'Europe/Warsaw' into v_starts_at
  from public.coffee_meetings where id = p_meeting_id;
  if v_starts_at is null or v_starts_at <= now() then raise exception 'Zamówienia na to spotkanie są zamknięte.'; end if;
  delete from public.coffee_orders where user_id = v_user.id and meeting_id = p_meeting_id;
  return '{}'::jsonb;
end;
$$;

create function public.coffee_create_meeting(p_token text, p_name text, p_starts_at timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user public.coffee_users;
begin
  v_user := coffee_private.current_user(p_token);
  if not v_user.is_admin then raise exception 'Ta czynność jest dostępna tylko dla admina.'; end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 120 or p_starts_at is null or p_starts_at <= now() then
    raise exception 'Podaj nazwę i przyszłą datę spotkania.';
  end if;
  insert into public.coffee_meetings(name, meeting_date, start_time)
  values(btrim(p_name), (p_starts_at at time zone 'Europe/Warsaw')::date, (p_starts_at at time zone 'Europe/Warsaw')::time);
  return '{}'::jsonb;
end;
$$;

create function public.coffee_create_user(p_token text, p_first_name text, p_last_name text, p_password text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user public.coffee_users;
begin
  v_user := coffee_private.current_user(p_token);
  if not v_user.is_admin then raise exception 'Ta czynność jest dostępna tylko dla admina.'; end if;
  if p_first_name is null or p_last_name is null or char_length(btrim(p_first_name)) not between 1 and 80 or char_length(btrim(p_last_name)) not between 1 and 80 then
    raise exception 'Podaj imię i nazwisko (do 80 znaków).';
  end if;
  if p_password is null or char_length(p_password) < 8 or octet_length(p_password) > 72 then raise exception 'Hasło musi mieć co najmniej 8 znaków i maksymalnie 72 bajty.'; end if;
  insert into public.coffee_users(first_name, last_name, password_hash)
  values(btrim(p_first_name), btrim(p_last_name), extensions.crypt(p_password, extensions.gen_salt('bf', 10)));
  return '{}'::jsonb;
exception when unique_violation then raise exception 'Osoba o tym imieniu i nazwisku już istnieje.';
end;
$$;

create function public.coffee_reset_password(p_token text, p_user_id uuid, p_password text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user public.coffee_users;
begin
  v_user := coffee_private.current_user(p_token);
  if not v_user.is_admin then raise exception 'Ta czynność jest dostępna tylko dla admina.'; end if;
  if p_password is null or char_length(p_password) < 8 or octet_length(p_password) > 72 then raise exception 'Hasło musi mieć co najmniej 8 znaków i maksymalnie 72 bajty.'; end if;
  update public.coffee_users set password_hash = extensions.crypt(p_password, extensions.gen_salt('bf', 10)),
    failed_logins = 0, locked_until = null where id = p_user_id;
  if not found then raise exception 'Nie znaleziono użytkownika.'; end if;
  delete from coffee_private.sessions where user_id = p_user_id;
  return '{}'::jsonb;
end;
$$;

create function public.coffee_logout(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  delete from coffee_private.sessions where token_hash = extensions.digest(p_token, 'sha256');
  return '{}'::jsonb;
end;
$$;

-- PostgreSQL grants function execution to PUBLIC by default. Restrict explicitly.
revoke all on function public.coffee_login(text,text,text), public.coffee_state(text),
  public.coffee_save_order(text,uuid,text), public.coffee_delete_order(text,uuid),
  public.coffee_create_meeting(text,text,timestamptz), public.coffee_create_user(text,text,text,text),
  public.coffee_reset_password(text,uuid,text), public.coffee_logout(text) from public;
grant execute on function public.coffee_login(text,text,text), public.coffee_state(text),
  public.coffee_save_order(text,uuid,text), public.coffee_delete_order(text,uuid),
  public.coffee_create_meeting(text,text,timestamptz), public.coffee_create_user(text,text,text,text),
  public.coffee_reset_password(text,uuid,text), public.coffee_logout(text) to anon;

notify pgrst, 'reload schema';
commit;
