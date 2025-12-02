# BMD NTCS Integration

BMD NTCS ist Österreichs führende Buchhaltungssoftware. Die Integration erfolgt über die bestehenden File-Connectors (CSV/Excel) statt eines eigenen API-Connectors.

## Warum File-basierte Integration?

1. **BMD hat kein öffentliches REST-API** - Der Datenimport erfolgt ausschließlich über CSV-Dateien
2. **Verschiedene Import-Modi** - BMD unterstützt mehrere CSV-Formate je nach Datentyp
3. **Flexibilität** - Die File-Connectors können an jedes BMD-Importformat angepasst werden

## BMD Import-Formate

### 1. Buchungen (Buchungsimport)

BMD akzeptiert Buchungen über "Buchen → Import Buchungen" oder "Vorerfassung Buchungen".

**Format-Optionen:**
- **Fixe Feldlängen** (legacy): Keine Trennzeichen, Felder durch Position definiert
- **CSV mit Spaltenüberschriften** (NTCS): Semikolon-getrennt mit Header-Zeile

**Typische Felder für Buchungsimport:**

| Feld | Typ | Beschreibung |
|------|-----|--------------|
| Buchungsdatum | date | Datum der Buchung (dd.MM.yyyy) |
| Belegnummer | string | Eindeutige Belegnummer |
| Sollkonto | number | Konto für Soll-Buchung |
| Habenkonto | number | Konto für Haben-Buchung |
| Betrag | decimal | Buchungsbetrag (Komma als Dezimaltrenner) |
| Steuercode | string | BMD-Steuercode (z.B. "U20" für 20% USt) |
| Buchungstext | string | Beschreibung der Buchung |
| Kostenstelle | string | Optional: Kostenstelle |

### 2. Personenkonten (Debitoren/Kreditoren)

Import über "FIBU-Stammdaten → Konten".

**Felder für Personenkonten:**

| Feld | Typ | Beschreibung |
|------|-----|--------------|
| Kontonummer | number | Eindeutige Kontonummer |
| Bezeichnung | string | Firmen- oder Personenname |
| Straße | string | Adresszeile |
| PLZ | string | Postleitzahl |
| Ort | string | Stadt |
| Land | string | Länderkürzel (AT, DE, etc.) |
| UID | string | UID-Nummer |
| Telefon | string | Telefonnummer |
| Email | string | E-Mail-Adresse |
| Zahlungsbedingung | string | BMD-Zahlungsbedingung |

### 3. Sachkonten

Import über "Sonderprogramme → Datenexport → BMD".

**Felder für Sachkonten:**

| Feld | Typ | Beschreibung |
|------|-----|--------------|
| Kontonummer | number | Sachkontonummer |
| Bezeichnung | string | Kontobezeichnung |
| Kontotyp | string | Aktiva, Passiva, Aufwand, Erlös |
| Steuercode | string | Standard-Steuercode |

## Beispiel-Konfiguration

### Export aus Odoo für BMD

```json
{
  "connectors": [
    {
      "id": "odoo-invoices",
      "name": "Odoo Rechnungen",
      "type": "odoo",
      "url": "https://mycompany.odoo.com",
      "database": "mydb",
      "username": "admin@example.com",
      "password": "api-key",
      "model": "account.move",
      "readonly": true
    },
    {
      "id": "bmd-buchungen",
      "name": "BMD Buchungen Export",
      "type": "csv",
      "filePath": "./export/bmd_buchungen.csv",
      "delimiter": ";",
      "headers": true
    }
  ]
}
```

### Transformation: Odoo → BMD Format

Da Odoo und BMD unterschiedliche Feldnamen verwenden, ist eine Transformation nötig:

```typescript
// Beispiel: Odoo account.move → BMD Buchung
function transformInvoiceToBMD(odooInvoice: OdooInvoice): BMDBuchung {
  return {
    Buchungsdatum: formatDate(odooInvoice.invoice_date, 'dd.MM.yyyy'),
    Belegnummer: odooInvoice.name,
    Sollkonto: mapOdooAccountToBMD(odooInvoice.debit_account_id),
    Habenkonto: mapOdooAccountToBMD(odooInvoice.credit_account_id),
    Betrag: odooInvoice.amount_total.toFixed(2).replace('.', ','),
    Steuercode: mapOdooTaxToBMD(odooInvoice.tax_ids),
    Buchungstext: odooInvoice.ref || odooInvoice.name,
  };
}
```

## Import-Reihenfolge

BMD erfordert eine bestimmte Reihenfolge beim Import:

1. **Sachkonten** - Müssen existieren bevor Buchungen referenziert werden
2. **Personenkonten** - Debitoren/Kreditoren vor Buchungen importieren
3. **Buchungen** - Erst nach Konten-Import möglich

## Tipps für die Praxis

### Encoding
- BMD erwartet **Windows-1252** oder **UTF-8 mit BOM**
- CSV-Connector verwendet standardmäßig UTF-8

### Dezimalzahlen
- BMD verwendet **Komma** als Dezimaltrenner (1.234,56)
- Tausendertrennzeichen: Punkt

### Datumsformat
- Deutsches Format: **dd.MM.yyyy**
- Beispiel: 15.12.2025

### Belege/Dokumente
- PDF-Belege müssen im gleichen Ordner wie CSV liegen
- Dateiname in CSV muss exakt übereinstimmen

## Weiterführende Ressourcen

- [BMD Datenimport Anleitung](https://academy.domonda.com/academy/bmd-datenimport)
- [BMD NTCS Schnittstelle](https://www.schmidhuber.com/de/euronews/daten-import-export/bmd-ntcs)
- [Domonda BMD Academy](https://academy.domonda.com/academy/bmd)
