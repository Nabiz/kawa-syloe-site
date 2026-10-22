import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

const path = "supabase/migrations/20261022_long_sessions.sql";
test(
  "SQL sessions: migrate valid sessions once, 180/7 day expiry, no revival, reset and logout",
  {
    skip: ["supabase/schema.sql", path].every(existsSync)
      ? false
      : "Skrypty SQL są lokalne i wykluczone z repozytorium.",
  },
  async () => {
    const db = new PGlite({ extensions: { pgcrypto } });
    try {
      await db.exec("create role anon;create role authenticated;");
      await db.exec(await readFile("supabase/schema.sql", "utf8"));
      await db.exec(`insert into public.coffee_users(first_name,last_name,password_hash,is_admin) values
      ('Jan','Kowalski',extensions.crypt('Kawa123!',extensions.gen_salt('bf',4)),true),
      ('Anna','Nowak',extensions.crypt('Kawa123!',extensions.gen_salt('bf',4)),false);`);
      const rpc = async (name: string, args: unknown[]) =>
        (
          await db.query<{ value: any }>(
            `select public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) as value`,
            args,
          )
        ).rows[0].value;
      const expiry = async (token: string) =>
        (
          await db.query<{ value: number }>(
            "select extract(epoch from expires_at)*1000 as value from coffee_private.sessions where token_hash=extensions.digest($1,'sha256')",
            [token],
          )
        ).rows[0]?.value;
      await db.exec("set role anon");
      const anna = await rpc("coffee_login", ["Anna", "Nowak", "Kawa123!"]);
      const admin = await rpc("coffee_login", ["Jan", "Kowalski", "Kawa123!"]);
      await db.exec("reset role");
      const oldAnna = Number(await expiry(anna.token));
      const oldAdmin = Number(await expiry(admin.token));
      await db.query(
        "insert into coffee_private.sessions values(extensions.digest($1,'sha256'),$2,now()-interval '1 day')",
        ["expired", anna.user.id],
      );
      const oldExpired = Number(await expiry("expired"));
      const migration = await readFile(path, "utf8");
      await db.exec(migration);
      const extended = Number(await expiry(anna.token));
      assert.equal(extended - oldAnna, 173 * 86400000);
      assert.equal(Number(await expiry(admin.token)), oldAdmin);
      assert.equal(Number(await expiry("expired")), oldExpired);
      await db.exec(migration);
      assert.equal(Number(await expiry(anna.token)), extended);
      await db.exec("set role anon");
      await assert.rejects(rpc("coffee_state", ["expired"]), /Sesja wygasła/);
      assert.ok((await rpc("coffee_login", ["Anna", "Nowak", "wrong"])).error);
      const freshAnna = await rpc("coffee_login", [
        "Anna",
        "Nowak",
        "Kawa123!",
      ]);
      const freshAdmin = await rpc("coffee_login", [
        "Jan",
        "Kowalski",
        "Kawa123!",
      ]);
      await db.exec("reset role");
      const remaining = await db.query<{ days: number }>(
        "select extract(epoch from (expires_at-now()))/86400 as days from coffee_private.sessions where token_hash=extensions.digest($1,'sha256')",
        [freshAnna.token],
      );
      assert.ok(Number(remaining.rows[0].days) > 179.99);
      assert.ok(Number(remaining.rows[0].days) <= 180);
      const adminRemaining = await db.query<{ days: number }>(
        "select extract(epoch from (expires_at-now()))/86400 as days from coffee_private.sessions where token_hash=extensions.digest($1,'sha256')",
        [freshAdmin.token],
      );
      assert.ok(
        Number(adminRemaining.rows[0].days) > 6.99 &&
          Number(adminRemaining.rows[0].days) <= 7,
      );
      await db.exec("set role anon");
      await rpc("coffee_reset_password", [
        freshAdmin.token,
        anna.user.id,
        "NewPass123!",
      ]);
      await assert.rejects(
        rpc("coffee_state", [freshAnna.token]),
        /Sesja wygasła/,
      );
      await assert.rejects(rpc("coffee_state", [anna.token]), /Sesja wygasła/);
      const newAnna = await rpc("coffee_login", [
        "Anna",
        "Nowak",
        "NewPass123!",
      ]);
      await rpc("coffee_logout", [newAnna.token]);
      await assert.rejects(
        rpc("coffee_state", [newAnna.token]),
        /Sesja wygasła/,
      );
    } finally {
      await db.close();
    }
  },
);
