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
rsync -az backups/archiv/uploads/ \
  /var/lib/docker/volumes/$(basename "$PWD")_uploads/_data/

docker compose up -d --build   # App + Caddy starten
```

Migrationen müssen hier **nicht** erneut laufen — der Dump enthält bereits das komplette
Schema inklusive der Payload-internen `payload_migrations`-Tabelle.

## Monitoring

- **Erreichbarkeit:** Uptime-Ping auf `https://archiv.stamm-greif.de/anmelden` (HTTP 200
  erwartet), z. B. mit [Uptime Kuma](https://github.com/louislam/uptime-kuma) (selbst gehostet)
  oder [healthchecks.io](https://healthchecks.io) (kostenlos für wenige Checks), Intervall
  5–15 Minuten, Alarm per E-Mail/Push bei Ausfall.
- **Plattenplatz:** täglicher Cronjob mit `df`-Warnung, z. B.:

  ```
  30 7 * * * df -h / | awk 'NR==2 && int($5) > 85 {print "Platte auf "  $5  " voll: " $0}' | mail -s "archiv: Speicherplatz-Warnung" du@stamm-greif.de
  ```

  (setzt einen konfigurierten MTA/`mail`-Befehl voraus; alternativ den Storage-Box-Speicher
  ebenfalls im Auge behalten, da die Backups dort langfristig wachsen.)
