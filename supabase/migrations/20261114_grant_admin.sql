-- Add the admin promotion RPC to an existing project. No schema or data changes
-- happen until an authenticated admin calls this function.
begin;

create or replace function public.coffee_grant_admin(p_token text, p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor public.coffee_users;
begin
  v_actor := coffee_private.current_user(p_token);
  if not v_actor.is_admin then
    raise exception 'Ta czynność jest dostępna tylko dla admina.';
  end if;

  update public.coffee_users set is_admin = true
  where id = p_user_id and not is_admin;
  if found then
    -- Require a new login so no previously issued participant token gains admin access.
    delete from coffee_private.sessions where user_id = p_user_id;
  elsif not exists (select 1 from public.coffee_users where id = p_user_id) then
    raise exception 'Nie znaleziono użytkownika.';
  end if;
  return '{}'::jsonb;
end;
$$;

revoke all on function public.coffee_grant_admin(text, uuid) from public, anon, authenticated;
grant execute on function public.coffee_grant_admin(text, uuid) to anon;

notify pgrst, 'reload schema';
commit;
