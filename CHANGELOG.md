# Changelog

All notable changes to this project are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [1.8.0] - 2026-11-24

### Added
- Dashboard: Link zum Board im Header (Chip „Board ↗“, `tracker.board` in `/api/v1/state`) (#607, closes #604)
- Context-Budget-Panel: Verlaufsgraph „Auslastung 5-h-Fenster“ mit Prognose, Pausen und Umschalter Fenster / 24 h / 7 Tage; neuer Endpunkt `GET /api/v1/budget/five-hour` (#608, closes #605)
