# Betrieb — Stamm-Greif-Archiv

Kurzanleitung für die Leute, die den Server nach mir betreuen. Alle Befehle laufen im
Repo-Verzeichnis auf dem VPS (z. B. `/opt/archiv`).

## Voraussetzungen

- Ein VPS (z. B. Hetzner CX-Klasse) mit Docker Engine + Docker Compose Plugin (`docker compose
  version` muss funktionieren), min. ~2 GB RAM, genug Plattenplatz für Fotos + DB.
- Eine Domain (`archiv.stamm-greif.de`) mit einem DNS-A-Record auf die VPS-IP. Ports 80 und 443
  müssen von außen erreichbar sein (Caddy holt sich darüber automatisch ein Let's-Encrypt-
  Zertifikat — dafür muss die Domain schon auf den Server zeigen, *bevor* Caddy startet).
- Das Repo geklont nach `/opt/archiv` (oder einem anderen Pfad — dann in der Backup-Cronzeile
  unten anpassen).

## Erststart

```sh
cd /opt/archiv
cp .env.example .env
# DB_PASSWORD und PAYLOAD_SECRET setzen, z. B. mit:
#   openssl rand -hex 32      (für DB_PASSWORD — hex, damit keine + / = die DATABASE_URI zerlegen)
#   openssl rand -base64 32   (für PAYLOAD_SECRET)
$EDITOR .env

docker compose up -d db                        # Postgres starten, Healthcheck abwarten
docker compose run --rm migrate                 # Datenbankschema anlegen (siehe unten)
docker compose up -d --build                    # App + Caddy bauen und starten
```

Danach `https://archiv.stamm-greif.de/admin` öffnen — Payload zeigt automatisch das Formular
zum Anlegen des ersten Nutzers. **Rolle auf „Admin" stellen** (Standard wäre „Mitglied"). Alle
weiteren Nutzer kommen über Einladungslinks ins System, nicht über Selbstregistrierung.

### Deployment per fertigem Image (Alternative ohne Server-Build)

Jeder Merge auf `main` veröffentlicht das fertige Produktions-Image als
`ghcr.io/ckeller42/stamm-greif:latest` (GitHub Container Registry). Statt auf dem Server zu
bauen, kann man es direkt ziehen — schneller und braucht kaum RAM:

```sh
docker compose pull app
docker compose up -d
```

(Beim allerersten Mal ggf. `docker login ghcr.io` mit einem GitHub-Token, falls das Paket nicht
öffentlich ist. Migrationen wie gehabt vorher per `docker compose run --rm migrate`.)

Hinweis: `docker compose run --rm migrate` baut weiterhin lokal aus dem Quellcode (das
`migrate`-Image kommt nicht aus der Registry) — das Repo muss dafür aktuell gezogen sein
(`git pull`). Nur der `app`-Container kommt fertig aus der Registry.

`ghcr.io/...:latest` wird bei jedem Merge auf main veröffentlicht, unabhängig davon, ob die
CI-Checks des Merges grün waren — im Zweifel das `:sha-<commit>`-Tag eines bekannten guten
Stands verwenden. `docker compose up -d --build` überschreibt das lokale `:latest`-Tag mit
einem Quell-Build — danach zeigt `docker compose pull app` scheinbar keine Änderung.

## Datenbankschema / Migrationen

Payload synchronisiert das Schema in der Entwicklung automatisch mit der DB ("Push-Modus"). Im
Container ist `NODE_ENV=production` gesetzt, wodurch Payload diesen Push-Modus automatisch
abschaltet (Datenverlust-Risiko in Produktion) — stattdessen müssen echte Migrationen laufen.
Eine initiale Migration (`src/migrations/…_initial_schema.ts`) ist im Repo enthalten und legt
beim allerersten Start das komplette Schema an (siehe `migrate`-Befehl oben).

**Bei künftigen Code-Änderungen, die Collections/Felder ändern:** vor dem Deploy lokal
`pnpm payload migrate:create` gegen eine Kopie der Produktionsdaten (oder einfach die lokale
Dev-DB) laufen lassen, die erzeugte Datei in `src/migrations/` committen, und nach dem Pull auf
dem Server erneut den Migrations-Befehl ausführen — **vor** dem
Neustart der App (`docker compose up -d --build`). Der `migrate`-Service ist bewusst kein Teil
von `docker compose up`, damit er nie versehentlich automatisch mitläuft.

**Wichtig — das `migrate`-Image zuerst neu bauen:** `docker compose run` verwendet ein
zwischengespeichertes Image; ohne Neubau laufen die neuen Migrationsdateien nicht mit und die
Migration meldet fälschlich „Done", ohne etwas anzuwenden. Nach jedem `git pull` daher immer:

```sh
docker compose build migrate            # neuen Quellcode ins migrate-Image übernehmen
docker compose run --rm migrate         # ausstehende Migrationen anwenden
docker compose up -d --build            # App + Caddy neu bauen und starten
```

Zur Kontrolle, dass alles angewendet wurde:
`docker compose exec db psql -U archiv -d archiv -c "SELECT name FROM payload_migrations ORDER BY id;"`

## Backup

`scripts/backup.sh` sichert nächtlich per Cron: Postgres-Dump (gzip) + Foto-Uploads, beides per
rsync auf einen Hetzner Storage Box (oder ein beliebiges rsync/ssh-Ziel), plus 30 Tage lokale
Aufbewahrung unter `/var/backups/archiv`.

Cronjob (`crontab -e`, als der Nutzer, der auch `docker compose` ausführen darf):

```
0 3 * * * cd /opt/archiv && OFFSITE_TARGET=u123@u123.your-storagebox.de: ./scripts/backup.sh >> /var/log/archiv-backup.log 2>&1
```

(Storage-Box-Zugangsdaten/SSH-Key vorher einmalig einrichten, damit rsync ohne Passwortabfrage
läuft.) `OFFSITE_TARGET` muss mit `:` bzw. `/` enden — das Skript hängt `backups/archiv/...`
direkt daran.

## Restore (z. B. auf einem neuen Server)

```sh
cd /opt/archiv
cp .env.example .env && $EDITOR .env   # gleiche DB_PASSWORD/PAYLOAD_SECRET wie vorher verwenden
docker compose up -d db
# warten, bis die DB healthy ist (docker compose ps)

gunzip < db-JJJJ-MM-TT.sql.gz | docker compose exec -T db psql -U archiv archiv

# Uploads zurückspielen (Pfad zum tatsächlichen Docker-Volume, nicht in den Container-Pfad!):
# Der Volume-Name beginnt mit dem Compose-Projektnamen, der in docker-compose.yml fest auf
# "stamm-greif" gepinnt ist (name: stamm-greif) — unabhängig vom tatsächlichen Checkout-Pfad
# (z. B. /opt/archiv). Nicht mit $(basename "$PWD") herleiten, das war der alte, vor dem Pin
# verwendete Ansatz und stimmt auf /opt/archiv nicht mit dem echten Volume-Namen überein.
rsync -az backups/archiv/uploads/ \
  /var/lib/docker/volumes/stamm-greif_uploads/_data/

docker compose up -d --build   # App + Caddy starten
```

Migrationen müssen hier **nicht** erneut laufen — der Dump enthält bereits das komplette
Schema inklusive der Payload-internen `payload_migrations`-Tabelle.

**Schritt 5 (P2.3 — Gesichtserkennung):** `reconcileHiddenFaceData` einmal manuell auslösen,
sobald die App wieder läuft. Der Dump aus Schritt 3 enthält auch `face_suggestions` —
Gesichtsdaten liegen in derselben Datenbank wie alles andere und sind damit ebenso im Backup wie
jede sonstige Tabelle. Ein Restore kann also Gesichts-Vorlagen (Embeddings) von Personen
wiederherstellen, deren Einwilligung zwischenzeitlich widerrufen wurde (`hidden: true`) — der
ursprüngliche Widerruf hat sie bereits transaktional gelöscht (siehe
`src/hooks/purge-face-data.ts`), aber ein älterer Dump kennt diesen Widerruf noch nicht.
`reconcileHiddenFaceData` ist idempotent (auf einem gesunden System ein No-op) und löscht
Gesichtsdaten für JEDE aktuell verborgene Person erneut:

```sh
# Admin-Login vorausgesetzt (POST /api/payload-jobs ist per jobsCollectionOverrides admin-only):
curl -X POST http://localhost:3000/api/payload-jobs \
  -H 'Content-Type: application/json' -H "Cookie: $ADMIN_COOKIE" \
  -d '{"task": "reconcileHiddenFaceData", "input": {}}'
# … oder im Admin-UI unter /admin/collections/payload-jobs → „Create New" → Task
# „reconcileHiddenFaceData" wählen, dann per Cron/„Run Jobs Now" ausführen lassen.
```

## Fehlersuche

Wenn ein API-Fehler auftritt (eine fehlgeschlagene Server-Antwort), zeigt Payload in der
Fehlermeldung eine kurze **Fehler-ID** an (z. B. „... (Fehler-ID: abc123)"). Diese ID steht
auch im strukturierten Log der `app` — damit lässt sich der genaue Vorfall wiederfinden, ohne
im ganzen Log zu suchen. Client-seitige oder Netzwerkfehler (z. B. keine Verbindung zum
Server) tragen keine Fehler-ID — dafür gibt es keinen Log-Eintrag zum Nachschlagen.

```sh
scripts/errors.sh abc123
```

gibt alle Log-Zeilen mit dieser Fehler-ID aus (als JSON, via `jq` formatiert). Weitere
Aufrufe:

```sh
scripts/errors.sh recent [stunden]   # Fehler der letzten N Stunden (Default: 24)
scripts/errors.sh tail               # Fehler live mitverfolgen
```

Das Skript braucht `jq` (`apt install jq` bzw. `apk add jq`) sowie einen Log-Zugriff über
`docker compose logs` — beides ist auf dem VPS vorausgesetzt.

Log-Aufbewahrung: Die `app`-, `db`- und `caddy`-Container laufen mit dem Docker-`json-file`-
Treiber und Rotation (`docker-compose.yml`, je 5 × 10 MB) — die Historie ist also begrenzt,
übersteht aber Neustarts der Container.

Die Logs enthalten personenbezogene Daten (Nutzer-IDs — keine E-Mail-Adressen mehr — sowie
IP-Adressen) — deshalb bleiben sie auf dem Server und unterliegen der Log-Rotation.
Einladungs-Tokens werden in den Logs geschwärzt (`[token]`).

Zusätzlich liefert `https://archiv.stamm-greif.de/api/health` einen schnellen Gesamtstatus:
HTTP 200 (`status: "ok"`) wenn die App inklusive DB-Verbindung erreichbar ist, HTTP 503
(`status: "degraded"`) wenn die Datenbank nicht antwortet. Die Antwort enthält außerdem
`errorsLastHour` (Anzahl Fehler der letzten Stunde) als groben Trend-Indikator.

## Papierkorb (automatischer Purge nach 30 Tagen)

Gelöschte Fotos landen zunächst im Papierkorb (`deletedAt` gesetzt, Kuratoren/Admin-Aktion) und
bleiben dort 30 Tage sichtbar/wiederherstellbar. Danach werden sie **automatisch endgültig**
gelöscht — DB-Eintrag und alle gespeicherten Dateien (Original + Vorschaubilder).

Das läuft in-process über Payloads Jobs-System (`src/jobs/purgePapierkorb.ts`, verdrahtet in
`payload.config.ts`) — kein separater Cron/Systemd-Timer auf dem Server nötig, das läuft mit im
laufenden `app`-Container. Der Purge-Job wird täglich um 04:00 Uhr **eingeplant**; ausgeführt
wird er beim nächsten 15-Minuten-Tick danach (spätestens ~04:15) — Einplanen (`schedule`) und
Ausführen (`autoRun`, alle 15 Minuten) sind zwei getrennte Mechanismen in Payloads Jobs-System,
nicht ein einzelner Lauf um 04:00 Uhr.

**Prüfen, ob er läuft:** ein strukturierter Log-Eintrag mit `"msg":"papierkorb-purge"` erscheint
täglich (auch wenn nichts zu löschen war, dann `"purgedCount":0`) — mit `docker compose logs app`
suchen, oder gezielt:

```sh
docker compose logs app | grep papierkorb-purge
```

Ein Eintrag mit `"failedCount"` > 0 zeigt einzelne fehlgeschlagene Löschungen (z. B. Datei schon
weg) — die zugehörigen Fehler stehen als separate `papierkorb-purge-errors`-Zeile direkt daneben.

**Hinweis:** `payload_jobs`/`payload_jobs_log`-Zeilen werden nach einem erfolgreichen Lauf
absichtlich NICHT automatisch gelöscht (`jobs.deleteJobOnComplete: false` in `payload.config.ts` —
nötig, um einen sonst reproduzierbaren Postgres-Deadlock zwischen zwei gleichzeitig laufenden
Job-Durchläufen auf derselben Queue zu vermeiden) — die Tabelle wächst unbegrenzt; es gibt aktuell
keinen eigenen Aufräum-Job dafür.

**Manuell anstoßen** (z. B. um nicht bis 04:00 Uhr zu warten): über die Payload Local API, etwa
per `docker compose exec app node` mit einem kurzen Skript, das `payload.jobs.queue({ task:
'purgePapierkorb', input: {} })` gefolgt von `payload.jobs.run()` aufruft — oder einfach bis zum
nächsten planmäßigen Lauf warten, ein einzelner Tag Verzögerung hat bei einer 30-Tage-Frist keine
praktische Auswirkung.

## Duplikaterkennung beim Hochladen

Jedes hochgeladene Foto bekommt beim erfolgreichen Verarbeiten automatisch einen Perceptual Hash
(dHash); schlägt die Bildverarbeitung fehl, wird der Upload nicht abgelehnt, das Foto hat dann
aber keinen Hash und nimmt nicht an der Prüfung teil. Beim Erstellen eines
neuen Fotos wird dieser Hash mit allen vorhandenen Fotos verglichen; liegt ein sehr ähnliches Foto
vor (z. B. dasselbe Dia erneut gescannt oder anders exportiert), wird das neue Foto als
**mögliches Duplikat markiert, aber nicht blockiert** — unterschiedliche Ausschnitte oder Scans
desselben Motivs sollen weiterhin hochgeladen werden können. Kuratoren sehen in der
Foto-Übersicht im Admin-Bereich den Verweis auf das vermutlich identische Foto (`duplicateOf`) und
können selbst entscheiden, ob es sich tatsächlich um ein Duplikat handelt. Mitglieder sehen im
Upload-Formular nur einen allgemeinen Hinweis, ohne Details zum vorhandenen Foto preiszugeben.

Die Prüfung läuft nur beim **Erstellen** eines neuen Fotos, nicht bei späteren Bearbeitungen: wird
ein fälschlich markiertes Foto erneut hochgeladen, um die Markierung loszuwerden, bleibt
`duplicateOf`/`duplicateSuspected` des ursprünglichen Eintrags bestehen — die Markierung muss in
diesem Fall manuell im Admin-Bereich entfernt werden.

Ein paar bewusste Einschränkungen:

- Die Prüfung läuft absichtlich über **alle** vorhandenen Fotos, auch verborgene, im Papierkorb
  liegende oder unveröffentlichte — nur so fällt in der Moderation auf, wenn jemand die Kopie eines
  bereits zurückgezogenen Fotos erneut hochlädt.
- Fotos aus der Zeit **vor** diesem Feature haben keinen Perceptual Hash und nehmen an der Prüfung
  nicht teil (weder als neu zu prüfendes Foto noch als möglicher Treffer für andere). Ein
  nachträgliches Backfill-Skript für den Altbestand ist ein mögliches späteres Follow-up, aber noch
  nicht umgesetzt.
- Die Markierung ist **Best-Effort**, kein exakter Abgleich: sie läuft nur beim Erstellen (siehe
  oben) und vergleicht gegen den zum jeweiligen Zeitpunkt vorhandenen Bestand — zwei nahezu
  gleichzeitige Uploads desselben Fotos können sich dadurch gegenseitig verpassen, wenn der zweite
  Upload bereits läuft, bevor der erste vollständig gespeichert ist.

## Gesichtserkennung

Erkennt beim Veröffentlichen eines Fotos automatisch Gesichter darauf und schlägt — sobald ein
Gesicht einer bereits bestätigten Person hinreichend ähnlich ist — diese Person als Markierung
vor. **Das ist ausschließlich ein Vorschlag: nichts wird automatisch getaggt, ein Kurator
bestätigt oder verwirft jeden Vorschlag von Hand** unter `/gesichter`.

Ein/Aus über die Umgebungsvariable `FACE_DETECTION_ENABLED` — **auf dieser Instanz `true`**
(bewusste Entscheidung des Betreibers). Für andere Deployments dieses Codes ist die empfohlene
Grundeinstellung `false`, bis eine Datenschutz-Folgenabschätzung (DSFA, siehe unten) vorliegt; der
Code bleibt dann mit ausgeliefert, aber inaktiv.

**Prüfen, ob es läuft:**

```sh
docker compose logs app | grep face-detect
```

zeigt einen Log-Eintrag pro verarbeitetem Foto (Anzahl erkannter Gesichter, Anzahl erzeugter
Vorschläge). Zusätzlich meldet `/api/health` im Feld `faces` den Bereitschaftsstatus (`"aus"`,
`"bereit"` oder `"Modell fehlt"`) — das ist rein informativ und **kein Grund für Uptime Kuma zu
alarmieren**: ein fehlendes Modell verschlechtert nicht `status`/den HTTP-Code der Antwort.

**Aktivierung auf einem bestehenden Archiv:** ein einmaliger Nachtrag holt Gesichtsvorschläge für
alle bereits veröffentlichten Fotos nach (neu hochgeladene Fotos lösen die Erkennung ohnehin beim
Veröffentlichen automatisch aus). Ausgelöst als Admin über `POST /api/payload-jobs`:

```sh
curl -X POST http://localhost:3000/api/payload-jobs \
  -H 'Content-Type: application/json' -H "Cookie: $ADMIN_COOKIE" \
  -d '{"task": "backfillFaces", "input": {}}'
# … oder im Admin-UI unter /admin/collections/payload-jobs → „Create New" → Task
# „Gesichtserkennung: Archiv nachtragen" wählen.
```

Das reiht pro veröffentlichtem Foto **einen** Erkennungs-Job in die eigene `faces`-Queue ein und
drosselt sich selbst über deren Ausführungsrate — bei einem großen Archiv läuft der Rückstand über
Stunden ab, nicht sofort. Fortschritt beobachten: `"msg":"faces-backfill-enqueued"` im Log zeigt,
wie viele Fotos eingereiht wurden, danach zeigt die Anzahl offener Vorschläge unter `/gesichter`
den laufenden Fortschritt der Abarbeitung.

**Datenschutz:** Gesichts-Vorlagen (Embeddings) sind biometrische Daten nach Art. 9 DSGVO. Als
Einwilligungsgrenze gilt dieselbe `verbergen`-Markierung wie im übrigen Archiv (`People` →
„Person verbergen (Einwilligung widerrufen)"); bei Minderjährigen entscheiden die
Erziehungsberechtigten. Die Daten verlassen den Server nicht und werden an keine dritte Stelle
übermittelt — die Erkennung läuft in-process im `app`-Container, es gibt keinen externen
Dienstaufruf. Art. 22 DSGVO (automatisierte Einzelentscheidung) greift nicht, weil jeder Vorschlag
von einem Menschen bestätigt wird, bevor er wirkt. Wird die Funktion aktiviert, muss der Eintrag im
Verzeichnis von Verarbeitungstätigkeiten festhalten, dass die Aktivierung einen vollständigen
Nachtrag (Backfill) über den kompletten Altbestand einschließt. Eine schriftliche
Datenschutz-Folgenabschätzung (DSFA) wird empfohlen.

**Modell-Lizenz:** die verwendeten InsightFace-Gewichte (`buffalo_s`, siehe
`scripts/fetch-face-models.sh`) stehen laut InsightFace-Model-Zoo „ausschließlich für
nicht-kommerzielle Forschungszwecke" zur Verfügung — das erfüllt ein Vereinsarchiv wie dieses.

Die Gesichtsdaten liegen in derselben Datenbank wie alles andere und sind deshalb in den
Sicherungen enthalten. Wird bei einer Person „verbergen" gesetzt, sind im laufenden Betrieb
**sofort weg**: jeder Vorschlag, der sie als `suggestedPerson` nennt (bestätigt oder abgelehnt),
UND jeder weitere Vorschlag auf einem Foto, auf dem sie in „Personen" markiert ist — auch wenn
dieser Vorschlag fälschlich einer anderen Person zugeordnet wurde (Verwechslung bei der
Bestätigung). Eine Lücke bleibt unvermeidbar, weil sie algorithmisch nicht auflösbar ist: ein noch
offener, nie bestätigter Vorschlag, dessen Gesicht tatsächlich diese Person zeigt, den aber noch
niemand ihr zugeordnet und sie auch sonst nirgends auf diesem Foto markiert hat, kann das System
nicht automatisch mit ihr verknüpfen — er verschwindet erst über den regulären Weg: „Ablehnen",
die 180-Tage-Frist unten, oder (sobald ein Kurator ihn — richtig oder fälschlich — bestätigt) die
Löschung beim nächsten „verbergen". In bereits erstellten Sicherungen bleiben gelöschte
Gesichtsdaten davon unberührt, bis diese Sicherungen turnusmäßig überschrieben werden (30 Tage
lokal wie ausgelagert). Danach sind sie auch dort verschwunden. **Nach jedem Restore einer älteren
Sicherung muss „Gesichtsdaten aufräumen" laufen**, sonst leben die gelöschten Daten wieder (Schritt
5 der Restore-Anleitung oben, `reconcileHiddenFaceData`).

Ein paar bewusste Einschränkungen:

- Eine falsche Bestätigung wird über **„Rückgängig"** unter `/gesichter` korrigiert: der Vorschlag
  geht zurück auf „offen", und die Person wird — sofern kein anderer bestätigter Vorschlag auf
  demselben Foto sie noch nennt — auch wieder von diesem Foto abgetaggt. Die gespeicherte
  Gesichts-Vorlage (Embedding) bleibt dabei **erhalten**: das Gesicht ist ja weiterhin real und
  könnte erneut zugeordnet werden. Sie verschwindet erst über „Ablehnen" (löscht die Vorlage
  sofort) oder automatisch nach 180 Tagen, falls der Vorschlag offen bleibt (siehe unten) — nicht
  durch bloßes Entfernen der Personen-Markierung im Admin-Bereich, das lässt Vorschlag und Vorlage
  unangetastet.
- „Rückgängig" auf dem einzigen bestätigten Gesicht einer Person nimmt diese Person wieder aus dem
  Abgleich heraus — sie erscheint dann bei künftigen Fotos nicht mehr als Vorschlag, bis erneut ein
  Gesicht von ihr bestätigt wird.
- Vorschläge sind Best-Effort: schlägt ein Erkennungs-Job fehl, gibt es für dieses Foto einfach
  keine Vorschläge, kein Fehler wird an Mitglieder oder Kuratoren sichtbar.
- Der Abgleich ist ein linearer Scan über alle bestätigten Gesichter — das reicht bis in den
  niedrigen vierstelligen Bereich; ab etwa 10 000 bestätigten Gesichtern braucht es `pgvector`.
- Unbestätigte Vorschläge verlieren nach 180 Tagen automatisch ihre biometrische Vorlage (siehe
  „Papierkorb" oben, derselbe Purge-Mechanismus).

**Ressourcenbedarf:** kein zusätzlicher Container und keine höhere RAM-Stufe nötig — zum
Fußabdruck des Basis-Stacks kommen während eines laufenden Erkennungs-Jobs grob 200–300 MB dazu;
ein 2-GB-VPS bleibt ausreichend.

## Kiosk & Zeitleiste

**Kiosk aufsetzen:** Als Kurator/Admin `/kiosk-admin` öffnen, dort einen Link mit Label und
Ablaufzeit erzeugen (Ablaufzeit ist auf `KIOSK_LINK_TTL_HOURS` gedeckelt, Standard 12 Stunden)
und den erzeugten Link auf dem Beamer/Tablet öffnen — dort mit `f` in den Vollbildmodus wechseln.
Auf dem Gerät selbst ist **kein Login** nötig; der Link trägt die Berechtigung.

**`KIOSK_PUBLIC_URL` setzen:** Die QR-Codes auf dem Beamer müssen von Gäste-Handys erreichbar
sein. Ist der Server nur unter einem internen Namen (z. B. Tailscale-Hostname/IP) statt unter
`https://archiv.stamm-greif.de` erreichbar, muss `KIOSK_PUBLIC_URL` in der `.env` auf die
öffentlich erreichbare Basis-URL gesetzt werden — sonst zeigen die QR-Codes auf eine Adresse, die
ein Gäste-Handy nicht auflösen kann. Bleibt die Variable leer, wird die Adresse aus dem
eingehenden Request abgeleitet (funktioniert nur, wenn diese Adresse auch von Gäste-Handys aus
erreichbar ist).

**Was angezeigt wird — die Konsens-Regel:** Der Kiosk ist die einzige Stelle im System, die ohne
Anmeldung öffentlich sichtbar ist. Ein Foto erscheint dort **nur**, wenn ein Kurator es
ausdrücklich als „Für Kiosk freigegeben“ markiert hat **und** es zusätzlich veröffentlicht, nicht
verborgen (keine verborgene Person markiert) und nicht im Papierkorb ist — die Freigabe ist immer
eine zusätzliche Einschränkung, niemals ein Umgehen der übrigen Regeln. **Kuratoren dürfen Fotos
von Minderjährigen oder mitglieder-interne Fotos NICHT für den Kiosk freigeben** — der öffentliche
Beamer ist die Grenze dessen, was ohne Anmeldung sichtbar werden darf. Wird eine Einwilligung
widerrufen (Person unter „Personen“ auf „verbergen“ gesetzt), verschwindet das Foto sofort aus
Slideshow und QR-Downloads — auch aus bereits angezeigten/gescannten QR-Codes, die dann ins Leere
laufen.

**Link widerrufen:** In `/kiosk-admin` beim jeweiligen Link „Widerrufen“ klicken — der Link ist
sofort tot, ohne Neustart der App und ohne jede Auswirkung auf Mitglieder-Logins. Links laufen
unabhängig davon ohnehin nach `KIOSK_LINK_TTL_HOURS` (Standard 12 Stunden) automatisch ab.

**Nichts wird indexiert:** Der Kiosk trägt wie der Rest der App `robots: noindex` — er wird nie
von Suchmaschinen erfasst, unabhängig davon, wie lange ein Link aktiv ist.

**Zeitleiste (`/zeitleiste`):** Nur für angemeldete Mitglieder, kein öffentlicher Zugriff. Dort
wählt man eine Ereignisreihe (z. B. „Sommerlager“) und geht Jahr für Jahr durch deren Fotos. Es
gelten dieselben Konsens-Regeln wie im übrigen Archiv (keine verborgenen Personen, keine
unveröffentlichten/gelöschten Fotos) — die Zeitleiste hat keine eigene Freigabe-Logik wie der
Kiosk und ist mit ihm nur über den gemeinsamen Fotobestand verwandt.

## Monitoring

- **Erreichbarkeit:** Uptime-Ping auf `https://archiv.stamm-greif.de/api/health` (HTTP 200
  erwartet, HTTP 503 bei DB-Ausfall — siehe „Fehlersuche" oben), z. B. mit
  [Uptime Kuma](https://github.com/louislam/uptime-kuma) (selbst gehostet) oder
  [healthchecks.io](https://healthchecks.io) (kostenlos für wenige Checks), Intervall
  5–15 Minuten, Alarm per E-Mail/Push bei Ausfall.
- **Plattenplatz:** täglicher Cronjob mit `df`-Warnung, z. B.:

  ```
  30 7 * * * df -h / | awk 'NR==2 && int($5) > 85 {print "Platte auf "  $5  " voll: " $0}' | mail -s "archiv: Speicherplatz-Warnung" du@stamm-greif.de
  ```

  (setzt einen konfigurierten MTA/`mail`-Befehl voraus; alternativ den Storage-Box-Speicher
  ebenfalls im Auge behalten, da die Backups dort langfristig wachsen.)
