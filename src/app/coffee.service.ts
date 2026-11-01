import { Injectable } from "@angular/core";
import type { Config, GuestMenu, Session, State } from "./models";

type GuestCredentials = { token: string; meetingId: string; name: string; createdAt: number };

export function sessionExpired(error: unknown): boolean {
  return error instanceof Error && /Sesja (gościa )?wygasła/.test(error.message);
}

@Injectable({ providedIn: "root" })
export class CoffeeService {
  private config: Config = { supabaseUrl: "", supabasePublicKey: "" };
  private token = "";
  private sessionKey = "";
  private guestActive = false;
  private guestCredentials: GuestCredentials | null = null;
  private guestPreview: State | null = null;

  async init(): Promise<State | null> {
    const response = await fetch(new URL("config.json", document.baseURI), {
      cache: "no-store",
    });
    if (!response.ok)
      throw new Error("Nie udało się wczytać konfiguracji aplikacji.");
    this.config = await response.json();
    const { supabaseUrl, supabasePublicKey } = this.config;
    if (!supabaseUrl || !supabasePublicKey)
      throw new Error("Uzupełnij adres i publiczny klucz w config.json.");
    if (
      !/^https:\/\//.test(supabaseUrl) ||
      supabasePublicKey.startsWith("sb_secret_")
    )
      throw new Error(
        "Konfiguracja wymaga adresu HTTPS i publicznego klucza Supabase.",
      );
    if (supabasePublicKey.startsWith("eyJ")) {
      try {
        const payload = JSON.parse(
          atob(
            supabasePublicKey
              .split(".")[1]
              .replace(/-/g, "+")
              .replace(/_/g, "/"),
          ),
        );
        if (payload.role !== "anon") throw new Error("invalid");
      } catch {
        throw new Error("Użyj publicznego klucza anon, nie service_role.");
      }
    }
    this.sessionKey = `kawa-syloe.session:${supabaseUrl}`;
    this.guestActive = false;
    this.token = localStorage.getItem(this.sessionKey) ?? "";
    if (this.token) {
      try {
        return await this.state();
      } catch (error) {
        if (!sessionExpired(error)) throw error;
        this.clearSession();
      }
    }
    try {
      const raw = localStorage.getItem(`${this.sessionKey}:guest`);
      this.guestCredentials = raw ? JSON.parse(raw) : null;
      if (this.guestCredentials && !/^[0-9a-f]{64}$/.test(this.guestCredentials.token)) this.guestCredentials = null;
    } catch { this.guestCredentials = null; }
    if (!this.guestCredentials) return null;
    this.guestActive = true;
    try {
      const state = await this.rpc<State | null>("coffee_guest_state", { p_token: this.guestCredentials.token });
      if (!state) this.guestActive = false; // Pending first write: retain the token for a safe retry.
      return state;
    } catch (error) {
      if (!sessionExpired(error)) throw error;
      this.clearSession();
      return null;
    }
  }

  async login(
    firstName: string,
    lastName: string,
    password: string,
  ): Promise<State> {
    const session: Session = await this.rpc("coffee_login", {
      p_first_name: firstName,
      p_last_name: lastName,
      p_password: password,
    });
    this.token = session.token;
    this.guestActive = false;
    localStorage.setItem(this.sessionKey, this.token);
    return this.state();
  }

  async state(): Promise<State> {
    if (this.guestActive) {
      if (!this.guestCredentials && this.guestPreview) return this.guestPreview;
      const state = await this.rpc<State | null>("coffee_guest_state", { p_token: this.guestCredentials?.token });
      if (!state) throw new Error("Nie otrzymaliśmy potwierdzenia zapisu. Spróbuj zapisać wybór ponownie.");
      return state;
    }
    return this.rpc("coffee_state", { p_token: this.token });
  }

  async enterGuest(name: string): Promise<State> {
    const menu = await this.rpc<GuestMenu>("coffee_guest_menu", {});
    if (!menu.meeting) throw new Error("Zamawianie jako gość jest dostępne w dniu najbliższego spotkania.");
    if (!name.trim() || name.trim().length > 80) throw new Error("Podaj imię (do 80 znaków).");
    if (this.guestCredentials?.meetingId !== menu.meeting.id || Date.now() - this.guestCredentials.createdAt >= 12 * 60 * 60 * 1000) {
      this.guestCredentials = null;
      localStorage.removeItem(`${this.sessionKey}:guest`);
    }
    if (this.guestCredentials) {
      this.guestActive = true;
      const saved = await this.rpc<State | null>("coffee_guest_state", { p_token: this.guestCredentials.token });
      if (saved) return saved;
      this.guestCredentials.name = name.trim();
    }
    this.guestPreview = {
      user: { id: "", firstName: name.trim(), lastName: "", isAdmin: false, isGuest: true },
      meetings: [menu.meeting], coffeeTypes: menu.coffeeTypes, orders: [], users: [],
      guest: { meetingId: menu.meeting.id, expiresAt: null },
    };
    this.guestActive = true;
    return this.guestPreview;
  }

  async checkRegistrationPassword(password: string): Promise<void> {
    await this.rpc("coffee_check_registration_password", {
      p_registration_password: password,
    });
  }

  async register(
    registrationPassword: string,
    firstName: string,
    lastName: string,
    password: string,
  ): Promise<void> {
    await this.rpc("coffee_register", {
      p_registration_password: registrationPassword,
      p_first_name: firstName,
      p_last_name: lastName,
      p_password: password,
    });
  }

  async saveOrder(meetingId: string, coffeeType: string): Promise<void> {
    if (this.guestActive) {
      if (!this.guestCredentials) {
        if (!this.guestPreview) throw new Error("Sesja gościa wygasła.");
        this.guestCredentials = {
          token: Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join(""),
          meetingId, name: this.guestPreview.user.firstName, createdAt: Date.now(),
        };
      }
      // Persist before sending: a lost response must retry with the same token.
      localStorage.setItem(`${this.sessionKey}:guest`, JSON.stringify(this.guestCredentials));
      await this.rpc("coffee_guest_save_order", {
        p_token: this.guestCredentials.token, p_meeting_id: meetingId,
        p_name: this.guestCredentials.name, p_coffee_type: coffeeType,
      });
      return;
    }
    await this.rpc("coffee_save_order", {
      p_token: this.token,
      p_meeting_id: meetingId,
      p_coffee_type: coffeeType,
    });
  }

  async deleteOrder(meetingId: string): Promise<void> {
    if (this.guestActive) {
      await this.rpc("coffee_guest_delete_order", { p_token: this.guestCredentials?.token, p_meeting_id: meetingId });
      return;
    }
    await this.rpc("coffee_delete_order", {
      p_token: this.token,
      p_meeting_id: meetingId,
    });
  }

  async createMeeting(
    name: string,
    startsAt: string,
    coffeeTypes: string[],
  ): Promise<void> {
    await this.rpc("coffee_create_meeting", {
      p_token: this.token,
      p_name: name,
      p_starts_at: startsAt,
      p_coffee_types: coffeeTypes,
    });
  }

  async createUser(
    firstName: string,
    lastName: string,
    password: string,
  ): Promise<void> {
    await this.rpc("coffee_create_user", {
      p_token: this.token,
      p_first_name: firstName,
      p_last_name: lastName,
      p_password: password,
    });
  }

  async resetPassword(userId: string, password: string): Promise<void> {
    await this.rpc("coffee_reset_password", {
      p_token: this.token,
      p_user_id: userId,
      p_password: password,
    });
  }

  async logout(): Promise<void> {
    if (this.guestActive) {
      if (this.guestCredentials) await this.rpc("coffee_guest_logout", { p_token: this.guestCredentials.token });
    } else await this.rpc("coffee_logout", { p_token: this.token });
    this.clearSession();
  }

  clearSession(): void {
    if (this.guestActive) {
      this.guestCredentials = null;
      this.guestPreview = null;
      this.guestActive = false;
      localStorage.removeItem(`${this.sessionKey}:guest`);
      return;
    }
    this.token = "";
    localStorage.removeItem(this.sessionKey);
  }

  private async rpc<T>(
    name: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    const key = this.config.supabasePublicKey;
    let response: Response;
    try {
      response = await fetch(
        `${this.config.supabaseUrl.replace(/\/$/, "")}/rest/v1/rpc/${name}`,
        {
          method: "POST",
          headers: {
            apikey: key,
            "Content-Type": "application/json",
            ...(key.startsWith("eyJ")
              ? { Authorization: `Bearer ${key}` }
              : {}),
          },
          body: JSON.stringify(args),
          signal: AbortSignal.timeout(15000),
        },
      );
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError")
      )
        throw new Error(
          "Przekroczono czas oczekiwania. Nie otrzymaliśmy potwierdzenia operacji.",
        );
      throw new Error(
        "Brak połączenia z Supabase. Sprawdź internet. Nie otrzymaliśmy potwierdzenia operacji.",
      );
    }
    const data = await response.json();
    if (!response.ok || data?.error) {
      const message =
        data?.error ?? data?.message ?? "Nie udało się wykonać operacji.";
      if (data?.code === "PGRST202")
        throw new Error(
          name.startsWith("coffee_guest_")
            ? "Uruchom migrację 20261102_guests.sql w SQL Editor Supabase."
            : name === "coffee_create_meeting"
            ? "Uruchom migrację 20261021_coffee_types.sql w SQL Editor Supabase."
            : name === "coffee_register" ||
                name === "coffee_check_registration_password"
              ? "Uruchom migrację 20261021_registration.sql w SQL Editor projektu Supabase."
              : "Najpierw uruchom schema.sql w SQL Editor projektu Supabase.",
        );
      throw new Error(message);
    }
    return data as T;
  }
}
