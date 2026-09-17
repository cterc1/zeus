const fs = require("fs");
const path = require("path");

const DATA_DIRECTORY = path.join(__dirname, "data");
const HISTORY_DIRECTORY = path.join(DATA_DIRECTORY, "history");
const CURRENT_DAY_FILE = path.join(DATA_DIRECTORY, "current-day.json");

function ensureDirectories() {
    fs.mkdirSync(DATA_DIRECTORY, { recursive: true });
    fs.mkdirSync(HISTORY_DIRECTORY, { recursive: true });
}

function getEasternDate() {
    const formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    });

    return formatter.format(new Date());
}

function createEmptyDay(date) {
    return {
        date,
        timezone: "America/New_York",
        wins: 0,
        losses: 0,
        skips: 0,
        predictions: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
}

function readCurrentDay() {
    ensureDirectories();

    if (!fs.existsSync(CURRENT_DAY_FILE)) {
        const newDay = createEmptyDay(getEasternDate());
        writeCurrentDay(newDay);
        return newDay;
    }

    try {
        const contents = fs.readFileSync(CURRENT_DAY_FILE, "utf8");
        const day = JSON.parse(contents);

        if (!day || typeof day !== "object") {
            throw new Error("Current-day record is invalid.");
        }

        return day;
    } catch (error) {
        console.error("Unable to read current-day.json:", error.message);

        const newDay = createEmptyDay(getEasternDate());
        writeCurrentDay(newDay);
        return newDay;
    }
}

function writeCurrentDay(day) {
    ensureDirectories();

    day.updatedAt = new Date().toISOString();

    fs.writeFileSync(
        CURRENT_DAY_FILE,
        JSON.stringify(day, null, 2),
        "utf8"
    );
}

function archiveCurrentDay(day) {
    ensureDirectories();

    const archiveFile = path.join(
        HISTORY_DIRECTORY,
        `${day.date}.json`
    );

    if (!fs.existsSync(archiveFile)) {
        fs.writeFileSync(
            archiveFile,
            JSON.stringify(day, null, 2),
            "utf8"
        );

        console.log(`Archived Zeus daily record: ${day.date}`);
        return true;
    }

    return false;
}

function rolloverIfNeeded() {
    const currentDate = getEasternDate();
    const currentDay = readCurrentDay();

    if (currentDay.date === currentDate) {
        return currentDay;
    }

    archiveCurrentDay(currentDay);

    const newDay = createEmptyDay(currentDate);
    writeCurrentDay(newDay);

    console.log(
        `Zeus daily record reset: ${currentDay.date} -> ${currentDate}`
    );

    return newDay;
}

function addPrediction(prediction) {
    const day = rolloverIfNeeded();

    const record = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        timestamp: new Date().toISOString(),
        ...prediction
    };

    day.predictions.push(record);

    if (prediction.result === "WIN") {
        day.wins += 1;
    } else if (prediction.result === "LOSS") {
        day.losses += 1;
    } else if (prediction.result === "SKIP") {
        day.skips += 1;
    } else {
        throw new Error(
            `Invalid prediction result: ${prediction.result}. Expected WIN, LOSS, or SKIP.`
        );
    }

    writeCurrentDay(day);

    return record;
}

function recordWin(prediction = {}) {
    return addPrediction({
        ...prediction,
        result: "WIN"
    });
}

function recordLoss(prediction = {}) {
    return addPrediction({
        ...prediction,
        result: "LOSS"
    });
}

function recordSkip(prediction = {}) {
    return addPrediction({
        ...prediction,
        result: "SKIP"
    });
}

function getCurrentRecord() {
    return rolloverIfNeeded();
}

function getHistory() {
    ensureDirectories();

    const files = fs
        .readdirSync(HISTORY_DIRECTORY)
        .filter((file) => file.endsWith(".json"))
        .sort();

    return files.map((file) => {
        const filePath = path.join(HISTORY_DIRECTORY, file);

        try {
            return JSON.parse(fs.readFileSync(filePath, "utf8"));
        } catch (error) {
            console.error(
                `Unable to read archived record ${file}:`,
                error.message
            );

            return null;
        }
    }).filter(Boolean);
}

function getRecordSummary() {
    const current = getCurrentRecord();

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

ensureDirectories();

module.exports = {
    getEasternDate,
    getCurrentRecord,
    getRecordSummary,
    getHistory,
    recordWin,
    recordLoss,
    recordSkip,
    addPrediction,
    rolloverIfNeeded
};