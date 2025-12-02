# DataTrust - MCP Enterprise Connectors

LLM-gesteuerte Datenintegration über das Model Context Protocol.

![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)
![License](https://img.shields.io/badge/License-BSL%201.1-blue)
![Tests](https://img.shields.io/badge/Tests-20%20passing-brightgreen)

## Das Problem

Unternehmensdaten liegen in Silos: ERP, CRM, Buchhaltung, Excel-Listen. Manuelle Datenübertragung zwischen Systemen kostet Stunden pro Woche und produziert Fehler. Bestehende Integrationslösungen sind entweder zu teuer (Enterprise iPaaS) oder zu limitiert (Zapier für komplexe Logik).

## Die Lösung

Ein MCP-Server, der LLM-Agenten direkten Zugriff auf Geschäftsdaten gibt. Connectors für gängige Systeme + ein Trust Layer für Datenqualität und Compliance.

## Features

| Feature | Beschreibung | MCP Tool |
|---------|--------------|----------|
| **Connectors** | Excel, CSV, JSON, Odoo, HubSpot, PostgreSQL, MySQL | `list_connectors`, `read_records`, `write_records` |
| **Consistency Check** | Datenabgleich zwischen zwei Systemen | `compare_records` |
| **Change Detection** | Was hat sich seit Zeitpunkt X geändert? | `detect_changes`, `create_snapshot` |
| **Audit Trail** | Wer hat was wann geändert? | `query_audit_log` |
| **Reconciliation** | Automatischer Abgleich (z.B. Zahlungen ↔ Rechnungen) | `reconcile_records` |

## Quick Start

```bash
# Clone & Install
git clone https://github.com/aliuyar1234/datatrust.git
cd datatrust
pnpm install
pnpm build

# Server starten
node packages/mcp-server/dist/cli.js --config config.json
```

**Minimale Konfiguration (`config.json`):**

```json
{
  "server": { "name": "my-connectors", "version": "1.0.0" },
  "connectors": [
    {
      "id": "invoices",
      "type": "csv",
      "filePath": "./data/invoices.csv"
    },
    {
      "id": "customers",
      "type": "hubspot",
      "apiKey": "${HUBSPOT_API_KEY}",
      "objectType": "contacts"
    }
  ]
}
```

**Erster Befehl (im LLM):**

```
Lies alle Rechnungen über 1000€ aus dem invoices-Connector
```

## Use Cases

### 1. Datenabgleich zwischen Systemen

```
Vergleiche Kunden in Odoo mit Kontakten in HubSpot.
Zeige mir alle, die nur in einem System existieren.
```

→ `compare_records` findet Inkonsistenzen, zeigt fehlende Datensätze und Feldunterschiede.

### 2. Change Tracking

```
Was hat sich in der Kundendatenbank seit gestern 18:00 geändert?
```

→ `detect_changes` mit Timestamp-Feld oder Snapshot-Vergleich.

### 3. Zahlungsabgleich

```
Matche den Bankauszug mit offenen Rechnungen.
Toleranz: ±0.01€, Datum ±7 Tage.
```

→ `reconcile_records` mit konfigurierbaren Matching-Regeln und Confidence Scores.

## Packages

| Package | Beschreibung |
|---------|--------------|
| `@datatrust/core` | Interfaces, Types, Filter-Utilities |
| `@datatrust/connector-file` | CSV, JSON, Excel |
| `@datatrust/connector-api` | Odoo, HubSpot |
| `@datatrust/connector-db` | PostgreSQL, MySQL |
| `@datatrust/trust-core` | Data Trust Layer |
| `@datatrust/mcp-server` | MCP Server Implementation |

## Filter Syntax

```json
{
  "where": [
    { "field": "amount", "op": "gt", "value": 1000 },
    { "field": "status", "op": "eq", "value": "open" }
  ],
  "orderBy": [{ "field": "date", "direction": "desc" }],
  "limit": 100
}
```

**Operatoren:** `eq`, `neq`, `gt`, `lt`, `gte`, `lte`, `contains`, `in`

## Reconciliation Rules

```json
{
  "rules": [
    { "name": "amount", "sourceField": "amount", "targetField": "total",
      "operator": "equals_tolerance", "weight": 40, "options": { "tolerance": 0.01 } },
    { "name": "reference", "sourceField": "reference", "targetField": "invoice_number",
      "operator": "contains", "weight": 35 },
    { "name": "date", "sourceField": "booking_date", "targetField": "due_date",
      "operator": "date_range", "weight": 25, "options": { "dateRangeDays": 7 } }
  ],
  "minConfidence": 60
}
```

**Operatoren:** `equals`, `equals_tolerance`, `contains`, `regex`, `date_range`

## Development

```bash
pnpm install     # Dependencies
pnpm build       # Build all packages
pnpm -r test     # Run tests (20 tests)
```

## License

This project is licensed under the [Business Source License 1.1](./LICENSE.md).

**Free for:**
- Development and testing
- Learning and education
- Production use by organizations with annual revenue below €100,000

**After January 1, 2029:** Converts to MIT license (fully open source).

See [NOTICE.md](./NOTICE.md) for third-party licenses.

## Commercial Licensing

For production use by organizations with annual revenue of €100,000 or more, a commercial license is required.

**Contact:** ali.uyar1@hotmail.com

**Repository:** https://github.com/aliuyar1234/datatrust
