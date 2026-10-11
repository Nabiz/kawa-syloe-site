import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

test("PostgreSQL: RPC login, table isolation, ownership, reset and deadlines", async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await db.exec("create role anon; create role authenticated;");
    await db.exec(await readFile("supabase/schema.sql", "utf8"));
    await assert.rejects(
      db.exec(await readFile("supabase/create-admin.sql", "utf8")),
      /Najpierw wpisz/,
    );
    await db.exec(`insert into public.coffee_users(first_name,last_name,password_hash,is_admin) values
      ('Jan','Kowalski',extensions.crypt('Kawa123!',extensions.gen_salt('bf', 4)),true),
      ('Anna','Nowak',extensions.crypt('Kawa123!',extensions.gen_salt('bf', 4)),false);`);
    await db.exec("set role anon;");
    await assert.rejects(
      db.query("select * from public.coffee_users"),
      /permission denied/,
    );
    await assert.rejects(
      db.query("select * from public.coffee_orders"),
      /permission denied/,
    );
    await assert.rejects(
      db.query("select coffee_private.current_user('invalid')"),
      /permission denied/,
    );
    const rpc = async (name: string, args: unknown[]) => {
      const params = args.map((_, index) => `$${index + 1}`).join(",");
      return (
        await db.query<{ value: any }>(
          `select public.${name}(${params}) as value`,
          args,
        )
      ).rows[0].value;
    };
    assert.ok((await rpc("coffee_login", ["Anna", "Nowak", "wrong"])).error);
    const anna = await rpc("coffee_login", [" anna ", "NOWAK", "Kawa123!"]);
    const admin = await rpc("coffee_login", ["Jan", "Kowalski", "Kawa123!"]);
    assert.equal(anna.token.length, 64);
    assert.equal(anna.user.isAdmin, false);
    await assert.rejects(
      rpc("coffee_state", ["forged-token"]),
      /Sesja wygasła/,
    );
    await assert.rejects(
      rpc("coffee_create_meeting", [
        anna.token,
        "Denied",
        new Date(Date.now() + 86400000).toISOString(),
      ]),
      /admina/,
    );
    await rpc("coffee_create_meeting", [
      admin.token,
      "Niedzielna kawa",
      new Date(Date.now() + 86400000).toISOString(),
    ]);
    const meetingId = (await rpc("coffee_state", [admin.token])).meetings[0].id;
    await rpc("coffee_save_order", [anna.token, meetingId, "Latte"]);
    await rpc("coffee_save_order", [anna.token, meetingId, "Espresso"]);
    await rpc("coffee_save_order", [admin.token, meetingId, "Cappuccino"]);
    const annaState = await rpc("coffee_state", [anna.token]);
    assert.equal(annaState.orders.length, 1);
    assert.equal(annaState.orders[0].coffeeType, "Espresso");
    assert.equal(annaState.users.length, 0);
    assert.ok(!JSON.stringify(annaState).includes("password"));
    assert.equal((await rpc("coffee_state", [admin.token])).orders.length, 2);
    await assert.rejects(
      rpc("coffee_save_order", [anna.token, meetingId, "Invalid"]),
      /listy/,
    );
    await rpc("coffee_delete_order", [anna.token, meetingId]);
    assert.equal((await rpc("coffee_state", [admin.token])).orders.length, 1);
    await assert.rejects(
      rpc("coffee_create_user", [anna.token, "Ewa", "Nowak", "NewPass123!"]),
      /admina/,
    );
    await assert.rejects(
      rpc("coffee_create_user", [admin.token, "ANNA", "nowak", "NewPass123!"]),
      /już istnieje/,
    );
    await rpc("coffee_create_user", [
      admin.token,
      "Ewa",
      "Nowak",
      "NewPass123!",
    ]);
    assert.ok(
      (await rpc("coffee_login", ["Ewa", "Nowak", "NewPass123!"])).token,
    );
    await rpc("coffee_reset_password", [
      admin.token,
      anna.user.id,
      "NewPass123!",
    ]);
    await assert.rejects(rpc("coffee_state", [anna.token]), /Sesja wygasła/);
    assert.ok((await rpc("coffee_login", ["Anna", "Nowak", "Kawa123!"])).error);
    const newAnna = await rpc("coffee_login", ["Anna", "Nowak", "NewPass123!"]);
    await db.exec("reset role;");
    await db.exec(
      "update public.coffee_meetings set meeting_date = current_date - 1;",
    );
    await db.exec("set role anon;");
    await assert.rejects(
      rpc("coffee_save_order", [newAnna.token, meetingId, "Latte"]),
      /zamknięte/,
    );
    await assert.rejects(
      rpc("coffee_delete_order", [newAnna.token, meetingId]),
      /zamknięte/,
    );
    for (let i = 0; i < 5; i++)
      await rpc("coffee_login", ["Anna", "Nowak", "wrong"]);
    assert.ok(
      (await rpc("coffee_login", ["Anna", "Nowak", "NewPass123!"])).error,
    );
    await rpc("coffee_reset_password", [
      admin.token,
      anna.user.id,
      "NewPass123!",
    ]);
    assert.ok(
      (await rpc("coffee_login", ["Anna", "Nowak", "NewPass123!"])).token,
    );
    await rpc("coffee_logout", [admin.token]);
    await assert.rejects(rpc("coffee_state", [admin.token]), /Sesja wygasła/);
  } finally {
    await db.close();
  }
});
