# The Order Room

A live, in-person version of the Beer Distribution Game supply-chain simulation, built for **AEC 411 (Food Systems Supply Chains)**. An instructor runs one game session with several parallel 4-role supply chains (breakout groups); teams join on their own devices, claim a role (Retailer / Wholesaler / Distributor / Factory), and place order decisions each round. A chain's round auto-advances once all four roles have submitted.

Static site, no build step — `index.html` + two small ES modules (`game-engine.js`, `order-room-data.js`) plus Firebase config.

## How it's wired up

- **Hosting:** GitHub Pages, served straight from this repo.
- **Sync:** Firestore, on the same `agribusiness-simulator` Firebase project as the Agribusiness-Sim tool, under its own top-level collection (`orderRoomSessions`) so the two apps' data never overlaps. See [firebase-config.js](firebase-config.js) for the project config (public client identifiers, not secrets — access control lives in Firestore rules, not in hiding this file).
- **Auth:** anonymous Firebase Auth for every participant (instructor and teams alike) — no accounts. This is a single in-person class period with no grades or persistent stakes, so the rules just gate the collection behind "signed in," rather than the PIN/ownership model Agribusiness-Sim uses for its multi-week graded simulation.
- **Concurrency:** claiming a role and submitting an order + advancing the round both run inside Firestore transactions (see the file header of [order-room-data.js](order-room-data.js)) so two roles submitting in the same instant can't silently clobber each other's write — the classic lost-update race the original single-file prototype had via `window.storage`'s plain get-then-set.

## One-time setup

**1. Deploy the Firestore rules.** The rules for this app live in [firestore.rules](firestore.rules) here as documentation, but the actual deployed rules file is shared with Agribusiness-Sim (there's only one `firestore.rules` per Firebase project). Whenever the `orderRoomSessions` block changes, copy it into the real rules file and redeploy:
   - Firebase Console → `agribusiness-simulator` project → Firestore Database → **Rules** tab → paste → **Publish**, or
   - `firebase deploy --only firestore:rules` from wherever that project's rules are managed.

**2. Enable GitHub Pages.** Repo → **Settings** → **Pages** → Source: `Deploy from a branch` → Branch: `main` / `(root)` → **Save**. GitHub will publish at `https://timdelbridge.github.io/Beergame_Inperson/`.

## Embedding in Canvas

Canvas's Rich Content Editor supports raw HTML embeds. Use an iframe pointed at the published Pages URL:

```html
<iframe src="https://timdelbridge.github.io/Beergame_Inperson/" width="100%" height="900" style="border:0;" allow="clipboard-write"></iframe>
```

Since this is a live, room-based exercise (everyone needs the same 4-letter game code at the same time), it's likely more useful as a linked page for students to open on their own device than as an embedded iframe — the iframe is mainly convenient for the instructor's own dashboard/results view inside a Canvas page.

## Local development

No build step — just serve the folder statically (ES module imports need `http://`, not `file://`):

```
python -m http.server 8420
```

Then open `http://localhost:8420`.

## Files

| File | Purpose |
|---|---|
| `index.html` | UI, routing, rendering — the whole app shell |
| `game-engine.js` | Pure simulation logic (round processing, demand generation) — no Firebase, no DOM |
| `order-room-data.js` | Firestore data-access layer: auth, listeners, transactions |
| `firebase-config.js` | Public Firebase client config |
| `firestore.rules` | Reference copy of this app's rules block (see "One-time setup" above) |
