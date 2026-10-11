const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Warsaw",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

// datetime-local does not include a zone. Meeting times always mean Warsaw,
// including when the person creating a meeting is travelling abroad.
export function warsawDateTimeToIso(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))
    throw new Error("Podaj datę i godzinę spotkania.");
  const [year, month, day, hour, minute] = value.split(/[-T:]/).map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wall;
  for (let attempt = 0; attempt < 3; attempt++) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(guess)).map((p) => [p.type, p.value]),
    );
    const local = Date.UTC(
      +parts["year"],
      +parts["month"] - 1,
      +parts["day"],
      +parts["hour"],
      +parts["minute"],
      +parts["second"],
    );
    guess = wall - (local - guess);
  }
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(guess)).map((p) => [p.type, p.value]),
  );
  if (
    `${parts["year"]}-${parts["month"]}-${parts["day"]}T${parts["hour"]}:${parts["minute"]}` !==
    value
  ) {
    throw new Error("Ta data lub godzina nie istnieje. Wybierz inną.");
  }
  return new Date(guess).toISOString();
}
