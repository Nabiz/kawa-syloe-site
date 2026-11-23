-- Run in SQL Editor on the existing database, after schema.sql on a new project.
-- Supabase Vault must be enabled. Set coffee_registration_password in Vault's UI.
begin;

-- Only the database owner and SECURITY DEFINER functions may read the shared secret.
revoke all on schema vault from public, anon, authenticated;
revoke all on vault.secrets, vault.decrypted_secrets from public, anon, authenticated;

create or replace function public.coffee_check_registration_password(p_registration_password text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_secret text;
begin
  select decrypted_secret into v_secret from vault.decrypted_secrets
  where name = 'coffee_registration_password';
  if v_secret is null or v_secret = '' then
    raise exception 'Rejestracja jest teraz niedostępna. Skontaktuj się z adminem.';
  end if;
  if p_registration_password is null or octet_length(p_registration_password) > 1024
    or extensions.digest(p_registration_password, 'sha256') is distinct from extensions.digest(v_secret, 'sha256') then
    raise exception 'Nieprawidłowe hasło rejestracji.';
  end if;
  return '{}'::jsonb;
end;
$$;

create or replace function public.coffee_register(
  p_registration_password text, p_first_name text, p_last_name text, p_password text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  -- Recheck on every insert: showing/hiding the form is not an access control.
  perform public.coffee_check_registration_password(p_registration_password);
  if p_first_name is null or p_last_name is null
    or char_length(btrim(p_first_name)) not between 1 and 80
    or char_length(btrim(p_last_name)) not between 1 and 80 then
    raise exception 'Podaj imię i nazwisko (do 80 znaków).';
  end if;
  if p_password is null or char_length(p_password) < 8 or octet_length(p_password) > 72 then
    raise exception 'Hasło musi mieć co najmniej 8 znaków i maksymalnie 72 bajty.';
  end if;
  -- The existing unique index on lower(btrim(first_name)), lower(btrim(last_name))
  -- also prevents duplicate accounts from simultaneous requests.
  insert into public.coffee_users(first_name, last_name, password_hash, is_admin)
  values (btrim(p_first_name), btrim(p_last_name), extensions.crypt(p_password, extensions.gen_salt('bf', 10)), false);
  return '{}'::jsonb;
exception when unique_violation then
  raise exception 'Osoba o tym imieniu i nazwisku już istnieje.';
end;
$$;

revoke all on function public.coffee_check_registration_password(text),
  public.coffee_register(text,text,text,text) from public, anon, authenticated;
grant execute on function public.coffee_check_registration_password(text),
  public.coffee_register(text,text,text,text) to anon;

notify pgrst, 'reload schema';
commit;
