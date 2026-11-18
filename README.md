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

## Deploy (Workers Builds from GitHub)

Every push to `main` deploys automatically: Cloudflare runs `npx wrangler deploy`, using `wrangler.jsonc`.

1. In `wrangler.jsonc`, fill in `database_name` and `database_id` for **the same D1 database SIS Tools uses**.
   Find them under Workers & Pages › D1.
2. In Cloudflare, go to Workers & Pages › Create › Import a repository and pick `aff1690/sis-bids`.
   - Build command: leave blank.
   - Deploy command: `npx wrangler deploy`.
   - Path: `/`, the repo root.
3. In the new Worker, open **Settings › Variables and secrets** and add these:
   - `ACCESS_AUD`
   - `ACCESS_TEAM`: the same value as SIS Tools.
   - `ADMIN_EMAILS`: the same value as SIS Tools.
   - `SIS_TOOLS_HOST`: optional.

   `keep_vars` in `wrangler.jsonc` keeps deploys from wiping these.
4. Put the Worker behind **Cloudflare Access** with the same policy as SIS Tools, either with the "Protect with Cloudflare Access" toggle
   or under Zero Trust › Access › Applications. Copy the application's AUD tag into `ACCESS_AUD`.

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

Run `npx wrangler dev` with the variables `DEV_LOGIN=1` and `ADMIN_EMAILS=you@x`.
Then open `http://127.0.0.1:8788/__dev` to sign in as any email.
