-- 180 days from login for participants; admins keep 7 days.
-- Existing valid participant sessions are extended once, without reviving expired ones.
begin;

do $$
begin
  -- The login function is the policy marker: a rerun must not extend sessions again.
  if strpos(pg_get_functiondef('public.coffee_login(text,text,text)'::regprocedure), '180 days') = 0 then
    update coffee_private.sessions s set expires_at = s.expires_at + interval '173 days'
    from public.coffee_users u
    where u.id = s.user_id and not u.is_admin and s.expires_at > now();
  end if;
end;
$$;

create or replace function public.coffee_login(p_first_name text, p_last_name text, p_password text)
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
    return v_error;
  end if;
  update public.coffee_users set failed_logins = 0, locked_until = null where id = v_user.id;
  delete from coffee_private.sessions where expires_at <= now();
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into coffee_private.sessions values (
    extensions.digest(v_token, 'sha256'), v_user.id,
    now() + case when v_user.is_admin then interval '7 days' else interval '180 days' end
  );
  return jsonb_build_object('token', v_token, 'user', jsonb_build_object(
    'id', v_user.id, 'firstName', v_user.first_name, 'lastName', v_user.last_name, 'isAdmin', v_user.is_admin));
end;
$$;
revoke all on function public.coffee_login(text,text,text) from public, anon, authenticated;
grant execute on function public.coffee_login(text,text,text) to anon;

notify pgrst, 'reload schema';
commit;
