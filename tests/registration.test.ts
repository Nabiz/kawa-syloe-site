import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

test(
  "registration SQL: secret gate, direct API protection, unique names and secret rotation",
  {
    skip: [
      "supabase/schema.sql",
      "supabase/migrations/20261021_registration.sql",
    ].every(existsSync)
      ? false
      : "Skrypty SQL są lokalne i wykluczone z repozytorium.",
  },
  async () => {
    const db = new PGlite({ extensions: { pgcrypto } });
    try {
      await db.exec("create role anon; create role authenticated;");
      await db.exec(await readFile("supabase/schema.sql", "utf8"));
      // Vault's encryption extension is Supabase-specific. Model its SQL interface
      // and permissive grants here; the actual application migration runs unchanged.
      await db.exec(`
      create schema vault;
      create table vault.secrets(name text primary key, decrypted_secret text);
      create view vault.decrypted_secrets as select * from vault.secrets;
      grant usage on schema vault to public, anon, authenticated;
      grant select on vault.secrets, vault.decrypted_secrets to public, anon, authenticated;
    `);
      const migration = await readFile(
        "supabase/migrations/20261021_registration.sql",
        "utf8",
      );
      await db.exec(migration);
      await db.exec(migration); // Safe to reapply to an existing project.
      const rpc = async (name: string, args: unknown[]) =>
        (
          await db.query<{ value: any }>(
            `select public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) as value`,
            args,
          )
        ).rows[0].value;
      await db.exec("set role anon");
      await assert.rejects(
        rpc("coffee_check_registration_password", ["anything"]),
        /niedostępna/,
      );
      await assert.rejects(
        rpc("coffee_register", ["anything", "Marta", "Nowak", "MyPass123!"]),
        /niedostępna/,
      );
      await db.exec("reset role");
      await db.query("insert into vault.secrets values ($1, $2)", [
        "coffee_registration_password",
        "OnlyFriends123!",
      ]);
      await db.exec("set role anon");
      await assert.rejects(
        db.query("select * from vault.decrypted_secrets"),
        /permission denied/,
      );
      await assert.rejects(
        db.query("select * from vault.secrets"),
        /permission denied/,
      );
      await assert.rejects(
        db.query(
          "insert into public.coffee_users(first_name,last_name,password_hash,is_admin) values ('X','Y','forged',true)",
        ),
        /permission denied/,
      );
      for (const secret of [
        null,
        "",
        "wrong",
        "onlyfriends123!",
        " OnlyFriends123! ",
        "x".repeat(1025),
      ]) {
        await assert.rejects(
          rpc("coffee_check_registration_password", [secret]),
          /hasło rejestracji/,
        );
        await assert.rejects(
          rpc("coffee_register", [secret, "Marta", "Nowak", "MyPass123!"]),
          /hasło rejestracji/,
        );
      }
      assert.deepEqual(
        await rpc("coffee_check_registration_password", ["OnlyFriends123!"]),
        {},
      );
      // Calling registration directly still requires the shared secret.
      await assert.rejects(
        rpc("coffee_register", ["wrong", "Marta", "Nowak", "MyPass123!"]),
        /hasło rejestracji/,
      );
      for (const [first, last, password] of [
        [null, "Nowak", "MyPass123!"],
        ["  ", "Nowak", "MyPass123!"],
        ["Marta", "x".repeat(81), "MyPass123!"],
        ["Marta", "Nowak", null],
        ["Marta", "Nowak", "short"],
        ["Marta", "Nowak", "ą".repeat(37)],
      ]) {
        await assert.rejects(
          rpc("coffee_register", ["OnlyFriends123!", first, last, password]),
          /Podaj imię|Hasło musi/,
        );
      }
      await rpc("coffee_register", [
        "OnlyFriends123!",
        " Marta ",
        " Nowak ",
        "MyPass123!",
      ]);
      const marta = await rpc("coffee_login", ["marta", "NOWAK", "MyPass123!"]);
      assert.equal(marta.user.isAdmin, false);
      assert.equal(marta.user.firstName, "Marta");
      assert.ok(marta.token);
      for (const [first, last] of [
        ["Marta", "Nowak"],
        [" MARTA ", "nowak "],
      ]) {
        await assert.rejects(
          rpc("coffee_register", [
            "OnlyFriends123!",
            first,
            last,
            "MyPass123!",
          ]),
          /już istnieje/,
        );
      }
      await assert.rejects(
        rpc("coffee_register", ["wrong", "Marta", "Nowak", "MyPass123!"]),
        /hasło rejestracji/,
      );
      await rpc("coffee_register", [
        "OnlyFriends123!",
        "Marta",
        "Kowalska",
        "MyPass123!",
      ]);
      await rpc("coffee_register", [
        "OnlyFriends123!",
        "Ewa",
        "Nowak",
        "MyPass123!",
      ]);
      await db.exec("reset role");
      const users = (
        await db.query<{ password_hash: string; is_admin: boolean }>(
          "select password_hash, is_admin from public.coffee_users",
        )
      ).rows;
      assert.equal(users.length, 3);
      assert.ok(
        users.every(
          (user) =>
            !user.is_admin &&
            user.password_hash !== "MyPass123!" &&
            user.password_hash.startsWith("$2"),
        ),
      );
      await db.query(
        "update vault.secrets set decrypted_secret = $1 where name = 'coffee_registration_password'",
        ["NewInvitation123!"],
      );
      await db.exec("set role anon");
      await assert.rejects(
        rpc("coffee_register", ["OnlyFriends123!", "Ola", "Lis", "MyPass123!"]),
        /hasło rejestracji/,
      );
      await rpc("coffee_register", [
        "NewInvitation123!",
        "Ola",
        "Lis",
        "MyPass123!",
      ]);
      assert.ok(
        (await rpc("coffee_login", ["Marta", "Nowak", "MyPass123!"])).token,
      );
      await db.exec(
        "reset role; update vault.secrets set decrypted_secret = ''; set role anon;",
      );
      await assert.rejects(
        rpc("coffee_register", ["", "Ola", "Kot", "MyPass123!"]),
        /niedostępna/,
      );
      await db.exec("reset role; set role authenticated;");
      await assert.rejects(
        db.query("select * from vault.decrypted_secrets"),
        /permission denied/,
      );
      await assert.rejects(
        rpc("coffee_check_registration_password", ["NewInvitation123!"]),
        /permission denied/,
      );
    } finally {
      await db.close();
    }
  },
);
