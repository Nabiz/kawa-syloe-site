import { test } from "node:test";
import assert from "node:assert/strict";
import { DemoStore } from "../src/app/demo-store";
import { warsawDateTimeToIso } from "../src/app/time";

test("demo: order ownership, unique orders, admin access and password reset", async () => {
  const values = new Map<string, string>();
  let now = Date.now();
  const store = new DemoStore(
    {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
    },
    () => now,
  );
  await store.init();
  await assert.rejects(store.login("Anna", "Nowak", "wrong"), /Nieprawidłowe/);
  const anna = await store.login(" anna ", "NOWAK", "Kawa123!");
  const jan = await store.login("Jan", "Kowalski", "Kawa123!");
  const meeting = store.state(anna.token).meetings[0];
  assert.equal(store.state(anna.token).users.length, 0);
  assert.ok(
    store.state(anna.token).orders.every((o) => o.userId === anna.user.id),
  );
  assert.throws(
    () =>
      store.createMeeting(
        anna.token,
        "Forbidden",
        new Date(now + 86400000).toISOString(),
        ["Czarna"],
      ),
    /admina/,
  );
  store.saveOrder(anna.token, meeting.id, "Czarna");
  store.saveOrder(anna.token, meeting.id, "Biała");
  assert.equal(store.state(anna.token).orders.length, 1);
  assert.equal(store.state(anna.token).orders[0].coffeeType, "Biała");
  assert.throws(
    () => store.saveOrder(anna.token, meeting.id, "Invalid"),
    /listy/,
  );
  store.deleteOrder(anna.token, meeting.id);
  assert.equal(store.state(anna.token).orders.length, 0);
  assert.ok(
    store.state(jan.token).orders.some((o) => o.userId === jan.user.id),
  );
  await assert.rejects(
    store.createUser(jan.token, "ANNA", "nowak", "NewPass123!"),
    /już istnieje/,
  );
  await store.createUser(jan.token, "Ewa", "Kowalska", "NewPass123!");
  await store.login("Ewa", "Kowalska", "NewPass123!");
  await store.resetPassword(jan.token, anna.user.id, "NewPass123!");
  assert.throws(() => store.state(anna.token), /Sesja wygasła/);
  await assert.rejects(
    store.login("Anna", "Nowak", "Kawa123!"),
    /Nieprawidłowe/,
  );
  now = Date.parse(meeting.startsAt) - 1000;
  const newAnna = await store.login("Anna", "Nowak", "NewPass123!");
  now = Date.parse(meeting.startsAt) + 1;
  assert.throws(
    () => store.saveOrder(newAnna.token, meeting.id, "Herbata Zimowa"),
    /zamknięte/,
  );
  store.logout(jan.token);
  assert.throws(() => store.state(jan.token), /Sesja wygasła/);
  assert.ok(!JSON.stringify([...values.values()]).includes("NewPass123!"));
});

test("Warsaw time is independent of host timezone and handles daylight saving", () => {
  assert.equal(
    warsawDateTimeToIso("2026-10-18T10:00"),
    "2026-10-18T08:00:00.000Z",
  );
  assert.equal(
    warsawDateTimeToIso("2026-11-01T10:00"),
    "2026-11-01T09:00:00.000Z",
  );
  assert.throws(() => warsawDateTimeToIso("2027-03-28T02:30"), /nie istnieje/);
  assert.throws(() => warsawDateTimeToIso("2027-02-30T10:00"), /nie istnieje/);
});
