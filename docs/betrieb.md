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
dem Server erneut `docker compose run --rm migrate` ausführen — **vor** dem
Neustart der App (`docker compose up -d --build`). Der `migrate`-Service ist bewusst kein Teil
von `docker compose up`, damit er nie versehentlich automatisch mitläuft.

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
`payload.config.ts`): täglich um 04:00 Uhr wird der Purge-Job eingereiht und im selben Lauf
ausgeführt — kein separater Cron/Systemd-Timer auf dem Server nötig, das läuft mit im laufenden
`app`-Container.

**Prüfen, ob er läuft:** ein strukturierter Log-Eintrag mit `"msg":"papierkorb-purge"` erscheint
täglich (auch wenn nichts zu löschen war, dann `"purgedCount":0`) — mit `docker compose logs app`
suchen, oder gezielt:

```sh
docker compose logs app | grep papierkorb-purge
```

Ein Eintrag mit `"failedCount"` > 0 zeigt einzelne fehlgeschlagene Löschungen (z. B. Datei schon
weg) — die zugehörigen Fehler stehen als separate `papierkorb-purge-errors`-Zeile direkt daneben.

**Manuell anstoßen** (z. B. um nicht bis 04:00 Uhr zu warten): über die Payload Local API, etwa
per `docker compose exec app node` mit einem kurzen Skript, das `payload.jobs.queue({ task:
'purgePapierkorb', input: {} })` gefolgt von `payload.jobs.run()` aufruft — oder einfach bis zum
nächsten planmäßigen Lauf warten, ein einzelner Tag Verzögerung hat bei einer 30-Tage-Frist keine
praktische Auswirkung.

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
