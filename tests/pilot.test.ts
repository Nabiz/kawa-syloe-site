import "@angular/compiler";
import { Injector, runInInjectionContext } from "@angular/core";
import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../src/app/app";
import { CoffeeService } from "../src/app/coffee.service";
import { archivedMeetings, upcomingMeetings } from "../src/app/meetings";
import {
  DEFAULT_COFFEE_TYPES,
  type Meeting,
  type State,
} from "../src/app/models";
import { DemoStore } from "../src/app/demo-store";

test("meetings: all future events, fifty archived events, boundary and no future fallback", () => {
  const now = Date.parse("2026-10-22T10:00:00Z");
  const events: Meeting[] = Array.from({ length: 54 }, (_, index) => ({
    id: String(index),
    name: String(index),
    startsAt: new Date(now + (index - 50) * 86400000).toISOString(),
    coffeeTypes: [],
  })).reverse();
  assert.deepEqual(
    upcomingMeetings(events, now).map((m) => m.id),
    ["51", "52", "53"],
  );
  assert.equal(archivedMeetings(events, now).length, 51);
  assert.equal(archivedMeetings(events, now)[0].id, "50");
  assert.deepEqual(upcomingMeetings(events, now + 4 * 86400000), []);
  assert.equal(events[0].id, "53"); // Filtering must not reorder the source.
});

test("meeting navigation: all future dates, per-meeting menu and orders, boundaries and expiry", async () => {
  const now = Date.now();
  const events: Meeting[] = Array.from({ length: 14 }, (_, index) => ({
    id: String(index),
    name: `Spotkanie ${index}`,
    startsAt: new Date(now + (index + 1) * 7 * 86400000).toISOString(),
    coffeeTypes: [index === 1 ? "Biała" : "Czarna"],
  }));
  const state: State = {
    user: { id: "anna", firstName: "Anna", lastName: "Nowak", isAdmin: false },
    meetings: [...events].reverse(),
    orders: [{ id: "saved", userId: "anna", meetingId: "1", coffeeType: "Biała" }],
    users: [],
    coffeeTypes: structuredClone(DEFAULT_COFFEE_TYPES),
  };
  const writes: string[] = [];
  const api = {
    init: async () => structuredClone(state),
    state: async () => structuredClone(state),
    saveOrder: async (id: string) => { writes.push(id); },
  };
  const injector = Injector.create({ providers: [{ provide: CoffeeService, useValue: api }] });
  const app = runInInjectionContext(injector, () => new App());
  try {
    await app.ngOnInit();
    assert.equal(app.meeting()?.id, "0");
    assert.equal(app.visibleMeetings().length, 14);
    app.moveMeeting(-1);
    assert.equal(app.meeting()?.id, "0");
    app.chooseCoffee("Czarna");
    app.showMeetingPicker.set(true);
    app.moveMeeting(1);
    assert.equal(app.showMeetingPicker(), false);
    assert.equal(app.meeting()?.id, "1");
    assert.deepEqual(app.coffees().map((c) => c.name), ["Biała"]);
    assert.equal(app.selectedCoffee(), "Biała");
    assert.equal(app.savedCoffee(), "Biała");
    app.moveMeeting(-1);
    assert.equal(app.selectedCoffee(), "");
    app.selectMeeting("13");
    app.moveMeeting(1);
    assert.equal(app.meeting()?.id, "13");
    app.busy.set(true);
    app.moveMeeting(-1);
    assert.equal(app.meeting()?.id, "13");
    app.busy.set(false);
    app.chooseCoffee("Czarna");
    await app.saveOrder();
    assert.deepEqual(writes, ["13"]);
    assert.equal(app.meeting()?.id, "13"); // Refresh keeps the chosen future date.
    app.now.set(Date.parse(events[12].startsAt));
    assert.equal(app.visibleMeetings().length, 1);
    app.moveMeeting(-1);
    assert.equal(app.meeting()?.id, "13");
    app.now.set(Date.parse(events[13].startsAt));
    assert.equal(app.visibleMeetings().length, 0);
    assert.equal(app.meeting(), undefined);
    app.moveMeeting(1);
    assert.equal(app.meeting(), undefined);
  } finally {
    app.ngOnDestroy();
    injector.destroy();
  }
});

test("UI state: preserve unsaved choice on failure, retry safely, retain acknowledged writes", async () => {
  const meeting: Meeting = {
    id: "meeting",
    name: "Spotkanie",
    startsAt: new Date(Date.now() + 86400000).toISOString(),
    coffeeTypes: DEFAULT_COFFEE_TYPES.map((c) => c.name),
  };
  const state: State = {
    user: { id: "anna", firstName: "Anna", lastName: "Nowak", isAdmin: true },
    meetings: [meeting],
    orders: [],
    users: [],
    coffeeTypes: structuredClone(DEFAULT_COFFEE_TYPES),
  };
  let saveCalls = 0;
  let createCalls = 0;
  let deleteCalls = 0;
  let failRead = false;
  const api = {
    init: async () => structuredClone(state),
    state: async () => {
      if (failRead) throw new Error("Brak połączenia");
      return structuredClone(state);
    },
    saveOrder: async (id: string, coffee: string) => {
      if (++saveCalls === 1) throw new Error("Brak połączenia");
      state.orders = [
        {
          id: "order",
          meetingId: id,
          userId: state.user.id,
          coffeeType: coffee,
        },
      ];
    },
    deleteOrder: async () => {
      deleteCalls++;
      state.orders = [];
    },
    createMeeting: async () => {
      createCalls++;
      state.meetings.push({
        ...meeting,
        id: "new-meeting",
        name: "Nowe spotkanie",
      });
    },
  };
  const injector = Injector.create({
    providers: [{ provide: CoffeeService, useValue: api }],
  });
  const app = runInInjectionContext(injector, () => new App());
  try {
    await app.ngOnInit();
    app.chooseCoffee("Czarna");
    await app.saveOrder();
    assert.equal(app.selectedCoffee(), "Czarna");
    assert.equal(app.savedCoffee(), null);
    assert.equal(app.unsavedChoice(), true);
    assert.equal(app.retryAvailable(), true);
    app.dismissFeedback();
    assert.ok(app.error()); // Closing the snackbar does not hide the inline error.
    await app.retry();
    assert.equal(saveCalls, 2);
    assert.equal(app.savedCoffee(), "Czarna");
    assert.equal(app.unsavedChoice(), false);
    assert.equal(app.error(), "");
    app.chooseCoffee("Biała");
    failRead = true;
    await app.saveOrder();
    assert.equal(app.savedCoffee(), "Biała");
    assert.match(app.error(), /Zmiana została zapisana/);
    assert.equal(app.action(), "refresh");
    failRead = false;
    await app.retry();
    assert.equal(saveCalls, 3); // Retry only fetches state after an acknowledged write.
    assert.equal(app.savedCoffee(), "Biała");
    failRead = true;
    await app.cancelOrder();
    assert.equal(app.savedCoffee(), null);
    assert.equal(app.selectedCoffee(), "");
    failRead = false;
    await app.retry();
    assert.equal(deleteCalls, 1);
    app.changeView("create");
    app.meetingName = "Nowe spotkanie";
    app.meetingDate = "2099-01-01T10:00";
    failRead = true;
    await app.createMeeting();
    assert.equal(app.view(), "meetings");
    assert.equal(app.action(), "refresh");
    assert.match(app.error(), /Spotkanie zostało dodane/);
    failRead = false;
    await app.retry();
    assert.equal(createCalls, 1);
    assert.equal(app.data()?.meetings.length, 2);
  } finally {
    app.ngOnDestroy();
    injector.destroy();
  }
});

test("demo sessions: participant lasts 180 days, admin 7, logout and reset still revoke", async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const start = Date.now();
  let now = start;
  const store = new DemoStore(storage, () => now);
  await store.init();
  const anna = await store.login("Anna", "Nowak", "Kawa123!");
  const jan = await store.login("Jan", "Kowalski", "Kawa123!");
  now = start + 8 * 86400000;
  assert.equal(store.state(anna.token).user.id, anna.user.id);
  assert.throws(() => store.state(jan.token), /Sesja wygasła/);
  now = start + 179 * 86400000;
  assert.ok(store.state(anna.token));
  const admin = await store.login("Jan", "Kowalski", "Kawa123!");
  await store.resetPassword(admin.token, anna.user.id, "NewPass123!");
  assert.throws(() => store.state(anna.token), /Sesja wygasła/);
  const newAnna = await store.login("Anna", "Nowak", "NewPass123!");
  store.logout(newAnna.token);
  assert.throws(() => store.state(newAnna.token), /Sesja wygasła/);
  const expiring = await store.login("Anna", "Nowak", "NewPass123!");
  now += 180 * 86400000 + 1;
  assert.throws(() => store.state(expiring.token), /Sesja wygasła/);
});
