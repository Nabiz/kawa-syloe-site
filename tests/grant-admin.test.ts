import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

const scripts = [
  "supabase/schema.sql",
  "supabase/migrations/20261021_coffee_types.sql",
  "supabase/migrations/20261022_long_sessions.sql",
  "supabase/migrations/20261102_guests.sql",
  "supabase/migrations/20261114_grant_admin.sql",
];

test("SQL promotion: admin only, existing data preserved, old sessions revoked once", {
  skip: scripts.every(existsSync) ? false : "Skrypty SQL są lokalne i wykluczone z repozytorium.",
}, async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await db.exec("create role anon; create role authenticated");
    for (const path of scripts.slice(0, -1)) await db.exec(await readFile(path, "utf8"));
    const migration = await readFile(scripts[4], "utf8");
    await db.exec(`insert into public.coffee_users(first_name,last_name,password_hash,is_admin) values
      ('Admin','Test',extensions.crypt('TestPass123!',extensions.gen_salt('bf',4)),true),
      ('Ala','Test',extensions.crypt('TestPass123!',extensions.gen_salt('bf',4)),false),
      ('Ola','Test',extensions.crypt('TestPass123!',extensions.gen_salt('bf',4)),false);
      set role anon;`);
    const rpc = async (name: string, ...args: unknown[]) => (await db.query<{ value: any }>(
      `select public.${name}(${args.map((_, index) => `$${index + 1}`).join(",")}) as value`, args,
    )).rows[0].value;
    const admin = await rpc("coffee_login", "Admin", "Test", "TestPass123!");
    const alice = await rpc("coffee_login", "Ala", "Test", "TestPass123!");
    const secondAlice = await rpc("coffee_login", "Ala", "Test", "TestPass123!");
    const ola = await rpc("coffee_login", "Ola", "Test", "TestPass123!");
    const guestToken = "a".repeat(64);
    await db.exec(`reset role;
      insert into public.coffee_meetings(name,meeting_date,start_time)
      values('Dzisiaj',(now() at time zone 'Europe/Warsaw')::date,(now() at time zone 'Europe/Warsaw')::time);
      insert into public.coffee_meeting_types select id,'Czarna' from public.coffee_meetings;
      set role anon;`);
    const menu = await rpc("coffee_guest_menu");
    await rpc("coffee_guest_save_order", guestToken, menu.meeting.id, "Gość", "Czarna");
    await rpc("coffee_save_order", alice.token, menu.meeting.id, "Czarna");
    const snapshot = await rpc("coffee_state", admin.token);
    await db.exec("reset role");
    await db.exec(migration);
    await db.exec("set role anon");
    assert.deepEqual(await rpc("coffee_state", admin.token), snapshot);
    assert.equal((await rpc("coffee_state", alice.token)).user.isAdmin, false);
    await assert.rejects(rpc("coffee_grant_admin", alice.token, alice.user.id), /tylko dla admina/);
    await assert.rejects(rpc("coffee_grant_admin", guestToken, alice.user.id), /Sesja wygasła/);
    await assert.rejects(rpc("coffee_grant_admin", "invalid", alice.user.id), /Sesja wygasła/);
    await assert.rejects(rpc("coffee_grant_admin", admin.token, "00000000-0000-0000-0000-000000000000"), /Nie znaleziono/);
    await rpc("coffee_grant_admin", admin.token, alice.user.id);
    for (const { token } of [alice, secondAlice]) {
      await assert.rejects(rpc("coffee_state", token), /Sesja wygasła/);
    }
    assert.equal((await rpc("coffee_state", ola.token)).user.isAdmin, false);
    const promoted = await rpc("coffee_login", "Ala", "Test", "TestPass123!");
    assert.equal(promoted.user.isAdmin, true);
    await rpc("coffee_grant_admin", admin.token, alice.user.id);
    await db.exec("reset role");
    await db.exec(migration);
    const expiry = (await db.query<{ days: number }>(
      "select round(extract(epoch from expires_at - now())/86400)::int as days from coffee_private.sessions where token_hash=extensions.digest($1,'sha256')",
      [promoted.token],
    )).rows[0].days;
    assert.equal(expiry, 7);
    await db.exec("set role anon");
    const after = await rpc("coffee_state", promoted.token);
    assert.equal(after.user.isAdmin, true);
    assert.deepEqual(after.orders, snapshot.orders);
    assert.equal(after.users.find((user: any) => user.id === alice.user.id).isAdmin, true);
    await db.exec("reset role; set role authenticated");
    await assert.rejects(rpc("coffee_grant_admin", admin.token, ola.user.id), /permission denied/);
  } finally {
    await db.close();
  }
});
