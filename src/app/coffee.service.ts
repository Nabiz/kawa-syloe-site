import { Injectable } from "@angular/core";
import { DemoStore } from "./demo-store";
import type { Config, Session, State } from "./models";

@Injectable({ providedIn: "root" })
export class CoffeeService {
  demo = true;
  private config: Config = { supabaseUrl: "", supabasePublicKey: "" };
  private readonly demoStore = new DemoStore(localStorage);
  private token = "";
  private sessionKey = "";

  async init(): Promise<State | null> {
    const response = await fetch(new URL("config.json", document.baseURI), {
      cache: "no-store",
    });
    if (!response.ok && response.status !== 404)
      throw new Error("Nie udało się wczytać konfiguracji aplikacji.");
    if (response.ok) this.config = await response.json();
    const { supabaseUrl, supabasePublicKey } = this.config;
    if (!!supabaseUrl !== !!supabasePublicKey)
      throw new Error("Uzupełnij adres i publiczny klucz w config.json.");
    if (
      supabaseUrl &&
      (!/^https:\/\//.test(supabaseUrl) ||
        supabasePublicKey.startsWith("sb_secret_"))
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
    this.demo = !supabaseUrl;
    this.sessionKey = `kawa-syloe.session:${this.demo ? "demo" : supabaseUrl}`;
    if (this.demo) await this.demoStore.init();
    this.token = localStorage.getItem(this.sessionKey) ?? "";
    if (!this.token) return null;
    try {
      return await this.state();
    } catch (error) {
      if (error instanceof Error && error.message.includes("Sesja wygasła")) {
        this.clearSession();
        return null;
      }
      throw error;
    }
  }

  async login(
    firstName: string,
    lastName: string,
    password: string,
  ): Promise<State> {
    const session: Session = this.demo
      ? await this.demoStore.login(firstName, lastName, password)
      : await this.rpc("coffee_login", {
          p_first_name: firstName,
          p_last_name: lastName,
          p_password: password,
        });
    this.token = session.token;
    localStorage.setItem(this.sessionKey, this.token);
    return this.state();
  }

  async state(): Promise<State> {
    return this.demo
      ? this.demoStore.state(this.token)
      : this.rpc("coffee_state", { p_token: this.token });
  }

  async saveOrder(meetingId: string, coffeeType: string): Promise<void> {
    if (this.demo) this.demoStore.saveOrder(this.token, meetingId, coffeeType);
    else
      await this.rpc("coffee_save_order", {
        p_token: this.token,
        p_meeting_id: meetingId,
        p_coffee_type: coffeeType,
      });
  }

  async deleteOrder(meetingId: string): Promise<void> {
    if (this.demo) this.demoStore.deleteOrder(this.token, meetingId);
    else
      await this.rpc("coffee_delete_order", {
        p_token: this.token,
        p_meeting_id: meetingId,
      });
  }

  async createMeeting(name: string, startsAt: string): Promise<void> {
    if (this.demo) this.demoStore.createMeeting(this.token, name, startsAt);
    else
      await this.rpc("coffee_create_meeting", {
        p_token: this.token,
        p_name: name,
        p_starts_at: startsAt,
      });
  }

  async createUser(
    firstName: string,
    lastName: string,
    password: string,
  ): Promise<void> {
    if (this.demo)
      await this.demoStore.createUser(
        this.token,
        firstName,
        lastName,
        password,
      );
    else
      await this.rpc("coffee_create_user", {
        p_token: this.token,
        p_first_name: firstName,
        p_last_name: lastName,
        p_password: password,
      });
  }

  async resetPassword(userId: string, password: string): Promise<void> {
    if (this.demo)
      await this.demoStore.resetPassword(this.token, userId, password);
    else
      await this.rpc("coffee_reset_password", {
        p_token: this.token,
        p_user_id: userId,
        p_password: password,
      });
  }

  async logout(): Promise<void> {
    try {
      if (this.demo) this.demoStore.logout(this.token);
      else await this.rpc("coffee_logout", { p_token: this.token });
    } finally {
      this.clearSession();
    }
  }

  clearSession(): void {
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
    } catch {
      throw new Error(
        "Brak połączenia z Supabase. Sprawdź internet i spróbuj ponownie.",
      );
    }
    const data = await response.json();
    if (!response.ok || data?.error) {
      const message =
        data?.error ?? data?.message ?? "Nie udało się wykonać operacji.";
      if (data?.code === "PGRST202")
        throw new Error(
          "Najpierw uruchom schema.sql w SQL Editor projektu Supabase.",
        );
      throw new Error(message);
    }
    return data as T;
  }
}
