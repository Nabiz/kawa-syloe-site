import "@angular/compiler";
import { test } from "node:test";
import assert from "node:assert/strict";
import { CoffeeService } from "../src/app/coffee.service";

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
