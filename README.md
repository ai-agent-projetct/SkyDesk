# RPTO Portal

Training management platform for drone RPTOs: public website + Super Admin, RPTO Admin, Staff and Student (pilot) portals.
Node.js (Express 5, EJS) + MySQL. Installable as an app (PWA).

## Setup

1. Copy `.env.example` to `.env` and fill in your MySQL user/password, a long `SESSION_SECRET`, `APP_URL`, and the first super admin's email/password.
   Email (SMTP) and Razorpay are optional — leave them blank to run without.
2. Install and create the database:
   ```
   npm install
   npm run setup            # tables + super admin
   npm run setup -- --demo  # optional: fictional demo RPTO, staff, students, batch, sample flight (password Demo@1234)
   ```
3. `npm start` → http://localhost:3000
4. `npm test` runs the smoke test. It changes data (takes tests, resets passwords), so run it on a **fresh** demo database.
5. Going live on a real server (domain, HTTPS, backups, checklist): see [DEPLOY.md](DEPLOY.md).

## Roles & workflow

| Who | Logs in to | Can do |
|---|---|---|
| Super Admin | `/super` | Review RPTO registrations + documents, approve / reject / suspend, create RPTOs directly, set staff limit (default 30), manage every user (password / two-step reset, Pilot Pro), payments, **training defaults** (default syllabus + question bank), tutorials |
| RPTO Admin (Accountable Manager / Admin) | `/rpto` | Everything for their RPTO: CRM & fees (GST, receipts), admissions, batches & timeline, tests, certificates, assets, logbooks & incidents, reports, members, settings (syllabus, question bank, branding, default trainer) |
| Instructor | `/rpto` | Dashboard, batches (per-trainee progress, flight-log attach), tests & marking, assets (view), logbooks, reports |
| Business Development | `/rpto` | Dashboard, CRM & fees |
| Student / pilot (unlimited) | `/student`, `/pilot` | Apply to batches, documents, schedule, online theory test, simulator test, pilot hub (logbooks, fleet, live monitor, tutorials), flight logs & 3D replay, simulator, record, certificate, plans & billing |

1. RPTO registers at `/register-rpto` with its documents → **pending**.
2. Super Admin approves → RPTO portal activates, official details lock.
3. Admin adds staff (Members, with DGCA instructor certificates) and assets, creates a batch, clicks **Auto schedule**:
   shared ground classes, then per-trainee simulator/flying slots (no RPAS, seat, instructor or trainee double-booked), then tests.
   Fine-tune on the **Timeline** (drag / resize, undo, slot gap).
4. Leads (CRM) → trainees → documents verified (trainees consent first; they can add extra documents) → admitted (roll no. + fee incl. GST).
5. Progress: mark ground classes done; slide each trainee's simulator/flying progress; attach flight logs to flying slots (drag files from a folder).
6. Tests: online MCQ (the RPTO's own bank, or the platform default), browser simulator test, practical test marked with evidence + log, OMR sheets for paper tests.
7. Eligible trainee → **Issue certificate** (signed by the RPA trainer) → record **RPC** number (trainee document files are then deleted) → ZIP record package.

## 3D homepage

The public homepage is a scroll-driven 3D site: a procedurally modelled quadcopter (three.js, served locally from
`node_modules/three` at `/vendor/three/`) flies through the page as you scroll. It hovers in the hero, then flies a pinned
3D-replay stage over low-poly terrain (Follow → Chase → Top → Side → FPV with a cockpit HUD). After that it perches beside the
feature cards while the sky turns to night, and lands on the helipad in the footer. Its poses come from `data-drone-at` /
`data-drone` markers in `views/public/home.ejs`, so moving a marker moves the drone. Add `?debug3d` to the URL to read its screen
position in the console. The design brief is in [docs/3d-homepage-prompt.md](docs/3d-homepage-prompt.md). With reduced motion or
no WebGL, the page falls back to a still drone and a static list of the replay views.

## Flight logs, 3D replay & analysis

`/flights` — upload ArduPilot `.bin` / `.log`, PX4 `.ulg` or CSV/TXT (needs latitude/longitude columns; DJI/Airdata-style
headers with feet/mph units are converted). INAV/Betaflight blackbox logs must be exported to CSV first.
The parser also reads flight modes, battery voltage/current, vibration, RC input, attitude/rate loops, parameters, the uploaded mission and errors.
The replay (dependency-free canvas, works offline) has 3D / top / side / chase / follow / FPV / orbit cameras, trace colour by altitude, speed,
climb, power, pitch or flight mode, mission waypoints and geofence, a mode timeline, full telemetry and sticks, synced graphs with presets,
Performance / Parameters / Analysis tabs, a **PID copilot** (heuristic tuning hints + a `.param` file of suggested changes — test carefully),
a printable **report** (Save as PDF) and **video export** (WebM). The free plan allows `FREE_FLIGHT_LIMIT` self-uploaded flights; Pilot Pro is unlimited.

## Practice simulator

`/simulator` — mode-2 keyboard or USB transmitter/gamepad (axis mapping, invert and **calibrate centre**), Stabilize / AltHold / Loiter
modes, arming by stick gesture (throttle down + yaw right) or button, take-off and return-home buttons, battery drain with a low-battery
return-home failsafe, motor sound, drills (hover & land, 10 m square, figure-8, **agri spray field** with coverage scoring, **FPV gate course**,
free flight), "watch demo" autopilot, flight-path trace and **replay last run**, drone profiles (trainer, sport, agri, or "fly like my drone"
from your own uploaded flights), gusty wind, pilot / chase / top / FPV views, and voice coaching in 11 languages (English, Hindi, Tamil,
Telugu, Kannada, Malayalam, Marathi, Bengali, Gujarati, Punjabi, Odia — phrases live in `PHR` / `PHR2` in `public/sim.js`; have a native
speaker review them; the device needs a speech voice installed for each language). It is a simplified model, not ArduPilot SITL.
A batch test of type **Simulator** can be opened for trainees: three drills in 15 minutes, scored in the browser (self-reported — supervise it).

## Pilot hub & logbooks

`/pilot` — dashboard (totals, this month, currency, last flight, what needs attention, personal bests, fleet, recent flights, quick actions).
`/pilot/fleet` — the pilot's own drones and batteries with hours, battery cycles and a maintenance log.
`/pilot/logbook` — pilot logbook (RPTO training flights, uploads, manual entries, and "instructing" flights for instructors, kept out of their
own total), flight logbook per drone, battery logbook (cycle count), maintenance logbook and simulator training; local/UTC toggle, print and Excel.
On a replay, **Add to logbook** records the drone, battery, exercise, RPIC and place. `/pilot/live` is a read-only live monitor for a local
[mavlink2rest](https://github.com/mavlink/mavlink2rest) bridge (with a demo flight); it never sends commands, and a recording can be saved as a flight.
`/pilot/tutorials` lists the platform's tutorials, with comments.

## Your account & data

Two-step verification (authenticator app, recovery codes; the super admin can reset it), sign out everywhere, instructor signature (printed on
certificates), **download my data** (ZIP of everything held plus uploaded files) and **delete account** (anonymised; training records an RPTO
must keep are retained without contact details; the last admin of an RPTO can't delete themselves).

## Completion credits & partner programme (optional)

- `CREDIT_PRICE` > 0 turns on completion credits: issuing a certificate uses 1 credit from the RPTO's balance, unless the trainee has an
  active Pilot Pro plan (then it's free). RPTOs buy credits under **Billing** (Razorpay); the super admin can add or remove credits on the RPTO's page.
  The balance can never go negative, and a double-clicked "Issue certificate" uses only one credit.
- `PARTNER_SHARE_PERCENT` > 0 turns on the partner programme: when a pilot pays for Pilot Pro within `PARTNER_MONTHS` of being certified,
  the certifying RPTO earns that % of the payment. The super admin sees what's due under **Payments** and marks it paid after paying out.

## Notes

- Uploaded files are stored in `uploads/` and only served to people entitled to see them.
- Without SMTP, new logins get a generated password shown once on screen; with SMTP an invitation/set-password link is emailed.
  "Forgot password" by email needs both SMTP and `APP_URL`.
- Changing a password (or an admin reset) signs the user out on all other devices; users can also do this under My account.
- Razorpay: set `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET`. Payments are confirmed server-side by signature check. Test in Razorpay test mode first.
- The syllabus and question bank are data: the platform default is edited under **Training defaults** (super admin); an RPTO can
  customise its own copy under **Settings → Syllabus / Question bank** (CSV import/export). `DEFAULT_SYLLABUS` in `src/training.js` only seeds a new install.
- "Export to Excel" downloads CSV files, which open directly in Excel.
- Scripts and styles are served as `/static/x.js?v=<hash>`; the hash changes when a file changes, so restart the app after updating files.
