'use strict';

const axios = require('axios');

const TIMEZONE = 'America/New_York';
const TABLE_NAME = process.env.SUPABASE_ZEUS_RECORDS_TABLE || 'zeus_daily_records';

let initialized = false;
let currentDayCache = null;

function getEasternDate(date = new Date()) {
    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    });

    return formatter.format(date);
}

function createEmptyDay(date) {
    const now = new Date().toISOString();

    return {
        date,
        timezone: TIMEZONE,
        wins: 0,
        losses: 0,
        skips: 0,
        predictions: [],
        createdAt: now,
        updatedAt: now
    };
}

function getSupabaseConfig() {
    const url = String(process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
    const key = String(
        process.env.SUPABASE_SERVICE_ROLE_KEY ||
        process.env.SUPABASE_ANON_KEY ||
        ''
    ).trim();

    if (!url) {
        throw new Error('SUPABASE_URL is missing. Add it to the Render environment variables.');
    }

    if (!key) {
        throw new Error(
            'SUPABASE_SERVICE_ROLE_KEY is missing. Add it to the Render environment variables.'
        );
    }

    return { url, key };
}

function getSupabaseClient() {
    const { url, key } = getSupabaseConfig();

    return axios.create({
        baseURL: `${url}/rest/v1`,
        timeout: 15000,
        headers: {
            apikey: key,
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json'
        }
    });
}

function normalizeDay(row, fallbackDate = getEasternDate()) {
    if (!row || typeof row !== 'object') {
        return createEmptyDay(fallbackDate);
    }

    return {
        date: String(row.date || fallbackDate),
        timezone: String(row.timezone || TIMEZONE),
        wins: Number.isFinite(Number(row.wins)) ? Number(row.wins) : 0,
        losses: Number.isFinite(Number(row.losses)) ? Number(row.losses) : 0,
        skips: Number.isFinite(Number(row.skips)) ? Number(row.skips) : 0,
        predictions: Array.isArray(row.predictions) ? row.predictions : [],
        createdAt: row.created_at || row.createdAt || new Date().toISOString(),
        updatedAt: row.updated_at || row.updatedAt || new Date().toISOString()
    };
}

function toDatabaseRow(day) {
    return {
        date: day.date,
        timezone: day.timezone || TIMEZONE,
        wins: Number(day.wins) || 0,
        losses: Number(day.losses) || 0,
        skips: Number(day.skips) || 0,
        predictions: Array.isArray(day.predictions) ? day.predictions : [],
        created_at: day.createdAt || new Date().toISOString(),
        updated_at: new Date().toISOString()
    };
}

async function fetchDay(date) {
    const client = getSupabaseClient();
    const response = await client.get(`/${TABLE_NAME}`, {
        params: {
            select: '*',
            date: `eq.${date}`,
            limit: 1
        }
    });

    const row = Array.isArray(response.data) ? response.data[0] : null;
    return row ? normalizeDay(row, date) : null;
}

async function upsertDay(day) {
    const client = getSupabaseClient();
    const row = toDatabaseRow(day);

    await client.post(`/${TABLE_NAME}`, row, {
        params: {
            on_conflict: 'date'
        },
        headers: {
            Prefer: 'resolution=merge-duplicates,return=minimal'
        }
    });

    day.updatedAt = row.updated_at;
    return day;
}

async function initializeRecordManager() {
    const currentDate = getEasternDate();
    const existing = await fetchDay(currentDate);

    if (existing) {
        currentDayCache = existing;
    } else {
        currentDayCache = createEmptyDay(currentDate);
        await upsertDay(currentDayCache);
        console.log(`Created Zeus Supabase daily record: ${currentDate}`);
    }

    initialized = true;
    return currentDayCache;
}

async function ensureInitialized() {
    if (!initialized || !currentDayCache) {
        await initializeRecordManager();
    }
}

async function rolloverIfNeeded() {
    await ensureInitialized();

    const currentDate = getEasternDate();

    if (currentDayCache.date === currentDate) {
        return currentDayCache;
    }

    const previousDate = currentDayCache.date;

    // The old day already lives permanently in Supabase. Persist one final
    // snapshot before switching the in-memory cache to the new Eastern day.
    await upsertDay(currentDayCache);

    const existing = await fetchDay(currentDate);

    if (existing) {
        currentDayCache = existing;
    } else {
        currentDayCache = createEmptyDay(currentDate);
        await upsertDay(currentDayCache);
    }

    console.log(`Zeus daily record reset: ${previousDate} -> ${currentDate}`);
    return currentDayCache;
}

async function addPrediction(prediction) {
    const day = await rolloverIfNeeded();

    const record = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        timestamp: new Date().toISOString(),
        ...prediction
    };

    day.predictions.push(record);

    if (prediction.result === 'WIN') {
        day.wins += 1;
    } else if (prediction.result === 'LOSS') {
        day.losses += 1;
    } else if (prediction.result === 'SKIP') {
        day.skips += 1;
    } else {
        throw new Error(
            `Invalid prediction result: ${prediction.result}. Expected WIN, LOSS, or SKIP.`
        );
    }

    await upsertDay(day);
    currentDayCache = day;

    return record;
}

async function recordWin(prediction = {}) {
    return addPrediction({
        ...prediction,
        result: 'WIN'
    });
}

async function recordLoss(prediction = {}) {
    return addPrediction({
        ...prediction,
        result: 'LOSS'
    });
}

async function recordSkip(prediction = {}) {
    return addPrediction({
        ...prediction,
        result: 'SKIP'
    });
}

async function getCurrentRecord() {
    return rolloverIfNeeded();
}

async function getHistory() {
    await ensureInitialized();

    const client = getSupabaseClient();
    const currentDate = getEasternDate();

    const response = await client.get(`/${TABLE_NAME}`, {
        params: {
            select: '*',
            date: `neq.${currentDate}`,
            order: 'date.asc'
        }
    });

    if (!Array.isArray(response.data)) {
        return [];
    }

    return response.data.map(row => normalizeDay(row, row.date));
}

async function getRecordSummary() {
    const current = await getCurrentRecord();

    return {
        date: current.date,
        timezone: current.timezone,
        wins: current.wins,
        losses: current.losses,
        skips: current.skips,
        totalPredictions: current.predictions.length,
        updatedAt: current.updatedAt
    };
}

async function flushRecordManager() {
    if (!initialized || !currentDayCache) {
        return;
    }

    await upsertDay(currentDayCache);
}

module.exports = {
    getEasternDate,
    initializeRecordManager,
    flushRecordManager,
    getCurrentRecord,
    getRecordSummary,
    getHistory,
    recordWin,
    recordLoss,
    recordSkip,
    addPrediction,
    rolloverIfNeeded
};
