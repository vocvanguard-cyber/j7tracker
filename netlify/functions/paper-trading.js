const NO_CACHE_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  "Pragma": "no-cache"
};

// Simulasi saja: tidak ada transaksi blockchain.
const STARTING_BALANCE_USD = 100;
const MAX_POSITION_USD = 10;
const MAX_OPEN_POSITIONS = 3;

function json(statusCode, data) {
  return {
    statusCode,
    headers: NO_CACHE_HEADERS,
    body: JSON.stringify(data)
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return json(405, {
      error: "Paper trading is read-only in this first version.",
      mode: "simulation"
    });
  }

  return json(200, {
    mode: "simulation",
    message: "Paper trading engine is online.",
    startingBalanceUsd: STARTING_BALANCE_USD,
    maxPositionUsd: MAX_POSITION_USD,
    maxOpenPositions: MAX_OPEN_POSITIONS,
    features: [
      "Simulated positions",
      "Position-size limits",
      "Take-profit and stop-loss planning"
    ],
    tradingEnabled: false,
    realFundsUsed: false,
    positions: [],
    note: "No persistent storage or real trades are enabled yet."
  });
};
