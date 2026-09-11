# Build prompt — SkyDesk 3D scroll homepage

Use this prompt (with an AI builder, or as a spec for a developer) to rebuild the public homepage as a scroll-driven 3D site.
It describes the **technique** studied on a reference drone site — a 3D drone that flies through the whole page as you scroll —
applied to SkyDesk's own product, copy and brand. Do not reuse the reference site's text, images, logo or 3D assets.

---

## Prompt

> Build a single-page marketing homepage for **SkyDesk**, a platform for drone Remote Pilot Training Organisations (RPTOs)
> and their pilots. The page is server-rendered HTML (Node/Express + EJS), styled with plain CSS, with one WebGL layer made in
> **three.js** (no React, no page builder). A procedurally modelled quadcopter lives in a fixed, full-viewport, transparent canvas
> above the page content (pointer-events: none) and is choreographed by scroll position, so it feels like the drone is travelling
> through the story. Everything must still work — readable and clickable — with WebGL off or `prefers-reduced-motion: reduce`.
>
> **The drone (built in code, no model file).** Rounded fuselage in brand blue (#1d6fe8) with a darker canopy, four arms in an X,
> motor bells, two-blade propellers that spin (speed follows the "throttle" — idle when landed, fast in flight), thin prop guards
> with orange tips, a small camera gimbal under the nose, skid landing gear, a green front LED and red rear LED (emissive).
> Soft hemisphere + sun lighting. It gently bobs and banks into its direction of travel; pitch nose-down when moving forward.
>
> **Sky.** Two fixed background layers: a daytime sky gradient with drifting CSS clouds at the top of the page, cross-fading to a
> deep navy "night" gradient with faint stars from the pilot-tools sections onwards, and back to a calm gradient for the footer.
>
> **Choreography (screen-space keyframes).** Each section defines where the drone should sit on screen (x/y in viewport units),
> its size, heading and attitude. Between keyframes the pose is interpolated with an ease-in-out curve, so scrolling smoothly
> flies it from one spot to the next, banking on lateral moves. Keyframes are anchored to real DOM sections (measured on load and
> resize), not hard-coded pixel offsets.
>
> **Sections, top to bottom.**
> 1. **Hero** — day sky and clouds. Badge "For DGCA-authorised RPTOs & their pilots", headline about running a drone school and a
>    pilot career from one place, two CTAs (Register your RPTO / I'm a pilot) and live stats (RPTOs, pilots, certificates).
>    Drone: large, hovering below the CTAs, slowly yawing, with a curved flight-path ribbon behind it.
> 2. **3D replay (pinned, ~5 screens of scroll).** A sticky full-screen stage: the drone flies a recorded-looking path over a
>    low-poly procedural terrain with a glowing trail. Scrolling steps the camera through **Follow → Chase → Top → Side → FPV**;
>    a caption card explains each view and a row of pills shows which one is active. In FPV, overlay a cockpit HUD — speed,
>    altitude, vertical speed, battery, satellites, heading tape and a REC timer — driven by the path data.
>    Copy explains that pilots upload ArduPilot (.bin/.log), PX4 (.ulg) or CSV logs and get a 3D replay with graphs,
>    flight-health checks, PID tuning hints and a PDF report.
> 3. **For RPTOs** — a grid of feature cards: admissions & documents, auto-scheduled batches with a drag-and-drop timeline,
>    per-trainee progress, tests (online, simulator, practical with evidence, OMR sheets), certificates & RPC, CRM & fees with GST
>    receipts, assets & logbooks with incidents, members & roles. Drone: small, perched on the corner of the grid.
> 4. **Pilot hub** — a dashboard-style mock card (flight hours, sorties, currency, a monthly bar chart) plus logbooks (pilot,
>    per-drone, battery, maintenance), fleet tracking and the read-only live monitor. Drone: hovers above the chart.
> 5. **Simulator** (navy sky) — Stabilize/AltHold/Loiter, arming, return-home, battery failsafe, drills (hover, square,
>    figure-8, agri spray, FPV gates), watch-then-fly demos and voice coaching in 11 Indian languages. Drone: weaves between cards.
> 6. **Pricing** — Free pilot account, RPTO plan, Pilot Pro. Drone: floats beside the highlighted plan.
> 7. **Portals** — Platform admin, RPTO portal, Pilot portal cards with log-in links.
> 8. **Footer** — a helipad graphic ("H" in a ring). Drone: descends and **lands on the pad**; propellers spin down.
>
> **Quality bar.** 60 fps on a mid-range laptop: device-pixel-ratio capped at 2, one draw call per part, no shadows maps (use a
> soft blob shadow on the helipad), pause rendering when the tab is hidden, rebuild keyframes on resize. Mobile: smaller drone,
> keyframes centred. Accessible: the canvas is `aria-hidden`, all content is real HTML text, focus order unaffected, reduced motion
> shows a still drone in the hero and a static list of camera views in the replay section.

---

## How the reference technique works (observed)

- A fixed full-viewport WebGL canvas (three.js) sits over the page with a low z-index and no pointer events; content scrolls under/over it.
- The drone is procedural (no model download); the animation is scroll-linked (the reference uses GSAP ScrollTrigger — our build
  uses a small keyframe interpolator instead of adding GSAP).
- The replay section is a tall section with a sticky inner stage, so ~5 screens of scrolling are spent on one pinned view while the
  camera mode, caption and HUD change with progress.
- Background "sky" layers are fixed divs whose opacity is driven by scroll, which is how the day → night change happens.
- The reference renders real satellite terrain with a 3D-globe library; that needs a map-data licence/token, so our build uses a
  procedural low-poly terrain instead.

## Implementation map (this repo)

| Piece | File |
|---|---|
| Page markup & copy | `views/public/home.ejs` |
| Styles (sky, clouds, sections, replay stage, HUD, helipad) | `public/home.css` |
| three.js scene, drone model, terrain, choreography | `public/home3d.js` |
| three.js library (served locally, no CDN) | `node_modules/three/build` → `/vendor/three/` |
