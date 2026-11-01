import {
  Component,
  computed,
  inject,
  OnDestroy,
  OnInit,
  signal,
} from "@angular/core";
import { FormsModule } from "@angular/forms";
import { CoffeeService, sessionExpired } from "./coffee.service";
import type { Meeting, State } from "./models";
import { meetingStatus, upcomingMeetings } from "./meetings";
import { warsawDateTimeToIso } from "./time";

type View = "order" | "meetings" | "create";
type Action =
  | "init"
  | "login"
  | "invitation"
  | "register"
  | "guest"
  | "save"
  | "cancel"
  | "create"
  | "refresh"
  | "logout";

@Component({
  selector: "app-root",
  standalone: true,
  imports: [FormsModule],
  templateUrl: "./app.html",
})
export class App implements OnInit, OnDestroy {
  readonly api = inject(CoffeeService);
  readonly data = signal<State | null>(null);
  readonly now = signal(Date.now());
  readonly loading = signal(true);
  readonly ready = signal(false);
  readonly busy = signal(false);
  readonly error = signal("");
  readonly notice = signal("");
  readonly feedbackClosed = signal(false);
  readonly action = signal<Action>("init");
  readonly view = signal<View>("order");
  readonly authView = signal<"login" | "invitation" | "register" | "guest">("login");
  readonly meetingId = signal("");
  readonly selectedCoffee = signal("");
  readonly visibleMeetings = computed(() => {
    const state = this.data();
    return state?.user.isGuest
      ? state.meetings.filter((meeting) => meeting.id === state.guest?.meetingId).slice(0, 1)
      : upcomingMeetings(state?.meetings ?? [], this.now());
  });
  readonly meeting = computed<Meeting | undefined>(
    () =>
      this.visibleMeetings().find((m) => m.id === this.meetingId()) ??
      this.visibleMeetings()[0],
  );
  readonly coffees = computed(
    () =>
      this.data()?.coffeeTypes.filter((c) =>
        this.meeting()?.coffeeTypes.includes(c.name),
      ) ?? [],
  );
  readonly offeredTypes = computed(
    () =>
      this.data()?.coffeeTypes.filter((c) => c.active && !c.attendanceOnly) ??
      [],
  );
  readonly ownOrder = computed(() =>
    this.data()?.orders.find(
      (o) =>
        o.meetingId === this.meeting()?.id && o.userId === this.data()?.user.id,
    ),
  );
  // Retain acknowledged writes if the following read fails.
  private readonly confirmedWrites = signal<Record<string, string | null>>({});
  readonly savedCoffee = computed(() => {
    const id = this.meeting()?.id ?? "";
    const confirmations = this.confirmedWrites();
    return Object.hasOwn(confirmations, id)
      ? confirmations[id]
      : (this.ownOrder()?.coffeeType ?? null);
  });
  readonly unsavedChoice = computed(
    () =>
      !!this.selectedCoffee() && this.selectedCoffee() !== this.savedCoffee(),
  );
  readonly meetingOrders = computed(
    () =>
      this.data()?.orders.filter((o) => o.meetingId === this.meeting()?.id) ??
      [],
  );
  readonly totals = computed(() =>
    (this.data()?.coffeeTypes ?? [])
      .map((c) => ({
        name: c.name,
        count: this.meetingOrders().filter((o) => o.coffeeType === c.name)
          .length,
      }))
      .filter((c) => c.count),
  );
  readonly retryAvailable = signal(false);
  private retryAction?: () => Promise<void>;
  private clockTimer?: ReturnType<typeof setInterval>;
  private feedbackTimer?: ReturnType<typeof setTimeout>;
  offeredCoffeeTypes: string[] = [];
  private offeringInitialized = false;
  firstName = "";
  lastName = "";
  password = "";
  guestName = "";
  registrationPassword = "";
  registrationFirstName = "";
  registrationLastName = "";
  registrationAccountPassword = "";
  registrationPasswordConfirmation = "";
  meetingName = "";
  meetingDate = "";

  async ngOnInit(): Promise<void> {
    this.clockTimer ??= setInterval(() => this.updateClock(), 30_000);
    await this.load();
  }
  ngOnDestroy(): void {
    clearInterval(this.clockTimer);
    clearTimeout(this.feedbackTimer);
  }
  private async load(): Promise<void> {
    this.loading.set(true);
    await this.run("init", async () => {
      const state = await this.api.init();
      if (state) this.setState(state);
      this.ready.set(true);
    });
    this.loading.set(false);
  }
  private updateClock(): void {
    this.now.set(Date.now());
    const expiry = this.data()?.guest?.expiresAt;
    if (expiry && Date.parse(expiry) <= this.now()) {
      this.showError(new Error("Sesja gościa wygasła."), "refresh");
      return;
    }
    const id = this.meeting()?.id ?? "";
    if (this.view() !== "create" && id !== this.meetingId())
      this.selectMeeting(id);
  }
  private setState(state: State): void {
    if (
      !Array.isArray(state.coffeeTypes) ||
      state.meetings.some((m) => !Array.isArray(m.coffeeTypes))
    )
      throw new Error(
        "Uruchom migrację 20261021_coffee_types.sql w SQL Editor Supabase.",
      );
    this.data.set(state);
    this.confirmedWrites.set({});
    this.now.set(Date.now());
    if (!this.offeringInitialized) {
      this.offeredCoffeeTypes = this.offeredTypes().map((c) => c.name);
      this.offeringInitialized = true;
    }
    this.meetingId.set(this.meeting()?.id ?? "");
    this.selectedCoffee.set(this.savedCoffee() ?? "");
  }
  changeView(view: View): void {
    if (this.busy()) return;
    this.view.set(view);
    this.selectMeeting(this.meeting()?.id ?? "");
  }
  selectMeeting(id: string): void {
    if (id && !this.visibleMeetings().some((meeting) => meeting.id === id)) return;
    this.meetingId.set(id);
    this.selectedCoffee.set(this.savedCoffee() ?? "");
    this.clearFeedback();
  }
  chooseCoffee(name: string): void {
    this.selectedCoffee.set(name);
    this.clearFeedback();
  }
  isClosed(meeting?: Meeting): boolean {
    return !!meeting && meetingStatus(meeting, this.now()) === "finished";
  }
  meetingLabel(meeting: Meeting, first = true): string {
    const status = meetingStatus(meeting, this.now());
    return status === "ongoing" ? "W trakcie" : status === "finished" ? "Zakończone" : first ? "Najbliższe spotkanie" : "Kolejne spotkanie";
  }
  date(value: string): string {
    return new Intl.DateTimeFormat("pl-PL", {
      timeZone: "Europe/Warsaw",
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(new Date(value));
  }
  time(value: string): string {
    return new Intl.DateTimeFormat("pl-PL", {
      timeZone: "Europe/Warsaw",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  }
  person(id: string): string {
    const user = this.data()?.users.find((u) => u.id === id);
    return user ? `${user.firstName} ${user.lastName}` : "Użytkownik";
  }
  toggleCoffeeType(name: string, enabled: boolean): void {
    this.offeredCoffeeTypes = enabled
      ? [...new Set([...this.offeredCoffeeTypes, name])]
      : this.offeredCoffeeTypes.filter((value) => value !== name);
  }

  async login(): Promise<void> {
    await this.run("login", async () => {
      this.view.set("order");
      this.setState(
        await this.api.login(
          this.firstName.trim(),
          this.lastName.trim(),
          this.password,
        ),
      );
      this.password = "";
      this.clearRegistration();
    });
  }
  openGuest(): void {
    this.clearRegistration();
    this.password = "";
    this.guestName = "";
    this.clearFeedback();
    this.authView.set("guest");
  }
  async enterGuest(): Promise<void> {
    await this.run("guest", async () => {
      this.view.set("order");
      this.setState(await this.api.enterGuest(this.guestName));
    });
  }
  private clearRegistration(): void {
    this.registrationPassword = "";
    this.registrationFirstName = "";
    this.registrationLastName = "";
    this.registrationAccountPassword = "";
    this.registrationPasswordConfirmation = "";
    this.authView.set("login");
  }
  openRegistration(): void {
    this.clearRegistration();
    this.password = "";
    this.clearFeedback();
    this.authView.set("invitation");
  }
  backToLogin(): void {
    this.clearRegistration();
    this.clearFeedback();
  }
  async unlockRegistration(): Promise<void> {
    await this.run("invitation", async () => {
      try {
        await this.api.checkRegistrationPassword(this.registrationPassword);
        this.authView.set("register");
      } catch (error) {
        this.registrationPassword = "";
        throw error;
      }
    });
  }
  async register(): Promise<void> {
    await this.run("register", async () => {
      if (
        this.registrationAccountPassword !==
        this.registrationPasswordConfirmation
      )
        throw new Error("Podane hasła do konta muszą być takie same.");
      try {
        await this.api.register(
          this.registrationPassword,
          this.registrationFirstName.trim(),
          this.registrationLastName.trim(),
          this.registrationAccountPassword,
        );
      } catch (error) {
        if (
          this.message(error).includes("hasło rejestracji") ||
          this.message(error).includes("Rejestracja jest teraz niedostępna")
        ) {
          this.registrationPassword = "";
          this.registrationAccountPassword = "";
          this.registrationPasswordConfirmation = "";
          this.authView.set("invitation");
        }
        throw error;
      }
      this.firstName = this.registrationFirstName.trim();
      this.lastName = this.registrationLastName.trim();
      this.password = "";
      this.clearRegistration();
      this.notify("Konto zostało utworzone. Zaloguj się swoim hasłem.");
    });
  }
  async logout(): Promise<void> {
    await this.run("logout", async () => {
      await this.api.logout();
      this.data.set(null);
      this.confirmedWrites.set({});
      this.password = "";
      this.guestName = "";
      this.clearRegistration();
      this.meetingId.set("");
      this.view.set("order");
    });
  }
  async refresh(): Promise<void> {
    await this.run("refresh", async () => {
      this.setState(await this.api.state());
      this.notify("Dane odświeżone.");
    });
  }
  async saveOrder(): Promise<void> {
    await this.run("save", async () => {
      const id = this.meeting()?.id;
      const coffee = this.selectedCoffee();
      if (!id || this.isClosed(this.meeting()))
        throw new Error("Zamówienia na to spotkanie są zamknięte.");
      if (!coffee) throw new Error("Wybierz kawę lub herbatę.");
      await this.api.saveOrder(id, coffee);
      this.confirmedWrites.update((values) => ({ ...values, [id]: coffee }));
      this.notify(`Zapisano: ${coffee}.`);
      await this.refreshAfterWrite();
    });
  }
  async cancelOrder(): Promise<void> {
    await this.run("cancel", async () => {
      const id = this.meeting()?.id;
      if (!id) return;
      if (this.isClosed(this.meeting())) throw new Error("Zamówienia na to spotkanie są zamknięte.");
      await this.api.deleteOrder(id);
      this.confirmedWrites.update((values) => ({ ...values, [id]: null }));
      this.selectedCoffee.set("");
      this.notify("Zapis na spotkanie został anulowany.");
      await this.refreshAfterWrite();
    });
  }
  private async refreshAfterWrite(): Promise<void> {
    try {
      this.setState(await this.api.state());
    } catch (error) {
      this.showError(
        new Error(
          `Zmiana została zapisana. Nie udało się odświeżyć danych: ${this.message(error)}`,
        ),
        "refresh",
        () => this.refresh(),
      );
    }
  }
  async createMeeting(): Promise<void> {
    await this.run("create", async () => {
      const previousIds = new Set(this.data()?.meetings.map((m) => m.id));
      await this.api.createMeeting(
        this.meetingName,
        warsawDateTimeToIso(this.meetingDate),
        this.offeredCoffeeTypes,
      );
      this.meetingName = "";
      this.meetingDate = "";
      this.view.set("meetings");
      this.notify("Spotkanie zostało dodane.");
      try {
        const state = await this.api.state();
        this.setState(state);
        const added = this.visibleMeetings().find((m) => !previousIds.has(m.id));
        if (added) {
          this.meetingId.set(added.id);
          this.selectedCoffee.set(this.savedCoffee() ?? "");
        }
      } catch (error) {
        this.showError(
          new Error(
            `Spotkanie zostało dodane. Nie udało się odświeżyć listy: ${this.message(error)}`,
          ),
          "refresh",
          () => this.refresh(),
        );
      }
    });
  }

  dismissFeedback(): void {
    this.feedbackClosed.set(true);
  }
  async retry(): Promise<void> {
    if (!this.busy()) await this.retryAction?.();
  }
  private clearFeedback(): void {
    clearTimeout(this.feedbackTimer);
    this.error.set("");
    this.notice.set("");
    this.feedbackClosed.set(false);
    this.retryAvailable.set(false);
    this.retryAction = undefined;
  }
  private notify(message: string): void {
    clearTimeout(this.feedbackTimer);
    this.notice.set(message);
    this.feedbackClosed.set(false);
    this.feedbackTimer = setTimeout(() => this.feedbackClosed.set(true), 7000);
  }
  private message(error: unknown): string {
    return error instanceof Error
      ? error.message
      : "Coś poszło nie tak. Spróbuj ponownie.";
  }
  private showError(
    error: unknown,
    action: Action,
    retry?: () => Promise<void>,
  ): void {
    clearTimeout(this.feedbackTimer);
    this.action.set(action);
    this.error.set(this.message(error));
    this.feedbackClosed.set(false);
    this.retryAction = retry;
    this.retryAvailable.set(!!retry);
    if (sessionExpired(error)) {
      this.api.clearSession();
      this.data.set(null);
      this.authView.set("login");
      this.confirmedWrites.set({});
      this.retryAvailable.set(false);
      this.retryAction = undefined;
    }
  }
  private async run(action: Action, work: () => Promise<void>): Promise<void> {
    if (this.busy()) return;
    this.clearFeedback();
    this.action.set(action);
    this.busy.set(true);
    try {
      await work();
    } catch (error) {
      // A timed-out INSERT may already have succeeded. Retry buttons are limited
      // to reads and the idempotent order upsert/delete, never account/meeting creation.
      const retry =
        action === "init"
          ? () => this.load()
          : action === "save" && this.message(error) !== "Osiągnięto limit zamówień gości"
            ? () => this.saveOrder()
            : action === "cancel"
              ? () => this.cancelOrder()
              : action === "refresh"
                ? () => this.refresh()
                : undefined;
      this.showError(error, action, retry);
    } finally {
      this.busy.set(false);
    }
  }
}
