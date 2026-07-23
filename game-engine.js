/**
 * The Order Room — pure simulation logic.
 *
 * No Firebase, no DOM. Same beer-distribution-game mechanics as the
 * original single-file prototype: four roles (retailer -> wholesaler ->
 * distributor -> factory), shipping/order pipeline delays, holding and
 * backlog costs. Exported as ES module bindings so both the data layer
 * and the UI can import just what they need.
 */

export const ROLES = ['retailer', 'wholesaler', 'distributor', 'factory'];

export const ROLE_LABEL = { retailer: 'Retailer', wholesaler: 'Wholesaler', distributor: 'Distributor', factory: 'Factory' };

export const ROLE_DESC = {
  retailer: 'Faces the customer. Fills real customer demand each round.',
  wholesaler: 'Supplies retailers. Fills retailer orders.',
  distributor: 'Supplies wholesalers. Fills wholesaler orders.',
  factory: 'Produces the goods. Fills distributor orders; no upstream supplier.'
};

export const ROLE_UPSTREAM_LABEL = { retailer: 'wholesaler', wholesaler: 'distributor', distributor: 'factory', factory: 'production' };

export const ROLE_COLOR = { retailer: '#d99a00', wholesaler: '#1fab6f', distributor: '#3f5fe0', factory: '#e2572f' };

export const downstreamOf = { factory: 'distributor', distributor: 'wholesaler', wholesaler: 'retailer' };
export const upstreamOf = { retailer: 'wholesaler', wholesaler: 'distributor', distributor: 'factory' };

export function createEngineState(session) {
  const s = {};
  ROLES.forEach(r => {
    s[r] = {
      inventory: session.initialInventory,
      backlog: 0,
      shipPipeline: Array(session.shipDelay).fill(session.initialDemand),
      orderPipeline: Array(session.orderDelay).fill(session.initialDemand),
      cumulativeCost: 0
    };
  });
  return s;
}

/**
 * Advances one round in place (mutates `state`). Pure w.r.t. everything
 * else — the caller (order-room-data.js) is responsible for making this
 * call transactionally so concurrent submissions can't interleave.
 */
export function processRound(state, decisions, demandThisRound, cfg) {
  const received_ship = {}, received_order = {}, shipped = {};
  ROLES.forEach(r => {
    received_ship[r] = state[r].shipPipeline[0];
    received_order[r] = r === 'retailer' ? demandThisRound : state[r].orderPipeline[0];
  });
  ROLES.forEach(r => {
    const s = state[r];
    s.inventory += received_ship[r];
    const totalDemand = s.backlog + received_order[r];
    shipped[r] = Math.min(s.inventory, totalDemand);
    s.inventory -= shipped[r];
    s.backlog = totalDemand - shipped[r];
  });
  ROLES.forEach(r => { state[r].shipPipeline.shift(); state[r].orderPipeline.shift(); });
  ROLES.forEach(r => { const down = downstreamOf[r]; if (down) state[down].shipPipeline.push(shipped[r]); });
  state.factory.shipPipeline.push(decisions.factory);
  ROLES.forEach(r => { const up = upstreamOf[r]; if (up) state[up].orderPipeline.push(decisions[r]); });
  const results = {};
  ROLES.forEach(r => {
    const s = state[r];
    const cost = s.inventory * cfg.holdingCost + s.backlog * cfg.backlogCost;
    s.cumulativeCost += cost;
    results[r] = {
      inventory: s.inventory, backlog: s.backlog, receivedShipment: received_ship[r],
      receivedOrder: received_order[r], shipped: shipped[r], orderPlaced: decisions[r], cost, cumulativeCost: s.cumulativeCost
    };
  });
  return results;
}

export function generateDemand(pattern, numRounds, initialDemand) {
  const arr = [];
  if (pattern === 'classic') {
    const stepAt = Math.max(3, Math.round(numRounds * 0.2));
    for (let i = 0; i < numRounds; i++) arr.push(i < stepAt ? initialDemand : initialDemand * 2);
  } else if (pattern === 'spike') {
    const spikeStart = Math.round(numRounds * 0.35);
    for (let i = 0; i < numRounds; i++) {
      if (i >= spikeStart && i < spikeStart + 2) arr.push(initialDemand * 4);
      else if (i >= spikeStart + 2 && i < spikeStart + 4) arr.push(Math.max(1, Math.round(initialDemand * 0.5)));
      else arr.push(initialDemand);
    }
  } else {
    for (let i = 0; i < numRounds; i++) {
      const noise = Math.round((Math.random() - 0.5) * 4);
      arr.push(Math.max(1, initialDemand + noise));
    }
  }
  return arr;
}

export function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0, I/1
  let c = '';
  for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}
