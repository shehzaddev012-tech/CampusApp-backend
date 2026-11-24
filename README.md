# CampusHub API

Node 22+ · Fastify · PostgreSQL · TypeScript. One API for the mobile app (and later the admin web dashboard).

## Setup (local)

1. Install PostgreSQL 15+ and note the `postgres` password.
2. `copy .env.example .env` and fill `DATABASE_URL` and a random `JWT_SECRET` (32+ chars). `.env` is git-ignored.
3. ```powershell
   npm install
   npm run db:create     # creates the database
   npm run migrate       # applies migrations/*.sql (checksummed, advisory-locked)
   npm run seed:study    # sample notes, books, study groups and jobs for IAC (run after seed)
   npm run seed          # 3 universities + test accounts + sample posts/events   (--reset to start over)
   npm run dev           # http://localhost:4000  (GET /health)
   ```
4. `npm test` runs the integration tests against a separate `campushub_test` database it creates itself.

## Test accounts (AUTH_MODE=dev only)

`ayesha@iac.test` (student), `society@iac.test`, `admin@iac.test`, `security@iac.test`, `deptadmin@iac.test`, `pending@iac.test` (waiting for approval), plus accounts for the `uol` and `demo` universities. The app lists them on its sign-in screen.

## Create a user or the first admin

```powershell
npm run create-user -- --email admin@uni.edu --name "Dr. Admin" --password "Strong#Pass1" --uni iac --role uni_admin
```
The person is created verified and approved, and signs in with that email and password. Roles: student, society_head, dept_admin, uni_admin, security. Running it again for the same email updates the password and role.

## Sign-in and email

Three ways in: **email + password** (sign-up confirmed by an emailed code; each sign-in asks for another emailed code while `REQUIRE_LOGIN_OTP=true`), **Continue with Google**, and in development only the seeded test accounts.

- Codes are 6 digits, valid 10 minutes, one use, at most 5 tries, one new code per 60 s. Only a keyed hash of a code is stored. Passwords use scrypt. 8 wrong passwords lock the account for 15 minutes. Changing the password signs the account out everywhere and sends a notice email.
- Without `SMTP_HOST` (development) emails are kept in memory; `GET /v1/dev/outbox?to=<email>` shows them and the app offers a tap-to-fill chip. Production refuses to start without SMTP.
- Emails are branded HTML with a plain-text twin (`src/mail/templates.ts`). For good inbox placement send from your own domain and add SPF / DKIM / DMARC records (your mail provider shows the values). A normal Gmail account works for testing but is limited to about 500 emails a day.

## Production checklist

- `NODE_ENV=production` (the API refuses `AUTH_MODE=dev` then), a managed PostgreSQL URL (use SSL), a new long `JWT_SECRET`, `CORS_ORIGIN` set to your real origins.
- `AUTH_MODE=firebase` + `FIREBASE_SERVICE_ACCOUNT` (see the app's `docs/FIREBASE_SETUP.md`).
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` (see `.env.example`). The API will not start in production without SMTP.
- Run behind HTTPS (reverse proxy / platform) and set the app's `API_URL` to that address.
- Run `npm run build` then `npm start`; run `npm run migrate` on each deploy. Back up the database.
- Set `RUN_JOBS=true` on exactly one instance (event reminders).
- Photos are files in `UPLOADS_DIR`: put it on a persistent disk **outside** the code folder, and back it up with the database. For more than one server, or hosting without a disk, add an object-store implementation in `src/storage`.

## Layout

```
migrations/   SQL schema (never edit an applied file; add a new one)
src/modules/  one file per area (auth, passwordAuth, membership, admin, posts, events, societies, albums, passes, devices, notifications)
src/media/    image processing (decode, strip EXIF, resize, thumbnail) and signed picture links
src/storage/  where uploaded files live (a folder today; swap for S3/R2)
src/auth/     tokens, Firebase verification, guards (who is asking, which university)
src/mail/     SMTP mailer + email templates
src/push/     FCM + Notifier (inbox first, push second)
src/jobs/     event reminders
test/         integration tests (isolation, tickets, seats, check-in, ...)
```
