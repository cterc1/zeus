const WebSocket = require("ws");

// ============================================================
// ZEUS MARKET DATA ENGINE
// Coinbase Advanced Trade + Kraken Spot WebSocket v2
// ============================================================

const CONFIG = {
    coinbase: {
        wsUrl: "wss://advanced-trade-ws.coinbase.com",
        productId: "BTC-USD"
    },

    kraken: {
        wsUrl: "wss://ws.kraken.com/v2",
        symbol: "BTC/USD"
    },

    reportIntervalMs: 5000,
    reconnectDelayMs: 3000,

    krakenBookDepth: 100,

    maxTrades: 5000,
    maxPriceHistory: 5000,

    priceWindows: [15, 30, 60, 180, 300],

    featureWindows: [15, 30, 60],

    bookDepths: [5, 10, 25, 50, 100]
};

// ============================================================
// STATE
// ============================================================

const state = {
    running: true,

    price: null,
    lastPriceSource: null,

    priceHistory: [],

    trades: [],

    exchanges: {
        coinbase: {
            connected: false,
            lastMessageAt: 0,
            lastPriceAt: 0,

            bids: new Map(),
            asks: new Map(),

            lastBookAt: 0,
            bookInitialized: false
        },

        kraken: {
            connected: false,
            lastMessageAt: 0,
            lastPriceAt: 0,

            bids: new Map(),
            asks: new Map(),

            lastBookAt: 0,
            bookInitialized: false
        }
    },

    stats: {
        startedAt: Date.now(),
        messages: {
            coinbase: 0,
            kraken: 0
        }
    }
};

// ============================================================
// UTILITY
// ============================================================

function now() {
    return Date.now();
}

function isFiniteNumber(value) {
    return Number.isFinite(Number(value));
}

function safeNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function percentChange(oldPrice, newPrice) {
    if (
        !Number.isFinite(oldPrice) ||
        !Number.isFinite(newPrice) ||
        oldPrice === 0
    ) {
        return null;
    }

    return ((newPrice - oldPrice) / oldPrice) * 100;
}

function average(values) {
    const valid = values.filter(
        value => Number.isFinite(value)
    );

    if (valid.length === 0) {
        return null;
    }

    return (
        valid.reduce(
            (sum, value) => sum + value,
            0
        ) / valid.length
    );
}

function round(value, decimals = 6) {
    if (!Number.isFinite(value)) {
        return null;
    }

    const factor = Math.pow(10, decimals);

    return Math.round(value * factor) / factor;
}

// ============================================================
// PRICE HISTORY
// ============================================================

function addPricePoint(price, source) {
    if (!isFiniteNumber(price)) {
        return;
    }

    const point = {
        timestamp: now(),
        price: Number(price),
        source
    };

    state.price = point.price;
    state.lastPriceSource = source;

    state.priceHistory.push(point);

    const cutoff = now() - 10 * 60 * 1000;

    while (
        state.priceHistory.length > 0 &&
        state.priceHistory[0].timestamp < cutoff
    ) {
        state.priceHistory.shift();
    }

    if (state.priceHistory.length > CONFIG.maxPriceHistory) {
        state.priceHistory.splice(
            0,
            state.priceHistory.length - CONFIG.maxPriceHistory
        );
    }
}

function getPriceMovement(seconds) {
    if (
        state.priceHistory.length === 0 ||
        state.price === null
    ) {
        return null;
    }

    const targetTime = now() - seconds * 1000;

    let closest = null;

    for (
        let i = state.priceHistory.length - 1;
        i >= 0;
        i--
    ) {
        const point = state.priceHistory[i];

        if (point.timestamp <= targetTime) {
            closest = point;
            break;
        }
    }

    if (!closest) {
        return null;
    }

    return percentChange(
        closest.price,
        state.price
    );
}

// ============================================================
// PRICE LOOKUP
// ============================================================

function getLatestPriceForExchange(exchangeName) {
    for (
        let i = state.priceHistory.length - 1;
        i >= 0;
        i--
    ) {
        const point = state.priceHistory[i];

        if (
            point.source === exchangeName ||
            point.source === `${exchangeName}-trade`
        ) {
            return {
                price: point.price,
                timestamp: point.timestamp,
                source: point.source
            };
        }
    }

    return null;
}

// ============================================================
// TRADE STORAGE
// ============================================================

function addTrade({
    price,
    quantity,
    side,
    exchange,
    timestamp
}) {
    const tradePrice = safeNumber(price);
    const tradeQuantity = safeNumber(quantity);

    if (
        tradePrice <= 0 ||
        tradeQuantity <= 0
    ) {
        return;
    }

    state.trades.push({
        timestamp: timestamp || now(),
        price: tradePrice,
        quantity: tradeQuantity,
        side: side || "unknown",
        exchange
    });

    const cutoff = now() - 10 * 60 * 1000;

    while (
        state.trades.length > 0 &&
        state.trades[0].timestamp < cutoff
    ) {
        state.trades.shift();
    }

    if (state.trades.length > CONFIG.maxTrades) {
        state.trades.splice(
            0,
            state.trades.length - CONFIG.maxTrades
        );
    }
}

// ============================================================
// COINBASE
// ============================================================

let coinbaseWs = null;
let coinbaseReconnectTimer = null;

function connectCoinbase() {
    if (!state.running) {
        return;
    }

    console.log("[Coinbase] Connecting...");

    try {
        coinbaseWs = new WebSocket(
            CONFIG.coinbase.wsUrl
        );

        coinbaseWs.on("open", () => {
            console.log("[Coinbase] Connected.");

            state.exchanges.coinbase.connected = true;
            state.exchanges.coinbase.lastMessageAt = now();

            subscribeCoinbase();
        });

        coinbaseWs.on("message", raw => {
            handleCoinbaseMessage(raw);
        });

        coinbaseWs.on("error", error => {
            console.log(
                "[Coinbase] Error:",
                error.message || error
            );
        });

        coinbaseWs.on("close", () => {
            state.exchanges.coinbase.connected = false;

            console.log("[Coinbase] Disconnected.");

            scheduleCoinbaseReconnect();
        });
    } catch (error) {
        console.log(
            "[Coinbase] Connection error:",
            error.message || error
        );

        scheduleCoinbaseReconnect();
    }
}

function subscribeCoinbase() {
    if (
        !coinbaseWs ||
        coinbaseWs.readyState !== WebSocket.OPEN
    ) {
        return;
    }

    coinbaseWs.send(
        JSON.stringify({
            type: "subscribe",
            channel: "heartbeats",
            product_ids: [
                CONFIG.coinbase.productId
            ]
        })
    );

    coinbaseWs.send(
        JSON.stringify({
            type: "subscribe",
            channel: "level2",
            product_ids: [
                CONFIG.coinbase.productId
            ]
        })
    );

    coinbaseWs.send(
        JSON.stringify({
            type: "subscribe",
            channel: "ticker",
            product_ids: [
                CONFIG.coinbase.productId
            ]
        })
    );

    coinbaseWs.send(
        JSON.stringify({
            type: "subscribe",
            channel: "market_trades",
            product_ids: [
                CONFIG.coinbase.productId
            ]
        })
    );
}

function handleCoinbaseMessage(raw) {
    let message;

    try {
        message = JSON.parse(
            raw.toString()
        );
    } catch {
        return;
    }

    state.stats.messages.coinbase++;

    state.exchanges.coinbase.lastMessageAt = now();

    const channel = message.channel;

    if (!channel) {
        return;
    }

    // --------------------------------------------------------
    // LEVEL 2
    // --------------------------------------------------------

    if (
        channel === "l2_data" ||
        channel === "level2"
    ) {
        handleCoinbaseBook(message);
        return;
    }

    // --------------------------------------------------------
    // TICKER
    // --------------------------------------------------------

    if (channel === "ticker") {
        const events = Array.isArray(
            message.events
        )
            ? message.events
            : [];

        for (const event of events) {
            const tickers = Array.isArray(
                event.tickers
            )
                ? event.tickers
                : [];

            for (const ticker of tickers) {
                const productId =
                    ticker.product_id ||
                    ticker.productId;

                if (
                    productId &&
                    productId !==
                        CONFIG.coinbase.productId
                ) {
                    continue;
                }

                const price =
                    ticker.price ??
                    ticker.last_trade_price;

                if (isFiniteNumber(price)) {
                    addPricePoint(
                        Number(price),
                        "coinbase"
                    );

                    state.exchanges.coinbase.lastPriceAt =
                        now();
                }
            }
        }

        return;
    }

    // --------------------------------------------------------
    // MARKET TRADES
    // --------------------------------------------------------

    if (channel === "market_trades") {
        const events = Array.isArray(
            message.events
        )
            ? message.events
            : [];

        for (const event of events) {
            const trades = Array.isArray(
                event.trades
            )
                ? event.trades
                : [];

            for (const trade of trades) {
                const productId =
                    trade.product_id ||
                    trade.productId;

                if (
                    productId &&
                    productId !==
                        CONFIG.coinbase.productId
                ) {
                    continue;
                }

                const price = safeNumber(
                    trade.price ??
                    trade.trade_price
                );

                const quantity = safeNumber(
                    trade.size ??
                    trade.trade_size
                );

                let timestamp = now();

                if (trade.time) {
                    const parsed =
                        Date.parse(
                            trade.time
                        );

                    if (
                        Number.isFinite(
                            parsed
                        )
                    ) {
                        timestamp = parsed;
                    }
                }

                if (trade.trade_time) {
                    const parsed =
                        Date.parse(
                            trade.trade_time
                        );

                    if (
                        Number.isFinite(
                            parsed
                        )
                    ) {
                        timestamp = parsed;
                    }
                }

                addTrade({
                    price,
                    quantity,
                    side:
                        trade.side ||
                        trade.aggressor_side ||
                        "unknown",
                    exchange: "coinbase",
                    timestamp
                });

                if (price > 0) {
                    addPricePoint(
                        price,
                        "coinbase-trade"
                    );
                }
            }
        }
    }
}

// ============================================================
// COINBASE ORDER BOOK
// ============================================================

function handleCoinbaseBook(message) {
    const book =
        state.exchanges.coinbase;

    const events = Array.isArray(
        message.events
    )
        ? message.events
        : [];

    for (const event of events) {
        const productId =
            event.product_id ||
            event.productId;

        if (
            productId &&
            productId !==
                CONFIG.coinbase.productId
        ) {
            continue;
        }

        const updates = Array.isArray(
            event.updates
        )
            ? event.updates
            : [];

        if (updates.length === 0) {
            continue;
        }

        if (event.type === "snapshot") {
            book.bids.clear();
            book.asks.clear();
        }

        for (const entry of updates) {
            if (!entry) {
                continue;
            }

            const side =
                String(
                    entry.side || ""
                ).toLowerCase();

            const price = safeNumber(
                entry.price_level ??
                entry.price ??
                entry.px
            );

            const quantity = safeNumber(
                entry.new_quantity ??
                entry.quantity ??
                entry.qty
            );

            if (price <= 0) {
                continue;
            }

            const isBid =
                side === "bid" ||
                side === "buy";

            const isAsk =
                side === "ask" ||
                side === "offer" ||
                side === "sell";

            if (!isBid && !isAsk) {
                continue;
            }

            if (quantity <= 0) {
                if (isBid) {
                    book.bids.delete(price);
                }

                if (isAsk) {
                    book.asks.delete(price);
                }

                continue;
            }

            if (isBid) {
                book.bids.set(
                    price,
                    quantity
                );
            }

            if (isAsk) {
                book.asks.set(
                    price,
                    quantity
                );
            }
        }

        if (updates.length > 0) {
            book.bookInitialized = true;
            book.lastBookAt = now();
        }
    }
}

function scheduleCoinbaseReconnect() {
    if (!state.running) {
        return;
    }

    if (coinbaseReconnectTimer) {
        return;
    }

    coinbaseReconnectTimer = setTimeout(() => {
        coinbaseReconnectTimer = null;

        state.exchanges.coinbase.bids.clear();
        state.exchanges.coinbase.asks.clear();

        state.exchanges.coinbase.bookInitialized =
            false;

        connectCoinbase();
    }, CONFIG.reconnectDelayMs);
}

// ============================================================
// KRAKEN
// ============================================================

let krakenWs = null;
let krakenReconnectTimer = null;

function connectKraken() {
    if (!state.running) {
        return;
    }

    console.log("[Kraken] Connecting...");

    try {
        krakenWs = new WebSocket(
            CONFIG.kraken.wsUrl
        );

        krakenWs.on("open", () => {
            console.log("[Kraken] Connected.");

            state.exchanges.kraken.connected = true;
            state.exchanges.kraken.lastMessageAt = now();

            subscribeKraken();
        });

        krakenWs.on("message", raw => {
            handleKrakenMessage(raw);
        });

        krakenWs.on("error", error => {
            console.log(
                "[Kraken] Error:",
                error.message || error
            );
        });

        krakenWs.on("close", () => {
            state.exchanges.kraken.connected = false;

            console.log("[Kraken] Disconnected.");

            scheduleKrakenReconnect();
        });
    } catch (error) {
        console.log(
            "[Kraken] Connection error:",
            error.message || error
        );

        scheduleKrakenReconnect();
    }
}

function subscribeKraken() {
    if (
        !krakenWs ||
        krakenWs.readyState !== WebSocket.OPEN
    ) {
        return;
    }

    krakenWs.send(
        JSON.stringify({
            method: "subscribe",
            params: {
                channel: "book",
                symbol: [
                    CONFIG.kraken.symbol
                ],
                depth:
                    CONFIG.krakenBookDepth,
                snapshot: true
            }
        })
    );

    krakenWs.send(
        JSON.stringify({
            method: "subscribe",
            params: {
                channel: "ticker",
                symbol: [
                    CONFIG.kraken.symbol
                ]
            }
        })
    );

    krakenWs.send(
        JSON.stringify({
            method: "subscribe",
            params: {
                channel: "trade",
                symbol: [
                    CONFIG.kraken.symbol
                ]
            }
        })
    );

    krakenWs.send(
        JSON.stringify({
            method: "subscribe",
            params: {
                channel: "ohlc",
                symbol: [
                    CONFIG.kraken.symbol
                ],
                interval: 1
            }
        })
    );
}

function handleKrakenMessage(raw) {
    let message;

    try {
        message = JSON.parse(
            raw.toString()
        );
    } catch {
        return;
    }

    state.stats.messages.kraken++;

    state.exchanges.kraken.lastMessageAt =
        now();

    if (message.method === "subscribe") {
        if (message.success === false) {
            console.log(
                "[Kraken] Subscription failed:",
                message.error ||
                    "Unknown error"
            );
        }

        return;
    }

    if (
        message.channel ===
        "heartbeat"
    ) {
        return;
    }

    const channel = message.channel;

    if (!channel) {
        return;
    }

    // --------------------------------------------------------
    // BOOK
    // --------------------------------------------------------

    if (channel === "book") {
        handleKrakenBook(message);
        return;
    }

    // --------------------------------------------------------
    // TICKER
    // --------------------------------------------------------

    if (channel === "ticker") {
        const data = Array.isArray(
            message.data
        )
            ? message.data
            : [];

        for (const ticker of data) {
            if (
                ticker.symbol &&
                ticker.symbol !==
                    CONFIG.kraken.symbol
            ) {
                continue;
            }

            const price =
                ticker.last ??
                ticker.last_trade_price ??
                ticker.price;

            if (isFiniteNumber(price)) {
                addPricePoint(
                    Number(price),
                    "kraken"
                );

                state.exchanges.kraken.lastPriceAt =
                    now();
            }
        }

        return;
    }

    // --------------------------------------------------------
    // TRADE
    // --------------------------------------------------------

    if (channel === "trade") {
        const data = Array.isArray(
            message.data
        )
            ? message.data
            : [];

        for (const trade of data) {
            if (
                trade.symbol &&
                trade.symbol !==
                    CONFIG.kraken.symbol
            ) {
                continue;
            }

            const price =
                safeNumber(
                    trade.price
                );

            const quantity =
                safeNumber(
                    trade.qty ??
                    trade.quantity
                );

            let timestamp = now();

            if (trade.timestamp) {
                const parsed =
                    Date.parse(
                        trade.timestamp
                    );

                if (
                    Number.isFinite(
                        parsed
                    )
                ) {
                    timestamp = parsed;
                }
            }

            addTrade({
                price,
                quantity,
                side:
                    trade.side ||
                    "unknown",
                exchange: "kraken",
                timestamp
            });

            if (price > 0) {
                addPricePoint(
                    price,
                    "kraken-trade"
                );
            }
        }
    }
}

// ============================================================
// KRAKEN ORDER BOOK
// ============================================================

function handleKrakenBook(message) {
    const book =
        state.exchanges.kraken;

    if (
        !Array.isArray(message.data) ||
        !message.data[0]
    ) {
        return;
    }

    const payload =
        message.data[0];

    if (
        payload.symbol &&
        payload.symbol !==
            CONFIG.kraken.symbol
    ) {
        return;
    }

    const bids =
        Array.isArray(payload.bids)
            ? payload.bids
            : [];

    const asks =
        Array.isArray(payload.asks)
            ? payload.asks
            : [];

    if (message.type === "snapshot") {
        book.bids.clear();
        book.asks.clear();

        for (const level of bids) {
            const price =
                safeNumber(
                    level.price
                );

            const quantity =
                safeNumber(
                    level.qty
                );

            if (
                price > 0 &&
                quantity > 0
            ) {
                book.bids.set(
                    price,
                    quantity
                );
            }
        }

        for (const level of asks) {
            const price =
                safeNumber(
                    level.price
                );

            const quantity =
                safeNumber(
                    level.qty
                );

            if (
                price > 0 &&
                quantity > 0
            ) {
                book.asks.set(
                    price,
                    quantity
                );
            }
        }

        book.bookInitialized = true;
        book.lastBookAt = now();

        return;
    }

    if (message.type === "update") {
        for (const level of bids) {
            const price =
                safeNumber(
                    level.price
                );

            const quantity =
                safeNumber(
                    level.qty
                );

            if (price <= 0) {
                continue;
            }

            if (quantity <= 0) {
                book.bids.delete(
                    price
                );
            } else {
                book.bids.set(
                    price,
                    quantity
                );
            }
        }

        for (const level of asks) {
            const price =
                safeNumber(
                    level.price
                );

            const quantity =
                safeNumber(
                    level.qty
                );

            if (price <= 0) {
                continue;
            }

            if (quantity <= 0) {
                book.asks.delete(
                    price
                );
            } else {
                book.asks.set(
                    price,
                    quantity
                );
            }
        }

        book.bookInitialized = true;
        book.lastBookAt = now();
    }
}

function scheduleKrakenReconnect() {
    if (!state.running) {
        return;
    }

    if (krakenReconnectTimer) {
        return;
    }

    krakenReconnectTimer = setTimeout(() => {
        krakenReconnectTimer = null;

        state.exchanges.kraken.bids.clear();
        state.exchanges.kraken.asks.clear();

        state.exchanges.kraken.bookInitialized =
            false;

        connectKraken();
    }, CONFIG.reconnectDelayMs);
}

// ============================================================
// ORDER BOOK STATS
// ============================================================

function getBookStats(exchangeName) {
    const exchange =
        state.exchanges[
            exchangeName
        ];

    if (!exchange) {
        return {
            bids: 0,
            asks: 0,
            bidQuantity: 0,
            askQuantity: 0,
            imbalance: 0,
            bestBid: null,
            bestAsk: null,
            spread: null,
            spreadPercent: null,
            initialized: false,
            lastBookAt: 0
        };
    }

    const bids =
        Array.from(
            exchange.bids.entries()
        );

    const asks =
        Array.from(
            exchange.asks.entries()
        );

    bids.sort(
        (a, b) =>
            b[0] - a[0]
    );

    asks.sort(
        (a, b) =>
            a[0] - b[0]
    );

    const topBids =
        bids.slice(0, 100);

    const topAsks =
        asks.slice(0, 100);

    let bidQuantity = 0;
    let askQuantity = 0;

    for (const [, quantity] of topBids) {
        bidQuantity +=
            safeNumber(quantity);
    }

    for (const [, quantity] of topAsks) {
        askQuantity +=
            safeNumber(quantity);
    }

    const bestBid =
        topBids.length > 0
            ? topBids[0][0]
            : null;

    const bestAsk =
        topAsks.length > 0
            ? topAsks[0][0]
            : null;

    let spread = null;
    let spreadPercent = null;

    if (
        bestBid !== null &&
        bestAsk !== null &&
        bestAsk >= bestBid
    ) {
        spread =
            bestAsk -
            bestBid;

        const midpoint =
            (bestAsk + bestBid) /
            2;

        if (midpoint > 0) {
            spreadPercent =
                (spread / midpoint) *
                100;
        }
    }

    const total =
        bidQuantity +
        askQuantity;

    const imbalance =
        total > 0
            ? (
                  bidQuantity -
                  askQuantity
              ) / total
            : 0;

    return {
        bids: topBids.length,
        asks: topAsks.length,

        bidQuantity,

        askQuantity,

        imbalance,

        bestBid,

        bestAsk,

        spread,

        spreadPercent,

        initialized:
            exchange.bookInitialized,

        lastBookAt:
            exchange.lastBookAt
    };
}

function getBookDepthStats(
    exchangeName,
    depth
) {
    const exchange =
        state.exchanges[
            exchangeName
        ];

    if (!exchange) {
        return {
            depth,
            bidQuantity: 0,
            askQuantity: 0,
            imbalance: 0
        };
    }

    const bids =
        Array.from(
            exchange.bids.entries()
        ).sort(
            (a, b) =>
                b[0] - a[0]
        );

    const asks =
        Array.from(
            exchange.asks.entries()
        ).sort(
            (a, b) =>
                a[0] - b[0]
        );

    const topBids =
        bids.slice(0, depth);

    const topAsks =
        asks.slice(0, depth);

    let bidQuantity = 0;
    let askQuantity = 0;

    for (const [, quantity] of topBids) {
        bidQuantity +=
            safeNumber(quantity);
    }

    for (const [, quantity] of topAsks) {
        askQuantity +=
            safeNumber(quantity);
    }

    const total =
        bidQuantity +
        askQuantity;

    const imbalance =
        total > 0
            ? (
                  bidQuantity -
                  askQuantity
              ) / total
            : 0;

    return {
        depth,

        bidQuantity,

        askQuantity,

        imbalance
    };
}

function calculateCombinedBookStats() {
    const coinbase =
        getBookStats(
            "coinbase"
        );

    const kraken =
        getBookStats(
            "kraken"
        );

    const bidQuantity =
        coinbase.bidQuantity +
        kraken.bidQuantity;

    const askQuantity =
        coinbase.askQuantity +
        kraken.askQuantity;

    const total =
        bidQuantity +
        askQuantity;

    const imbalance =
        total > 0
            ? (
                  bidQuantity -
                  askQuantity
              ) / total
            : 0;

    return {
        coinbase,
        kraken,

        bidQuantity,

        askQuantity,

        imbalance
    };
}

// ============================================================
// TRADE STATS
// ============================================================

function getRecentTradeStats(
    seconds = 60
) {
    const cutoff =
        now() -
        seconds * 1000;

    const recent =
        state.trades.filter(
            trade =>
                trade.timestamp >=
                cutoff
        );

    let buyQuantity = 0;
    let sellQuantity = 0;
    let unknownQuantity = 0;
    let totalQuantity = 0;

    let buyCount = 0;
    let sellCount = 0;
    let unknownCount = 0;

    for (const trade of recent) {
        const quantity =
            safeNumber(
                trade.quantity
            );

        totalQuantity +=
            quantity;

        const side =
            String(
                trade.side || ""
            ).toLowerCase();

        if (side === "buy") {
            buyQuantity +=
                quantity;

            buyCount++;
        } else if (
            side === "sell"
        ) {
            sellQuantity +=
                quantity;

            sellCount++;
        } else {
            unknownQuantity +=
                quantity;

            unknownCount++;
        }
    }

    const directionalTotal =
        buyQuantity +
        sellQuantity;

    const tradeImbalance =
        directionalTotal > 0
            ? (
                  buyQuantity -
                  sellQuantity
              ) /
              directionalTotal
            : 0;

    const buyRatio =
        directionalTotal > 0
            ? buyQuantity /
              directionalTotal
            : null;

    const sellRatio =
        directionalTotal > 0
            ? sellQuantity /
              directionalTotal
            : null;

    return {
        seconds,

        count:
            recent.length,

        buyCount,

        sellCount,

        unknownCount,

        buyQuantity,

        sellQuantity,

        unknownQuantity,

        totalQuantity,

        directionalQuantity:
            directionalTotal,

        buyRatio,

        sellRatio,

        imbalance:
            tradeImbalance
    };
}

// ============================================================
// TRADE PRESSURE FEATURES
// ============================================================

function calculateTradeFeatures() {
    const windows = {};

    for (
        const seconds of
        CONFIG.featureWindows
    ) {
        const stats =
            getRecentTradeStats(
                seconds
            );

        windows[seconds] = {
            count:
                stats.count,

            buyCount:
                stats.buyCount,

            sellCount:
                stats.sellCount,

            totalVolume:
                stats.totalQuantity,

            buyVolume:
                stats.buyQuantity,

            sellVolume:
                stats.sellQuantity,

            unknownVolume:
                stats.unknownQuantity,

            buyRatio:
                stats.buyRatio,

            sellRatio:
                stats.sellRatio,

            imbalance:
                stats.imbalance
        };
    }

    return windows;
}

// ============================================================
// REALIZED VOLATILITY
// ============================================================

function getRealizedVolatility(
    seconds = 60
) {
    const cutoff =
        now() -
        seconds * 1000;

    const points =
        state.priceHistory.filter(
            point =>
                point.timestamp >=
                cutoff
        );

    if (points.length < 3) {
        return null;
    }

    const returns = [];

    for (
        let i = 1;
        i < points.length;
        i++
    ) {
        const previous =
            points[i - 1].price;

        const current =
            points[i].price;

        if (
            previous > 0 &&
            current > 0
        ) {
            returns.push(
                Math.log(
                    current /
                        previous
                )
            );
        }
    }

    if (returns.length < 2) {
        return null;
    }

    const mean =
        returns.reduce(
            (sum, value) =>
                sum + value,
            0
        ) /
        returns.length;

    let variance = 0;

    for (const value of returns) {
        variance +=
            Math.pow(
                value - mean,
                2
            );
    }

    variance /=
        returns.length - 1;

    return Math.sqrt(
        variance
    );
}

// ============================================================
// MOMENTUM FEATURES
// ============================================================

function calculateMomentumFeatures() {
    const movements = {};

    for (
        const seconds of
        CONFIG.priceWindows
    ) {
        movements[seconds] =
            getPriceMovement(
                seconds
            );
    }

    const movement15 =
        movements[15];

    const movement30 =
        movements[30];

    const movement60 =
        movements[60];

    let acceleration15to30 = null;
    let acceleration30to60 = null;

    if (
        movement15 !== null &&
        movement30 !== null
    ) {
        acceleration15to30 =
            movement15 -
            movement30;
    }

    if (
        movement30 !== null &&
        movement60 !== null
    ) {
        acceleration30to60 =
            movement30 -
            movement60;
    }

    let shortTermAcceleration = null;

    if (
        acceleration15to30 !== null &&
        acceleration30to60 !== null
    ) {
        shortTermAcceleration =
            (
                acceleration15to30 +
                acceleration30to60
            ) / 2;
    } else if (
        acceleration15to30 !== null
    ) {
        shortTermAcceleration =
            acceleration15to30;
    } else if (
        acceleration30to60 !== null
    ) {
        shortTermAcceleration =
            acceleration30to60;
    }

    return {
        movement15s:
            movement15,

        movement30s:
            movement30,

        movement60s:
            movement60,

        movement180s:
            movements[180],

        movement300s:
            movements[300],

        acceleration15to30,

        acceleration30to60,

        shortTermAcceleration
    };
}

// ============================================================
// ORDER BOOK FEATURES
// ============================================================

function calculateOrderBookFeatures() {
    const combined =
        calculateCombinedBookStats();

    const depth = {};

    for (
        const depthSize of
        CONFIG.bookDepths
    ) {
        const coinbase =
            getBookDepthStats(
                "coinbase",
                depthSize
            );

        const kraken =
            getBookDepthStats(
                "kraken",
                depthSize
            );

        const bidQuantity =
            coinbase.bidQuantity +
            kraken.bidQuantity;

        const askQuantity =
            coinbase.askQuantity +
            kraken.askQuantity;

        const total =
            bidQuantity +
            askQuantity;

        const imbalance =
            total > 0
                ? (
                      bidQuantity -
                      askQuantity
                  ) / total
                : 0;

        depth[depthSize] = {
            bidQuantity,

            askQuantity,

            imbalance
        };
    }

    return {
        combined: {
            bidQuantity:
                combined.bidQuantity,

            askQuantity:
                combined.askQuantity,

            imbalance:
                combined.imbalance
        },

        depths: depth,

        coinbase: {
            bids:
                combined.coinbase.bids,

            asks:
                combined.coinbase.asks,

            bestBid:
                combined.coinbase.bestBid,

            bestAsk:
                combined.coinbase.bestAsk,

            spread:
                combined.coinbase.spread,

            spreadPercent:
                combined.coinbase.spreadPercent,

            imbalance:
                combined.coinbase.imbalance
        },

        kraken: {
            bids:
                combined.kraken.bids,

            asks:
                combined.kraken.asks,

            bestBid:
                combined.kraken.bestBid,

            bestAsk:
                combined.kraken.bestAsk,

            spread:
                combined.kraken.spread,

            spreadPercent:
                combined.kraken.spreadPercent,

            imbalance:
                combined.kraken.imbalance
        }
    };
}

// ============================================================
// SPREAD FEATURES
// ============================================================

function calculateSpreadFeatures() {
    const coinbase =
        getBookStats(
            "coinbase"
        );

    const kraken =
        getBookStats(
            "kraken"
        );

    const exchanges = {
        coinbase: {
            bestBid:
                coinbase.bestBid,

            bestAsk:
                coinbase.bestAsk,

            spread:
                coinbase.spread,

            spreadPercent:
                coinbase.spreadPercent
        },

        kraken: {
            bestBid:
                kraken.bestBid,

            bestAsk:
                kraken.bestAsk,

            spread:
                kraken.spread,

            spreadPercent:
                kraken.spreadPercent
        }
    };

    const validSpreads = [
        coinbase.spreadPercent,
        kraken.spreadPercent
    ].filter(
        value =>
            Number.isFinite(value)
    );

    return {
        exchanges,

        averageSpreadPercent:
            average(
                validSpreads
            )
    };
}

// ============================================================
// CROSS-EXCHANGE FEATURES
// ============================================================

function calculateCrossExchangeFeatures() {
    const coinbase =
        getLatestPriceForExchange(
            "coinbase"
        );

    const kraken =
        getLatestPriceForExchange(
            "kraken"
        );

    if (
        !coinbase ||
        !kraken ||
        coinbase.price <= 0 ||
        kraken.price <= 0
    ) {
        return {
            coinbasePrice:
                coinbase
                    ? coinbase.price
                    : null,

            krakenPrice:
                kraken
                    ? kraken.price
                    : null,

            priceDifference:
                null,

            priceDifferencePercent:
                null,

            midpoint:
                null
        };
    }

    const difference =
        coinbase.price -
        kraken.price;

    const midpoint =
        (
            coinbase.price +
            kraken.price
        ) / 2;

    const differencePercent =
        midpoint > 0
            ? (
                  difference /
                  midpoint
              ) * 100
            : null;

    return {
        coinbasePrice:
            coinbase.price,

        krakenPrice:
            kraken.price,

        priceDifference:
            difference,

        priceDifferencePercent:
            differencePercent,

        midpoint
    };
}

// ============================================================
// VOLATILITY FEATURES
// ============================================================

function calculateVolatilityFeatures() {
    return {
        realized15s:
            getRealizedVolatility(
                15
            ),

        realized30s:
            getRealizedVolatility(
                30
            ),

        realized60s:
            getRealizedVolatility(
                60
            ),

        realized180s:
            getRealizedVolatility(
                180
            ),

        realized300s:
            getRealizedVolatility(
                300
            )
    };
}

// ============================================================
// EXCHANGE HEALTH
// ============================================================

function getExchangeHealth(
    exchangeName
) {
    const exchange =
        state.exchanges[
            exchangeName
        ];

    const currentTime =
        now();

    const messageAge =
        exchange.lastMessageAt > 0
            ? currentTime -
              exchange.lastMessageAt
            : Infinity;

    const priceAge =
        exchange.lastPriceAt > 0
            ? currentTime -
              exchange.lastPriceAt
            : Infinity;

    const bookAge =
        exchange.lastBookAt > 0
            ? currentTime -
              exchange.lastBookAt
            : Infinity;

    return {
        connected:
            exchange.connected,

        messageAge,

        priceAge,

        bookAge,

        bookInitialized:
            exchange.bookInitialized
    };
}

// ============================================================
// DATA QUALITY
// ============================================================

function calculateDataQuality() {
    let score = 0;

    const coinbase =
        state.exchanges.coinbase;

    const kraken =
        state.exchanges.kraken;

    if (coinbase.connected) {
        score += 20;
    }

    if (kraken.connected) {
        score += 20;
    }

    if (
        coinbase.lastPriceAt > 0 &&
        now() -
            coinbase.lastPriceAt <
            5000
    ) {
        score += 10;
    }

    if (
        kraken.lastPriceAt > 0 &&
        now() -
            kraken.lastPriceAt <
            5000
    ) {
        score += 10;
    }

    const coinbaseBook =
        getBookStats(
            "coinbase"
        );

    if (
        coinbaseBook.initialized &&
        coinbaseBook.bids > 0 &&
        coinbaseBook.asks > 0 &&
        now() -
            coinbaseBook.lastBookAt <
            10000
    ) {
        score += 10;
    }

    const krakenBook =
        getBookStats(
            "kraken"
        );

    if (
        krakenBook.initialized &&
        krakenBook.bids > 0 &&
        krakenBook.asks > 0 &&
        now() -
            krakenBook.lastBookAt <
            10000
    ) {
        score += 10;
    }

    if (state.trades.length > 0) {
        const latestTrade =
            state.trades[
                state.trades.length - 1
            ];

        if (
            latestTrade &&
            now() -
                latestTrade.timestamp <
                10000
        ) {
            score += 10;
        }
    }

    return clamp(
        score,
        0,
        100
    );
}

// ============================================================
// FEATURE QUALITY
// ============================================================

function calculateFeatureQuality() {
    let score = 0;

    const dataQuality =
        calculateDataQuality();

    // Raw data quality contributes 50%.
    score +=
        dataQuality * 0.5;

    // Price history available.
    if (
        state.priceHistory.length >=
        20
    ) {
        score += 10;
    }

    // Enough history for 60-second calculations.
    if (
        state.priceHistory.length >=
        60
    ) {
        score += 10;
    }

    // Recent trades available.
    const recentTrades =
        getRecentTradeStats(
            60
        );

    if (
        recentTrades.count >=
        20
    ) {
        score += 10;
    }

    // Both order books available.
    const book =
        calculateCombinedBookStats();

    if (
        book.coinbase.bids > 0 &&
        book.coinbase.asks > 0
    ) {
        score += 5;
    }

    if (
        book.kraken.bids > 0 &&
        book.kraken.asks > 0
    ) {
        score += 5;
    }

    // Both exchange prices available.
    const cross =
        calculateCrossExchangeFeatures();

    if (
        cross.coinbasePrice !== null &&
        cross.krakenPrice !== null
    ) {
        score += 5;
    }

    return clamp(
        Math.round(score),
        0,
        100
    );
}

// ============================================================
// COMPLETE FEATURE SNAPSHOT
// ============================================================

function getFeatureSnapshot() {
    const momentum =
        calculateMomentumFeatures();

    const orderBook =
        calculateOrderBookFeatures();

    const tradePressure =
        calculateTradeFeatures();

    const volatility =
        calculateVolatilityFeatures();

    const spread =
        calculateSpreadFeatures();

    const crossExchange =
        calculateCrossExchangeFeatures();

    return {
        timestamp:
            now(),

        price:
            state.price,

        momentum,

        orderBook,

        tradePressure,

        volatility,

        spread,

        crossExchange,

        quality: {
            data:
                calculateDataQuality(),

            features:
                calculateFeatureQuality()
        }
    };
}

// ============================================================
// MARKET SNAPSHOT
// ============================================================

function getMarketSnapshot() {
    const book =
        calculateCombinedBookStats();

    const movements = {};

    for (
        const seconds of
        CONFIG.priceWindows
    ) {
        movements[seconds] =
            getPriceMovement(
                seconds
            );
    }

    const tradeStats60 =
        getRecentTradeStats(
            60
        );

    const features =
        getFeatureSnapshot();

    return {
        timestamp:
            now(),

        price:
            state.price,

        priceSource:
            state.lastPriceSource,

        movements,

        orderBook: {
            coinbase:
                book.coinbase,

            kraken:
                book.kraken,

            combined: {
                bidQuantity:
                    book.bidQuantity,

                askQuantity:
                    book.askQuantity,

                imbalance:
                    book.imbalance
            }
        },

        trades: {
            stored:
                state.trades.length,

            recent60s:
                tradeStats60
        },

        volatility: {
            realized15s:
                getRealizedVolatility(
                    15
                ),

            realized30s:
                getRealizedVolatility(
                    30
                ),

            realized60s:
                getRealizedVolatility(
                    60
                ),

            realized180s:
                getRealizedVolatility(
                    180
                ),

            realized300s:
                getRealizedVolatility(
                    300
                )
        },

        health: {
            coinbase:
                getExchangeHealth(
                    "coinbase"
                ),

            kraken:
                getExchangeHealth(
                    "kraken"
                )
        },

        dataQuality:
            calculateDataQuality(),

        features
    };
}

// ============================================================
// REPORTING
// ============================================================

function formatMovement(
    value
) {
    if (
        value === null ||
        !Number.isFinite(value)
    ) {
        return "COLLECTING";
    }

    return `${value.toFixed(4)}%`;
}

function formatNumber(
    value,
    decimals = 6
) {
    if (
        value === null ||
        !Number.isFinite(value)
    ) {
        return "COLLECTING";
    }

    return value.toFixed(
        decimals
    );
}

function printReport() {
    const snapshot =
        getMarketSnapshot();

    const book =
        snapshot.orderBook;

    const features =
        snapshot.features;

    console.log("");

    console.log(
        "========== ZEUS MARKET DATA + FEATURES =========="
    );

    if (
        snapshot.price !== null
    ) {
        console.log(
            `BTC: $${snapshot.price.toFixed(
                2
            )}`
        );
    } else {
        console.log(
            "BTC: WAITING"
        );
    }

    console.log(
        `Data Quality: ${snapshot.dataQuality}%`
    );

    console.log(
        `Feature Quality: ${features.quality.features}%`
    );

    console.log(
        `Coinbase: ${
            snapshot.health.coinbase.connected
                ? "CONNECTED"
                : "DISCONNECTED"
        }`
    );

    console.log(
        `Kraken: ${
            snapshot.health.kraken.connected
                ? "CONNECTED"
                : "DISCONNECTED"
        }`
    );

    // --------------------------------------------------------
    // ORDER BOOK
    // --------------------------------------------------------

    console.log("");

    console.log(
        "----- ORDER BOOK -----"
    );

    console.log(
        `Coinbase Book: ${
            book.coinbase.bids
        } bids / ${
            book.coinbase.asks
        } asks`
    );

    console.log(
        `Kraken Book: ${
            book.kraken.bids
        } bids / ${
            book.kraken.asks
        } asks`
    );

    console.log(
        `Combined Bid Quantity: ${
            book.combined.bidQuantity.toFixed(
                4
            )
        }`
    );

    console.log(
        `Combined Ask Quantity: ${
            book.combined.askQuantity.toFixed(
                4
            )
        }`
    );

    console.log(
        `Order Book Imbalance: ${
            book.combined.imbalance.toFixed(
                4
            )
        }`
    );

    console.log(
        `5-Level Imbalance: ${
            formatNumber(
                features.orderBook.depths[5]
                    .imbalance,
                4
            )
        }`
    );

    console.log(
        `10-Level Imbalance: ${
            formatNumber(
                features.orderBook.depths[10]
                    .imbalance,
                4
            )
        }`
    );

    console.log(
        `25-Level Imbalance: ${
            formatNumber(
                features.orderBook.depths[25]
                    .imbalance,
                4
            )
        }`
    );

    // --------------------------------------------------------
    // MOMENTUM
    // --------------------------------------------------------

    console.log("");

    console.log(
        "----- MOMENTUM -----"
    );

    console.log(
        `15s Movement: ${
            formatMovement(
                features.momentum
                    .movement15s
            )
        }`
    );

    console.log(
        `30s Movement: ${
            formatMovement(
                features.momentum
                    .movement30s
            )
        }`
    );

    console.log(
        `60s Movement: ${
            formatMovement(
                features.momentum
                    .movement60s
            )
        }`
    );

    console.log(
        `180s Movement: ${
            formatMovement(
                features.momentum
                    .movement180s
            )
        }`
    );

    console.log(
        `300s Movement: ${
            formatMovement(
                features.momentum
                    .movement300s
            )
        }`
    );

    console.log(
        `Short-Term Acceleration: ${
            formatMovement(
                features.momentum
                    .shortTermAcceleration
            )
        }`
    );

    // --------------------------------------------------------
    // TRADE PRESSURE
    // --------------------------------------------------------

    console.log("");

    console.log(
        "----- TRADE PRESSURE -----"
    );

    const pressure60 =
        features.tradePressure[60];

    console.log(
        `60s Buy Volume: ${
            formatNumber(
                pressure60.buyVolume,
                4
            )
        }`
    );

    console.log(
        `60s Sell Volume: ${
            formatNumber(
                pressure60.sellVolume,
                4
            )
        }`
    );

    console.log(
        `60s Trade Imbalance: ${
            formatNumber(
                pressure60.imbalance,
                4
            )
        }`
    );

    console.log(
        `60s Trade Count: ${
            pressure60.count
        }`
    );

    console.log(
        `60s Total Volume: ${
            formatNumber(
                pressure60.totalVolume,
                4
            )
        }`
    );

    // --------------------------------------------------------
    // VOLATILITY
    // --------------------------------------------------------

    console.log("");

    console.log(
        "----- VOLATILITY -----"
    );

    console.log(
        `15s Realized Volatility: ${
            formatNumber(
                features.volatility
                    .realized15s,
                8
            )
        }`
    );

    console.log(
        `30s Realized Volatility: ${
            formatNumber(
                features.volatility
                    .realized30s,
                8
            )
        }`
    );

    console.log(
        `60s Realized Volatility: ${
            formatNumber(
                features.volatility
                    .realized60s,
                8
            )
        }`
    );

    // --------------------------------------------------------
    // SPREAD
    // --------------------------------------------------------

    console.log("");

    console.log(
        "----- MARKET MICROSTRUCTURE -----"
    );

    console.log(
        `Coinbase Spread: ${
            formatNumber(
                features.spread.exchanges
                    .coinbase.spread,
                2
            )
        }`
    );

    console.log(
        `Kraken Spread: ${
            formatNumber(
                features.spread.exchanges
                    .kraken.spread,
                2
            )
        }`
    );

    console.log(
        `Average Spread %: ${
            formatNumber(
                features.spread
                    .averageSpreadPercent,
                6
            )
        }%`
    );

    console.log(
        `Coinbase/Kraken Difference: ${
            formatNumber(
                features.crossExchange
                    .priceDifference,
                2
            )
        }`
    );

    console.log(
        `Cross-Exchange Difference %: ${
            formatNumber(
                features.crossExchange
                    .priceDifferencePercent,
                6
            )
        }%`
    );

    console.log(
        `Trades Stored: ${
            snapshot.trades.stored
        }`
    );

    console.log(
        "=================================================="
    );
}

// ============================================================
// START / STOP
// ============================================================

let reportTimer = null;

function start() {
    console.log(
        "=================================================="
    );

    console.log(
        "       ZEUS MARKET DATA + FEATURES STARTING"
    );

    console.log(
        "=================================================="
    );

    console.log(
        `Product: ${CONFIG.coinbase.productId}`
    );

    console.log(
        "Feeds: Coinbase + Kraken"
    );

    console.log(
        "Order books: SEPARATED BY EXCHANGE"
    );

    console.log(
        "Feature layer: ENABLED"
    );

    console.log(
        "Prediction engine: NOT ENABLED"
    );

    console.log(
        "=================================================="
    );

    connectCoinbase();
    connectKraken();

    reportTimer =
        setInterval(
            printReport,
            CONFIG.reportIntervalMs
        );
}

function stop() {
    if (!state.running) {
        return;
    }

    state.running = false;

    console.log("");

    console.log(
        "Stopping Zeus market data..."
    );

    if (reportTimer) {
        clearInterval(
            reportTimer
        );

        reportTimer = null;
    }

    if (coinbaseReconnectTimer) {
        clearTimeout(
            coinbaseReconnectTimer
        );

        coinbaseReconnectTimer =
            null;
    }

    if (krakenReconnectTimer) {
        clearTimeout(
            krakenReconnectTimer
        );

        krakenReconnectTimer =
            null;
    }

    if (coinbaseWs) {
        try {
            coinbaseWs.close();
        } catch {}
    }

    if (krakenWs) {
        try {
            krakenWs.close();
        } catch {}
    }
}

// ============================================================
// PROCESS SIGNALS
// ============================================================

process.on(
    "SIGINT",
    () => {
        stop();

        setTimeout(() => {
            process.exit(0);
        }, 250);
    }
);

process.on(
    "SIGTERM",
    () => {
        stop();

        setTimeout(() => {
            process.exit(0);
        }, 250);
    }
);

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    start,
    stop,

    getMarketSnapshot,
    getFeatureSnapshot,

    getBookStats,
    getBookDepthStats,
    calculateCombinedBookStats,
    calculateOrderBookFeatures,

    getRecentTradeStats,
    calculateTradeFeatures,

    getRealizedVolatility,
    calculateVolatilityFeatures,

    getPriceMovement,
    calculateMomentumFeatures,

    calculateSpreadFeatures,
    calculateCrossExchangeFeatures,

    calculateDataQuality,
    calculateFeatureQuality,

    state
};

// ============================================================
// RUN DIRECTLY
// ============================================================

if (
    require.main === module
) {
    start();
}