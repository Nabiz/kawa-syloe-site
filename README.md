# Kawa Syloe — PoC

Statyczny frontend w Angularze. Działa na komputerze i telefonie, a po podłączeniu
projektu Supabase komunikuje się bezpośrednio z jego API. Nie ma osobnej aplikacji
backendowej, .NET ani własnego serwera.

Repozytorium służy do publikowania frontendu na GitHub Pages. Katalog `supabase/`
ze skryptami SQL oraz `public/config.json` są lokalne i wykluczone z Gita.
Opisane poniżej pliki SQL nie są pobierane podczas klonowania repozytorium.

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
- Samodzielna rejestracja po podaniu wspólnego hasła od admina.
- Wybór spotkania i napoju z menu ustalonego przez admina.
- Zapis obecności bez napoju przez opcję „Inna (daj znać po spotkaniu)”.
- Zapis, zmiana i anulowanie własnego zamówienia.
- Zamknięcie zamówień po rozpoczęciu spotkania.
- Panel admina: zapisane osoby, liczba napojów oraz osoby bez napoju.
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

### Rejestracja na zaproszenie — aktualizacja istniejącego projektu

1. W panelu projektu Supabase otwórz **Vault**. Jeśli rozszerzenie nie jest włączone,
   w SQL Editor uruchom `create extension if not exists supabase_vault with schema vault;`.
2. W Vault dodaj sekret o nazwie **`coffee_registration_password`**. Jego wartością
   jest wybrane przez Ciebie wspólne hasło, które przekażesz znajomym. Użyj długiego,
   trudnego do zgadnięcia hasła; maksymalna długość to 1024 bajty.
   Wpisz je w interfejsie Vault, bez zapisywania w plikach projektu.
3. W SQL Editor uruchom zawartość
   **`supabase/migrations/20261021_registration.sql`**. Migrację można uruchomić
   ponownie. Zachowuje istniejących użytkowników, spotkania i zamówienia.
   **Na istniejącej bazie nie uruchamiaj ponownie `schema.sql`.** Nowy projekt
   wymaga najpierw `schema.sql`, a następnie tej migracji.
4. Opublikuj frontend zwykłym pushem do `main`. **Nie dodawaj hasła rejestracji do
   sekretów GitHub Actions, `public/config.json` ani environment.ts.** Hasło jest
   sprawdzane w Supabase, więc konfiguracja workflow pozostaje bez zmian.

Na ekranie logowania wybierz „Nie masz konta? Zarejestruj się”. Poprawne hasło
rejestracji odsłania formularz imienia, nazwiska i własnego hasła do konta.
Po utworzeniu konta użytkownik wraca do logowania z uzupełnionym imieniem i nazwiskiem.
Nowe konto ma uprawnienia zwykłego uczestnika. Para imię + nazwisko jest unikalna
także między kontami utworzonymi przez admina i samodzielnie. Wielkość liter oraz
spacje na początku i końcu są pomijane. Indeks unikalny chroni również przed
równoczesnymi próbami utworzenia tej samej osoby.

Baza sprawdza wspólne hasło zarówno przy otwieraniu formularza, jak i przy każdym
wywołaniu `coffee_register`. Wpisane hasło pozostaje tylko w pamięci bieżącego
formularza, nigdy w localStorage. API nie udostępnia sekretu ani jego hasha.
Zmiana wartości sekretu w Vault działa od razu, także dla już otwartych formularzy,
bez przebudowy strony. Usunięcie sekretu lub wyczyszczenie jego wartości zamyka
samodzielną rejestrację. Logowanie i tworzenie kont przez admina nadal działają.

Wspólne hasło ogranicza rejestrację do osób, które je znają. Osoba posiadająca
hasło nadal może tworzyć wiele różnych kont; nie jest to limit liczby rejestracji
ani zabezpieczenie przed przeciążaniem publicznego API.

W trybie demo publiczne hasło rejestracji to **`SyloeDemo!`**. Służy tylko do
sprawdzenia interfejsu; nie jest hasłem używanym w Supabase.

Dokumentacja Vault: https://supabase.com/docs/guides/database/vault.

### Katalog napojów i menu spotkania — aktualizacja bazy

W SQL Editor Supabase uruchom lokalny plik
**`supabase/migrations/20261021_coffee_types.sql`**, przed opublikowaniem nowego
frontendu. Na nowej bazie najpierw uruchom `schema.sql`; migracja rejestracji jest
niezależna i również pozostaje potrzebna do rejestracji użytkowników.
Nie uruchamiaj ponownie `schema.sql` na istniejącej bazie.

Migracja dodaje katalog `coffee_types` z czterema pozycjami:
**Czarna**, **Biała**, **Herbata Zimowa**, **Inna (daj znać po spotkaniu)**.
Admin zaznacza dostępne napoje podczas tworzenia spotkania. Uczestnik widzi tylko
menu tego spotkania. Baza weryfikuje dostępność także przy bezpośrednim wywołaniu API.
Opcja „Inna…” oznacza obecność bez zamawiania napoju i jest zawsze dostępna.
Admin może odznaczyć wszystkie napoje i utworzyć spotkanie z samymi zapisami obecności.

Zapis „Inna…” jest jednym wierszem w `coffee_orders`, oznaczonym przez powiązany
typ `attendance_only = true`. Jest wliczany do liczby osób, ale nie do liczby napojów.
Zmiana wyboru nadpisuje ten sam zapis, anulowanie usuwa zapis i zmniejsza liczbę osób.
Tak jak wcześniej, zmiany są możliwe tylko do rozpoczęcia spotkania.

Dotychczasowe spotkania i zamówienia są zachowane z oryginalnymi nazwami napojów.
Historyczne rodzaje są nieaktywne dla nowych menu, ale nadal widoczne przy
wcześniejszych zamówieniach. Stare spotkania otrzymują cztery nowe opcje oraz typy
wcześniej na nich zamówione. Ponowne uruchomienie migracji nie rozszerza menu nowych
spotkań. Katalog i powiązania są udostępniane przez `coffee_state`, bez nowych
requestów do API przy wyświetlaniu menu. Lokalne demo aktualizuje stare dane bez
usuwania kont i zapisów.

Katalog `supabase/` nadal jest ignorowany przez Git — migrację zachowaj lokalnie
i wykonaj w SQL Editor, nie jest automatycznie wdrażana przez GitHub Actions.

### Tabele i API

Tabele biznesowe, widoczne w Table Editor:

- `coffee_users`: imię, nazwisko, hash hasła, oznaczenie admina. Para imię + nazwisko
  jest unikalna bez rozróżniania wielkości liter i skrajnych spacji.
- `coffee_meetings`: nazwa, data i godzina rozpoczęcia.
- `coffee_orders`: napój lub obecność bez napoju oraz relacje do użytkownika i spotkania.
- `coffee_types`: katalog napojów i oznaczenie opcji bez napoju.
- `coffee_meeting_types`: menu wybrane dla danego spotkania.

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
działającego serwera. Test rejestracji wykonuje migrację SQL i sprawdza uprawnienia,
unikalność, wymaganie wspólnego hasła i jego zmianę. Interfejs SQL Vault jest w nim
odwzorowany lokalnie, bez rozszerzenia szyfrującego Supabase. Testy nie zastępują
sprawdzenia integracji z API prawdziwego projektu. Gdy lokalnych plików `supabase/`
nie ma (np. w GitHub Actions), testy SQL są jawnie pomijane; pozostałe testy nadal
się wykonują. Publikowanie frontendu nie wymaga dostępu do skryptów ani danych bazy.

## Gdzie szukać kodu

- `src/app/app.ts` i `app.html`: ekrany, formularze i stan interfejsu.
- `src/app/coffee.service.ts`: wywołania API i przełączanie demo/Supabase.
- `src/app/demo-store.ts`: dane przykładowe do lokalnego PoC.
- `src/app/models.ts`: modele i lista kaw.
- `src/styles.css`: responsywny wygląd.
- `supabase/schema.sql`: tabele, uprawnienia i funkcje API.
- `supabase/migrations/20261021_registration.sql`: rejestracja i weryfikacja sekretu Vault.

Frontend ma jeden główny komponent standalone, zwykłe formularze `ngModel` i sygnały
Angulara. Nie ma dodatkowej biblioteki UI, routera ani osobnego systemu zarządzania stanem.
