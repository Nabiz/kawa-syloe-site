-- Replace the name and password BEFORE running in the Supabase SQL Editor.
-- This runs as the project owner, never from the frontend.
do $$
declare
  v_first_name text := 'WPISZ_IMIE';
  v_last_name text := 'WPISZ_NAZWISKO';
  v_password text := 'WPISZ_WLASNE_HASLO';
begin
  if v_first_name = 'WPISZ_IMIE' or v_last_name = 'WPISZ_NAZWISKO' or v_password = 'WPISZ_WLASNE_HASLO' then
    raise exception 'Najpierw wpisz własne imię, nazwisko i hasło w skrypcie.';
  end if;
  if char_length(v_password) < 8 or octet_length(v_password) > 72 then raise exception 'Hasło musi mieć co najmniej 8 znaków i maksymalnie 72 bajty.'; end if;
  insert into public.coffee_users(first_name, last_name, password_hash, is_admin)
  values (btrim(v_first_name), btrim(v_last_name), extensions.crypt(v_password, extensions.gen_salt('bf', 10)), true);
end;
$$;
