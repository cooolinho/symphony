# Symphony mit Docker betreiben

Diese Anleitung richtet Symphony per `docker compose` auf einem Server hinter einem vorhandenen
[Traefik](https://doc.traefik.io/traefik/) ein, beschreibt den Betrieb und hilft bei Fehlern. Die Einrichtung ohne Docker
steht in [Getting Started](getting-started.md).

Die Dateien dazu liegen im Repository: `Dockerfile`, `docker-compose.yml`, `docker/entrypoint.sh`,
`docker/ssh_known_hosts`, `.dockerignore` und die Vorlage `.env.example`.

## Voraussetzungen

| Was | Prüfen mit |
|---|---|
| **Docker Engine** mit **Compose v2** | `docker --version`, `docker compose version` |
| **Traefik** läuft, mit einem **externen Docker-Netzwerk**, einem **HTTPS-Entrypoint** und einem **Cert-Resolver** (beides nur für HTTPS; in einem vertrauenswürdigen LAN geht auch reines HTTP, siehe Schritt 9) | `docker network ls`, Traefik-Konfiguration |
| **DNS-Eintrag** für die Domain des Dashboards, der auf den Server zeigt | `dig symphony.example.com` |
| **GitHub Project Board** und **GitHub-Token** mit den Scopes `repo` und `project` | [Getting Started](getting-started.md), Schritte 2 und 3 |

Notiere dir die Namen aus Traefik: Netzwerk (Standard in der Compose-Datei: `traefik`), Entrypoint (`websecure`) und
Cert-Resolver (`letsencrypt`). Du trägst sie in Schritt 9 ein. Board und Token legst du wie in
[Getting Started](getting-started.md) an; das wird hier nicht wiederholt.

## Einrichtung Schritt für Schritt

Alle Schritte laufen auf dem Server, außer Schritt 4 (lokal).

### 1. Repository klonen

```bash
git clone git@github.com:cooolinho/symphony.git
cd symphony
```

### 2. `.env` anlegen

```bash
cp .env.example .env
chmod 600 .env
```

### 3. Board, Repository und GitHub-Token eintragen

Setze `GITHUB_PROJECT_NUMBER`, `GITHUB_REPOSITORY` und `GITHUB_TOKEN` wie in
[Getting Started](getting-started.md#4-env-anlegen) (Token: [Schritt 3](getting-started.md#3-github-token-erstellen)).
`GITHUB_TOKEN` bleibt im Symphony-Prozess und wird aus der Umgebung von Agenten und Hooks entfernt.

### 4. Claude-Zugang erzeugen

Führe auf einem Rechner **mit Browser** (nicht auf dem Server) aus:

```bash
claude setup-token
```

Trage den ausgegebenen Token in der `.env` des Servers ein:

```dotenv
CLAUDE_CODE_OAUTH_TOKEN=…
```

Alternative: ein `ANTHROPIC_API_KEY`. Der Entrypoint verlangt eines von beiden.

### 5. SSH-Key erzeugen

Symphony klont per SSH, der Agent pusht per SSH. Der Key liegt als Docker-Secret `ssh_key` unter `./secrets/ssh_key`
(der Ordner `secrets/` ist in `.gitignore`):

```bash
mkdir -p secrets
ssh-keygen -t ed25519 -f secrets/ssh_key -N '' -C symphony@<server>
```

Das Secret ist ein Bind-Mount der Host-Datei und muss für die **UID im Container** lesbar sein (Standard `1000`, siehe
Schritt 9). Gehört die Datei einem anderen Benutzer, setze den Besitzer und einen engen Modus:

```bash
sudo chown "$(id -u):$(id -g)" secrets/ssh_key   # nur wenn UID/GID der Container dem Server-Benutzer entsprechen
chmod 400 secrets/ssh_key
```

Der Entrypoint kopiert den Key nach `~/.ssh/id_symphony` mit Modus `0600`. Liegt er im Container an einem anderen Pfad
als `/run/secrets/ssh_key`, setze `SYMPHONY_SSH_KEY`.

### 6. Public Key bei GitHub hinterlegen

Den Inhalt von `secrets/ssh_key.pub` trägst du bei GitHub ein. Es gibt zwei Wege:

- **Deploy-Key** (Repository → *Settings → Deploy keys*, **Allow write access** aktivieren): Ein Deploy-Key gilt
  **nur für ein Repository** und braucht Schreibrecht, sonst kann der Agent nicht pushen. Das passt, wenn
  `GITHUB_REPOSITORY` genau ein Repository nennt.
- **Maschinen-Benutzer:** Für mehrere Repositories legst du einen eigenen GitHub-Benutzer an, gibst ihm Schreibzugriff
  auf diese Repositories und trägst den Public Key in dessen *Settings → SSH keys* ein. GitHub erlaubt jeden Deploy-Key
  nur einmal, ein Benutzer-Key dagegen deckt alle Repositories dieses Benutzers ab.

Gib dem Key nur die nötigen Rechte, denn der Agent kann ihn erreichen (siehe [Sicherheit](#sicherheit)).

### 7. Git-Identität setzen

Die Agenten committen im Workspace; ohne Identität scheitert jeder Commit:

```dotenv
GIT_USER_NAME=Symphony
GIT_USER_EMAIL=symphony@example.com
```

### 8. Dashboard-Login einrichten

Das Dashboard hat keine eigene Anmeldung; Traefik übernimmt sie. Erzeuge eine htpasswd-Zeile (bcrypt):

```bash
htpasswd -nbB admin 'MeinPasswort'
# ohne lokales Apache:
docker run --rm httpd:2 htpasswd -nbB admin 'MeinPasswort'
```

Trage die Zeile in die `.env` ein, **in einfachen Anführungszeichen und jedes `$` einfach** (kein `$$`). So übernimmt
`docker compose` den Wert wörtlich, und Node liest ihn unverändert:

```dotenv
SYMPHONY_BASIC_AUTH='admin:$2y$05$…'
```

Alternativ nutzt du eine vorhandene Forward-Auth oder Middleware und setzt statt des BasicAuth
`SYMPHONY_TRAEFIK_MIDDLEWARES`, z. B. `authelia@docker` oder `a@file,b@docker`. Ohne eines von beiden bricht jeder
`docker compose`-Befehl ab (fail closed).

### 9. Domain und Traefik-Werte setzen

```dotenv
SYMPHONY_DOMAIN=symphony.example.com   # Pflicht
TRAEFIK_NETWORK=traefik                # externes Netzwerk von Traefik
TRAEFIK_ENTRYPOINT=websecure           # HTTPS-Entrypoint
TRAEFIK_CERTRESOLVER=letsencrypt
```

Die Werte nach dem `=` sind die Standardwerte der Compose-Datei; setze sie auf deine Namen aus den Voraussetzungen.

**Nur HTTP im LAN:** Hat dein Traefik keine Zertifikate (z. B. ein Heimnetz mit `*.docker.lan`), betreibe das Dashboard
ohne TLS auf dem HTTP-Entrypoint:

```dotenv
SYMPHONY_DOMAIN=symphony.docker.lan
TRAEFIK_NETWORK=docker_lan_network     # Netzwerk, an dem Traefik hängt
TRAEFIK_ENTRYPOINT=web                 # HTTP-Entrypoint (Port 80)
TRAEFIK_TLS=false                      # kein TLS am Router; TRAEFIK_CERTRESOLVER wird dann ignoriert
```

`TRAEFIK_TLS=false` ist nötig: Ein Router mit TLS (Standard) beantwortet nur TLS-Verbindungen, auch auf dem
HTTP-Entrypoint. Ohne die Zeile liefert `http://<SYMPHONY_DOMAIN>/` ein 404, obwohl der Container läuft. Beachte die
Hinweise unter [Sicherheit](#sicherheit): Über HTTP laufen Login und Daten unverschlüsselt.

`UID` und `GID` (Standard `1000`) sind Build-Args. Sie bestimmen den Besitzer der Volumes und der Datei
`./secrets/ssh_key`. Passe sie an, wenn dein Server-Benutzer eine andere ID hat (`id -u`, `id -g`):

```dotenv
UID=1001
GID=1001
```

Weitere optionale Werte: `SYMPHONY_PORT` (Standard `4000`), `TZ` (Standard `Europe/Berlin`) und `PHP_VERSION`
(Standard `8.4`, siehe [Fehlerbilder](#fehlerbilder)).

### 10. Dry Run

```bash
docker compose run --rm symphony --dry-run
```

Der Befehl baut das Image, falls nötig, prüft Variablen, Token und Board und startet keine Agenten. Er zeigt auch,
welche Variable fehlt (siehe [Fehlerbilder](#fehlerbilder)).

### 11. Starten

```bash
docker compose up -d --build
```

### 12. Logs ansehen

```bash
docker compose logs -f
```

### 13. Dashboard öffnen

Öffne `https://<SYMPHONY_DOMAIN>/` und melde dich mit dem Login aus Schritt 8 an. Mit `TRAEFIK_TLS=false` (Schritt 9) ist
es `http://<SYMPHONY_DOMAIN>/`; ein Browser im HTTPS-Only-Modus braucht dafür eine Ausnahme.

## Betrieb

### Update

```bash
git pull && docker compose up -d --build
```

Dabei wird der Container ersetzt: Laufende Agenten werden gestoppt, die **Workspaces bleiben** im Volume. Issues, deren
Karte noch in einer aktiven Spalte steht, nimmt Symphony nach dem Start wieder auf. Wartezeiten aus Session-Limits sind
danach vergessen, siehe [Fehlerbehebung](usage.md#fehlerbehebung).

### `stop_grace_period`

Bei `docker compose stop`, `down` und beim Update sendet Docker `SIGTERM`. Symphony stoppt dann seine Agenten und wartet
bis zu `hooks.timeout_ms` + 30 s auf sie und ihre `after_run`-Hooks. Die Compose-Datei gibt dafür
`stop_grace_period: 120s`, danach beendet Docker den Container hart. Bekommt die `WORKFLOW.md` einen langen
`after_run`-Hook, erhöhe den Wert in `docker-compose.yml`.

### Konfiguration ändern

- **`.env` geändert:** `docker compose up -d` erzeugt den Container mit den neuen Werten neu. Ein bloßes
  `docker compose restart` liest die `.env` nicht neu ein.
- **`WORKFLOW.md` oder `model-costs.yml` geändert:** Beide liegen im Image unter `/app`. Baue neu mit
  `docker compose up -d --build`. Ohne Rebuild geht es mit den optionalen Read-only-Mounts in `docker-compose.yml`
  (Kommentarzeichen entfernen):

  ```yaml
  - ./WORKFLOW.md:/app/WORKFLOW.md:ro
  - ./model-costs.yml:/app/model-costs.yml:ro
  ```

  Symphony lädt beide dann live neu. Ein Bind-Mount einer einzelnen Datei folgt aber dem Inode: Ersetzt dein Editor die
  Datei, statt sie an Ort und Stelle zu überschreiben, sieht der Container die alte Fassung. Dann hilft
  `docker compose restart`.

### Logs und Transkripte

`docker compose logs -f` zeigt die laufenden Logs. Log pro Repository und Transkripte liegen im Volume `state`, im
Container unter `/home/symphony/.local/state/symphony` (`SYMPHONY_LOG_DIR`):

```bash
docker compose exec symphony ls /home/symphony/.local/state/symphony/repositories
docker compose exec symphony ls /home/symphony/.local/state/symphony/sessions
```

Aufbau und Inhalt: [Logs, Transkripte und Workspaces](usage.md#logs-transkripte-und-workspaces).

### Volumes und Backup

| Volume | Pfad im Container | Inhalt |
|---|---|---|
| `state` | `/home/symphony/.local/state/symphony` | Log pro Repository, Transkripte |
| `claude` | `/home/symphony/.claude` | Zustand von Claude Code |
| `workspaces` | `/home/symphony/symphony-workspaces` | ein Klon pro Issue |
| `composer-cache` | `/home/symphony/.cache/composer` | Composer-Cache, ersetzbar |

Compose stellt den Projektnamen voran (meist der Ordnername): Das Volume heißt z. B. `symphony_state`. Prüfe die Namen
mit `docker volume ls`. Sicherung eines Volumes:

```bash
docker run --rm -v <volume>:/data:ro -v "$PWD":/backup debian:stable-slim tar czf /backup/<volume>.tgz -C /data .
```

Was wichtig ist:

- **`state`** (Statistiken und Logs) und **`claude`** (Claude-Zustand): sichern.
- **`workspaces`:** lassen sich neu klonen, enthalten aber **unfertige Arbeit** (ungepushte Commits, Änderungen).
- **`composer-cache`:** muss nicht gesichert werden.

### Bestehende Historie auf den Server übertragen

Startest du Symphony im Container, nachdem es schon lokal gelaufen ist, kannst du Log pro Repository
(`repositories/`) und Transkripte (`sessions/`) aus `~/.local/state/symphony` in das Volume `state` des Servers
übertragen. Das Skript läuft **lokal** und verbindet sich per SSH:

```bash
scripts/push-history.sh --dry-run   # zeigt nur, was passieren würde
scripts/push-history.sh
```

Es stoppt den Container auf dem Server (`docker stop`), sichert den dortigen Stand als `~/symphony-state-backup-<zeit>.tgz`, **ersetzt**
`repositories/` und `sessions/` komplett durch den lokalen Stand, vergleicht die Dateianzahl und startet den Container
wieder (auch bei einem Fehler). Alles, was der Server-Container bisher aufgezeichnet hat, wird dabei überschrieben.
Workspaces, Claude-Zustand und Composer-Cache werden nicht übertragen. Ein lokal laufendes Symphony muss vorher beendet
sein.

| Variable | Standard | Bedeutung |
|---|---|---|
| `SYMPHONY_CONTAINER` | `symphony` | Name des Containers auf dem Server (`docker ps -a`), bei Compose meist `<projekt>-symphony-1` |
| `SYMPHONY_REMOTE` | `cooolinho@docker.lan` | SSH-Ziel |
| `SYMPHONY_LOCAL_STATE` | `$SYMPHONY_LOG_DIR`, sonst `~/.local/state/symphony` | lokaler Log-Ordner |

Die Variablen liest das Skript aus der Shell oder aus der `.env` im Repository-Ordner **auf dem Rechner, auf dem du es
startest** (die Shell hat Vorrang), z. B. `SYMPHONY_CONTAINER=symphony-symphony-1`.

Optionen: `--yes` (ohne Rückfrage), `--no-backup`, `--dry-run`. Das Skript nutzt eine SSH-Verbindung für alle Schritte, ein
Passwort oder eine Passphrase wird also nur einmal abgefragt.

Das Backup spielst du bei Bedarf so zurück (auf dem Server; Container vorher mit `docker stop <container>` stoppen und
danach mit `docker start <container>` starten):

```bash
docker run --rm -i --volumes-from <container> --entrypoint bash "$(docker inspect -f '{{.Config.Image}}' <container>)" \
  -c 'cd /home/symphony/.local/state/symphony && rm -rf repositories sessions && tar xzf -' < ~/symphony-state-backup-<zeit>.tgz
```

### Ressourcen-Limits

Als Richtwert braucht jeder parallele Agent (Claude Code, Composer, Tests) etwa 1 CPU und 2 GB RAM. Mit
`SYMPHONY_MAX_CONCURRENT_AGENTS` begrenzt du die Parallelität. Optional begrenzt du den Container in
`docker-compose.yml` (Kommentarzeichen entfernen):

```yaml
cpus: 2
mem_limit: 4g
```

## Fehlerbilder

| Symptom | Ursache und Lösung |
|---|---|
| `Host key verification failed` | Die `known_hosts` für GitHub liegen im Image (`/etc/ssh/ssh_known_hosts`, aus `docker/ssh_known_hosts`). Ist der Eintrag veraltet, aktualisiere die Datei und baue neu. `StrictHostKeyChecking` **nicht** abschalten. |
| `Permission denied (publickey)` | Der Public Key fehlt bei GitHub, oder der Deploy-Key gehört zu einem anderen Repository oder hat kein Schreibrecht (*Allow write access*). Für mehrere Repositories einen Maschinen-Benutzer verwenden, siehe Schritt 6. Test: `docker compose exec symphony ssh -T git@github.com`. |
| `GitHub token lacks a required scope` | Dem Token fehlt `project` (oder `repo`). Einen klassischen Token mit `repo` und `project` erstellen und `GITHUB_TOKEN` ändern, dann `docker compose up -d`. |
| `network … declared as external, but could not be found` | Das Netzwerk aus `TRAEFIK_NETWORK` existiert nicht. Namen mit `docker network ls` prüfen und in der `.env` eintragen. |
| 404 oder 502 über die Domain | Der Container hängt nicht im Traefik-Netz: `TRAEFIK_NETWORK` muss das Netzwerk sein, an dem auch Traefik hängt (`docker network inspect <netz>`). Außerdem `SYMPHONY_DOMAIN`, `TRAEFIK_ENTRYPOINT` und `TRAEFIK_CERTRESOLVER` mit der Traefik-Konfiguration vergleichen und den Container-Status prüfen (`docker compose ps`). |
| 404 über `http://`, obwohl der Container `healthy` ist | Der Router hat TLS (Standard), hängt aber an einem HTTP-Entrypoint (`TRAEFIK_ENTRYPOINT=web`): Er beantwortet nur TLS-Verbindungen. Für reines HTTP setze `TRAEFIK_TLS=false` (Schritt 9), sonst nutze einen HTTPS-Entrypoint. Danach `docker compose up -d`. |
| Traefik-Log: `the router symphony@docker uses a non-existent resolver: letsencrypt` | `TRAEFIK_CERTRESOLVER` nennt einen Resolver, den Traefik nicht kennt (`docker logs traefik`). Setze den Namen aus der Traefik-Konfiguration oder schalte TLS mit `TRAEFIK_TLS=false` ab, wenn dein Traefik keine Zertifikate ausstellt. |
| `403 control_disabled` beim Retry | Der Neustart ist bei einer Nicht-Loopback-Bindung nur mit `SYMPHONY_ALLOW_REMOTE_CONTROL=true` erlaubt. `docker-compose.yml` setzt es; läuft der Container anders (z. B. mit eigener Umgebung), setze es dort. |
| `403 forbidden_origin` beim Retry | Der `Origin`-Header fehlt oder passt nicht zum `Host`. Der Browser setzt ihn selbst; per `curl` gibst du ihn mit: `-H 'Origin: https://<SYMPHONY_DOMAIN>'`, siehe [Dashboard und API](usage.md#dashboard-und-api). |
| `Permission denied` auf Volumes nach geänderter `UID`/`GID` | Die Volumes gehören noch der alten ID. Besitzer im Volume ändern, dann neu starten: `docker run --rm -v <volume>:/data debian:stable-slim chown -R <UID>:<GID> /data` für jedes Volume aus der Tabelle oben. Auch `secrets/ssh_key` muss für die neue UID lesbar sein. |
| `symphony-entrypoint: missing required environment variables:` | Der Entrypoint nennt die fehlenden Namen: `GITHUB_TOKEN`, `GITHUB_PROJECT_NUMBER`, `GITHUB_REPOSITORY`, `GIT_USER_NAME`, `GIT_USER_EMAIL` und `CLAUDE_CODE_OAUTH_TOKEN` oder `ANTHROPIC_API_KEY`. In der `.env` ergänzen, dann `docker compose up -d`. |
| `symphony-entrypoint: SSH key not readable: …` | `./secrets/ssh_key` fehlt oder ist für die UID im Container nicht lesbar, siehe Schritt 5. |
| Healthcheck `unhealthy` | Der Check ruft `/api/v1/state` auf `SYMPHONY_PORT` ab. Ohne gesetzten `SYMPHONY_PORT` entfällt er. Ursache steht in `docker compose logs`: meist ein Startfehler oder ein anderer Port in `.env` als in Traefik. In den ersten 60 s nach dem Start (`start-period`) wird er noch nicht gewertet. |
| `Laravel Boost skipped: composer install failed` oder Composer meldet eine PHP- oder Extension-Version, die nicht zu `composer.lock` passt | Das Image bringt PHP 8.4 mit den Extensions `mbstring`, `xml`, `curl`, `zip`, `intl`, `bcmath`, `sqlite3` und `gd` mit. Brauchen die Projekte eine andere Version, setze `PHP_VERSION` in der `.env` (z. B. `8.3`) und baue neu: `docker compose up -d --build`. Fehlt eine weitere Extension, ergänze sie im `Dockerfile` und baue neu. |

## Sicherheit

- **Nicht-root:** Symphony und die Agenten laufen im Container als Benutzer `symphony` (UID/GID aus den Build-Args), nicht
  als root. `/app` gehört root und ist für `symphony` schreibgeschützt: Agenten können Symphony selbst nicht ändern.
- **`GITHUB_TOKEN`** bleibt im Symphony-Prozess und wird aus der Umgebung von Agenten und Hooks entfernt. Die Checks
  bekommen zusätzlich weder `ANTHROPIC_API_KEY` noch `CLAUDE_CODE_OAUTH_TOKEN`.
- **`CLAUDE_CODE_OAUTH_TOKEN` und der SSH-Key** sind für den Agenten erreichbar. Gib dem Key deshalb nur die nötigen
  Rechte: einen Deploy-Key pro Repository oder einen Maschinen-Benutzer, der nur auf die bearbeiteten Repositories
  schreiben darf. Kein persönlicher Key.
- **Dashboard:** Es ist nur über Traefik mit Login erreichbar. Die Compose-Datei hat kein `ports:`, Symphony hat keine
  eigene Anmeldung, und **Retry** ist nur mit passendem `Origin` möglich (Schutz gegen CSRF). Behalte den Login (BasicAuth
  oder Forward-Auth) bei: Ohne ihn könnte jeder im Netz Worker neu starten.
- **Nur HTTP (`TRAEFIK_TLS=false`):** Das BasicAuth-Passwort, die Dashboard-Daten und der Retry-Aufruf gehen
  unverschlüsselt durchs Netz. Nutze das nur in einem vertrauenswürdigen LAN, nie über das Internet; dort bleibt HTTPS
  mit Zertifikat Pflicht.
- **Kein Docker-Socket, kein Docker-in-Docker:** Mounte `/var/run/docker.sock` nicht in den Container. Wer ihn erreicht,
  hat Root auf dem Host.
- **Vertrauen:** Issue-Texte sind fremde Eingaben. Bearbeite nur Boards, deren Issues du vertraust. Weitere Hinweise:
  [Sicherheit](usage.md#sicherheit).

← [Dokumentation](index.md) · Zurück: [Getting Started](getting-started.md)
