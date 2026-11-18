# SIS Bids, build B1 (settings and catalog)

SIS Bids is the estimating site that will replace D-Tools SI. It runs on its own site next to SIS Tools, but it uses
**the same database and the same sign-in**, so jobs, people and roles are shared and nothing gets copied between the two.

This build covers step 1 of the spec:

- **Settings:** cost codes with an hourly rate for each division (EL and LV), aliases for the old D-Tools codes,
  payment schedule templates, lead number counters (EL-0200, LV-0200), and systems with their subsystems.
- **Catalog:** products, labor items, non-taxable service items, and user-made packages. Labor is set in H:M:S per cost code.
  Packages can hold products, labor, services and other packages.
- **D-Tools catalog import:** loads your SI catalog export. It was tested on `Products Nov 18 2026` (2,673 products,
  about 0.6 s). Phases and labor types map through the aliases, for example `[6020]` to 7030 Rough-In.

The Bids tab shows a placeholder until build B2, which adds bids, the room tree and the takeoff.

## Deploy (once)

1. **Cloudflare dashboard › Workers & Pages › Create › Pages › Upload assets.** Name it `sis-bids` and upload this folder.
   It holds `_worker.js`, `index.html`, `app.js` and `style.css`.
2. **Settings › Bindings › D1 database:** add binding `DB` and pick **the same D1 database SIS Tools uses**.
3. **Settings › Variables and secrets:**
   - `ACCESS_AUD`: the Application Audience tag from step 4.
   - `ACCESS_TEAM`: the same value as in SIS Tools.
   - `ADMIN_EMAILS`: the same value as in SIS Tools.
   - `SIS_TOOLS_HOST` (optional): SIS Tools' hostname, for example `tools.example.com`. This adds a link back to it in the header.
4. **Zero Trust › Access › Applications › Add › Self-hosted:** add the new site's hostname, with the same policy SIS Tools uses.
   Copy its **Application Audience (AUD) tag** into `ACCESS_AUD`.
5. Deploy again so the bindings take effect, then open the site.

## Who can use it

- Admins always have access.
- Otherwise it's **PMs and up**: the Project Manager role, plus any role with Edit on Projects or Administration.
- If an admin later gives the `bids` tool a level in SIS Tools' Role permissions, or sets a per-person exception, that level wins.
- Only Admins, and roles with "Manage roles", can change Settings. Everyone else sees them read-only.

## First steps after deploying

1. In **Settings**, fill in the EL and LV rate for each cost code, then click **Save cost codes**.
2. In **Settings › Lead numbers**, set the next EL and LV numbers, then click **Save lead numbers**.
   These can only move forward.
3. In **Catalog**, click **Import D-Tools catalog** and pick your SI catalog export (CSV).
   You can re-import at any time; products are matched on manufacturer and model.

## Data

New tables, all created on first use:

| Table | Holds |
| --- | --- |
| `bid_catalog` | Every catalog item |
| `bid_catalog_labor` | Labor lines in seconds, per cost code |
| `bid_package_items` | Package contents |
| `bid_lead_counters` | The next lead number per division |

Settings live in SIS Tools' `settings` table under the keys `bids:costCodes`, `bids:paySchedules` and `bids:systems`.
Nothing that SIS Tools already stores is changed.

## Local test

Run `npx wrangler pages dev .` with a D1 binding `DB` and the variables `DEV_LOGIN=1` and `ADMIN_EMAILS=you@x`.
Then open `http://127.0.0.1:8788/__dev` to sign in as any email.
