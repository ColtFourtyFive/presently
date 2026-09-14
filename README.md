# Kumon center CRM

An in-house CRM for one Kumon center, built with React, TypeScript, Express, and PostgreSQL. This first build covers student and guardian records, inquiries, recurring schedules, staff attendance, follow-up tasks, and attendance history.

The preview is hosted at [web-production-ce255.up.railway.app](https://web-production-ce255.up.railway.app) in the [Kumon CRM Railway project](https://railway.com/project/83fb1c4c-5246-4250-8e00-a4fc4053c5ff). The `web` service connects to the project's `Postgres` service. Sign-in credentials are in the private, Git-ignored `LOCAL_ACCESS.md` file on the development computer. The preview contains fictional records.

The requirements remain in `research/BRD.md`, `research/FRD.md`, and `research/FDR.md`. The application implements a subset of that proposed first release. See [implementation status](docs/implementation-status.md) for the remaining work before operational use.

## Run locally

Use Node.js 22 or later.

```sh
npm install
cp .env.example .env
```

Set `ADMIN_EMAIL` and a strong, unique `ADMIN_PASSWORD` of at least 12 characters in `.env`, then run:

```sh
npm run dev
```

Open `http://127.0.0.1:3000`. The initial owner account comes from your environment settings. These values only create the first account; changing them after initialization does not reset its password. Passwords and access details belong in your password manager or ignored local files, never in this repository.

When `DATABASE_URL` is empty, PGlite persists data in `.data/postgres`. Restarting the server preserves that data. Set `DATABASE_URL` to use PostgreSQL instead. `SEED_DEMO=true` creates fictional sample records when the database is initialized. Use a separate empty database with `SEED_DEMO=false` for a future real-data environment.

## Check and build

```sh
npm test
npm run build
npm start
```

Tests use an isolated, in-memory PGlite database and exercise the HTTP API. The build type-checks the project, compiles the browser application, and bundles the Express server. `npm start` serves the compiled application.

For browser workflow checks, start the local server with its demo database, then run:

```sh
npx playwright install chromium
npm run test:e2e
```

The browser suite reads credentials from `.env`, creates clearly labeled synthetic records, and writes screenshots plus a check report to `tmp/browser`. It requires a demo database. `BASE_URL` can select a different preview environment; use it only for environments where creating test records is appropriate.

## Deploy on Railway

The repository contains `railway.json` with `npm run build`, `npm start`, and `/api/health` as the deployment health check.

Create a web service and PostgreSQL service in the same Railway project. Configure the web service with:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Reference the PostgreSQL service's `DATABASE_URL` |
| `ADMIN_EMAIL` | Initial owner's email |
| `ADMIN_PASSWORD` | A strong, unique secret |
| `CENTER_NAME` | Center's display name |
| `CENTER_TIMEZONE` | IANA time zone, such as `America/Los_Angeles` |
| `HOST` | `0.0.0.0` |
| `NODE_ENV` | `production` |
| `APP_URL` | The public HTTPS application origin |
| `SEED_DEMO` | `true` for the fictional demo, `false` for a new real-data database |

Railway supplies `PORT`. Use the attached PostgreSQL service in Railway; local PGlite storage is for local development and must not be relied on across Railway container replacements. Railway variables and `.env` are configuration secrets and must not be committed.

The health endpoint checks application and database availability. It does not certify backup recovery, attendance policy compliance, or all requirements in the FRD.

The current deployment uses `SEED_DEMO=true`. To deploy another version from this linked checkout, run `railway up --service web`. The `.railwayignore` file excludes local credentials, local databases, research source files, generated requirement documents, and test output from uploads. Railway project configuration remains in `railway.json`.

## Current operating boundaries

This build contains fictional demo records. It has no connection to Kumon corporate systems, payment processing, or outbound email and SMS. Guardian contact history records staff-entered notes.

Attendance records describe staff-observed arrivals and departures. Schedules do not create attendance. A restricted pickup must not be treated as authorized release. An observed exceptional departure records the fact and creates a review incident.

Before introducing real student data, complete the authentication, contingency, retention, recovery, and operating-readiness work tracked in [implementation status](docs/implementation-status.md). A successful deployment alone does not complete the FRD's proposed M1 release.
