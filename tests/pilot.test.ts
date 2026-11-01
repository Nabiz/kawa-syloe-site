import "@angular/compiler";
import { Injector, runInInjectionContext } from "@angular/core";
import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../src/app/app";
import { CoffeeService } from "../src/app/coffee.service";
import { MEETING_DURATION_MS, meetingStatus, upcomingMeetings } from "../src/app/meetings";
import type { Meeting, State } from "../src/app/models";
import { COFFEE_TYPES } from "./fixtures";

test("meetings: only two nearest future dates, past dates excluded, boundary and no mutation", () => {
  const now = Date.parse("2026-11-01T08:00:00Z");
  const events: Meeting[] = Array.from({ length: 100 }, (_, index) => ({
    id: String(index),
    name: String(index),
    startsAt: new Date(now + (index - 60) * 86400000).toISOString(),
    coffeeTypes: [],
  })).reverse();
  assert.deepEqual(upcomingMeetings(events, now).map((m) => m.id), ["60", "61"]);
  assert.equal(meetingStatus(events.find((m) => m.id === "60")!, now), "ongoing");
  assert.deepEqual(upcomingMeetings(events, now + MEETING_DURATION_MS).map((m) => m.id), ["61", "62"]);
  assert.deepEqual(upcomingMeetings(events, now + 39 * 86400000).map((m) => m.id), ["99"]);
  assert.deepEqual(upcomingMeetings(events, now + 39 * 86400000 + MEETING_DURATION_MS), []);
  assert.equal(events[0].id, "99");
});

test("meeting selection: two dates in participant and admin views, own menu/orders and rollover", async () => {
  const now = Date.now();
  const events: Meeting[] = Array.from({ length: 14 }, (_, index) => ({
    id: String(index),
    name: `Spotkanie ${index}`,
    startsAt: new Date(now + (index + 1) * 7 * 86400000).toISOString(),
    coffeeTypes: [index === 1 ? "Biała" : "Czarna"],
  }));
  const state: State = {
    user: { id: "anna", firstName: "Anna", lastName: "Nowak", isAdmin: true },
    meetings: [...events].reverse(),
    orders: [{ id: "saved", userId: "anna", meetingId: "1", coffeeType: "Biała" }],
    users: [],
    coffeeTypes: structuredClone(COFFEE_TYPES),
  };
  const writes: string[] = [];
  const api = {
    init: async () => structuredClone(state),
    state: async () => structuredClone(state),
    saveOrder: async (id: string) => { writes.push(id); },
    createMeeting: async () => { state.meetings.push({ ...events[13], id: "new", name: "Dalszy termin" }); },
  };
  const injector = Injector.create({ providers: [{ provide: CoffeeService, useValue: api }] });
  const app = runInInjectionContext(injector, () => new App());
  try {
    await app.ngOnInit();
    assert.equal(app.meeting()?.id, "0");
    assert.deepEqual(app.visibleMeetings().map((m) => m.id), ["0", "1"]);
    app.chooseCoffee("Czarna");
    app.selectMeeting("1");
    assert.deepEqual(app.coffees().map((c) => c.name), ["Biała"]);
    assert.equal(app.selectedCoffee(), "Biała");
    assert.equal(app.savedCoffee(), "Biała");
    app.selectMeeting("13");
    assert.equal(app.meeting()?.id, "1");
    await app.saveOrder();
    assert.deepEqual(writes, ["1"]);
    app.selectMeeting("0");
    assert.equal(app.selectedCoffee(), "");
    app.changeView("meetings");
    assert.deepEqual(app.visibleMeetings().map((m) => m.id), ["0", "1"]);
    app.meetingName = "Dalszy termin";
    app.meetingDate = "2099-01-01T10:00";
    await app.createMeeting();
    assert.equal(app.meetingId(), "0");
    assert.match(app.notice(), /Spotkanie zostało dodane/);
    app.now.set(Date.parse(events[0].startsAt) + MEETING_DURATION_MS);
    assert.deepEqual(app.visibleMeetings().map((m) => m.id), ["1", "2"]);
    assert.equal(app.meeting()?.id, "1");
    state.meetings = [events[13]];
    await app.refresh();
    assert.equal(app.visibleMeetings().length, 1);
    app.now.set(Date.parse(events[13].startsAt) + MEETING_DURATION_MS);
    assert.deepEqual(app.visibleMeetings(), []);
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
    coffeeTypes: COFFEE_TYPES.map((c) => c.name),
  };
  const state: State = {
    user: { id: "anna", firstName: "Anna", lastName: "Nowak", isAdmin: true },
    meetings: [meeting],
    orders: [],
    users: [],
    coffeeTypes: structuredClone(COFFEE_TYPES),
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

test("guest UI: a single bound meeting, in-progress ordering and no switch to next after closure", async () => {
  const now = Date.now();
  const meeting: Meeting = {
    id: "today", name: "Dzisiaj", startsAt: new Date(now - 3600000).toISOString(), coffeeTypes: ["Czarna"],
  };
  const guest: State = {
    user: { id: "guest", firstName: "Ala", lastName: "", isAdmin: false, isGuest: true },
    guest: { meetingId: "today", expiresAt: new Date(now + 12 * 3600000).toISOString() },
    meetings: [meeting, { ...meeting, id: "next", startsAt: new Date(now + 86400000).toISOString() }],
    coffeeTypes: structuredClone(COFFEE_TYPES), orders: [], users: [],
  };
  const writes: string[] = [];
  let full = false;
  const injector = Injector.create({ providers: [{ provide: CoffeeService, useValue: {
    init: async () => null, enterGuest: async () => structuredClone(guest),
    state: async () => structuredClone(guest), saveOrder: async (id: string) => {
      if (full) throw new Error("Osiągnięto limit zamówień gości");
      writes.push(id);
    },
    logout: async () => {},
  } }] });
  const app = runInInjectionContext(injector, () => new App());
  try {
    await app.ngOnInit();
    app.openGuest();
    app.guestName = "Ala";
    await app.enterGuest();
    assert.equal(app.meetingLabel(meeting), "W trakcie");
    assert.equal(app.visibleMeetings().length, 1);
    app.selectMeeting("next");
    assert.equal(app.meeting()?.id, "today");
    app.chooseCoffee("Czarna");
    await app.saveOrder();
    assert.deepEqual(writes, ["today"]);
    full = true;
    app.chooseCoffee("Czarna");
    await app.saveOrder();
    assert.equal(app.error(), "Osiągnięto limit zamówień gości");
    assert.equal(app.retryAvailable(), false);
    app.now.set(Date.parse(meeting.startsAt) + MEETING_DURATION_MS);
    assert.equal(app.meeting()?.id, "today");
    assert.equal(app.meetingLabel(meeting), "Zakończone");
    await app.saveOrder();
    assert.deepEqual(writes, ["today"]);
    assert.match(app.error(), /zamknięte/);
    await app.logout();
    assert.equal(app.authView(), "login");
    assert.equal(app.data(), null);
    assert.equal(app.guestName, "");
  } finally { app.ngOnDestroy(); injector.destroy(); }
});
