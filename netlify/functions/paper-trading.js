const { getStore } = require("@netlify/blobs");

const HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  "Pragma": "no-cache"
};

const STARTING_BALANCE_USD = 100;
const MAX_POSITION_USD = 10;
const MAX_OPEN_POSITIONS = 3;
const TAKE_PROFIT_PCT = 40;
const STOP_LOSS_PCT = 20;
const STORE_NAME = "j7tracker-paper-trading";

function response(statusCode, data) {
  return {
    statusCode,
    headers: HEADERS,
    body: JSON.stringify(data)
  };
}

function getAuthToken(event) {
  const header =
    event.headers?.authorization ||
    event.headers?.Authorization ||
    "";

  return header.startsWith("Bearer ")
    ? header.slice(7)
    : "";
}

function authorized(event) {
  const secret = process.env.PAPER_TRADING_SECRET;

  if (!secret || secret.length < 24) {
    return false;
  }

  const supplied = getAuthToken(event);

  if (!supplied || supplied.length !== secret.length) {
    return false;
  }

  // Constant-time comparison.
  let diff = 0;

  for (let i = 0; i < secret.length; i++) {
    diff |= secret.charCodeAt(i) ^ supplied.charCodeAt(i);
  }

  return diff === 0;
}

function validId(value) {
  return typeof value === "string" &&
    /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

function validPrice(value) {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0;
}

function validAmount(value) {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= MAX_POSITION_USD;
}

function makeId() {
  return require("crypto").randomUUID();
}

async function loadAccount(store, accountId) {
  let account = await store.get(accountId, { type: "json" });

  if (!account) {
    account = {
      balanceUsd: STARTING_BALANCE_USD,
      positions: [],
      history: [],
      createdAt: new Date().toISOString()
    };

    await store.setJSON(accountId, account);
  }

  return account;
}

exports.handler = async (event) => {
  const serverSecret = process.env.PAPER_TRADING_SECRET;

  if (!serverSecret) {
    return response(500, {
      error: "Server configuration error: PAPER_TRADING_SECRET is missing."
    });
  }

  if (serverSecret.length < 24) {
    return response(500, {
      error: "Server configuration error: secret is too short."
    });
  }

  if (!authorized(event)) {
    return response(401, {
      error: "Unauthorized. Check the Paper Trading secret."
    });
  }

  const method = event.httpMethod;

  if (!["GET", "POST"].includes(method)) {
    return response(405, {
      error: "Method not allowed."
    });
  }

  const store = getStore({
    name: STORE_NAME,
    consistency: "strong"
  });

  if (method === "GET") {
    const accountId = event.queryStringParameters?.accountId;

    if (!validId(accountId)) {
      return response(400, {
        error: "A valid accountId is required."
      });
    }

    try {
      const account = await loadAccount(store, accountId);

      return response(200, {
        mode: "simulation",
        tradingEnabled: false,
        realFundsUsed: false,
        startingBalanceUsd: STARTING_BALANCE_USD,
        maxPositionUsd: MAX_POSITION_USD,
        maxOpenPositions: MAX_OPEN_POSITIONS,
        takeProfitPct: TAKE_PROFIT_PCT,
        stopLossPct: STOP_LOSS_PCT,
        balanceUsd: account.balanceUsd,
        positions: account.positions,
        history: account.history.slice(-50)
      });
    } catch (error) {
      console.error("Paper account read failed:", error.message);

      return response(500, {
        error: "Could not load the paper trading account."
      });
    }
  }

  let body;

  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return response(400, { error: "Invalid JSON body." });
  }

  const { accountId, action } = body;

  if (!validId(accountId)) {
    return response(400, { error: "Invalid accountId." });
  }

  if (!["buy", "sell", "update-price"].includes(action)) {
    return response(400, { error: "Unsupported action." });
  }

  try {
    const account = await loadAccount(store, accountId);

    if (action === "buy") {
      const { token, amountUsd, priceUsd } = body;

      if (
        typeof token !== "string" ||
        token.trim().length < 1 ||
        token.length > 100 ||
        !validAmount(amountUsd) ||
        !validPrice(priceUsd)
      ) {
        return response(400, {
          error: "Invalid token, amountUsd, or priceUsd."
        });
      }

      if (account.positions.length >= MAX_OPEN_POSITIONS) {
        return response(409, { error: "Maximum open positions reached." });
      }

      if (amountUsd > account.balanceUsd) {
        return response(409, { error: "Insufficient virtual balance." });
      }

      const position = {
        id: makeId(),
        token: token.trim(),
        entryPriceUsd: priceUsd,
        currentPriceUsd: priceUsd,
        investedUsd: amountUsd,
        quantity: amountUsd / priceUsd,
        takeProfitPriceUsd: priceUsd * (1 + TAKE_PROFIT_PCT / 100),
        stopLossPriceUsd: priceUsd * (1 - STOP_LOSS_PCT / 100),
        openedAt: new Date().toISOString()
      };

      account.balanceUsd -= amountUsd;
      account.positions.push(position);

      account.history.push({
        action: "buy",
        token: position.token,
        amountUsd,
        priceUsd,
        at: new Date().toISOString()
      });

      await store.setJSON(accountId, account);

      return response(200, {
        ok: true,
        mode: "simulation",
        message: "Virtual position opened.",
        position,
        balanceUsd: account.balanceUsd
      });
    }

    if (action === "sell") {
      const { positionId, priceUsd } = body;

      if (!validId(positionId) || !validPrice(priceUsd)) {
        return response(400, {
          error: "Invalid positionId or priceUsd."
        });
      }

      const index = account.positions.findIndex(
        (position) => position.id === positionId
      );

      if (index === -1) {
        return response(404, { error: "Position not found." });
      }

      const position = account.positions[index];
      const proceedsUsd = position.quantity * priceUsd;
      const pnlUsd = proceedsUsd - position.investedUsd;

      account.balanceUsd += proceedsUsd;
      account.positions.splice(index, 1);

      account.history.push({
        action: "sell",
        token: position.token,
        proceedsUsd,
        pnlUsd,
        priceUsd,
        at: new Date().toISOString()
      });

      await store.setJSON(accountId, account);

      return response(200, {
        ok: true,
        mode: "simulation",
        message: "Virtual position closed.",
        proceedsUsd,
        pnlUsd,
        balanceUsd: account.balanceUsd
      });
    }

    if (action === "update-price") {
      const { positionId, priceUsd } = body;

      if (!validId(positionId) || !validPrice(priceUsd)) {
        return response(400, {
          error: "Invalid positionId or priceUsd."
        });
      }

      const position = account.positions.find(
        (item) => item.id === positionId
      );

      if (!position) {
        return response(404, { error: "Position not found." });
      }

      position.currentPriceUsd = priceUsd;

      const pnlPct =
        ((priceUsd - position.entryPriceUsd) /
          position.entryPriceUsd) * 100;

      let trigger = null;

      if (priceUsd >= position.takeProfitPriceUsd) {
        trigger = "take-profit";
      } else if (priceUsd <= position.stopLossPriceUsd) {
        trigger = "stop-loss";
      }

      await store.setJSON(accountId, account);

      return response(200, {
        ok: true,
        mode: "simulation",
        position,
        pnlPct,
        trigger,
        message: trigger
          ? "TP/SL condition reached. Call sell with a validated price to close the position."
          : "Price updated. No TP/SL threshold reached."
      });
    }
  } catch (error) {
    console.error("Paper trading operation failed:", error.message);

    return response(500, {
      error: "Paper trading operation failed."
    });
  }
};
