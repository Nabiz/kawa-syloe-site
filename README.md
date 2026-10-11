# Kawa Syloe — PoC

Statyczny frontend w Angularze. Działa na komputerze i telefonie, a po podłączeniu
projektu Supabase komunikuje się bezpośrednio z jego API. Nie ma osobnej aplikacji
backendowej, .NET ani własnego serwera.

## Uruchomienie

Wymagany Node.js zgodny z Angularem 22, np. 24.15 lub nowszy z linii 24.

```sh
npm ci
npm start
```

Otwórz adres wyświetlony przez Angular CLI, zwykle http://127.0.0.1:4200.

Bez konfiguracji Supabase aplikacja uruchamia **tryb demo**. Dane demo są zapisane
wyłącznie w localStorage tej przeglądarki. Nie są wysyłane do żadnej bazy.

| Imię | Nazwisko | Hasło | Dostęp |
| --- | --- | --- | --- |
| Anna | Nowak | Kawa123! | Uczestnik |
| Jan | Kowalski | Kawa123! | Admin |
| Marek | Wiśniewski | Kawa123! | Uczestnik |

Przyciski na ekranie logowania pozwalają wejść na konta Anna i Jan jednym kliknięciem.
Reset danych demo: usuń wpis `kawa-syloe.demo.v1` oraz wpis sesji demo z localStorage,
a potem odśwież stronę. Tryb demo służy do sprawdzenia interfejsu; nie zabezpiecza
danych przed osobą mającą dostęp do tej przeglądarki. Nie używaj w nim prawdziwych haseł.

## Co można sprawdzić

- Logowanie imieniem, nazwiskiem i hasłem, bez maila, telefonu i osobnego loginu.
- Wybór spotkania i jednej z czterech kaw.
- Zapis, zmiana i anulowanie własnego zamówienia.
- Zamknięcie zamówień po rozpoczęciu spotkania.
- Panel admina: zamówienia wszystkich osób i liczba poszczególnych kaw.
- Tworzenie spotkań i kont oraz reset hasła innej osoby.
- Po resecie hasła wcześniejsze sesje tej osoby przestają działać.

## Podłączenie Supabase

1. Utwórz nowy projekt w Supabase. Wybierz region odpowiedni dla użytkowników.
2. W **SQL Editor** uruchom zawartość `supabase/schema.sql`. Skrypt jest przeznaczony
   do jednorazowego uruchomienia w nowym projekcie; wykonuje się w transakcji.
3. W edytorze Supabase wklej `supabase/create-admin.sql`, zastąp trzy wartości
   zastępcze własnym imieniem, nazwiskiem i hasłem, a następnie uruchom skrypt.
   Nie zapisuj zmienionego skryptu z prawdziwym hasłem w repozytorium.
4. Odszukaj **Project URL** i **Publishable key** w ustawieniach projektu.
   Starszy publiczny klucz **anon** też jest obsługiwany.
5. Skopiuj `public/config.example.json` do `public/config.json` i uzupełnij wartości:

```json
{
  "supabaseUrl": "https://TWOJ-PROJEKT.supabase.co",
  "supabasePublicKey": "sb_publishable_TUTAJ_PUBLICZNY_KLUCZ"
}
```

6. Odśwież aplikację. Pasek „Tryb demo” zniknie. Zaloguj się na konto admina,
   dodaj spotkanie i użytkowników. Dane demonstracyjne nie są przenoszone do Supabase.

`public/config.json` jest pomijany przez Git. W repozytorium zostaje wyłącznie pusty
wzór `public/config.example.json`. Brak konfiguracji uruchamia tryb demo.

Publiczny klucz będzie dostępny w opublikowanej statycznej stronie; `.gitignore`
chroni przed zapisaniem go w repozytorium, nie ukrywa go w przeglądarce.
**Nie używaj klucza secret ani
service_role.** Dostęp do danych ograniczają funkcje SQL i uprawnienia w bazie.

### Tabele i API

Trzy tabele biznesowe, widoczne w Table Editor:

- `coffee_users`: imię, nazwisko, hash hasła, oznaczenie admina. Para imię + nazwisko
  jest unikalna bez rozróżniania wielkości liter i skrajnych spacji.
- `coffee_meetings`: nazwa, data i godzina rozpoczęcia.
- `coffee_orders`: rodzaj kawy oraz relacje do użytkownika i spotkania.

W prywatnym schemacie `coffee_private` jest jedna techniczna tabela sesji.
Hasła w Supabase są hashowane przez pgcrypto (bcrypt, koszt 10). Hash hasła nie
opuszcza bazy. Zalogowanie daje losowy token ważny 7 dni; baza przechowuje jego digest.
Po 5 nieudanych próbach konto jest blokowane na 15 minut. Admin może zresetować hasło
i blokadę. PoC nie implementuje globalnego ograniczania liczby wywołań API.

Frontend wywołuje przez `/rest/v1/rpc/` tylko funkcje `coffee_*`, np.
`coffee_login`, `coffee_state`, `coffee_save_order`. Bezpośredni dostęp do tabel
dla publicznych ról jest zablokowany. Id użytkownika dla zamówienia wynika z sesji,
nie z wartości wybranej w przeglądarce. Admin jest sprawdzany w bazie.

Daty spotkań mają strefę **Europe/Warsaw**, również gdy admin jest za granicą.
Jedna osoba ma jedno zamówienie na spotkanie; kolejny zapis aktualizuje jego wybór.
Upoważnienia nie są częścią pierwszego PoC.

Panel Supabase: **Table Editor → public** pozwala przeglądać dane. Nie jest to panel
udostępniany uczestnikom. Właściciel projektu może również nadać nowe hasło adminowi
przez SQL Editor, używając `extensions.crypt` i `extensions.gen_salt`, oraz usunąć
jego sesje z `coffee_private.sessions`.

## GitHub Pages

```sh
npm run build:pages
```

Gotowa strona znajduje się w `dist/kawa-syloe/browser`. Można opublikować ten folder
na GitHub Pages. `--base-href ./` pozwala działać także pod adresem repozytorium,
np. `https://uzytkownik.github.io/kawa-syloe-site/`.

Workflow `.github/workflows/pages.yml` publikuje stronę po każdym pushu do `main`.
Można go też uruchomić ręcznie:

1. W ustawieniach repozytorium wybierz **Pages → Source → GitHub Actions**.
2. W **Secrets and variables → Actions → Repository secrets** dodaj `SUPABASE_URL`
   oraz `SUPABASE_PUBLISHABLE_KEY`, jeśli chcesz podłączyć prawdziwą bazę.
3. W **Actions → GitHub Pages → Run workflow** uruchom publikację.

Workflow uruchamia testy, tworzy `public/config.json` z powyższych ustawień na czas
budowania, buduje Angulara i publikuje wynik. Brak któregoś ustawienia zatrzymuje
publikację z czytelnym błędem. Lokalny `public/config.json` pozostaje poza repozytorium.
Aplikacja nie korzysta z tras URL, więc odświeżenie strony nie wymaga przekierowań SPA.

## Sprawdzenie

```sh
npm test
npm run build:pages
```

Testy wykonują właściwy skrypt SQL na lokalnym PostgreSQL w WebAssembly (PGlite)
oraz sprawdzają tryb demo i przeliczanie czasu. Nie wymagają konta Supabase ani
działającego serwera. Nie zastępują sprawdzenia integracji z API prawdziwego projektu.

## Gdzie szukać kodu

- `src/app/app.ts` i `app.html`: ekrany, formularze i stan interfejsu.
- `src/app/coffee.service.ts`: wywołania API i przełączanie demo/Supabase.
- `src/app/demo-store.ts`: dane przykładowe do lokalnego PoC.
- `src/app/models.ts`: modele i lista kaw.
- `src/styles.css`: responsywny wygląd.
- `supabase/schema.sql`: tabele, uprawnienia i funkcje API.

Frontend ma jeden główny komponent standalone, zwykłe formularze `ngModel` i sygnały
Angulara. Nie ma dodatkowej biblioteki UI, routera ani osobnego systemu zarządzania stanem.
