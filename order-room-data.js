/**
 * The Order Room — Firestore data-access layer.
 *
 * Replaces the original prototype's window.storage (Claude-artifact-only
 * sandbox API, not available outside claude.ai) with real Firestore, on
 * the same "agribusiness-simulator" Firebase project as the Agribusiness
 * Sim tool, under its own top-level collection (orderRoomSessions) so the
 * two apps' data and rules never overlap.
 *
 * Concurrency: every read-modify-write against a chain document (claiming
 * a role, submitting an order + advancing the round) runs inside a
 * Firestore transaction. The original prototype did a plain get-then-set
 * against window.storage for both of these, which is a classic lost-update
 * race: if two roles on the same chain wrote at the same instant, whichever
 * write landed second would silently overwrite the first's change because
 * it had read the doc before that change existed. Firestore transactions
 * close this: the SDK re-reads and re-runs the whole transaction function
 * server-side if the document changed since the read, so two simultaneous
 * submits always serialize correctly instead of racing.
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, runTransaction, onSnapshot, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { ROLES, createEngineState, processRound, generateDemand, generateCode } from "./game-engine.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const MAX_CODE_ATTEMPTS = 8;

// ============================================================
// AUTH
// ============================================================

/** Every participant (instructor and teams alike) is an anonymous Firebase
 *  Auth user — there are no accounts. This is purely what firestore.rules
 *  gates reads/writes on; it's not meant to distinguish instructor from
 *  team (this is an in-person, single-room, low-stakes exercise, same
 *  trust model as the original no-auth-at-all prototype). */
async function ensureAnonymousSession() {
  if (auth.currentUser) return auth.currentUser;
  return new Promise((resolve, reject) => {
    const unsub = onAuthStateChanged(auth, (user) => {
      if (user) { unsub(); resolve(user); }
    }, reject);
    signInAnonymously(auth).catch((e) => { unsub(); reject(e); });
  });
}

// ============================================================
// SESSION / CHAIN REFS
// ============================================================

const sessionRef = (code) => doc(db, "orderRoomSessions", code);
const chainRef = (code, chainId) => doc(db, "orderRoomSessions", code, "chains", String(chainId));

async function createSession(cfg) {
  await ensureAnonymousSession();
  let code, existingSnap;
  let attempt = 0;
  do {
    if (attempt >= MAX_CODE_ATTEMPTS) throw new Error("Could not generate a unique game code — please try again.");
    code = generateCode();
    existingSnap = await getDoc(sessionRef(code));
    attempt++;
  } while (existingSnap.exists());

  const demand = generateDemand(cfg.demandPattern, cfg.numRounds, cfg.initialDemand);
  const session = {
    code, createdAt: serverTimestamp(), status: 'lobby',
    numChains: cfg.numChains, numRounds: cfg.numRounds,
    shipDelay: cfg.shipDelay, orderDelay: cfg.orderDelay,
    initialInventory: cfg.initialInventory, initialDemand: cfg.initialDemand,
    holdingCost: cfg.holdingCost, backlogCost: cfg.backlogCost,
    demandPattern: cfg.demandPattern, demand
  };
  await setDoc(sessionRef(code), session);

  for (let n = 1; n <= cfg.numChains; n++) {
    const chain = {
      chainId: n,
      roles: {
        retailer: { teamName: '', claimedBy: null }, wholesaler: { teamName: '', claimedBy: null },
        distributor: { teamName: '', claimedBy: null }, factory: { teamName: '', claimedBy: null }
      },
      currentRound: 1,
      pendingOrders: { retailer: null, wholesaler: null, distributor: null, factory: null },
      kickback: { retailer: null, wholesaler: null, distributor: null, factory: null },
      state: createEngineState(session),
      history: [],
      status: 'lobby'
    };
    await setDoc(chainRef(code, n), chain);
  }
  return { ...session, createdAt: Date.now() };
}

async function getSession(code) {
  await ensureAnonymousSession();
  const snap = await getDoc(sessionRef(code));
  return snap.exists() ? snap.data() : null;
}

/** `onChange(data, meta)` — meta.fromCache is true when this snapshot came
 *  from the SDK's local cache because the device is currently offline
 *  (rather than an error: Firestore serves last-known state and keeps
 *  retrying in the background). The UI uses this to show a subtle
 *  "reconnecting" indicator instead of treating a dropped connection as a
 *  hard failure. `onError` only fires for actual terminal errors
 *  (permission-denied, etc.) that won't resolve on their own. */
function listenToSession(code, onChange, onError) {
  return onSnapshot(sessionRef(code), (snap) => {
    onChange(snap.exists() ? snap.data() : null, { fromCache: snap.metadata.fromCache });
  }, onError);
}

function listenToChain(code, chainId, onChange, onError) {
  return onSnapshot(chainRef(code, chainId), (snap) => {
    onChange(snap.exists() ? snap.data() : null, { fromCache: snap.metadata.fromCache });
  }, onError);
}

/** Attaches one listener per chain (numChains is small — capped at 12 in
 *  the setup form) and calls back with the full array, 1-indexed by
 *  chainId, every time any single chain changes. Returns one function that
 *  unsubscribes all of them. */
function listenToAllChains(code, numChains, onChange, onError) {
  const chains = new Array(numChains + 1).fill(null);
  const fromCacheFlags = new Array(numChains + 1).fill(false);
  const unsubs = [];
  for (let n = 1; n <= numChains; n++) {
    unsubs.push(onSnapshot(chainRef(code, n), (snap) => {
      chains[n] = snap.exists() ? snap.data() : null;
      fromCacheFlags[n] = snap.metadata.fromCache;
      onChange(chains.slice(1), { fromCache: fromCacheFlags.slice(1).some(Boolean) });
    }, onError));
  }
  return () => unsubs.forEach((u) => u());
}

async function startGame(code) {
  await updateDoc(sessionRef(code), { status: 'playing' });
  const snap = await getDoc(sessionRef(code));
  const session = snap.data();
  await Promise.all(
    Array.from({ length: session.numChains }, (_, i) => i + 1)
      .map((n) => updateDoc(chainRef(code, n), { status: 'playing' }))
  );
}

async function endGame(code) {
  await updateDoc(sessionRef(code), { status: 'ended' });
}

// ============================================================
// ROLE CLAIM (transactional — see file header)
// ============================================================

/**
 * Before the instructor starts the game, a role can only be (re-)claimed by
 * the browser that originally claimed it (matched by anonymous auth uid,
 * which persists across tab closes/reopens in the same browser) — this
 * stops one student from grabbing a seat another student already named.
 * Once the game is playing, that restriction is dropped: a student who
 * lost their tab and reopens the app from a different device still needs
 * to be able to walk back into their seat, and there's no ownership model
 * beyond "whoever's in the room" for this in-person exercise.
 */
async function setTeamName(code, chainId, role, name) {
  const user = await ensureAnonymousSession();
  const ref = chainRef(code, chainId);
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error("This chain could not be found.");
    const chain = snap.data();

    const existing = chain.roles[role];
    const existingName = existing && existing.teamName ? existing.teamName.trim() : '';
    if (chain.status === 'lobby' && existingName && existing.claimedBy && existing.claimedBy !== user.uid) {
      throw new Error(`This role has already been taken by "${existingName}". Please choose a different seat.`);
    }

    chain.roles[role] = { teamName: name, claimedBy: user.uid };
    tx.set(ref, chain);
    return chain;
  });
}

// ============================================================
// ORDER SUBMISSION + ROUND PROCESSING (transactional — see file header)
// ============================================================

/**
 * Submitting an order no longer auto-advances the round even once all four
 * roles are in — the instructor reviews the four submitted values on the
 * dashboard and explicitly clicks "Advance round" (see `advanceRound`
 * below). This just records this role's order for the current round.
 */
async function submitOrder(code, chainId, role, value) {
  await ensureAnonymousSession();
  const ref = chainRef(code, chainId);
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error("This chain could not be found.");
    const chain = snap.data();

    // A straggler submit that was in flight exactly as the instructor ended
    // the game lands here as a harmless no-op rather than writing into
    // pendingOrders on a chain nothing will ever read further.
    if (chain.status === 'finished') return chain;

    // Idempotent guard: if this role already has an order in for the
    // current round (e.g. a retried submit after a flaky connection),
    // don't double-apply it.
    if (chain.pendingOrders[role] !== null && chain.pendingOrders[role] !== undefined) {
      return chain;
    }

    chain.pendingOrders[role] = value;
    if (!chain.kickback) chain.kickback = { retailer: null, wholesaler: null, distributor: null, factory: null };
    chain.kickback[role] = null;

    tx.set(ref, chain);
    return chain;
  });
}

/**
 * Instructor-triggered: processes the round once all four roles have
 * submitted. `session` is passed in (not re-read inside the transaction)
 * because its cost/delay/demand fields are fixed at createSession time and
 * never change afterward. Only `chain` needs transactional read-modify-write
 * safety here.
 */
async function advanceRound(code, chainId, session) {
  await ensureAnonymousSession();
  const ref = chainRef(code, chainId);
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error("This chain could not be found.");
    const chain = snap.data();
    if (chain.status === 'finished') return chain;

    const allIn = ROLES.every((r) => chain.pendingOrders[r] !== null && chain.pendingOrders[r] !== undefined);
    if (!allIn) throw new Error("Not all roles have submitted an order yet.");

    const demandThisRound = session.demand[chain.currentRound - 1];
    const results = processRound(chain.state, chain.pendingOrders, demandThisRound, session);
    chain.history.push(Object.assign({ round: chain.currentRound }, results));
    chain.currentRound += 1;
    chain.pendingOrders = { retailer: null, wholesaler: null, distributor: null, factory: null };
    chain.kickback = { retailer: null, wholesaler: null, distributor: null, factory: null };
    if (chain.currentRound > session.numRounds) chain.status = 'finished';

    tx.set(ref, chain);
    return chain;
  });
}

/**
 * Instructor-triggered: clears a role's submitted order for the current
 * round and flags it so that role's team sees a "please resubmit" notice —
 * for catching an obviously broken entry (a stray extra zero, etc.) before
 * it gets baked into the round.
 */
async function kickBackOrder(code, chainId, role) {
  await ensureAnonymousSession();
  const ref = chainRef(code, chainId);
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error("This chain could not be found.");
    const chain = snap.data();
    if (chain.status === 'finished') return chain;
    if (chain.pendingOrders[role] === null || chain.pendingOrders[role] === undefined) return chain;

    chain.pendingOrders[role] = null;
    if (!chain.kickback) chain.kickback = { retailer: null, wholesaler: null, distributor: null, factory: null };
    chain.kickback[role] = "Your last order was sent back by the instructor for review — please resubmit.";

    tx.set(ref, chain);
    return chain;
  });
}

export const OrderRoomData = {
  auth, db,
  ensureAnonymousSession,
  createSession, getSession, listenToSession,
  listenToChain, listenToAllChains,
  startGame, endGame,
  setTeamName, submitOrder, advanceRound, kickBackOrder,
};
