import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

const scripts = ["supabase/schema.sql", "supabase/migrations/20261021_coffee_types.sql", "supabase/migrations/20261102_guests.sql"];
const options = { skip: scripts.every(existsSync) ? false : "Skrypty SQL są lokalne i wykluczone z repozytorium." };
const token = (n: number) => n.toString(16).padStart(64, "0");

test("guest RPC: lifetime cap, atomic retry, cancellation, expiry, ownership and isolation", options, async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await db.exec("create role anon; create role authenticated");
    for (const path of scripts) await db.exec(await readFile(path, "utf8"));
    // Rerunning preserves data and keeps all helpers private.
    await db.exec(await readFile(scripts[2], "utf8"));
    const rpc = async (name: string, args: unknown[] = []) => (await db.query<{ value: any }>(
      `select public.${name}(${args.map((_, index) => `$${index + 1}`).join(",")}) as value`, args,
    )).rows[0].value;
    await db.exec(`insert into public.coffee_users(first_name,last_name,password_hash,is_admin) values
      ('Admin','Test',extensions.crypt('Password123!',extensions.gen_salt('bf',4)),true),
      ('Member','Test',extensions.crypt('Password123!',extensions.gen_salt('bf',4)),false);
      insert into public.coffee_meetings(name,meeting_date,start_time)
      values ('Dzisiaj',(now() at time zone 'Europe/Warsaw')::date,(now() at time zone 'Europe/Warsaw')::time),
             ('Następne',(now() at time zone 'Europe/Warsaw')::date+7,time '10:00');
      insert into public.coffee_meeting_types select id,'Czarna' from public.coffee_meetings;
      set role anon;`);
    const menu = await rpc("coffee_guest_menu");
    const meeting = menu.meeting.id;
    assert.equal(menu.meeting.status, "ongoing");
    assert.equal(menu.coffeeTypes.length, 1);
    assert.equal(menu.orders, undefined);
    const admin = await rpc("coffee_login", ["Admin", "Test", "Password123!"]);
    const member = await rpc("coffee_login", ["Member", "Test", "Password123!"]);
    const later = (await rpc("coffee_state", [admin.token])).meetings.find((m: any) => m.name === "Następne").id;
    await assert.rejects(rpc("coffee_guest_save_order", [token(1), later, "Jan", "Czarna"]), /w dniu najbliższego/);
    await assert.rejects(rpc("coffee_guest_save_order", [token(1), meeting, " ", "Czarna"]), /Podaj imię/);
    await assert.rejects(rpc("coffee_guest_save_order", [token(1), meeting, "Jan", "Biała"]), /dostępny/);
    assert.equal(await rpc("coffee_guest_state", [token(1)]), null);
    await assert.rejects(db.query("select * from coffee_private.guests"), /permission denied/);
    await assert.rejects(db.query("select coffee_private.guest_state(gen_random_uuid())"), /permission denied/);
    await db.exec("reset role");
    assert.equal((await db.query<{ count: number }>("select count(*)::int as count from coffee_private.guests")).rows[0].count, 0);
    await db.exec("set role anon");
    await Promise.all(Array.from({ length: 5 }, () => rpc("coffee_guest_save_order", [token(1), meeting, "Jan", "Czarna"])));
    const first = await rpc("coffee_guest_state", [token(1)]);
    const expiry = first.guest.expiresAt;
    assert.ok(Math.abs(Date.parse(expiry) - Date.now() - 12 * 3600000) < 3000);
    assert.equal(first.user.isGuest, true);
    assert.equal(first.orders.length, 1);
    assert.equal(first.meetings.length, 1);
    assert.equal(first.users.length, 0);
    assert.ok(!JSON.stringify(first).includes(token(1)));
    await rpc("coffee_guest_save_order", [token(2), meeting, "Jan", "Czarna"]); // Duplicate names are allowed.
    assert.notEqual(first.user.id, (await rpc("coffee_guest_state", [token(2)])).user.id);
    await assert.rejects(rpc("coffee_guest_delete_order", [token(1), later]), /innego spotkania/);
    await rpc("coffee_guest_delete_order", [token(1), meeting]);
    assert.equal((await rpc("coffee_guest_state", [token(1)])).orders.length, 0);
    await rpc("coffee_guest_save_order", [token(1), meeting, "Jan", "Czarna"]);
    assert.equal((await rpc("coffee_guest_state", [token(1)])).guest.expiresAt, expiry);
    await rpc("coffee_guest_delete_order", [token(1), meeting]);
    await rpc("coffee_guest_logout", [token(2)]);
    await assert.rejects(rpc("coffee_guest_state", [token(2)]), /Sesja gościa wygasła/);
    await assert.rejects(rpc("coffee_guest_save_order", [token(2), meeting, "Jan", "Czarna"]), /Sesja gościa wygasła/);
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => rpc("coffee_guest_save_order", [token(i + 3), meeting, "Gość", "Czarna"])));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 8);
    for (const result of results) if (result.status === "rejected") assert.match(String(result.reason), /Osiągnięto limit zamówień gości/);
    // A cancelled guest still owns its slot and can restore its own order at capacity.
    await rpc("coffee_guest_save_order", [token(1), meeting, "Jan", "Czarna"]);
    const state = await rpc("coffee_state", [admin.token]);
    assert.equal(state.orders.filter((o: any) => o.guestName).length, 10);
    assert.equal((await rpc("coffee_state", [member.token])).orders.length, 0);
    await assert.rejects(rpc("coffee_state", [token(1)]), /Sesja wygasła/);
    await db.exec("reset role");
    const rows = (await db.query<any>("select * from coffee_private.guests order by slot")).rows;
    assert.equal(rows.length, 10);
    assert.equal(rows[0].slot, 1);
    assert.equal(rows[9].slot, 10);
    await assert.rejects(db.query("insert into coffee_private.guests(meeting_id,slot,display_name,token_hash,expires_at) values($1,11,'Overflow',decode('ff','hex'),now())", [meeting]), /check constraint/);
    await db.query("update coffee_private.guests set expires_at = now()-interval '1 second' where id=$1", [first.user.id]);
    await db.exec("set role anon");
    await assert.rejects(rpc("coffee_guest_delete_order", [token(1), meeting]), /Sesja gościa wygasła/);
    await assert.rejects(rpc("coffee_guest_save_order", [token(1), meeting, "Jan", "Czarna"]), /Sesja gościa wygasła/);
    await assert.rejects(rpc("coffee_guest_save_order", [token(99), meeting, "Jan", "Czarna"]), /Osiągnięto limit zamówień gości/);
  } finally { await db.close(); }
});

test("meeting deadlines: ordering during four hours, Warsaw guest day, closure and preserved orders", options, async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await db.exec("create role anon; create role authenticated");
    for (const path of scripts) await db.exec(await readFile(path, "utf8"));
    const rpc = async (name: string, args: unknown[] = []) => (await db.query<{ value: any }>(
      `select public.${name}(${args.map((_, index) => `$${index + 1}`).join(",")}) as value`, args,
    )).rows[0].value;
    await db.exec(`insert into public.coffee_users(first_name,last_name,password_hash) values
      ('Member','Test',extensions.crypt('Password123!',extensions.gen_salt('bf',4)));
      insert into public.coffee_meetings(name,meeting_date,start_time) values
      ('Spotkanie',(now() at time zone 'Europe/Warsaw')::date+1,time '10:00');
      insert into public.coffee_meeting_types select id,'Czarna' from public.coffee_meetings;
      set role anon;`);
    const member = await rpc("coffee_login", ["Member", "Test", "Password123!"]);
    const meeting = (await rpc("coffee_state", [member.token])).meetings[0].id;
    assert.equal((await rpc("coffee_guest_menu")).meeting, null);
    await assert.rejects(rpc("coffee_guest_save_order", [token(1), meeting, "Ala", "Czarna"]), /w dniu najbliższego/);
    await db.exec(`reset role; update public.coffee_meetings set meeting_date=(now() at time zone 'Europe/Warsaw')::date, start_time=(now() at time zone 'Europe/Warsaw')::time; set role anon;`);
    await rpc("coffee_save_order", [member.token, meeting, "Czarna"]);
    await rpc("coffee_delete_order", [member.token, meeting]);
    await rpc("coffee_save_order", [member.token, meeting, "Czarna"]);
    await rpc("coffee_guest_save_order", [token(1), meeting, "Ala", "Czarna"]);
    await db.exec(`reset role; update public.coffee_meetings set meeting_date=((now()-interval '4 hours 1 second') at time zone 'Europe/Warsaw')::date, start_time=((now()-interval '4 hours 1 second') at time zone 'Europe/Warsaw')::time; set role anon;`);
    assert.equal((await rpc("coffee_guest_menu")).meeting, null);
    for (const [name, args] of [
      ["coffee_save_order", [member.token, meeting, "Czarna"]],
      ["coffee_delete_order", [member.token, meeting]],
      ["coffee_guest_save_order", [token(1), meeting, "Ala", "Czarna"]],
      ["coffee_guest_delete_order", [token(1), meeting]],
    ] as const) await assert.rejects(rpc(name, [...args]), /zamknięte/);
    const guest = await rpc("coffee_guest_state", [token(1)]);
    assert.equal(guest.meetings[0].status, "finished");
    assert.equal(guest.orders.length, 1);
    assert.equal((await rpc("coffee_state", [member.token])).orders.length, 1);
  } finally { await db.close(); }
});
