import "@angular/compiler";
import { test } from "node:test";
import assert from "node:assert/strict";
import { CoffeeService } from "../src/app/coffee.service";
import type { State } from "../src/app/models";
import { COFFEE_TYPES } from "./fixtures";

test("Supabase configuration is required, existing sessions survive, expired sessions are cleared", async (t) => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "document", {
    configurable: true, value: { baseURI: "https://example.test/kawa/" },
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  t.after(() => {
    for (const [key, descriptor] of [["document", originalDocument], ["localStorage", originalStorage]] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const config = { supabaseUrl: "https://example.supabase.co", supabasePublicKey: "sb_publishable_test" };
  let configResponse = () => Response.json(config);
  let expired = false;
  const calls: { url: string; body: unknown }[] = [];
  t.mock.method(globalThis, "fetch", async (input: URL | string, init?: RequestInit) => {
    if (String(input) === "https://example.test/kawa/config.json") return configResponse();
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    if (expired) return Response.json({ message: "Sesja wygasła. Zaloguj się ponownie." }, { status: 400 });
    return Response.json({ user: { id: "user" }, meetings: [], orders: [], coffeeTypes: [], users: [] });
  });
  configResponse = () => new Response(null, { status: 404 });
  await assert.rejects(new CoffeeService().init(), /konfiguracji aplikacji/);
  configResponse = () => Response.json({ supabaseUrl: "", supabasePublicKey: "" });
  await assert.rejects(new CoffeeService().init(), /Uzupełnij adres/);
  assert.equal(calls.length, 0);
  configResponse = () => Response.json(config);
  assert.equal(await new CoffeeService().init(), null);
  const sessionKey = `kawa-syloe.session:${config.supabaseUrl}`;
  values.set(sessionKey, "existing-token");
  const api = new CoffeeService();
  assert.equal((await api.init())?.user.id, "user");
  assert.deepEqual(calls[0], {
    url: `${config.supabaseUrl}/rest/v1/rpc/coffee_state`, body: { p_token: "existing-token" },
  });
  expired = true;
  await assert.rejects(api.logout(), /Sesja wygasła/);
  assert.equal(values.get(sessionKey), "existing-token");
  assert.equal(await new CoffeeService().init(), null);
  assert.equal(values.has(sessionKey), false);
});

test("guest browser session: no writes before save, lost-response retry uses same token, reload and expiry", async (t) => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "document", { configurable: true, value: { baseURI: "https://example.test/" } });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  t.after(() => {
    for (const [key, descriptor] of [["document", originalDocument], ["localStorage", originalStorage]] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const meeting = { id: "meeting", name: "Spotkanie", startsAt: new Date().toISOString(), coffeeTypes: ["Czarna"] };
  const config = { supabaseUrl: "https://example.supabase.co", supabasePublicKey: "sb_publishable_test" };
  let persisted: State | null = null;
  let expired = false;
  let menuAvailable = true;
  const writes: Record<string, any>[] = [];
  t.mock.method(globalThis, "fetch", async (input: URL | string, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("config.json")) return Response.json(config);
    const args = JSON.parse(String(init?.body));
    if (url.endsWith("coffee_guest_menu")) return Response.json({ meeting: menuAvailable ? meeting : null, coffeeTypes: COFFEE_TYPES });
    if (url.endsWith("coffee_guest_state")) return expired ? Response.json({ message: "Sesja gościa wygasła." }, { status: 400 }) : Response.json(persisted);
    if (url.endsWith("coffee_guest_save_order")) {
      writes.push(args);
      assert.ok(values.has(`kawa-syloe.session:${config.supabaseUrl}:guest`));
      persisted = {
        user: { id: "guest", firstName: args.p_name, lastName: "", isAdmin: false, isGuest: true },
        meetings: [meeting], coffeeTypes: COFFEE_TYPES, users: [],
        orders: [{ id: "order", userId: "guest", meetingId: "meeting", coffeeType: args.p_coffee_type }],
        guest: { meetingId: "meeting", expiresAt: new Date(Date.now() + 12 * 3600000).toISOString() },
      };
      if (writes.length === 1) throw new Error("Lost response after successful write");
      return Response.json({});
    }
    throw new Error(`Unexpected API call: ${url}`);
  });
  const api = new CoffeeService();
  assert.equal(await api.init(), null);
  assert.equal((await api.enterGuest("  Ala  ")).user.firstName, "Ala");
  assert.equal(values.size, 0);
  assert.equal(writes.length, 0);
  await assert.rejects(api.saveOrder("meeting", "Czarna"), /Brak połączenia/);
  await api.saveOrder("meeting", "Czarna");
  assert.match(writes[0].p_token, /^[0-9a-f]{64}$/);
  assert.equal(writes[0].p_token, writes[1].p_token);
  assert.equal((await api.state()).orders[0].coffeeType, "Czarna");
  const resumed = new CoffeeService();
  assert.equal((await resumed.init())?.user.firstName, "Ala");
  assert.equal(writes.length, 2);
  expired = true;
  assert.equal(await new CoffeeService().init(), null);
  assert.equal(values.size, 0);
  menuAvailable = false;
  await assert.rejects(new CoffeeService().enterGuest("Ala"), /w dniu najbliższego spotkania/);
});
