'use strict';

const axios = require('axios');
const https = require('https');

/*
 * Zeus Crypto.com prediction-market connector
 *
 * This module is READ-ONLY. It never places orders.
 *
 * Why this version exists:
 * The older connector queried DCM /public/get-instruments and expected the
 * active BTC 15-minute strike to be directly exposed on the instrument.
 * Crypto.com's current public Predictions API separately exposes prediction
 * EVENTS and their CONTRACTS, so this connector uses that API first and keeps
 * the DCM instrument endpoint as a secondary fallback.
 */

const CONFIG = {
    pollIntervalMs: 5000,
    requestTimeoutMs: 10000,

    minimumDurationMs: 10 * 60 * 1000,
    maximumDurationMs: 20 * 60 * 1000,
    targetDurationMs: 15 * 60 * 1000,

    btcNames: [
        'BTC',
        'BTCUSD',
        'BTCUSDT',
        'BITCOIN'
    ],

    predictionsBaseUrl: 'https://data-api.crypto.com/api/v1/predictions',
    dcmBaseUrl: 'https://api.crypto.com/dcm/v1'
};

const state = {
    running: false,
    lastPollAt: null,
    lastSuccessAt: null,
    lastError: null,
    activeMarket: null,
    source: null,
    eventsSeen: 0,
    contractsSeen: 0,
    btcEventsSeen: 0,
    btcContractsSeen: 0,
    instrumentsSeen: 0,
    btcBinaryInstrumentsSeen: 0,
    dcmDiagnostics: null,
    dcmHttpDiagnostics: null,
    predictionDiagnostics: null
};

let timer = null;

// Render can advertise both IPv6 and IPv4 routes for api.crypto.com even when
// IPv6 egress is unavailable. Keep DCM traffic on IPv4 so a dead IPv6 route
// cannot consume the request window. This agent is used only for DCM REST calls.
const dcmHttpsAgent = new https.Agent({
    family: 4,
    keepAlive: true,
    maxSockets: 4,
    maxFreeSockets: 2,
    timeout: 30000
});

function safeNumber(value, fallback = null) {
    if (value === null || value === undefined || value === '') {
        return fallback;
    }

    if (typeof value === 'string') {
        const cleaned = value.replace(/[$,%\s,]/g, '');
        const n = Number(cleaned);
        return Number.isFinite(n) ? n : fallback;
    }

    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function parseTime(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }

    if (value instanceof Date) {
        const n = value.getTime();
        return Number.isFinite(n) ? n : null;
    }

    if (typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value).trim())) {
        const n = Number(value);

        if (!Number.isFinite(n)) {
            return null;
        }

        if (n > 1e17) return n / 1e6;
        if (n > 1e14) return n / 1e6;
        if (n > 1e12) return n;
        if (n > 1e9) return n * 1000;

        return null;
    }

    const text = String(value).trim();

    const compact = text.match(
        /^(\d{4})(\d{2})(\d{2})[-_](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/
    );

    if (compact) {
        const iso = `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6]}.${(compact[7] || '000').padEnd(3, '0')}Z`;
        const parsed = Date.parse(iso);
        return Number.isFinite(parsed) ? parsed : null;
    }

    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : null;
}

function normalizeSymbol(value) {
    return String(value || '')
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '');
}

function normalizeText(value) {
    return String(value || '')
        .toUpperCase()
        .replace(/\s+/g, ' ')
        .trim();
}

function isBtcText(value) {
    const text = normalizeText(value);
    if (!text) return false;

    return (
        /\bBTC\b/.test(text) ||
        /\bBITCOIN\b/.test(text) ||
        normalizeSymbol(text).includes('BITCOIN') ||
        normalizeSymbol(text).startsWith('BTC')
    );
}

function objectValues(object) {
    if (!object || typeof object !== 'object') {
        return [];
    }

    return Object.entries(object).flatMap(([key, value]) => {
        if (value && typeof value === 'object') {
            return [key, ...objectValues(value)];
        }

        return [key, value];
    });
}

function objectEntriesDeep(object, prefix = '') {
    const output = [];

    if (!object || typeof object !== 'object') {
        return output;
    }

    for (const [key, value] of Object.entries(object)) {
        const path = prefix ? `${prefix}.${key}` : key;
        output.push({ key, path, value });

        if (value && typeof value === 'object') {
            output.push(...objectEntriesDeep(value, path));
        }
    }

    return output;
}

function findFirstByKeys(object, keys) {
    const wanted = new Set(keys.map(key => String(key).toLowerCase()));

    for (const entry of objectEntriesDeep(object)) {
        if (wanted.has(String(entry.key).toLowerCase())) {
            if (entry.value !== null && entry.value !== undefined && entry.value !== '') {
                return entry.value;
            }
        }
    }

    return null;
}

function findTimeByKeys(object, keys) {
    const wanted = keys.map(key => String(key).toLowerCase());

    for (const entry of objectEntriesDeep(object)) {
        const key = String(entry.key).toLowerCase();

        if (!wanted.includes(key)) {
            continue;
        }

        const parsed = parseTime(entry.value);

        if (parsed !== null) {
            return parsed;
        }
    }

    return null;
}

function findStrikeInText(text) {
    const value = String(text || '');

    const patterns = [
        /(?:ABOVE|OVER|GREATER THAN|EXCEEDS?|HIGHER THAN|AT LEAST|BELOW|UNDER|LESS THAN|LOWER THAN|AT MOST)[^$0-9]{0,40}\$?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.\d+)?)/i,
        /\$\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.\d+)?)/i,
        /\b([0-9]{2,3}(?:,[0-9]{3})+(?:\.\d+)?)\s*(?:USD|US DOLLARS?)\b/i,
        /\b(?:BTC|BITCOIN)[^0-9]{0,50}([0-9]{2,3}(?:,[0-9]{3})+(?:\.\d+)?)/i
    ];

    for (const pattern of patterns) {
        const match = value.match(pattern);

        if (!match) continue;

        const n = safeNumber(match[1]);

        if (n !== null && n > 1000) {
            return n;
        }
    }

    return null;
}

function extractStrike(object) {
    const strikeKeys = [
        'strike_price',
        'strikePrice',
        'strike',
        'strike_value',
        'strikeValue',
        'threshold',
        'threshold_price',
        'thresholdPrice',
        'barrier',
        'barrier_price',
        'barrierPrice',
        'target_price',
        'targetPrice',
        'price_threshold',
        'priceThreshold'
    ];

    for (const key of strikeKeys) {
        const value = findFirstByKeys(object, [key]);
        const n = safeNumber(value);

        if (n !== null && n > 1000) {
            return n;
        }
    }

    for (const entry of objectEntriesDeep(object)) {
        const key = normalizeText(entry.key);

        if (!/(STRIKE|THRESHOLD|BARRIER|TARGET).*PRICE|STRIKE|THRESHOLD|BARRIER/.test(key)) {
            continue;
        }

        const n = safeNumber(entry.value);

        if (n !== null && n > 1000) {
            return n;
        }
    }

    const textValues = objectValues(object)
        .filter(value => typeof value === 'string')
        .join(' | ');

    return findStrikeInText(textValues);
}

function extractOperator(object) {
    const operatorKeys = [
        'strike_operator',
        'strikeOperator',
        'operator',
        'comparison_operator',
        'comparisonOperator',
        'condition'
    ];

    for (const key of operatorKeys) {
        const value = findFirstByKeys(object, [key]);

        if (value !== null) {
            const text = normalizeText(value);

            if (text.includes('GREATER') || text === 'OVER' || text === 'ABOVE') return '>';
            if (text.includes('LESS') || text === 'UNDER' || text === 'BELOW') return '<';
            if (text.includes('EQUAL') || text === 'AT') return '=';
            if (['>', '>=', '<', '<=', '='].includes(String(value).trim())) {
                return String(value).trim();
            }
        }
    }

    const text = objectValues(object)
        .filter(value => typeof value === 'string')
        .join(' | ')
        .toUpperCase();

    if (/\b(?:ABOVE|OVER|GREATER THAN|EXCEEDS?|HIGHER THAN)\b/.test(text)) return '>';
    if (/\b(?:BELOW|UNDER|LESS THAN|LOWER THAN)\b/.test(text)) return '<';

    return null;
}

function extractOpenClose(object) {
    const open = findTimeByKeys(object, [
        'open_time',
        'openTime',
        'start_time',
        'startTime',
        'opened_at',
        'openedAt',
        'market_open_time',
        'marketOpenTime',
        'open_timestamp',
        'openTimestamp'
    ]);

    const close = findTimeByKeys(object, [
        'close_time',
        'closeTime',
        'end_time',
        'endTime',
        'expires_at',
        'expiresAt',
        'expiry_time',
        'expiryTime',
        'expiration_time',
        'expirationTime',
        'expiry_timestamp',
        'expiryTimestamp',
        'event_end_date',
        'eventEndDate'
    ]);

    return { open, close };
}

function extractEventDate(object) {
    return findTimeByKeys(object, [
        'event_date',
        'eventDate',
        'start_time',
        'startTime',
        'open_time',
        'openTime'
    ]);
}

function collectText(object) {
    return objectValues(object)
        .filter(value => value !== null && value !== undefined)
        .map(value => String(value))
        .join(' | ');
}

function looksLikeBtcEvent(event) {
    const text = collectText(event);

    return isBtcText(text);
}

function looksLikeCrypto15MinuteMarket(event, contract = null) {
    const text = normalizeText(`${collectText(event)} ${collectText(contract || {})}`);

    if (!isBtcText(text)) {
        return false;
    }

    return (
        /15\s*(?:MIN|MINS|MINUTE|MINUTES)/.test(text) ||
        /QUICK|SHORT[- ]TERM|INTRADAY/.test(text) ||
        /ABOVE|BELOW|OVER|UNDER/.test(text)
    );
}

function getContractsFromEvent(event) {
    if (Array.isArray(event?.contracts)) {
        return event.contracts;
    }

    if (Array.isArray(event?.contract_list)) {
        return event.contract_list;
    }

    if (Array.isArray(event?.contractList)) {
        return event.contractList;
    }

    return [];
}

function unwrapData(response) {
    return (
        response?.data?.data ||
        response?.data?.result?.data ||
        response?.data?.result ||
        response?.data ||
        []
    );
}

async function getPredictionEvents() {
    const urls = [
        `${CONFIG.predictionsBaseUrl}/events`,
        `${CONFIG.predictionsBaseUrl}/events/search`
    ];

    const results = [];

    try {
        const response = await axios.get(urls[0], {
            params: {
                status: 'active',
                limit: 50
            },
            timeout: CONFIG.requestTimeoutMs,
            headers: { Accept: 'application/json' }
        });

        const data = unwrapData(response);

        if (Array.isArray(data)) {
            results.push(...data);
        }
    } catch (error) {
        state.lastError = {
            source: 'PREDICTIONS_EVENTS',
            message: error.message,
            timestamp: new Date().toISOString()
        };
    }

    // Search is a useful fallback because the active-events list can contain
    // a broad universe and the BTC contract may not be in the first page.
    try {
        const response = await axios.get(urls[1], {
            params: {
                q: 'BTC',
                limit: 50
            },
            timeout: CONFIG.requestTimeoutMs,
            headers: { Accept: 'application/json' }
        });

        const data = unwrapData(response);

        if (Array.isArray(data)) {
            results.push(...data);
        }
    } catch (error) {
        // Search failure is not fatal when the main events endpoint worked.
    }

    const unique = new Map();

    for (const event of results) {
        const id = event?.id || event?.event_id || event?.eventId || event?.symbol || JSON.stringify(event);
        unique.set(String(id), event);
    }

    return [...unique.values()];
}

async function getEventContracts(eventId) {
    if (!eventId) return [];

    try {
        const response = await axios.get(
            `${CONFIG.predictionsBaseUrl}/events/${encodeURIComponent(eventId)}/contracts`,
            {
                timeout: CONFIG.requestTimeoutMs,
                headers: { Accept: 'application/json' }
            }
        );

        const data = unwrapData(response);
        return Array.isArray(data) ? data : [];
    } catch (error) {
        return [];
    }
}

function chooseTimePair(event, contract) {
    const eventTimes = extractOpenClose(event);
    const contractTimes = extractOpenClose(contract);

    const open = contractTimes.open ?? eventTimes.open ?? extractEventDate(event);
    const close = contractTimes.close ?? eventTimes.close;

    return { open, close };
}

function duration(open, close) {
    return open != null && close != null && close > open
        ? close - open
        : null;
}

function isCurrent15m(open, close, now = Date.now()) {
    if (open == null || close == null) return false;

    const d = close - open;

    if (d < CONFIG.minimumDurationMs || d > CONFIG.maximumDurationMs) {
        return false;
    }

    return now >= open && now < close;
}

function scoreCandidate(candidate, now = Date.now()) {
    const d = duration(candidate.openTimeMs, candidate.closeTimeMs);
    let score = 0;

    if (candidate.strike !== null) score += 5000;
    if (candidate.btc) score += 1000;
    if (candidate.is15mText) score += 1000;
    if (candidate.openTimeMs != null && candidate.closeTimeMs != null) score += 1000;

    if (d != null) {
        score -= Math.abs(d - CONFIG.targetDurationMs) / 1000;
    }

    if (candidate.closeTimeMs != null) {
        score += Math.min(Math.max(candidate.closeTimeMs - now, 0) / 1000, 900) / 10;
    }

    return score;
}

function normalizePredictionMarket(event, contract, now = Date.now()) {
    const { open, close } = chooseTimePair(event, contract);
    const combined = {
        event,
        contract,
        metadata: event?.metadata || event?.meta || {}
    };

    const strike = extractStrike(combined);
    const strikeOperator = extractOperator(combined);

    const eventId = event?.id || event?.event_id || event?.eventId || null;
    const contractId = contract?.id || contract?.contract_id || contract?.contractId || null;
    const symbol = contract?.symbol || contract?.ticker || contract?.code || event?.symbol || null;
    const title =
        contract?.title ||
        contract?.name ||
        contract?.description ||
        event?.title ||
        event?.name ||
        null;

    const d = duration(open, close);

    return {
        available: true,
        source: 'CRYPTO.COM_PREDICTIONS_API',
        eventId,
        contractId,
        symbol,
        displayName: title,
        title,
        instrumentType: 'PREDICTION_CONTRACT',
        underlying: 'BTC',
        strike,
        strikeAvailable: strike !== null,
        strikeOperator,
        openTime: open != null ? new Date(open).toISOString() : null,
        closeTime: close != null ? new Date(close).toISOString() : null,
        openTimestampMs: open,
        closeTimestampMs: close,
        durationMs: d,
        durationMinutes: d != null ? d / 60000 : null,
        secondsRemaining: close != null
            ? Math.max(0, Math.ceil((close - now) / 1000))
            : null,
        tradable: Boolean(
            contract?.tradable ??
            contract?.is_tradable ??
            contract?.active ??
            event?.tradable ??
            true
        ),
        status: event?.status || contract?.status || 'active',
        yesContract: contract?.yes || contract?.outcome === 'YES' || contract?.side === 'YES' ? contract : null,
        event,
        contract,
        raw: combined
    };
}

function candidateIsUsable(market, now = Date.now()) {
    if (!market) return false;
    if (!isCurrent15m(market.openTimestampMs, market.closeTimestampMs, now)) return false;
    if (market.strike === null) return false;
    return true;
}

async function pollPredictionApi() {
    const now = Date.now();
    const events = await getPredictionEvents();

    state.eventsSeen = events.length;
    state.btcEventsSeen = events.filter(looksLikeBtcEvent).length;

    const candidates = [];
    const rejectionCounts = {
        btcEvents: 0,
        contractsExamined: 0,
        textOrDurationMismatch: 0,
        missingOpenTime: 0,
        missingCloseTime: 0,
        durationOutside10To20Minutes: 0,
        notCurrentByTime: 0,
        missingStrike: 0,
        usable: 0
    };
    const rejectedSample = [];

    for (const event of events) {
        if (!looksLikeBtcEvent(event)) {
            continue;
        }

        rejectionCounts.btcEvents += 1;

        const eventId = event?.id || event?.event_id || event?.eventId;
        let contracts = getContractsFromEvent(event);

        if (contracts.length === 0 && eventId) {
            contracts = await getEventContracts(eventId);
        }

        state.contractsSeen += contracts.length;
        state.btcContractsSeen += contracts.length;

        if (contracts.length === 0) {
            // Some API responses put enough contract information directly on
            // the event. Treat the event itself as a candidate.
            contracts = [event];
        }

        for (const contract of contracts) {
            rejectionCounts.contractsExamined += 1;

            const market = normalizePredictionMarket(event, contract, now);
            const textMatch = looksLikeCrypto15MinuteMarket(event, contract);
            const reasons = [];

            if (!textMatch && market.durationMinutes !== 15) {
                rejectionCounts.textOrDurationMismatch += 1;
                reasons.push('TEXT_OR_DURATION_MISMATCH');
            }

            if (market.openTimestampMs == null) {
                rejectionCounts.missingOpenTime += 1;
                reasons.push('MISSING_OPEN_TIME');
            }

            if (market.closeTimestampMs == null) {
                rejectionCounts.missingCloseTime += 1;
                reasons.push('MISSING_CLOSE_TIME');
            }

            if (
                market.durationMs != null &&
                (
                    market.durationMs < CONFIG.minimumDurationMs ||
                    market.durationMs > CONFIG.maximumDurationMs
                )
            ) {
                rejectionCounts.durationOutside10To20Minutes += 1;
                reasons.push('DURATION_OUTSIDE_10_TO_20_MINUTES');
            }

            if (
                market.openTimestampMs != null &&
                market.closeTimestampMs != null &&
                !isCurrent15m(
                    market.openTimestampMs,
                    market.closeTimestampMs,
                    now
                )
            ) {
                rejectionCounts.notCurrentByTime += 1;
                reasons.push('NOT_CURRENT_BY_TIME');
            }

            if (market.strike === null) {
                rejectionCounts.missingStrike += 1;
                reasons.push('MISSING_STRIKE');
            }

            const candidate = {
                ...market,
                btc: true,
                is15mText: textMatch
            };

            if (
                reasons.length === 0 &&
                candidateIsUsable(candidate, now)
            ) {
                rejectionCounts.usable += 1;
                candidate.selectionScore = scoreCandidate(candidate, now);
                candidates.push(candidate);
                continue;
            }

            if (rejectedSample.length < 10) {
                rejectedSample.push({
                    eventId: market.eventId,
                    eventTitle: event?.title || event?.name || null,
                    eventStatus: event?.status || null,
                    contractId: market.contractId,
                    symbol: market.symbol,
                    contractTitle: contract?.title || contract?.name || null,
                    contractStatus: contract?.status || null,
                    openTime: market.openTime,
                    closeTime: market.closeTime,
                    durationMinutes: market.durationMinutes,
                    strike: market.strike,
                    operator: market.strikeOperator,
                    textMatch,
                    reasons
                });
            }
        }
    }

    state.predictionDiagnostics = {
        generatedAt: new Date(now).toISOString(),
        rejectionCounts,
        rejectedSample
    };

    candidates.sort((a, b) => b.selectionScore - a.selectionScore);

    return candidates[0] || null;
}

async function fetchDcmInstruments() {
    /*
     * DCM fallback, optimized for the live BTC intraday contract.
     *
     * First query recently updated BINARY_OPTION instruments directly. This
     * avoids crawling the much larger all-event catalog just to discover a
     * short-lived BTC contract. If that direct lookup cannot produce any
     * instruments, fall back to the event -> event_symbols lookup.
     *
     * DCM page requests get one retry because Render occasionally sees an
     * individual Crypto.com reference-data page exceed the normal timeout.
     */
    const instruments = [];
    const pages = [];
    const eventPages = [];
    const now = Date.now();
    const dcmTimeoutMs = Math.max(CONFIG.requestTimeoutMs, 20000);
    const recentLookbackMs = 48 * 60 * 60 * 1000;
    const recentSinceNs = Math.floor((now - recentLookbackMs) * 1e6);

    state.dcmHttpDiagnostics = {
        strategy: 'RECENT_BINARY_INSTRUMENTS_THEN_BTC_EVENT_FALLBACK',
        eventsEndpoint: `${CONFIG.dcmBaseUrl}/public/get-events`,
        endpoint: `${CONFIG.dcmBaseUrl}/public/get-instruments`,
        recentSinceNs,
        recentPages: [],
        eventPages: [],
        btcEventSymbols: [],
        pages: [],
        totalInstruments: 0,
        error: null
    };

    async function getWithRetry(url, params, label) {
        let lastError = null;

        for (let attempt = 1; attempt <= 3; attempt += 1) {
            try {
                const response = await axios.get(url, {
                    params,
                    timeout: dcmTimeoutMs,
                    httpsAgent: dcmHttpsAgent,
                    headers: {
                        Accept: 'application/json',
                        'Content-Type': 'application/json',
                        Connection: 'keep-alive'
                    }
                });

                return { response, attempt };
            } catch (error) {
                lastError = error;

                const code = String(error?.code || '').toUpperCase();
                const message = String(error?.message || '');
                const retryableNetworkCodes = new Set([
                    'ECONNABORTED',
                    'ETIMEDOUT',
                    'ECONNRESET',
                    'ECONNREFUSED',
                    'ENETUNREACH',
                    'EHOSTUNREACH',
                    'EAI_AGAIN'
                ]);
                const retryable =
                    retryableNetworkCodes.has(code) ||
                    /timeout|timed out|ETIMEDOUT|ENETUNREACH|ECONNRESET|EAI_AGAIN/i.test(message) ||
                    Number(error?.response?.status) >= 500;

                if (!retryable || attempt >= 3) {
                    error.dcmLabel = label;
                    error.dcmAttempt = attempt;
                    throw error;
                }

                // Short bounded backoff: 500 ms before retry 2, 1.5 s before retry 3.
                const retryDelayMs = attempt === 1 ? 500 : 1500;
                await new Promise(resolve => setTimeout(resolve, retryDelayMs));
            }
        }

        throw lastError;
    }

    try {
        // Fast path: ask only for recently updated binary-option instruments.
        // A live 15-minute BTC contract is short-lived, so this is far smaller
        // than requesting the complete DCM instrument history with since=0.
        const recentPages = [];
        const seenRecentCursors = new Set();
        let recentCursor = null;
        let recentPage = 0;
        const maxRecentPages = 10;

        do {
            const params = {
                inst_type: 'BINARY_OPTION',
                since: recentSinceNs,
                limit: 1000
            };

            if (recentCursor) {
                params.cursor = recentCursor;
            }

            const { response, attempt } = await getWithRetry(
                `${CONFIG.dcmBaseUrl}/public/get-instruments`,
                params,
                `recent-instruments-page-${recentPage + 1}`
            );

            const body = response.data;
            const result = body?.result || {};
            const pageData = Array.isArray(result.data) ? result.data : [];
            const nextCursor = result?.next_cursor || null;

            recentPages.push({
                page: recentPage + 1,
                attempt,
                httpStatus: response.status,
                responseCode: body?.code ?? null,
                responseMessage: body?.message ?? null,
                pageInstrumentCount: pageData.length,
                btcBinaryCount: pageData.filter(
                    instrument => dcmIsBinaryOption(instrument) && dcmLooksLikeBtc(instrument)
                ).length,
                nextCursor: nextCursor ? String(nextCursor) : null
            });

            instruments.push(...pageData);
            recentPage += 1;

            if (!nextCursor || seenRecentCursors.has(String(nextCursor))) {
                recentCursor = null;
            } else {
                seenRecentCursors.add(String(nextCursor));
                recentCursor = nextCursor;
            }
        } while (recentCursor && recentPage < maxRecentPages);

        state.dcmHttpDiagnostics.recentPages = recentPages;

        // If the recent binary feed returned data, let the existing strict BTC,
        // 15-minute, tradable and strike filters decide whether it is usable.
        if (instruments.length) {
            state.dcmHttpDiagnostics = {
                ...state.dcmHttpDiagnostics,
                recentPages,
                eventPages,
                btcEventSymbols: [],
                pages,
                totalInstruments: instruments.length,
                error: null
            };
            return instruments;
        }

        // Secondary path: discover BTC events and fetch their instruments.
        const eventWindowMs = 6 * 60 * 60 * 1000;
        const lowerEventNs = Math.floor((now - eventWindowMs) * 1e6);
        const upperEventNs = Math.floor((now + eventWindowMs) * 1e6);
        const btcEventSymbolSet = new Set();
        const seenEventCursors = new Set();
        let eventCursor = null;
        let eventPage = 0;
        const maxEventPages = 20;

        do {
            const eventParams = {
                limit: 100,
                event_date: lowerEventNs,
                event_end_date: upperEventNs
            };

            if (eventCursor) {
                eventParams.cursor = eventCursor;
            }

            const { response: eventResponse, attempt } = await getWithRetry(
                `${CONFIG.dcmBaseUrl}/public/get-events`,
                eventParams,
                `events-page-${eventPage + 1}`
            );

            const eventBody = eventResponse.data;
            const eventResult = eventBody?.result || {};
            const events = Array.isArray(eventResult.data) ? eventResult.data : [];

            const pageBtcEventSymbols = [...new Set(
                events
                    .filter(event => {
                        const values = [
                            event?.symbol,
                            event?.name,
                            event?.description,
                            event?.event_details?.eventName,
                            event?.event_details?.metaData?.NAME,
                            event?.event_details?.metaData?.UNDERLYING,
                            event?.event_details?.metaData?.ASSET,
                            event?.event_details?.metaData?.TICKER
                        ].filter(Boolean);
                        return values.some(isBtcText);
                    })
                    .map(event => event?.symbol)
                    .filter(Boolean)
            )];

            for (const symbol of pageBtcEventSymbols) {
                btcEventSymbolSet.add(symbol);
            }

            const nextCursor = eventResult?.next_cursor || null;

            eventPages.push({
                page: eventPage + 1,
                attempt,
                httpStatus: eventResponse.status,
                responseCode: eventBody?.code ?? null,
                responseMessage: eventBody?.message ?? null,
                eventsReturned: events.length,
                btcEventsReturned: pageBtcEventSymbols.length,
                btcEventsFoundTotal: btcEventSymbolSet.size,
                nextCursor: nextCursor ? String(nextCursor) : null
            });

            eventPage += 1;

            if (!nextCursor || seenEventCursors.has(String(nextCursor))) {
                eventCursor = null;
            } else {
                seenEventCursors.add(String(nextCursor));
                eventCursor = nextCursor;
            }
        } while (
            eventCursor &&
            eventPage < maxEventPages &&
            btcEventSymbolSet.size === 0
        );

        const btcEventSymbols = [...btcEventSymbolSet];

        if (!btcEventSymbols.length) {
            state.dcmHttpDiagnostics = {
                ...state.dcmHttpDiagnostics,
                recentPages,
                eventPages,
                btcEventSymbols,
                pages,
                totalInstruments: instruments.length,
                error: null
            };
            return instruments;
        }

        for (let offset = 0; offset < btcEventSymbols.length; offset += 10) {
            const batch = btcEventSymbols.slice(offset, offset + 10);
            const seenCursors = new Set();
            let cursor = null;
            let page = 0;
            const maxPages = 20;

            do {
                const params = {
                    event_symbols: batch.join(','),
                    inst_type: 'BINARY_OPTION',
                    limit: 1000
                };

                if (cursor) {
                    params.cursor = cursor;
                }

                const { response, attempt } = await getWithRetry(
                    `${CONFIG.dcmBaseUrl}/public/get-instruments`,
                    params,
                    `event-instruments-page-${page + 1}`
                );

                const body = response.data;
                const result = body?.result || {};
                const pageData = Array.isArray(result.data) ? result.data : [];
                const nextCursor = result?.next_cursor || null;

                pages.push({
                    batch: batch.join(','),
                    page: page + 1,
                    attempt,
                    httpStatus: response.status,
                    responseCode: body?.code ?? null,
                    responseMessage: body?.message ?? null,
                    pageInstrumentCount: pageData.length,
                    nextCursor: nextCursor ? String(nextCursor) : null
                });

                instruments.push(...pageData);
                page += 1;

                if (!nextCursor || seenCursors.has(String(nextCursor))) {
                    cursor = null;
                } else {
                    seenCursors.add(String(nextCursor));
                    cursor = nextCursor;
                }
            } while (cursor && page < maxPages);
        }

        state.dcmHttpDiagnostics = {
            ...state.dcmHttpDiagnostics,
            recentPages,
            eventPages,
            btcEventSymbols,
            pages,
            totalInstruments: instruments.length,
            error: null
        };

        return instruments;
    } catch (error) {
        const body = error?.response?.data;
        let sample = null;

        try {
            const text = JSON.stringify(body ?? null);
            sample = text && text.length > 1800
                ? `${text.slice(0, 1800)}...<truncated>`
                : text;
        } catch {
            sample = '[UNSERIALIZABLE_ERROR_RESPONSE]';
        }

        state.dcmHttpDiagnostics = {
            ...state.dcmHttpDiagnostics,
            eventPages,
            pages,
            totalInstruments: instruments.length,
            error: {
                message: error.message,
                label: error?.dcmLabel || null,
                attempt: error?.dcmAttempt || null,
                requestUrl: error?.config?.url || null,
                requestParams: error?.config?.params || null,
                httpStatus: error?.response?.status ?? null,
                responseCode: body?.code ?? null,
                responseMessage: body?.message ?? body?.msg ?? null,
                sample
            }
        };

        throw error;
    }
}

function dcmLooksLikeBtc(instrument) {
    const values = [
        instrument?.base_ccy,
        instrument?.base_currency,
        instrument?.underlying_symbol,
        instrument?.symbol,
        instrument?.display_name,
        instrument?.event_symbol,
        instrument?.event_details?.eventName,
        instrument?.event_details?.metaData?.NAME,
        instrument?.event_details?.metaData?.UNDERLYING
    ].filter(Boolean);

    return values.some(isBtcText);
}

function dcmIsBinaryOption(instrument) {
    const type = normalizeText(
        instrument?.inst_type ||
        instrument?.instrument_type ||
        instrument?.security_sub_type ||
        instrument?.event_details?.metaData?.PREDICT_CONTRACT_TYPE ||
        ''
    );

    return type === 'BINARY_OPTION' || type.includes('BINARY');
}

function normalizeDcmMarket(instrument, now = Date.now()) {
    const { open, close } = extractOpenClose(instrument);
    const strike = extractStrike(instrument);
    const d = duration(open, close);

    return {
        available: true,
        source: 'CRYPTO.COM_DCM',
        eventId: instrument?.event_symbol || instrument?.event_id || null,
        contractId: instrument?.symbol || null,
        symbol: instrument?.symbol || null,
        displayName: instrument?.display_name || null,
        title: instrument?.display_name || null,
        instrumentType: instrument?.inst_type || 'BINARY_OPTION',
        underlying: instrument?.underlying_symbol || instrument?.base_ccy || 'BTC',
        strike,
        strikeAvailable: strike !== null,
        strikeOperator: extractOperator(instrument),
        strikeIndex: instrument?.attributes?.STRIKE_INDEX || instrument?.strike_index || null,
        openTime: open != null ? new Date(open).toISOString() : null,
        closeTime: close != null ? new Date(close).toISOString() : null,
        openTimestampMs: open,
        closeTimestampMs: close,
        durationMs: d,
        durationMinutes: d != null ? d / 60000 : null,
        secondsRemaining: close != null
            ? Math.max(0, Math.ceil((close - now) / 1000))
            : null,
        tradable: Boolean(instrument?.tradable),
        status: instrument?.status || 'active',
        metadata: instrument?.event_details?.metaData || {},
        raw: instrument
    };
}

async function pollDcmFallback() {
    try {
        const instruments = await fetchDcmInstruments();
        const now = Date.now();

        state.instrumentsSeen = instruments.length;
        state.btcBinaryInstrumentsSeen = instruments.filter(
            instrument => dcmIsBinaryOption(instrument) && dcmLooksLikeBtc(instrument)
        ).length;

        const diagnostics = {
            notTradable: 0,
            notBinary: 0,
            notBtc: 0,
            notCurrent15m: 0,
            noStrike: 0
        };

        const candidates = instruments
            .filter(instrument => {
                if (!instrument?.tradable) {
                    diagnostics.notTradable += 1;
                    return false;
                }
                if (!dcmIsBinaryOption(instrument)) {
                    diagnostics.notBinary += 1;
                    return false;
                }
                if (!dcmLooksLikeBtc(instrument)) {
                    diagnostics.notBtc += 1;
                    return false;
                }

                const market = normalizeDcmMarket(instrument, now);

                if (!isCurrent15m(market.openTimestampMs, market.closeTimestampMs, now)) {
                    diagnostics.notCurrent15m += 1;
                    return false;
                }

                if (market.strike === null) {
                    diagnostics.noStrike += 1;
                    return false;
                }

                return true;
            })
            .map(instrument => normalizeDcmMarket(instrument, now));

        state.dcmDiagnostics = diagnostics;

        candidates.sort((a, b) => {
            const ad = a.durationMs == null ? Infinity : Math.abs(a.durationMs - CONFIG.targetDurationMs);
            const bd = b.durationMs == null ? Infinity : Math.abs(b.durationMs - CONFIG.targetDurationMs);
            return ad - bd;
        });

        return candidates[0] || null;
    } catch (error) {
        state.dcmDiagnostics = {
            error: error.message
        };
        return null;
    }
}

async function poll() {
    state.lastPollAt = new Date().toISOString();
    state.contractsSeen = 0;
    state.btcContractsSeen = 0;

    try {
        let market = null;

        try {
            market = await pollPredictionApi();
        } catch (error) {
            state.lastError = {
                source: 'PREDICTIONS_API',
                message: error.message,
                timestamp: new Date().toISOString()
            };
        }

        if (!market) {
            market = await pollDcmFallback();
        }

        state.activeMarket = market;
        state.source = market?.source || null;
        state.lastSuccessAt = new Date().toISOString();

        if (market) {
            state.lastError = null;

            console.log('');
            console.log('========== CRYPTO.COM MARKET =========');
            console.log(`Source: ${market.source}`);
            console.log(`Contract: ${market.symbol || market.contractId || 'UNKNOWN'}`);
            console.log(`Title: ${market.title || market.displayName || 'UNKNOWN'}`);
            console.log(`BTC Strike: ${market.strike !== null ? `$${market.strike.toFixed(2)}` : 'NOT EXPOSED BY FEED'}`);
            console.log(`Operator: ${market.strikeOperator || 'UNKNOWN'}`);
            console.log(`Open: ${market.openTime || 'UNKNOWN'}`);
            console.log(`Close: ${market.closeTime || 'UNKNOWN'}`);
            console.log(`Strike Available: ${market.strikeAvailable ? 'YES' : 'NO'}`);
            console.log('========================================');
        } else {
            console.log('');
            console.log('========== CRYPTO.COM MARKET =========');
            console.log('Status: ACTIVE BTC 15-MINUTE CONTRACT NOT FOUND');
            console.log(`Prediction events scanned: ${state.eventsSeen}`);
            console.log(`BTC events found: ${state.btcEventsSeen}`);
            console.log(`Contracts scanned: ${state.contractsSeen}`);
            if (state.predictionDiagnostics) {
                console.log(`Predictions rejection summary: ${JSON.stringify(state.predictionDiagnostics.rejectionCounts)}`);
                console.log(`Predictions rejected BTC sample: ${JSON.stringify(state.predictionDiagnostics.rejectedSample)}`);
            }
            console.log(`DCM instruments scanned: ${state.instrumentsSeen}`);
            console.log(`DCM BTC binary matches: ${state.btcBinaryInstrumentsSeen}`);
            if (state.dcmHttpDiagnostics) {
                console.log(`DCM HTTP diagnostics: ${JSON.stringify(state.dcmHttpDiagnostics)}`);
            }
            if (state.dcmDiagnostics) {
                console.log(`DCM rejection summary: ${JSON.stringify(state.dcmDiagnostics)}`);
            }
            console.log('Decision: WAITING FOR AN ACTUAL CONTRACT + STRIKE');
            console.log('========================================');
        }
    } catch (error) {
        state.lastError = {
            source: 'CRYPTO_COM_MARKET',
            message: error.message,
            timestamp: new Date().toISOString()
        };

        console.error('Crypto.com market-data error:', error.message);
    }
}

function start() {
    if (state.running) return;

    state.running = true;

    console.log('Crypto.com 15-minute market feed starting...');
    console.log(`Predictions API: ${CONFIG.predictionsBaseUrl}`);
    console.log(`DCM fallback: ${CONFIG.dcmBaseUrl}/public/get-instruments`);
    console.log('Mode: READ-ONLY / PAPER');

    poll();
    timer = setInterval(poll, CONFIG.pollIntervalMs);
}

function stop() {
    state.running = false;

    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}

function getMarket() {
    return state.activeMarket;
}

function getStatus() {
    return {
        connected: Boolean(state.lastSuccessAt),
        running: state.running,
        lastPollAt: state.lastPollAt,
        lastSuccessAt: state.lastSuccessAt,
        lastError: state.lastError,
        source: state.source,
        eventsSeen: state.eventsSeen,
        contractsSeen: state.contractsSeen,
        btcEventsSeen: state.btcEventsSeen,
        btcContractsSeen: state.btcContractsSeen,
        instrumentsSeen: state.instrumentsSeen,
        btcBinaryInstrumentsSeen: state.btcBinaryInstrumentsSeen,
        dcmDiagnostics: state.dcmDiagnostics,
        market: state.activeMarket
    };
}

module.exports = {
    CONFIG,
    state,
    start,
    stop,
    poll,
    getMarket,
    getStatus
};
