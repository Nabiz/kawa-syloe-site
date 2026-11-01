import { test } from "node:test";
import assert from "node:assert/strict";
import { warsawDateTimeToIso } from "../src/app/time";

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
