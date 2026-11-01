import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import type { State } from "../src/app/models";

const attendance = "Inna (daj znać po spotkaniu)";
const migrationPath = "supabase/migrations/20261021_coffee_types.sql";

test(
  "SQL: per-meeting menu, attendance, catalogue permissions and existing orders",
  {
    skip: ["supabase/schema.sql", migrationPath].every(existsSync)
      ? false
      : "Skrypty SQL są lokalne i wykluczone z repozytorium.",
  },
  async () => {
    const db = new PGlite({ extensions: { pgcrypto } });
    try {
      await db.exec("create role anon; create role authenticated;");
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
      await db.exec("set role anon");
      const admin = await rpc("coffee_login", ["Jan", "Kowalski", "Kawa123!"]);
      const anna = await rpc("coffee_login", ["Anna", "Nowak", "Kawa123!"]);
      await rpc("coffee_create_meeting", [
        admin.token,
        "Poprzednie spotkanie",
        new Date(Date.now() + 86400000).toISOString(),
      ]);
      const oldMeetingId = (await rpc("coffee_state", [admin.token]))
        .meetings[0].id;
      await rpc("coffee_save_order", [anna.token, oldMeetingId, "Latte"]);
      const oldOrder = (await rpc("coffee_state", [anna.token])).orders[0];
      await db.exec("reset role");
      const migration = await readFile(migrationPath, "utf8");
      await db.exec(migration);
      await db.exec("set role anon");
      const initial: State = await rpc("coffee_state", [admin.token]);
      assert.equal(initial.coffeeTypes.filter((c) => c.active).length, 4);
      assert.equal(
        initial.coffeeTypes.find((c) => c.name === attendance)?.attendanceOnly,
        true,
      );
      assert.equal(
        initial.coffeeTypes.find((c) => c.name === "Latte")?.active,
        false,
      );
      assert.deepEqual(
        initial.orders.find((o) => o.id === oldOrder.id),
        oldOrder,
      );
      await assert.rejects(
        db.query("select * from public.coffee_types"),
        /permission denied/,
      );
      await assert.rejects(
        db.query("select * from public.coffee_meeting_types"),
        /permission denied/,
      );
      await assert.rejects(
        db.query("update public.coffee_types set attendance_only = false"),
        /permission denied/,
      );
      const date = new Date(Date.now() + 172800000).toISOString();
      await assert.rejects(
        rpc("coffee_create_meeting", [
          anna.token,
          "Niedozwolone",
          date,
          ["Czarna"],
        ]),
        /admina/,
      );
      for (const menu of [null, [null], ["Latte"], ["Nieznany napój"]])
        await assert.rejects(
          rpc("coffee_create_meeting", [
            admin.token,
            "Błędne menu",
            date,
            menu,
          ]),
          /listy/,
        );
      await rpc("coffee_create_meeting", [
        admin.token,
        "Tylko czarna",
        date,
        ["Czarna", "Czarna"],
      ]);
      const limited = (
        (await rpc("coffee_state", [admin.token])) as State
      ).meetings.find((m) => m.name === "Tylko czarna")!;
      assert.deepEqual(limited.coffeeTypes, ["Czarna", attendance]);
      await assert.rejects(
        rpc("coffee_save_order", [anna.token, limited.id, "Biała"]),
        /dostępny/,
      );
      await rpc("coffee_save_order", [anna.token, limited.id, "Czarna"]);
      await rpc("coffee_save_order", [anna.token, limited.id, attendance]);
      await rpc("coffee_save_order", [admin.token, limited.id, "Czarna"]);
      const state: State = await rpc("coffee_state", [admin.token]);
      const orders = state.orders.filter((o) => o.meetingId === limited.id);
      assert.equal(orders.length, 2); // Two attendees, one beverage.
      assert.equal(
        orders.filter(
          (o) =>
            !state.coffeeTypes.find((c) => c.name === o.coffeeType)
              ?.attendanceOnly,
        ).length,
        1,
      );
      assert.equal(
        (await rpc("coffee_state", [anna.token])).orders.filter(
          (o: any) => o.meetingId === limited.id,
        ).length,
        1,
      );
      await rpc("coffee_create_meeting", [
        admin.token,
        "Sama obecność",
        date,
        [],
      ]);
      const onlyAttendance = (
        (await rpc("coffee_state", [admin.token])) as State
      ).meetings.find((m) => m.name === "Sama obecność")!;
      assert.deepEqual(onlyAttendance.coffeeTypes, [attendance]);
      await rpc("coffee_save_order", [
        anna.token,
        onlyAttendance.id,
        attendance,
      ]);
      await assert.rejects(
        rpc("coffee_save_order", [anna.token, onlyAttendance.id, "Czarna"]),
        /dostępny/,
      );
      await db.exec("reset role");
      // Even a privileged direct INSERT must respect the offered-menu foreign key.
      await assert.rejects(
        db.query(
          "insert into public.coffee_orders(coffee_type,user_id,meeting_id) values ($1,$2,$3)",
          ["Biała", admin.user.id, onlyAttendance.id],
        ),
        /foreign key/,
      );
      await db.exec(migration);
      await db.exec("set role anon");
      const rerun: State = await rpc("coffee_state", [admin.token]);
      assert.deepEqual(
        rerun.meetings.find((m) => m.id === limited.id)?.coffeeTypes,
        limited.coffeeTypes,
      );
      assert.deepEqual(
        rerun.meetings.find((m) => m.id === onlyAttendance.id)?.coffeeTypes,
        [attendance],
      );
      assert.deepEqual(
        rerun.orders.find((o) => o.id === oldOrder.id),
        oldOrder,
      );
      await rpc("coffee_delete_order", [anna.token, limited.id]);
      assert.equal(
        (await rpc("coffee_state", [admin.token])).orders.filter(
          (o: any) => o.meetingId === limited.id,
        ).length,
        1,
      );
      await db.exec("reset role");
      await db.query(
        "update public.coffee_meetings set meeting_date = current_date-1 where id=$1",
        [onlyAttendance.id],
      );
      await db.exec("set role anon");
      await assert.rejects(
        rpc("coffee_save_order", [anna.token, onlyAttendance.id, attendance]),
        /zamknięte/,
      );
    } finally {
      await db.close();
    }
  },
);
