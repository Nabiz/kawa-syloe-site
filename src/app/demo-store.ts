import { DEFAULT_COFFEE_TYPES } from "./models";
import type {
  CoffeeType,
  Meeting,
  Order,
  Session,
  State,
  User,
} from "./models";

type DemoUser = User & { hash: string; salt: string };
type DemoSession = { token: string; userId: string; expiresAt: number };
type DemoData = {
  sessionPolicyVersion?: number;
  coffeeTypes: CoffeeType[];
  users: DemoUser[];
  meetings: Meeting[];
  orders: Order[];
  sessions: DemoSession[];
};
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEY = "kawa-syloe.demo.v1";
const normalize = (value: string) => value.trim().toLocaleLowerCase("pl");
const publicUser = ({ id, firstName, lastName, isAdmin }: User): User => ({
  id,
  firstName,
  lastName,
  isAdmin,
});
const hex = (value: ArrayBuffer) =>
  Array.from(new Uint8Array(value), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");

// This is a local preview, not the authentication used with Supabase.
// Demo passwords are hashed only to avoid keeping typed passwords in localStorage.
async function passwordHash(password: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return hex(
    await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: new TextEncoder().encode(salt),
        iterations: 100_000,
        hash: "SHA-256",
      },
      key,
      256,
    ),
  );
}

export class DemoStore {
  constructor(
    private readonly storage: StorageLike,
    private readonly now = () => Date.now(),
  ) {}

  async init(): Promise<void> {
    if (this.storage.getItem(KEY)) {
      const data = this.read();
      let changed = false;
      if (!data.coffeeTypes) {
        data.coffeeTypes = DEFAULT_COFFEE_TYPES.map((c) => ({ ...c }));
        for (const name of new Set(data.orders.map((o) => o.coffeeType))) {
          if (!data.coffeeTypes.some((c) => c.name === name))
            data.coffeeTypes.push({
              name,
              detail: "Wcześniejsze zamówienie",
              attendanceOnly: false,
              active: false,
            });
        }
        for (const meeting of data.meetings)
          meeting.coffeeTypes = [
            ...new Set([
              ...DEFAULT_COFFEE_TYPES.map((c) => c.name),
              ...data.orders
                .filter((o) => o.meetingId === meeting.id)
                .map((o) => o.coffeeType),
            ]),
          ];
        changed = true;
      }
      if (data.sessionPolicyVersion !== 1) {
        for (const session of data.sessions) {
          if (
            session.expiresAt > this.now() &&
            data.users.some((u) => u.id === session.userId && !u.isAdmin)
          )
            session.expiresAt += 173 * 24 * 60 * 60 * 1000;
        }
        data.sessionPolicyVersion = 1;
        changed = true;
      }
      if (changed) this.write(data);
      return;
    }
    const users: DemoUser[] = [];
    for (const [firstName, lastName, isAdmin] of [
      ["Jan", "Kowalski", true],
      ["Anna", "Nowak", false],
      ["Marek", "Wiśniewski", false],
    ] as const) {
      const salt = crypto.randomUUID();
      users.push({
        id: crypto.randomUUID(),
        firstName,
        lastName,
        isAdmin,
        salt,
        hash: await passwordHash("Kawa123!", salt),
      });
    }
    const day = new Date(this.now());
    day.setDate(day.getDate() + (7 - day.getDay() || 7));
    day.setHours(10, 0, 0, 0);
    const meeting: Meeting = {
      id: crypto.randomUUID(),
      name: "Niedzielna kawa w Syloe",
      startsAt: day.toISOString(),
      coffeeTypes: DEFAULT_COFFEE_TYPES.map((c) => c.name),
    };
    this.write({
      sessionPolicyVersion: 1,
      coffeeTypes: DEFAULT_COFFEE_TYPES.map((c) => ({ ...c })),
      users,
      meetings: [meeting],
      orders: [
        {
          id: crypto.randomUUID(),
          coffeeType: "Czarna",
          userId: users[0].id,
          meetingId: meeting.id,
        },
        {
          id: crypto.randomUUID(),
          coffeeType: "Biała",
          userId: users[1].id,
          meetingId: meeting.id,
        },
      ],
      sessions: [],
    });
  }

  private read(): DemoData {
    return JSON.parse(this.storage.getItem(KEY) ?? "{}") as DemoData;
  }
  private write(data: DemoData): void {
    this.storage.setItem(KEY, JSON.stringify(data));
  }
  private current(data: DemoData, token: string, admin = false): DemoUser {
    const session = data.sessions.find(
      (s) => s.token === token && s.expiresAt > this.now(),
    );
    const user = data.users.find((u) => u.id === session?.userId);
    if (!user) throw new Error("Sesja wygasła. Zaloguj się ponownie.");
    if (admin && !user.isAdmin)
      throw new Error("Ta czynność jest dostępna tylko dla admina.");
    return user;
  }

  async login(
    firstName: string,
    lastName: string,
    password: string,
  ): Promise<Session> {
    const data = this.read();
    const user = data.users.find(
      (u) =>
        normalize(u.firstName) === normalize(firstName) &&
        normalize(u.lastName) === normalize(lastName),
    );
    if (!user || (await passwordHash(password, user.salt)) !== user.hash)
      throw new Error("Nieprawidłowe imię, nazwisko lub hasło.");
    const token = crypto.randomUUID();
    data.sessions = data.sessions.filter((s) => s.expiresAt > this.now());
    data.sessions.push({
      token,
      userId: user.id,
      expiresAt: this.now() + (user.isAdmin ? 7 : 180) * 24 * 60 * 60 * 1000,
    });
    this.write(data);
    return { token, user: publicUser(user) };
  }

  state(token: string): State {
    const data = this.read();
    const user = this.current(data, token);
    return {
      coffeeTypes: data.coffeeTypes.map((c) => ({ ...c })),
      user: publicUser(user),
      meetings: [...data.meetings].sort((a, b) =>
        a.startsAt.localeCompare(b.startsAt),
      ),
      orders: data.orders.filter((o) => user.isAdmin || o.userId === user.id),
      users: user.isAdmin ? data.users.map(publicUser) : [],
    };
  }

  saveOrder(token: string, meetingId: string, coffeeType: string): void {
    const data = this.read();
    const user = this.current(data, token);
    const meeting = data.meetings.find((m) => m.id === meetingId);
    if (!meeting || new Date(meeting.startsAt).getTime() <= this.now())
      throw new Error("Zamówienia na to spotkanie są zamknięte.");
    if (!meeting.coffeeTypes.includes(coffeeType))
      throw new Error("Wybierz napój dostępny na tym spotkaniu z listy.");
    const previous = data.orders.find(
      (o) => o.meetingId === meetingId && o.userId === user.id,
    );
    if (previous) previous.coffeeType = coffeeType;
    else
      data.orders.push({
        id: crypto.randomUUID(),
        coffeeType,
        userId: user.id,
        meetingId,
      });
    this.write(data);
  }

  deleteOrder(token: string, meetingId: string): void {
    const data = this.read();
    const user = this.current(data, token);
    const meeting = data.meetings.find((m) => m.id === meetingId);
    if (!meeting || new Date(meeting.startsAt).getTime() <= this.now())
      throw new Error("Zamówienia na to spotkanie są zamknięte.");
    data.orders = data.orders.filter(
      (o) => o.meetingId !== meetingId || o.userId !== user.id,
    );
    this.write(data);
  }

  createMeeting(
    token: string,
    name: string,
    startsAt: string,
    coffeeTypes: string[],
  ): void {
    const data = this.read();
    this.current(data, token, true);
    if (
      !name.trim() ||
      name.trim().length > 120 ||
      !Number.isFinite(Date.parse(startsAt)) ||
      Date.parse(startsAt) <= this.now()
    )
      throw new Error("Podaj nazwę i przyszłą datę spotkania.");
    if (
      !Array.isArray(coffeeTypes) ||
      coffeeTypes.some(
        (name) => !data.coffeeTypes.some((c) => c.name === name && c.active),
      )
    )
      throw new Error("Wybierz napoje z listy.");
    data.meetings.push({
      id: crypto.randomUUID(),
      name: name.trim(),
      startsAt,
      coffeeTypes: [
        ...new Set([
          ...coffeeTypes,
          ...data.coffeeTypes
            .filter((c) => c.active && c.attendanceOnly)
            .map((c) => c.name),
        ]),
      ],
    });
    this.write(data);
  }

  async createUser(
    token: string,
    firstName: string,
    lastName: string,
    password: string,
  ): Promise<void> {
    const data = this.read();
    this.current(data, token, true);
    await this.addUser(firstName, lastName, password);
  }

  checkRegistrationPassword(password: string): void {
    // Public demo value only. Production checks the secret exclusively in SQL.
    if (password !== "SyloeDemo!")
      throw new Error("Nieprawidłowe hasło rejestracji.");
  }

  async register(
    registrationPassword: string,
    firstName: string,
    lastName: string,
    password: string,
  ): Promise<void> {
    this.checkRegistrationPassword(registrationPassword);
    await this.addUser(firstName, lastName, password);
  }

  private async addUser(
    firstName: string,
    lastName: string,
    password: string,
  ): Promise<void> {
    if (
      !firstName.trim() ||
      !lastName.trim() ||
      firstName.trim().length > 80 ||
      lastName.trim().length > 80
    )
      throw new Error("Podaj imię i nazwisko (do 80 znaków).");
    if (password.length < 8 || new TextEncoder().encode(password).length > 72)
      throw new Error(
        "Hasło musi mieć co najmniej 8 znaków i maksymalnie 72 bajty.",
      );
    const salt = crypto.randomUUID();
    const hash = await passwordHash(password, salt);
    // Read again after hashing so overlapping registrations do not lose updates.
    const data = this.read();
    if (
      data.users.some(
        (u) =>
          normalize(u.firstName) === normalize(firstName) &&
          normalize(u.lastName) === normalize(lastName),
      )
    )
      throw new Error("Osoba o tym imieniu i nazwisku już istnieje.");
    data.users.push({
      id: crypto.randomUUID(),
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      isAdmin: false,
      salt,
      hash,
    });
    this.write(data);
  }

  async resetPassword(
    token: string,
    userId: string,
    password: string,
  ): Promise<void> {
    const data = this.read();
    this.current(data, token, true);
    const user = data.users.find((u) => u.id === userId);
    if (!user) throw new Error("Nie znaleziono użytkownika.");
    if (password.length < 8 || new TextEncoder().encode(password).length > 72)
      throw new Error(
        "Hasło musi mieć co najmniej 8 znaków i maksymalnie 72 bajty.",
      );
    user.salt = crypto.randomUUID();
    user.hash = await passwordHash(password, user.salt);
    data.sessions = data.sessions.filter((s) => s.userId !== userId);
    this.write(data);
  }

  logout(token: string): void {
    const data = this.read();
    data.sessions = data.sessions.filter((s) => s.token !== token);
    this.write(data);
  }
}
