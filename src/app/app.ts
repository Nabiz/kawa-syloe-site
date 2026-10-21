import { Component, computed, inject, OnInit, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { CoffeeService } from "./coffee.service";
import { COFFEES, Meeting, State } from "./models";
import { warsawDateTimeToIso } from "./time";

@Component({
  selector: "app-root",
  standalone: true,
  imports: [FormsModule],
  templateUrl: "./app.html",
})
export class App implements OnInit {
  readonly api = inject(CoffeeService);
  readonly coffees = COFFEES;
  readonly data = signal<State | null>(null);
  readonly loading = signal(true);
  readonly ready = signal(false);
  readonly busy = signal(false);
  readonly error = signal("");
  readonly notice = signal("");
  readonly view = signal<"order" | "admin">("order");
  readonly authView = signal<"login" | "invitation" | "register">("login");
  readonly meetingId = signal("");
  readonly selectedCoffee = signal("");
  readonly meeting = computed(() =>
    this.data()?.meetings.find((m) => m.id === this.meetingId()),
  );
  readonly ownOrder = computed(() =>
    this.data()?.orders.find(
      (o) =>
        o.meetingId === this.meetingId() && o.userId === this.data()?.user.id,
    ),
  );
  readonly meetingOrders = computed(
    () =>
      this.data()?.orders.filter((o) => o.meetingId === this.meetingId()) ?? [],
  );
  readonly totals = computed(() =>
    this.coffees
      .map((c) => ({
        name: c.name,
        count: this.meetingOrders().filter((o) => o.coffeeType === c.name)
          .length,
      }))
      .filter((c) => c.count),
  );
  firstName = "";
  lastName = "";
  password = "";
  registrationPassword = "";
  registrationFirstName = "";
  registrationLastName = "";
  registrationAccountPassword = "";
  registrationPasswordConfirmation = "";
  meetingName = "";
  meetingDate = "";
  newFirstName = "";
  newLastName = "";
  newPassword = "";
  resetUserId = "";
  resetPasswordValue = "";

  async ngOnInit(): Promise<void> {
    try {
      const state = await this.api.init();
      if (state) this.setState(state);
      this.ready.set(true);
    } catch (error) {
      this.error.set(this.message(error));
    } finally {
      this.loading.set(false);
    }
  }

  private setState(state: State): void {
    this.data.set(state);
    if (!state.meetings.some((m) => m.id === this.meetingId())) {
      this.meetingId.set(
        (
          state.meetings.find(
            (m) => new Date(m.startsAt).getTime() > Date.now(),
          ) ?? state.meetings.at(-1)
        )?.id ?? "",
      );
    }
    this.selectedCoffee.set(this.ownOrder()?.coffeeType ?? "");
  }

  selectMeeting(id: string): void {
    this.meetingId.set(id);
    this.selectedCoffee.set(this.ownOrder()?.coffeeType ?? "");
    this.notice.set("");
  }

  isClosed(meeting?: Meeting): boolean {
    return !!meeting && Date.parse(meeting.startsAt) <= Date.now();
  }
  date(value: string): string {
    return new Intl.DateTimeFormat("pl-PL", {
      timeZone: "Europe/Warsaw",
      weekday: "long",
      day: "numeric",
      month: "long",
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

  async login(): Promise<void> {
    await this.run(async () => {
      this.setState(
        await this.api.login(
          this.firstName.trim(),
          this.lastName.trim(),
          this.password,
        ),
      );
      this.password = "";
      this.clearRegistration();
      this.view.set("order");
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
    this.error.set("");
    this.notice.set("");
    this.authView.set("invitation");
  }

  backToLogin(): void {
    this.clearRegistration();
    this.error.set("");
    this.notice.set("");
  }

  async unlockRegistration(): Promise<void> {
    await this.run(async () => {
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
    await this.run(async () => {
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
      this.notice.set("Konto zostało utworzone. Zaloguj się swoim hasłem.");
    });
  }

  demoLogin(admin: boolean): void {
    this.firstName = admin ? "Jan" : "Anna";
    this.lastName = admin ? "Kowalski" : "Nowak";
    this.password = "Kawa123!";
    void this.login();
  }

  async logout(): Promise<void> {
    await this.run(async () => {
      try {
        await this.api.logout();
      } finally {
        this.data.set(null);
        this.password = "";
        this.meetingId.set("");
        this.view.set("order");
      }
    });
  }

  async refresh(): Promise<void> {
    await this.run(async () => this.setState(await this.api.state()));
  }

  async saveOrder(): Promise<void> {
    await this.run(async () => {
      if (!this.selectedCoffee()) throw new Error("Wybierz kawę.");
      await this.api.saveOrder(this.meetingId(), this.selectedCoffee());
      this.setState(await this.api.state());
      this.notice.set("Gotowe! Twoja kawa jest na liście.");
    });
  }

  async cancelOrder(): Promise<void> {
    await this.run(async () => {
      await this.api.deleteOrder(this.meetingId());
      this.setState(await this.api.state());
      this.notice.set("Zamówienie zostało anulowane.");
    });
  }

  async createMeeting(): Promise<void> {
    await this.run(async () => {
      await this.api.createMeeting(
        this.meetingName,
        warsawDateTimeToIso(this.meetingDate),
      );
      this.setState(await this.api.state());
      this.meetingName = "";
      this.meetingDate = "";
      this.notice.set("Spotkanie zostało dodane.");
    });
  }

  async createUser(): Promise<void> {
    await this.run(async () => {
      await this.api.createUser(
        this.newFirstName,
        this.newLastName,
        this.newPassword,
      );
      this.setState(await this.api.state());
      this.newFirstName = "";
      this.newLastName = "";
      this.newPassword = "";
      this.notice.set("Konto zostało utworzone. Przekaż tej osobie hasło.");
    });
  }

  async resetPassword(): Promise<void> {
    await this.run(async () => {
      await this.api.resetPassword(this.resetUserId, this.resetPasswordValue);
      this.resetPasswordValue = "";
      this.resetUserId = "";
      this.notice.set(
        "Hasło zostało zmienione. Poprzednie sesje tej osoby wygasły.",
      );
    });
  }

  private message(error: unknown): string {
    return error instanceof Error
      ? error.message
      : "Coś poszło nie tak. Spróbuj ponownie.";
  }
  private async run(action: () => Promise<void>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set("");
    this.notice.set("");
    try {
      await action();
    } catch (error) {
      this.error.set(this.message(error));
      if (this.error().includes("Sesja wygasła")) {
        this.api.clearSession();
        this.data.set(null);
      }
    } finally {
      this.busy.set(false);
    }
  }
}
