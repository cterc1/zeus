'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');

const marketData = require('./marketData');
const cryptoPredictionMarket = require('./cryptoPredictionMarket');

const {
    calculateProbability
} = require('./probabilityEngine');

const {
    evaluateSignal
} = require('./signalEngine');

const {
    createPrediction,
    resolvePrediction,
    isPredictionExpired,
    getActivePrediction,
    getPrediction,
    getPredictions,
    getPredictionHistory,
    getPredictionSummary
} = require('./predictionEngine');

const {
    getRecordSummary,
    getHistory,
    recordWin,
    recordLoss,
    recordSkip,
    rolloverIfNeeded,
    initializeRecordManager,
    flushRecordManager
} = require('./recordManager');


/*
============================================================
                    ZEUS CORE ENGINE
============================================================

Market Data
     ↓
Crypto.com Real BTC 15-Minute Contract
     ↓
Current Round Confirmation
     ↓
Previous Round + Current Confirmation
     ↓
Probability Engine
     ↓
Signal Engine
     ↓
Paper Prediction
     ↓
Crypto.com Strike Settlement
     ↓
Record Manager

IMPORTANT:
- PAPER MODE ONLY
- NO REAL-MONEY TRADING
- NO ORDER PLACEMENT
- REAL CRYPTO.COM CONTRACT DATA IS READ-ONLY
============================================================
*/


/*
============================================================
                    EXPRESS SERVER
============================================================
*/

const app = express();

const PORT =
    process.env.PORT ||
    3000;

app.use(express.json());

const publicDirectory =
    path.join(
        __dirname,
        'public'
    );

app.use(
    express.static(
        publicDirectory
    )
);


/*
============================================================
                    ZEUS CONFIGURATION
============================================================
*/

const CONFIG = {

    /*
    Check active predictions and market state every 5 sec.
    */
    predictionCheckIntervalMs:
        5000,

    /*
    Informational decision interval.
    The hard per-round protection below is still authoritative.
    */
    decisionIntervalMs:
        60000,

    /*
    Hard duplicate protection.
    */
    minimumDecisionGapMs:
        55000,

    /*
    Crypto.com rounds are 15 minutes.
    */
    roundDurationMs:
        15 * 60 * 1000,

    /*
    Zeus waits two minutes after the actual contract
    opens before evaluating the current round.
    */
    currentConfirmationDurationMs:
        2 * 60 * 1000,

    /*
    Require at least 15 five-second observations.
    */
    minConfirmationSamples:
        15,

    /*
    Normal model:
    70% previous completed round
    30% current confirmation
    */
    previousRoundWeight:
        0.70,

    currentRoundWeight:
        0.30,

    /*
    Maximum number of in-memory completed rounds.
    */
    completedRoundLimit:
        20,

    /*
    Do not create a paper prediction without a real
    Crypto.com contract and strike.
    */
    requireCryptoContract:
        true
};


/*
============================================================
                    ENGINE STATE
============================================================
*/

const engineState = {

    running:
        false,

    startedAt:
        null,

    lastTickAt:
        null,

    lastDecisionAt:
        null,

    lastDecision:
        null,

    lastMarketSnapshot:
        null,

    lastProbability:
        null,

    lastSignal:
        null,

    lastPredictionResult:
        null,

    lastResolution:
        null,

    lastError:
        null,

    /*
    Current Crypto.com contract.
    */
    cryptoMarket:
        null,

    /*
    Current synchronized round.
    */
    currentRound:
        null,

    /*
    Frozen two-minute confirmation.
    */
    currentConfirmation:
        null,

    /*
    Completed round feature snapshots.
    */
    completedRounds:
        [],

    /*
    Current waiting / pending state.
    */
    pendingDecision:
        null
};


let engineTimer =
    null;

let shuttingDown =
    false;


/*
============================================================
                    UTILITY FUNCTIONS
============================================================
*/

function safeNumber(
    value,
    fallback = null
) {

    if (
        value === null ||
        value === undefined ||
        value === ''
    ) {
        return fallback;
    }

    const number =
        Number(value);

    return Number.isFinite(number)
        ? number
        : fallback;
}


function clamp(
    value,
    min,
    max
) {

    const number =
        safeNumber(
            value,
            min
        );

    return Math.min(
        max,
        Math.max(
            min,
            number
        )
    );
}


function average(
    values
) {

    const clean =
        values.filter(
            value =>
                Number.isFinite(
                    Number(value)
                )
        );

    if (
        clean.length === 0
    ) {
        return null;
    }

    return (
        clean.reduce(
            (
                sum,
                value
            ) =>
                sum +
                Number(value),
            0
        ) /
        clean.length
    );
}


function formatPrice(
    value
) {

    const number =
        safeNumber(
            value,
            null
        );

    if (
        number === null
    ) {
        return 'WAITING';
    }

    return number.toFixed(2);
}


function getFeatureQuality(
    snapshot
) {

    return clamp(
        snapshot?.features?.quality?.features ??
        snapshot?.featureQuality ??
        0,
        0,
        100
    );
}


function getDataQuality(
    snapshot
) {

    return clamp(
        snapshot?.dataQuality ??
        snapshot?.features?.quality?.data ??
        0,
        0,
        100
    );
}


/*
============================================================
          CRYPTO.COM MARKET SOURCE HELPER
============================================================
*/

function getCryptoMarket() {

    /*
    First try the live feed.
    */

    try {

        const liveMarket =
            cryptoPredictionMarket.getMarket();

        if (
            liveMarket
        ) {

            return liveMarket;
        }

    } catch (error) {

        /*
        Keep going to the cached market below.
        */
    }


    /*
    If the feed momentarily returns null, use the last
    valid market stored by Zeus.

    This prevents a temporary polling gap from making the
    dashboard suddenly display "--" while the same contract
    is still known.
    */

    return (
        engineState.cryptoMarket ||
        null
    );
}


/*
============================================================
        CRYPTO.COM MARKET NORMALIZATION
============================================================
*/

function parseTimestampMs(
    value
) {

    if (
        value === null ||
        value === undefined ||
        value === ''
    ) {
        return null;
    }


    const numeric =
        safeNumber(
            value,
            null
        );


    /*
    Numeric timestamps can be seconds or milliseconds.
    */
    if (
        numeric !== null
    ) {

        if (
            numeric > 100000000000
        ) {
            return numeric;
        }

        if (
            numeric > 1000000000
        ) {
            return numeric * 1000;
        }

        return null;
    }


    const parsed =
        new Date(
            value
        ).getTime();


    return Number.isFinite(
        parsed
    )
        ? parsed
        : null;
}


function normalizeCryptoMarket(
    market
) {

    if (
        !market
    ) {
        return null;
    }


    /*
    --------------------------------------------------------
    STRIKE
    --------------------------------------------------------
    */

    const strike =
        safeNumber(
            market.strike ??
            market.strikePrice ??
            market.threshold ??
            null,
            null
        );


    /*
    --------------------------------------------------------
    OPEN / CLOSE TIMESTAMPS
    --------------------------------------------------------
    */

    const openMs =
        parseTimestampMs(
            market.openTimestampMs ??
            market.openTimestamp ??
            market.startTimestampMs ??
            market.startTimestamp ??
            market.openTime ??
            market.startTime ??
            null
        );


    const closeMs =
        parseTimestampMs(
            market.closeTimestampMs ??
            market.closeTimestamp ??
            market.endTimestampMs ??
            market.endTimestamp ??
            market.closeTime ??
            market.endTime ??
            null
        );


    /*
    --------------------------------------------------------
    OPEN / CLOSE ISO VALUES
    --------------------------------------------------------
    */

    const openTime =
        openMs !== null
            ? new Date(
                openMs
            ).toISOString()
            : (
                market.openTime ||
                market.startTime ||
                null
            );


    const closeTime =
        closeMs !== null
            ? new Date(
                closeMs
            ).toISOString()
            : (
                market.closeTime ||
                market.endTime ||
                null
            );


    /*
    --------------------------------------------------------
    CURRENT TIME STATE
    --------------------------------------------------------
    */

    const now =
        Date.now();


    const activeByTime =
        openMs !== null &&
        closeMs !== null &&
        now >= openMs &&
        now < closeMs;


    const secondsRemaining =
        closeMs !== null
            ? Math.max(
                0,
                Math.ceil(
                    (
                        closeMs -
                        now
                    ) /
                    1000
                )
            )
            : null;


    /*
    --------------------------------------------------------
    OPERATOR
    --------------------------------------------------------
    */

    const strikeOperator =
        market.strikeOperator ??
        market.operator ??
        market.strikeOperatorSymbol ??
        null;


    /*
    --------------------------------------------------------
    CONTRACT IDENTIFIER
    --------------------------------------------------------
    */

    const symbol =
        market.symbol ??
        market.contractSymbol ??
        market.instrumentName ??
        null;


    const contractId =
        market.contractId ??
        market.id ??
        null;


    /*
    --------------------------------------------------------
    ACTIVE STATE
    --------------------------------------------------------
    */

    const explicitlyInactive =
        market.active === false ||
        market.isActive === false;


    const active =
        explicitlyInactive
            ? false
            : (
                market.active === true
                    ? true
                    : activeByTime
            );


    return {

        ...market,

        symbol,

        contractId,

        strike,

        strikeAvailable:
            strike !== null &&
            strike > 0,

        strikeOperator,

        openTimestampMs:
            openMs,

        closeTimestampMs:
            closeMs,

        openTime,

        closeTime,

        active,

        secondsRemaining,

        durationMinutes:
            openMs !== null &&
            closeMs !== null
                ? (
                    (
                        closeMs -
                        openMs
                    ) /
                    60000
                )
                : safeNumber(
                    market.durationMinutes,
                    null
                ),

        status:
            active
                ? 'ACTIVE'
                : (
                    closeMs !== null &&
                    now >= closeMs
                        ? 'CLOSED'
                        : (
                            openMs !== null &&
                            now < openMs
                                ? 'UPCOMING'
                                : (
                                    market.status ??
                                    'UNKNOWN'
                                )
                        )
                )
    };
}


function isCryptoMarketUsable(
    market
) {

    if (
        !market
    ) {
        return false;
    }

    if (
        !market.strikeAvailable
    ) {
        return false;
    }

    if (
        market.openTimestampMs === null ||
        market.closeTimestampMs === null
    ) {
        return false;
    }

    const now =
        Date.now();


    return (
        now >=
            market.openTimestampMs &&
        now <
            market.closeTimestampMs
    );
}


function getCryptoRoundId(
    market
) {

    if (
        !market
    ) {
        return null;
    }

    if (
        market.symbol
    ) {
        return String(
            market.symbol
        );
    }

    if (
        market.contractId
    ) {
        return String(
            market.contractId
        );
    }

    if (
        market.closeTimestampMs
    ) {
        return `BTC-${market.closeTimestampMs}`;
    }

    return null;
}


/*
============================================================
      ADAPT MARKET DATA TO PROBABILITY ENGINE
============================================================
*/

function buildProbabilitySnapshot(
    snapshot
) {

    if (
        !snapshot
    ) {
        return null;
    }

    const sourceFeatures =
        snapshot.features ||
        {};

    const momentum =
        sourceFeatures.momentum ||
        {};

    const orderBook =
        sourceFeatures.orderBook ||
        {};

    const tradePressure =
        sourceFeatures.tradePressure ||
        {};

    const volatility =
        sourceFeatures.volatility ||
        {};

    const spread =
        sourceFeatures.spread ||
        {};

    const crossExchange =
        sourceFeatures.crossExchange ||
        {};

    const depths =
        orderBook.depths ||
        {};

    const pressure15 =
        tradePressure[15] ||
        {};

    const pressure30 =
        tradePressure[30] ||
        {};

    const pressure60 =
        tradePressure[60] ||
        {};


    const probabilityFeatures = {

        /*
        --------------------------------------------------------
        MOMENTUM
        --------------------------------------------------------
        */

        momentum15:
            momentum.movement15s ??
            null,

        momentum30:
            momentum.movement30s ??
            null,

        momentum60:
            momentum.movement60s ??
            null,

        momentum180:
            momentum.movement180s ??
            null,

        momentum300:
            momentum.movement300s ??
            null,

        movement15:
            momentum.movement15s ??
            null,

        movement30:
            momentum.movement30s ??
            null,

        movement60:
            momentum.movement60s ??
            null,

        movement180:
            momentum.movement180s ??
            null,

        movement300:
            momentum.movement300s ??
            null,

        shortTermAcceleration:
            momentum.shortTermAcceleration ??
            null,


        /*
        --------------------------------------------------------
        ORDER BOOK
        --------------------------------------------------------
        */

        orderBookImbalance:
            snapshot.orderBook?.combined?.imbalance ??
            orderBook.combined?.imbalance ??
            null,

        bookImbalance:
            snapshot.orderBook?.combined?.imbalance ??
            orderBook.combined?.imbalance ??
            null,

        imbalance5:
            depths[5]?.imbalance ??
            null,

        imbalance10:
            depths[10]?.imbalance ??
            null,

        imbalance25:
            depths[25]?.imbalance ??
            null,

        fiveLevelImbalance:
            depths[5]?.imbalance ??
            null,

        tenLevelImbalance:
            depths[10]?.imbalance ??
            null,

        twentyFiveLevelImbalance:
            depths[25]?.imbalance ??
            null,


        /*
        --------------------------------------------------------
        TRADE PRESSURE
        --------------------------------------------------------
        */

        tradeImbalance15:
            pressure15.imbalance ??
            null,

        tradeImbalance30:
            pressure30.imbalance ??
            null,

        tradeImbalance60:
            pressure60.imbalance ??
            null,

        tradePressure15s:
            pressure15,

        tradePressure30s:
            pressure30,

        tradePressure60s:
            pressure60,


        /*
        --------------------------------------------------------
        VOLATILITY
        --------------------------------------------------------
        */

        realizedVolatility15:
            volatility.realized15s ??
            null,

        realizedVolatility30:
            volatility.realized30s ??
            null,

        realizedVolatility60:
            volatility.realized60s ??
            null,

        volatility15:
            volatility.realized15s ??
            null,

        volatility30:
            volatility.realized30s ??
            null,

        volatility60:
            volatility.realized60s ??
            null,


        /*
        --------------------------------------------------------
        MICROSTRUCTURE
        --------------------------------------------------------
        */

        averageSpreadPercent:
            spread.averageSpreadPercent ??
            null,

        averageSpreadPct:
            spread.averageSpreadPercent ??
            null,

        spreadPercent:
            spread.averageSpreadPercent ??
            null,

        coinbaseSpread:
            spread.exchanges?.coinbase?.spread ??
            null,

        krakenSpread:
            spread.exchanges?.kraken?.spread ??
            null,

        crossExchangeDifferencePercent:
            crossExchange.priceDifferencePercent ??
            null,

        crossExchangeDifferencePct:
            crossExchange.priceDifferencePercent ??
            null,

        exchangeDifferencePercent:
            crossExchange.priceDifferencePercent ??
            null
    };


    return {

        ...snapshot,

        featureQuality:
            getFeatureQuality(
                snapshot
            ),

        dataQuality:
            getDataQuality(
                snapshot
            ),

        movements:
            snapshot.movements ||
            {},

        orderBook:
            snapshot.orderBook ||
            {},

        trades: {

            ...(snapshot.trades || {}),

            recent15s:
                pressure15,

            recent30s:
                pressure30,

            recent60s:
                pressure60
        },

        volatility:
            snapshot.volatility ||
            {},

        features:
            probabilityFeatures
    };
}


/*
============================================================
          FLATTEN NUMERIC FEATURES FOR SAMPLING
============================================================
*/

function flattenNumericFeatures(
    object,
    output = {},
    prefix = ''
) {

    if (
        object === null ||
        object === undefined
    ) {
        return output;
    }

    if (
        typeof object !== 'object'
    ) {

        const number =
            safeNumber(
                object,
                null
            );

        if (
            number !== null &&
            prefix
        ) {

            output[prefix] =
                number;
        }

        return output;
    }

    if (
        Array.isArray(object)
    ) {
        return output;
    }


    for (
        const [
            key,
            value
        ] of Object.entries(
            object
        )
    ) {

        if (
            key === 'timestamp' ||
            key === 'time' ||
            key === 'date'
        ) {
            continue;
        }


        const nextPrefix =
            prefix
                ? `${prefix}.${key}`
                : key;


        if (
            typeof value ===
            'number'
        ) {

            if (
                Number.isFinite(
                    value
                )
            ) {

                output[nextPrefix] =
                    value;
            }

            continue;
        }


        if (
            typeof value ===
            'object' &&
            value !== null
        ) {

            flattenNumericFeatures(
                value,
                output,
                nextPrefix
            );
        }
    }


    return output;
}


/*
============================================================
        ROUND SAMPLE COLLECTION
============================================================
*/

function createRoundContainer(
    market,
    snapshot
) {

    const roundId =
        getCryptoRoundId(
            market
        );


    return {

        id:
            roundId,

        symbol:
            market?.symbol ||
            null,

        contractId:
            market?.contractId ||
            null,

        strike:
            market?.strike ??
            null,

        strikeOperator:
            market?.strikeOperator ??
            null,

        openTime:
            market?.openTime ??
            null,

        closeTime:
            market?.closeTime ??
            null,

        openTimestampMs:
            market?.openTimestampMs ??
            null,

        closeTimestampMs:
            market?.closeTimestampMs ??
            null,

        samples:
            [],

        frozen:
            false,

        frozenAt:
            null,

        featureSnapshot:
            null,

        dataQuality:
            null,

        featureQuality:
            null,

        firstPrice:
            safeNumber(
                snapshot?.price,
                null
            ),

        lastPrice:
            safeNumber(
                snapshot?.price,
                null
            ),

        createdAt:
            new Date().toISOString(),

        updatedAt:
            new Date().toISOString()
    };
}


function collectRoundSample(
    round,
    snapshot
) {

    if (
        !round ||
        !snapshot
    ) {
        return;
    }

    /*
    The first two-minute confirmation may be frozen for the
    current-round decision, but the round itself must continue
    collecting samples until the Crypto.com contract closes.

    This allows the NEXT round to use a genuinely completed
    previous 15-minute round instead of only the previous
    two-minute confirmation.
    */


    const adapted =
        buildProbabilitySnapshot(
            snapshot
        );


    const numeric =
        flattenNumericFeatures(
            adapted?.features ||
            {}
        );


    round.samples.push({

        timestamp:
            Date.now(),

        price:
            safeNumber(
                snapshot.price,
                null
            ),

        features:
            numeric,

        dataQuality:
            getDataQuality(
                snapshot
            ),

        featureQuality:
            getFeatureQuality(
                snapshot
            )
    });


    round.lastPrice =
        safeNumber(
            snapshot.price,
            round.lastPrice
        );


    round.updatedAt =
        new Date().toISOString();
}


function averageSampleFeatures(
    samples
) {

    const buckets =
        {};


    for (
        const sample of
        samples
    ) {

        for (
            const [
                key,
                value
            ] of Object.entries(
                sample.features ||
                {}
            )
        ) {

            if (
                !Number.isFinite(
                    Number(value)
                )
            ) {
                continue;
            }


            if (
                !buckets[key]
            ) {
                buckets[key] =
                    [];
            }


            buckets[key].push(
                Number(value)
            );
        }
    }


    const result =
        {};


    for (
        const [
            key,
            values
        ] of Object.entries(
            buckets
        )
    ) {

        const mean =
            average(
                values
            );


        if (
            mean !== null
        ) {

            result[key] =
                mean;
        }
    }


    return result;
}


function buildRoundDecisionSnapshot(
    round
) {

    if (
        !round ||
        !round.samples?.length
    ) {
        return null;
    }


    const featureValues =
        averageSampleFeatures(
            round.samples
        );


    const dataQuality =
        average(
            round.samples.map(
                sample =>
                    safeNumber(
                        sample.dataQuality,
                        null
                    )
            )
        );


    const featureQuality =
        average(
            round.samples.map(
                sample =>
                    safeNumber(
                        sample.featureQuality,
                        null
                    )
            )
        );


    return {

        timestamp:
            Date.now(),

        price:
            round.lastPrice,

        dataQuality:
            dataQuality ??
            0,

        featureQuality:
            featureQuality ??
            0,

        features:
            featureValues,

        source:
            'ZEUS_ROUND_AVERAGE',

        sampleCount:
            round.samples.length,

        roundId:
            round.id,

        strike:
            round.strike,

        strikeOperator:
            round.strikeOperator,

        cryptoMarket: {

            available:
                true,

            symbol:
                round.symbol,

            contractId:
                round.contractId,

            strike:
                round.strike,

            strikeAvailable:
                round.strike !== null,

            strikeOperator:
                round.strikeOperator,

            openTime:
                round.openTime,

            closeTime:
                round.closeTime,

            openTimestampMs:
                round.openTimestampMs,

            closeTimestampMs:
                round.closeTimestampMs
        }
    };
}


/*
============================================================
          FREEZE CURRENT 2-MINUTE CONFIRMATION
============================================================
*/

function captureCurrentConfirmation(
    round
) {

    if (
        !round
    ) {
        return null;
    }


    if (
        round.frozen
    ) {

        return (
            round.featureSnapshot ||
            null
        );
    }


    const now =
        Date.now();


    if (
        round.openTimestampMs === null
    ) {
        return null;
    }


    const elapsed =
        now -
        round.openTimestampMs;


    /*
    Do not evaluate immediately when a contract opens.
    */

    if (
        elapsed <
        CONFIG.currentConfirmationDurationMs
    ) {
        return null;
    }


    /*
    Require the minimum number of actual observations.
    */

    if (
        round.samples.length <
        CONFIG.minConfirmationSamples
    ) {
        return null;
    }


    const snapshot =
        buildRoundDecisionSnapshot(
            round
        );


    if (
        !snapshot
    ) {
        return null;
    }


    round.frozen =
        true;


    round.frozenAt =
        new Date().toISOString();


    round.featureSnapshot =
        snapshot;


    console.log('');

    console.log(
        '=================================================='
    );

    console.log(
        '          ZEUS CURRENT ROUND CONFIRMED'
    );

    console.log(
        '=================================================='
    );

    console.log(
        `Samples: ${
            snapshot.sampleCount
        }`
    );

    console.log(
        `Data Quality: ${
            snapshot.dataQuality.toFixed(2)
        }%`
    );

    console.log(
        `Feature Quality: ${
            snapshot.featureQuality.toFixed(2)
        }%`
    );

    console.log(
        `BTC: $${
            formatPrice(
                snapshot.price
            )
        }`
    );

    console.log(
        'Confirmation: READY'
    );

    console.log(
        '=================================================='
    );


    return snapshot;
}


/*
============================================================
              WEIGHTED ROUND COMBINATION
============================================================
*/

function combineFeatureObjects(
    previousFeatures,
    currentFeatures,
    previousWeight,
    currentWeight
) {

    const keys =
        new Set([
            ...Object.keys(
                previousFeatures ||
                {}
            ),
            ...Object.keys(
                currentFeatures ||
                {}
            )
        ]);


    const result =
        {};


    for (
        const key of keys
    ) {

        const previous =
            safeNumber(
                previousFeatures?.[key],
                null
            );

        const current =
            safeNumber(
                currentFeatures?.[key],
                null
            );


        if (
            previous !== null &&
            current !== null
        ) {

            result[key] =
                (
                    previous *
                    previousWeight
                ) +
                (
                    current *
                    currentWeight
                );

        } else if (
            current !== null
        ) {

            result[key] =
                current;

        } else if (
            previous !== null
        ) {

            result[key] =
                previous;
        }
    }


    return result;
}


function buildWeightedCombinedSnapshot(
    previousRound,
    currentConfirmation
) {

    if (
        !previousRound ||
        !currentConfirmation
    ) {
        return null;
    }


    const previousWeight =
        CONFIG.previousRoundWeight;

    const currentWeight =
        CONFIG.currentRoundWeight;


    const previousFeatures =
        previousRound.features ||
        {};

    const currentFeatures =
        currentConfirmation.features ||
        {};


    const dataQuality =
        (
            safeNumber(
                previousRound.dataQuality,
                0
            ) *
            previousWeight
        ) +
        (
            safeNumber(
                currentConfirmation.dataQuality,
                0
            ) *
            currentWeight
        );


    const featureQuality =
        (
            safeNumber(
                previousRound.featureQuality,
                0
            ) *
            previousWeight
        ) +
        (
            safeNumber(
                currentConfirmation.featureQuality,
                0
            ) *
            currentWeight
        );


    return {

        timestamp:
            Date.now(),

        price:
            currentConfirmation.price,

        dataQuality:
            clamp(
                dataQuality,
                0,
                100
            ),

        featureQuality:
            clamp(
                featureQuality,
                0,
                100
            ),

        features:
            combineFeatureObjects(
                previousFeatures,
                currentFeatures,
                previousWeight,
                currentWeight
            ),

        source:
            '15M_PREVIOUS_PLUS_2M_CURRENT',

        previousRoundId:
            previousRound.id ||
            null,

        currentRoundId:
            currentConfirmation.roundId ||
            null,

        sampleCount:
            safeNumber(
                previousRound.sampleCount,
                0
            ) +
            safeNumber(
                currentConfirmation.sampleCount,
                0
            ),

        cryptoMarket:
            currentConfirmation.cryptoMarket ||
            null,

        strike:
            currentConfirmation.strike ??
            currentConfirmation.cryptoMarket?.strike ??
            null,

        strikeOperator:
            currentConfirmation.strikeOperator ??
            currentConfirmation.cryptoMarket?.strikeOperator ??
            null
    };
}


/*
============================================================
                BOOTSTRAP SNAPSHOT
============================================================
*/

function buildBootstrapSnapshot(
    currentConfirmation
) {

    if (
        !currentConfirmation
    ) {
        return null;
    }


    return {

        ...currentConfirmation,

        source:
            'BOOTSTRAP_CURRENT_2M',

        previousRoundId:
            null,

        currentRoundId:
            currentConfirmation.roundId ||
            null,

        bootstrap:
            true
    };
}


/*
============================================================
          SAVE COMPLETED ROUND SNAPSHOT
============================================================
*/

function saveCompletedRound(
    snapshot
) {

    if (
        !snapshot
    ) {
        return;
    }


    const id =
        snapshot.roundId ||
        snapshot.id ||
        snapshot.currentRoundId ||
        null;


    if (
        !id
    ) {
        return;
    }


    if (
        engineState.completedRounds.some(
            round =>
                round.id === id
        )
    ) {
        return;
    }


    engineState.completedRounds.push({

        id,

        features:
            snapshot.features ||
            {},

        dataQuality:
            safeNumber(
                snapshot.dataQuality,
                0
            ),

        featureQuality:
            safeNumber(
                snapshot.featureQuality,
                0
            ),

        price:
            safeNumber(
                snapshot.price,
                null
            ),

        sampleCount:
            safeNumber(
                snapshot.sampleCount,
                0
            ),

        strike:
            snapshot.strike ??
            snapshot.cryptoMarket?.strike ??
            null,

        strikeOperator:
            snapshot.strikeOperator ??
            snapshot.cryptoMarket?.strikeOperator ??
            null,

        closeTime:
            snapshot.closeTime ??
            snapshot.cryptoMarket?.closeTime ??
            null,

        createdAt:
            new Date().toISOString()
    });


    while (
        engineState.completedRounds.length >
        CONFIG.completedRoundLimit
    ) {

        engineState.completedRounds.shift();
    }
}


/*
============================================================
              GET PREVIOUS ROUND
============================================================
*/

function getPreviousRound(
    currentRoundId
) {

    const rounds =
        engineState.completedRounds;


    for (
        let i =
            rounds.length - 1;
        i >= 0;
        i--
    ) {

        if (
            rounds[i].id !==
            currentRoundId
        ) {

            return rounds[i];
        }
    }


    return null;
}


/*
============================================================
              SYNC CRYPTO.COM ROUND
============================================================
*/

function syncCryptoRound(
    snapshot,
    market
) {

    if (
        !market
    ) {
        return null;
    }


    const roundId =
        getCryptoRoundId(
            market
        );


    if (
        !roundId
    ) {
        return null;
    }


    /*
    New contract detected.
    */

    if (
        !engineState.currentRound ||
        engineState.currentRound.id !==
            roundId
    ) {

        /*
        Preserve the genuinely completed previous round.

        The first two-minute confirmation remains frozen for the
        previous round's own decision, while samples continue to
        accumulate for the full contract. At transition, build a
        fresh average from all collected samples and save that as
        the previous completed round used by the next decision.
        */

        if (
            engineState.currentRound &&
            engineState.currentRound.samples?.length
        ) {

            const completedRoundSnapshot =
                buildRoundDecisionSnapshot(
                    engineState.currentRound
                );

            if (
                completedRoundSnapshot
            ) {

                saveCompletedRound(
                    completedRoundSnapshot
                );
            }
        }


        engineState.currentRound =
            createRoundContainer(
                market,
                snapshot
            );


        engineState.currentConfirmation =
            null;


        engineState.pendingDecision = {

            status:
                'COLLECTING_CONFIRMATION',

            reason:
                'NEW_CRYPTO_COM_ROUND',

            roundId,

            contract:
                market.symbol ||
                market.contractId ||
                null,

            strike:
                market.strike,

            strikeOperator:
                market.strikeOperator,

            samples:
                0,

            requiredSamples:
                CONFIG.minConfirmationSamples,

            confirmationSeconds:
                CONFIG.currentConfirmationDurationMs /
                1000,

            timestamp:
                new Date().toISOString()
        };


        console.log('');

        console.log(
            '=================================================='
        );

        console.log(
            '           ZEUS NEW CRYPTO.COM ROUND'
        );

        console.log(
            '=================================================='
        );

        console.log(
            `Contract: ${
                market.symbol ||
                market.contractId ||
                'UNKNOWN'
            }`
        );

        console.log(
            `Strike: ${
                market.strike !== null
                    ? `$${market.strike.toFixed(2)}`
                    : 'UNAVAILABLE'
            }`
        );

        console.log(
            `Operator: ${
                market.strikeOperator ||
                'UNKNOWN'
            }`
        );

        console.log(
            `Open: ${
                market.openTime ||
                'UNKNOWN'
            }`
        );

        console.log(
            `Close: ${
                market.closeTime ||
                'UNKNOWN'
            }`
        );

        console.log(
            'Status: COLLECTING 2-MINUTE CONFIRMATION'
        );

        console.log(
            `Required samples: ${
                CONFIG.minConfirmationSamples
            }`
        );

        console.log(
            '=================================================='
        );
    }


    return engineState.currentRound;
}


/*
============================================================
                RECORD PREDICTION RESULT
============================================================
*/

async function recordPredictionResult(
    resolvedPrediction
) {

    if (
        !resolvedPrediction
    ) {
        return null;
    }


    const prediction =
        resolvedPrediction;


    const metadata = {

        paper:
            true,

        predictionId:
            prediction.id,

        direction:
            prediction.direction,

        entryPrice:
            prediction.entryPrice,

        exitPrice:
            prediction.exitPrice,

        finalPrice:
            prediction.exitPrice,

        confidence:
            prediction.confidence,

        probabilityEdge:
            prediction.probabilityEdge,

        featureQuality:
            prediction.featureQuality,

        dataQuality:
            prediction.dataQuality,

        priceChange:
            prediction.priceChange,

        priceChangePercent:
            prediction.priceChangePercent,

        strikePrice:
            prediction.strikePrice ??
            null,

        strikeOperator:
            prediction.strikeOperator ??
            null,

        settlementType:
            prediction.settlementType ??
            null,

        cryptoContractSymbol:
            prediction.cryptoContractSymbol ??
            null,

        note:
            `Paper prediction ${prediction.id}`
    };


    if (
        prediction.result ===
        'WIN'
    ) {

        const record =
            await recordWin(
                metadata
            );


        console.log('');

        console.log(
            '******** ZEUS PAPER WIN ********'
        );

        console.log(
            `Prediction: ${prediction.id}`
        );

        console.log(
            `Direction: ${prediction.direction}`
        );

        console.log(
            `Entry: $${prediction.entryPrice}`
        );

        console.log(
            `Final: $${prediction.exitPrice}`
        );


        if (
            prediction.strikePrice !==
            null &&
            prediction.strikePrice !==
            undefined
        ) {

            console.log(
                `Strike: $${prediction.strikePrice}`
            );

            console.log(
                `Operator: ${
                    prediction.strikeOperator ||
                    'UNKNOWN'
                }`
            );
        }


        console.log(
            'Record manager: WIN recorded.'
        );

        console.log(
            '********************************'
        );


        return record;
    }


    if (
        prediction.result ===
        'LOSS'
    ) {

        const record =
            await recordLoss(
                metadata
            );


        console.log('');

        console.log(
            '******** ZEUS PAPER LOSS ********'
        );

        console.log(
            `Prediction: ${prediction.id}`
        );

        console.log(
            `Direction: ${prediction.direction}`
        );

        console.log(
            `Entry: $${prediction.entryPrice}`
        );

        console.log(
            `Final: $${prediction.exitPrice}`
        );


        if (
            prediction.strikePrice !==
            null &&
            prediction.strikePrice !==
            undefined
        ) {

            console.log(
                `Strike: $${prediction.strikePrice}`
            );

            console.log(
                `Operator: ${
                    prediction.strikeOperator ||
                    'UNKNOWN'
                }`
            );
        }


        console.log(
            'Record manager: LOSS recorded.'
        );

        console.log(
            '*********************************'
        );


        return record;
    }


    /*
    PUSH is intentionally not recorded as WIN or LOSS.
    */

    if (
        prediction.result ===
        'PUSH'
    ) {

        console.log('');

        console.log(
            '******** ZEUS PAPER PUSH ********'
        );

        console.log(
            `Prediction: ${prediction.id}`
        );

        console.log(
            `Entry: $${prediction.entryPrice}`
        );

        console.log(
            `Final: $${prediction.exitPrice}`
        );

        console.log(
            'No WIN or LOSS recorded.'
        );

        console.log(
            '*********************************'
        );
    }


    return null;
}


/*
============================================================
            RESOLVE ACTIVE PREDICTION
============================================================
*/

async function checkActivePrediction() {

    const active =
        getActivePrediction();


    if (
        !active
    ) {
        return null;
    }


    const now =
        new Date();


    if (
        !isPredictionExpired(
            active,
            now
        )
    ) {
        return null;
    }


    const snapshot =
        marketData.getMarketSnapshot();


    const finalPrice =
        safeNumber(
            snapshot?.price,
            null
        );


    if (
        finalPrice === null ||
        finalPrice <= 0
    ) {

        console.log(
            'Prediction expired, but no valid final price is available yet.'
        );

        return null;
    }


    console.log('');

    console.log(
        '=============================================='
    );

    console.log(
        '       ZEUS PREDICTION EXPIRATION'
    );

    console.log(
        '=============================================='
    );

    console.log(
        `Prediction: ${active.id}`
    );

    console.log(
        `Direction: ${active.direction}`
    );

    console.log(
        `Entry Price: $${active.entryPrice}`
    );

    console.log(
        `Final Price: $${finalPrice}`
    );


    if (
        active.strikePrice !==
        null &&
        active.strikePrice !==
        undefined
    ) {

        console.log(
            `Crypto.com Strike: $${active.strikePrice}`
        );

        console.log(
            `Operator: ${
                active.strikeOperator ||
                'UNKNOWN'
            }`
        );

        console.log(
            `Contract: ${
                active.cryptoContractSymbol ||
                'UNKNOWN'
            }`
        );
    }


    const result =
        resolvePrediction(
            active.id,
            finalPrice,
            now
        );


    if (
        !result ||
        !result.resolved
    ) {

        console.error(
            'Unable to resolve prediction:',
            result?.reason ||
            'UNKNOWN'
        );

        return null;
    }


    engineState.lastResolution =
        result.prediction;


    await recordPredictionResult(
        result.prediction
    );


    console.log(
        `Result: ${
            result.prediction.result
        }`
    );

    console.log(
        '=============================================='
    );


    return result.prediction;
}


/*
============================================================
                CREATE DECISION SNAPSHOT
============================================================
*/

function getDecisionSnapshot() {

    const market =
        normalizeCryptoMarket(
            getCryptoMarket()
        );


    if (
        CONFIG.requireCryptoContract &&
        !isCryptoMarketUsable(
            market
        )
    ) {

        return {

            ready:
                false,

            reason:
                !market
                    ? 'CRYPTO_COM_CONTRACT_UNAVAILABLE'
                    : !market.strikeAvailable
                        ? 'CRYPTO_COM_STRIKE_UNAVAILABLE'
                        : 'CRYPTO_COM_CONTRACT_NOT_CURRENT',

            market
        };
    }


    const currentRound =
        engineState.currentRound;


    if (
        !currentRound
    ) {

        return {

            ready:
                false,

            reason:
                'NO_CURRENT_ROUND',

            market
        };
    }


    if (
        !engineState.currentConfirmation
    ) {

        return {

            ready:
                false,

            reason:
                'CURRENT_2M_CONFIRMATION_NOT_READY',

            market
        };
    }


    const currentId =
        currentRound.id;


    /*
    Prefer a genuinely completed previous round.
    */

    const previous =
        getPreviousRound(
            currentId
        );


    if (
        previous
    ) {

        const combined =
            buildWeightedCombinedSnapshot(
                previous,
                engineState.currentConfirmation
            );


        if (
            combined
        ) {

            return {

                ready:
                    true,

                mode:
                    '15M_PREVIOUS_PLUS_2M_CURRENT',

                snapshot:
                    combined,

                market,

                previousRound:
                    previous,

                currentConfirmation:
                    engineState.currentConfirmation
            };
        }
    }


    /*
    BOOTSTRAP MODE

    No previous completed round exists.
    */

    const bootstrap =
        buildBootstrapSnapshot(
            engineState.currentConfirmation
        );


    if (
        bootstrap
    ) {

        return {

            ready:
                true,

            mode:
                'BOOTSTRAP_CURRENT_2M',

            snapshot:
                bootstrap,

            market,

            previousRound:
                null,

            currentConfirmation:
                engineState.currentConfirmation
        };
    }


    return {

        ready:
            false,

        reason:
            'DECISION_SNAPSHOT_UNAVAILABLE',

        market
    };
}


/*
============================================================
                    MAKE DECISION
============================================================
*/

async function makeDecision() {

    const now =
        Date.now();


    /*
    Do not decide too frequently.
    */

    if (
        engineState.lastDecisionAt &&
        (
            now -
            engineState.lastDecisionAt
        ) <
        CONFIG.minimumDecisionGapMs
    ) {

        return null;
    }


    /*
    Never create another prediction while one is active.
    */

    if (
        getActivePrediction()
    ) {

        return null;
    }


    await rolloverIfNeeded();


    const liveSnapshot =
        marketData.getMarketSnapshot();


    engineState.lastMarketSnapshot =
        liveSnapshot;


    if (
        !liveSnapshot
    ) {

        engineState.pendingDecision = {

            status:
                'WAITING',

            reason:
                'MARKET_SNAPSHOT_UNAVAILABLE',

            timestamp:
                new Date().toISOString()
        };

        return null;
    }


    const decision =
        getDecisionSnapshot();


    if (
        !decision.ready
    ) {

        engineState.pendingDecision = {

            status:
                'WAITING',

            reason:
                decision.reason,

            cryptoMarket:
                decision.market ||
                null,

            dataQuality:
                getDataQuality(
                    liveSnapshot
                ),

            featureQuality:
                getFeatureQuality(
                    liveSnapshot
                ),

            timestamp:
                new Date().toISOString()
        };


        engineState.lastDecision = {

            timestamp:
                new Date(
                    now
                ).toISOString(),

            price:
                liveSnapshot.price,

            mode:
                decision.reason,

            cryptoMarket:
                decision.market ||
                null,

            dataQuality:
                getDataQuality(
                    liveSnapshot
                ),

            featureQuality:
                getFeatureQuality(
                    liveSnapshot
                ),

            probability:
                null,

            signal:
                {
                    signal:
                        'SKIP',

                    reason:
                        decision.reason
                }
        };


        return null;
    }


    /*
    decision.snapshot is already in the flat probability-feature
    schema because each raw market sample was adapted before it
    was stored and averaged.

    Do NOT pass it through buildProbabilitySnapshot() again.
    A second adaptation looks for the original nested market-data
    structure and turns the already-averaged flat features into
    null values.
    */

    const adaptedSnapshot = {

        ...decision.snapshot,

        features: {
            ...(decision.snapshot.features || {})
        }
    };


    if (
        !adaptedSnapshot
    ) {

        engineState.pendingDecision = {

            status:
                'WAITING',

            reason:
                'PROBABILITY_SNAPSHOT_UNAVAILABLE',

            timestamp:
                new Date().toISOString()
        };

        return null;
    }


    /*
    Keep the REAL Crypto.com contract information attached
    to the exact snapshot used by the prediction.
    */

    adaptedSnapshot.cryptoMarket =
        decision.market;

    adaptedSnapshot.strike =
        decision.market.strike;

    adaptedSnapshot.strikeOperator =
        decision.market.strikeOperator;


    const probability =
        calculateProbability(
            adaptedSnapshot
        );


    /*
    Preserve actual quality values.
    */

    probability.dataQuality =
        safeNumber(
            decision.snapshot.dataQuality,
            getDataQuality(
                liveSnapshot
            )
        );


    probability.featureQuality =
        safeNumber(
            decision.snapshot.featureQuality,
            getFeatureQuality(
                liveSnapshot
            )
        );


    const signal =
        evaluateSignal(
            probability
        );


    engineState.lastProbability =
        probability;

    engineState.lastSignal =
        signal;

    engineState.lastDecisionAt =
        now;


    engineState.lastDecision = {

        timestamp:
            new Date(
                now
            ).toISOString(),

        price:
            liveSnapshot.price,

        mode:
            decision.mode,

        source:
            decision.snapshot.source,

        previousRoundId:
            decision.previousRound?.id ||
            null,

        currentRoundId:
            decision.currentConfirmation?.roundId ||
            null,

        cryptoMarket:
            decision.market,

        strike:
            decision.market.strike,

        strikeOperator:
            decision.market.strikeOperator,

        contract:
            decision.market.symbol ||
            decision.market.contractId ||
            null,

        dataQuality:
            probability.dataQuality,

        featureQuality:
            probability.featureQuality,

        probability,

        signal
    };


    engineState.pendingDecision = {

        status:
            signal.signal === 'SKIP'
                ? 'SIGNAL_REJECTED'
                : 'PREDICTION_READY',

        reason:
            signal.reason,

        signal:
            signal.signal,

        strength:
            signal.strength,

        roundId:
            decision.currentConfirmation?.roundId ||
            null,

        contract:
            decision.market.symbol ||
            decision.market.contractId ||
            null,

        strike:
            decision.market.strike,

        strikeOperator:
            decision.market.strikeOperator,

        timestamp:
            new Date().toISOString()
    };


    console.log('');

    console.log(
        '=================================================='
    );

    console.log(
        '              ZEUS LIVE DECISION'
    );

    console.log(
        '=================================================='
    );

    console.log(
        `Mode: ${decision.mode}`
    );

    console.log(
        `BTC: $${formatPrice(
            liveSnapshot.price
        )}`
    );

    console.log(
        `Data Quality: ${
            probability.dataQuality
        }%`
    );

    console.log(
        `Feature Quality: ${
            probability.featureQuality
        }%`
    );

    console.log(
        `UP Probability: ${
            probability.upProbability
        }%`
    );

    console.log(
        `DOWN Probability: ${
            probability.downProbability
        }%`
    );

    console.log(
        `Confidence: ${
            probability.confidence
        }%`
    );

    console.log(
        `Conflict: ${
            probability.conflict?.level ||
            'UNKNOWN'
        } (${
            probability.conflict?.score ??
            0
        })`
    );

    console.log(
        `Signal: ${
            signal.signal
        }`
    );

    console.log(
        `Strength: ${
            signal.strength
        }`
    );

    console.log(
        `Reason: ${
            signal.reason
        }`
    );


    /*
    Print diagnostics from the newer signal engine.
    */

    if (
        signal.diagnostics
    ) {

        console.log(
            `Failed Filters: ${
                signal.diagnostics.failedFilters?.length
                    ? signal.diagnostics.failedFilters
                        .map(
                            failure =>
                                `${failure.filter}: ${failure.reason}`
                        )
                        .join(', ')
                    : 'NONE'
            }`
        );
    }


    console.log(
        `Crypto.com Contract: ${
            decision.market.symbol ||
            decision.market.contractId ||
            'UNKNOWN'
        }`
    );

    console.log(
        `Crypto.com Strike: $${
            decision.market.strike.toFixed(2)
        }`
    );

    console.log(
        `Crypto.com Operator: ${
            decision.market.strikeOperator ||
            'UNKNOWN'
        }`
    );

    console.log(
        '--------------------------------------------------'
    );


    /*
    ========================================================
    SKIP
    ========================================================
    */

    if (
        signal.signal ===
        'SKIP'
    ) {

        console.log(
            'ZEUS DECISION: SKIP'
        );

        console.log(
            'No paper prediction created.'
        );


        try {

            await recordSkip({

                paper:
                    true,

                price:
                    liveSnapshot.price,

                upProbability:
                    probability.upProbability,

                downProbability:
                    probability.downProbability,

                confidence:
                    probability.confidence,

                featureQuality:
                    probability.featureQuality,

                dataQuality:
                    probability.dataQuality,

                reason:
                    signal.reason,

                mode:
                    decision.mode,

                contract:
                    decision.market.symbol ||
                    decision.market.contractId ||
                    null,

                strike:
                    decision.market.strike,

                strikeOperator:
                    decision.market.strikeOperator,

                note:
                    'Zeus live decision skipped'
            });

        } catch (error) {

            console.error(
                'Unable to record SKIP:',
                error
            );
        }


        console.log(
            '=================================================='
        );


        return signal;
    }


    /*
    ========================================================
    CREATE PAPER PREDICTION
    ========================================================
    */

    const predictionSnapshot = {

        ...liveSnapshot,

        cryptoMarket:
            decision.market,

        strike:
            decision.market.strike,

        strikeOperator:
            decision.market.strikeOperator,

        cryptoContractSymbol:
            decision.market.symbol ||
            decision.market.contractId ||
            null,

        cryptoMarketOpenTime:
            decision.market.openTime,

        cryptoMarketCloseTime:
            decision.market.closeTime,

        decisionMode:
            decision.mode,

        decisionSource:
            decision.snapshot.source,

        previousRoundId:
            decision.previousRound?.id ||
            null,

        currentRoundId:
            decision.currentConfirmation?.roundId ||
            null
    };


    const predictionResult =
        createPrediction(
            signal,
            predictionSnapshot
        );


    engineState.lastPredictionResult =
        predictionResult;


    if (
        !predictionResult ||
        !predictionResult.created
    ) {

        engineState.pendingDecision = {

            status:
                'PREDICTION_NOT_CREATED',

            reason:
                predictionResult?.reason ||
                'UNKNOWN',

            timestamp:
                new Date().toISOString()
        };


        console.log(
            `Prediction not created: ${
                predictionResult?.reason ||
                'UNKNOWN'
            }`
        );

        console.log(
            '=================================================='
        );


        return predictionResult;
    }


    const prediction =
        predictionResult.prediction;


    engineState.pendingDecision = {

        status:
            'PREDICTION_ACTIVE',

        reason:
            'PAPER_PREDICTION_CREATED',

        predictionId:
            prediction.id,

        roundId:
            decision.currentConfirmation?.roundId ||
            null,

        contract:
            decision.market.symbol ||
            decision.market.contractId ||
            null,

        strike:
            decision.market.strike,

        strikeOperator:
            decision.market.strikeOperator,

        timestamp:
            new Date().toISOString()
    };


    console.log(
        'ZEUS DECISION: PAPER PREDICTION CREATED'
    );

    console.log(
        `ID: ${
            prediction.id
        }`
    );

    console.log(
        `Direction: ${
            prediction.direction
        }`
    );

    console.log(
        `Strength: ${
            prediction.strength
        }`
    );

    console.log(
        `Entry Price: $${
            prediction.entryPrice
        }`
    );

    console.log(
        `Entry Time: ${
            prediction.entryTime
        }`
    );

    console.log(
        `Expiration: ${
            prediction.expirationTime
        }`
    );

    console.log(
        `Settlement: ${
            prediction.settlementType ||
            'PRICE_DIRECTION'
        }`
    );

    console.log(
        `Crypto.com Contract: ${
            prediction.cryptoContractSymbol ||
            decision.market.symbol ||
            'UNKNOWN'
        }`
    );

    console.log(
        `Strike: ${
            prediction.strikePrice !== null &&
            prediction.strikePrice !== undefined
                ? `$${prediction.strikePrice}`
                : 'UNKNOWN'
        }`
    );

    console.log(
        `Operator: ${
            prediction.strikeOperator ||
            decision.market.strikeOperator ||
            'UNKNOWN'
        }`
    );

    console.log(
        'NO REAL TRADE WAS PLACED.'
    );

    console.log(
        '=================================================='
    );


    return predictionResult;
}


/*
============================================================
                    MAIN ENGINE TICK
============================================================
*/

async function engineTick() {

    if (
        !engineState.running
    ) {
        return;
    }


    try {

        await rolloverIfNeeded();


        engineState.lastTickAt =
            new Date().toISOString();


        /*
        --------------------------------------------------------
        1. Resolve any expired paper prediction first.
        --------------------------------------------------------
        */

        await checkActivePrediction();


        /*
        --------------------------------------------------------
        2. Read the live exchange market snapshot.
        --------------------------------------------------------
        */

        const snapshot =
            marketData.getMarketSnapshot();


        engineState.lastMarketSnapshot =
            snapshot;


        if (
            !snapshot
        ) {

            engineState.pendingDecision = {

                status:
                    'WAITING',

                reason:
                    'MARKET_SNAPSHOT_UNAVAILABLE',

                timestamp:
                    new Date().toISOString()
            };

            return;
        }


        /*
        --------------------------------------------------------
        3. Read the REAL Crypto.com contract.
        --------------------------------------------------------
        */

        const cryptoMarket =
            normalizeCryptoMarket(
                getCryptoMarket()
            );


        /*
        Only replace the cached contract when the normalized
        feed actually contains a usable contract object.
        */

        if (
            cryptoMarket
        ) {

            engineState.cryptoMarket =
                cryptoMarket;
        }


        const activeCryptoMarket =
            cryptoMarket ||
            engineState.cryptoMarket;


        /*
        --------------------------------------------------------
        4. Require a real active Crypto.com contract.
        --------------------------------------------------------
        */

        if (
            !isCryptoMarketUsable(
                activeCryptoMarket
            )
        ) {

            let waitingReason =
                'CRYPTO_COM_CONTRACT_UNAVAILABLE';


            if (
                activeCryptoMarket
            ) {

                if (
                    !activeCryptoMarket.strikeAvailable
                ) {

                    waitingReason =
                        'CRYPTO_COM_STRIKE_UNAVAILABLE';

                } else {

                    waitingReason =
                        activeCryptoMarket.openTimestampMs !== null &&
                        Date.now() <
                            activeCryptoMarket.openTimestampMs
                        ? 'CRYPTO_COM_CONTRACT_NOT_OPEN'
                        : 'CRYPTO_COM_CONTRACT_NOT_CURRENT';
                }
            }


            engineState.pendingDecision = {

                status:
                    'WAITING_FOR_CONTRACT',

                reason:
                    waitingReason,

                cryptoMarket:
                    activeCryptoMarket,

                dataQuality:
                    getDataQuality(
                        snapshot
                    ),

                featureQuality:
                    getFeatureQuality(
                        snapshot
                    ),

                timestamp:
                    new Date().toISOString()
            };


            engineState.lastDecision = {

                timestamp:
                    new Date().toISOString(),

                price:
                    snapshot.price,

                mode:
                    'WAITING_FOR_CRYPTO_COM_CONTRACT',

                waitingReason,

                cryptoMarket:
                    activeCryptoMarket,

                dataQuality:
                    getDataQuality(
                        snapshot
                    ),

                featureQuality:
                    getFeatureQuality(
                        snapshot
                    ),

                probability:
                    null,

                signal: {

                    signal:
                        'SKIP',

                    reason:
                        waitingReason
                }
            };


            return;
        }


        /*
        --------------------------------------------------------
        5. Sync current round.
        --------------------------------------------------------
        */

        const round =
            syncCryptoRound(
                snapshot,
                activeCryptoMarket
            );


        if (
            !round
        ) {

            engineState.pendingDecision = {

                status:
                    'WAITING',

                reason:
                    'ROUND_SYNC_FAILED',

                timestamp:
                    new Date().toISOString()
            };

            return;
        }


        /*
        --------------------------------------------------------
        6. Collect current five-second observation.
        --------------------------------------------------------
        */

        collectRoundSample(
            round,
            snapshot
        );


        /*
        --------------------------------------------------------
        7. Update confirmation progress.
        --------------------------------------------------------
        */

        const elapsedMs =
            Date.now() -
            (
                round.openTimestampMs ??
                Date.now()
            );


        const elapsedSeconds =
            Math.max(
                0,
                Math.floor(
                    elapsedMs /
                    1000
                )
            );


        if (
            !round.frozen
        ) {

            engineState.pendingDecision = {

                status:
                    'COLLECTING_CONFIRMATION',

                reason:
                    'CURRENT_2M_CONFIRMATION_NOT_READY',

                roundId:
                    round.id,

                contract:
                    activeCryptoMarket.symbol ||
                    activeCryptoMarket.contractId ||
                    null,

                strike:
                    activeCryptoMarket.strike,

                strikeOperator:
                    activeCryptoMarket.strikeOperator,

                samples:
                    round.samples.length,

                requiredSamples:
                    CONFIG.minConfirmationSamples,

                elapsedSeconds,

                requiredSeconds:
                    CONFIG.currentConfirmationDurationMs /
                    1000,

                secondsUntilConfirmation:
                    Math.max(
                        0,
                        Math.ceil(
                            (
                                CONFIG.currentConfirmationDurationMs -
                                elapsedMs
                            ) /
                            1000
                        )
                    ),

                dataQuality:
                    getDataQuality(
                        snapshot
                    ),

                featureQuality:
                    getFeatureQuality(
                        snapshot
                    ),

                timestamp:
                    new Date().toISOString()
            };
        }


        /*
        --------------------------------------------------------
        8. Freeze the 2-minute confirmation once ready.
        --------------------------------------------------------
        */

        const confirmation =
            captureCurrentConfirmation(
                round
            );


        if (
            confirmation
        ) {

            engineState.currentConfirmation =
                confirmation;
        }


        /*
        --------------------------------------------------------
        9. Do not decide until current confirmation is frozen.
        --------------------------------------------------------
        */

        if (
            !engineState.currentConfirmation
        ) {

            return;
        }


        /*
        --------------------------------------------------------
        10. Do not create multiple predictions while active.
        --------------------------------------------------------
        */

        const active =
            getActivePrediction();


        if (
            active
        ) {

            engineState.pendingDecision = {

                status:
                    'PREDICTION_ACTIVE',

                reason:
                    'ACTIVE_PREDICTION_EXISTS',

                predictionId:
                    active.id,

                roundId:
                    round.id,

                contract:
                    activeCryptoMarket.symbol ||
                    activeCryptoMarket.contractId ||
                    null,

                timestamp:
                    new Date().toISOString()
            };

            return;
        }


        /*
        --------------------------------------------------------
        11. Do not evaluate the same Crypto.com contract twice.
        --------------------------------------------------------
        */

        const lastDecisionRoundId =
            engineState.lastDecision?.currentRoundId ||
            null;


        if (
            lastDecisionRoundId ===
            round.id
        ) {

            engineState.pendingDecision = {

                status:
                    'ROUND_ALREADY_EVALUATED',

                reason:
                    'CURRENT_CRYPTO_COM_ROUND_ALREADY_DECIDED',

                roundId:
                    round.id,

                contract:
                    activeCryptoMarket.symbol ||
                    activeCryptoMarket.contractId ||
                    null,

                timestamp:
                    new Date().toISOString()
            };

            return;
        }


        /*
        --------------------------------------------------------
        12. Make the decision.
        --------------------------------------------------------
        */

        await makeDecision();


        engineState.lastError =
            null;


    } catch (error) {

        engineState.lastError = {

            message:
                error.message,

            stack:
                error.stack,

            timestamp:
                new Date().toISOString()
        };


        engineState.pendingDecision = {

            status:
                'ERROR',

            reason:
                error.message,

            timestamp:
                new Date().toISOString()
        };


        console.error(
            'ZEUS ENGINE ERROR:',
            error
        );
    }
}


/*
============================================================
                    START ENGINE
============================================================
*/

async function startEngine() {

    if (
        engineState.running
    ) {
        return;
    }


    engineState.running =
        true;

    engineState.startedAt =
        new Date().toISOString();

    shuttingDown =
        false;


    console.log('');

    console.log(
        '=================================================='
    );

    console.log(
        '              ZEUS CORE ENGINE STARTING'
    );

    console.log(
        '=================================================='
    );

    console.log(
        'Market Data: INITIALIZING'
    );

    console.log(
        'Crypto.com Contract Feed: INITIALIZING'
    );

    console.log(
        'Probability Engine: ENABLED'
    );

    console.log(
        'Signal Engine: ENABLED'
    );

    console.log(
        'Prediction Engine: PAPER MODE'
    );

    console.log(
        'Record Manager: ENABLED'
    );

    console.log(
        'Real Trading: DISABLED'
    );

    console.log(
        'Round Model: 70% PREVIOUS + 30% CURRENT'
    );

    console.log(
        'Bootstrap Model: CURRENT 2-MINUTE ONLY'
    );

    console.log(
        'Confirmation: 2 MINUTES / 15 SAMPLES'
    );

    console.log(
        '=================================================='
    );


    /*
    Start live exchange feeds.
    */

    marketData.start();


    /*
    Start read-only Crypto.com prediction market feed.
    */

    try {

        cryptoPredictionMarket.start();

    } catch (error) {

        engineState.lastError = {

            source:
                'CRYPTO_COM_START',

            message:
                error.message,

            timestamp:
                new Date().toISOString()
        };

        console.error(
            'Unable to start Crypto.com market feed:',
            error.message
        );
    }


    /*
    Run Zeus every five seconds.
    */

    engineTimer =
        setInterval(
            engineTick,
            CONFIG.predictionCheckIntervalMs
        );


    /*
    Initial delayed tick.
    */

    setTimeout(
        () => {

            try {

                engineTick();

            } catch (error) {

                console.error(
                    'Initial Zeus tick failed:',
                    error
                );
            }

        },
        3000
    );
}


/*
============================================================
                    STOP ENGINE
============================================================
*/

function stopEngine() {

    if (
        !engineState.running &&
        !engineTimer
    ) {
        return;
    }


    engineState.running =
        false;


    if (
        engineTimer
    ) {

        clearInterval(
            engineTimer
        );

        engineTimer =
            null;
    }


    try {

        marketData.stop();

    } catch (error) {

        console.error(
            'Unable to stop market data:',
            error.message
        );
    }


    try {

        cryptoPredictionMarket.stop();

    } catch (error) {

        console.error(
            'Unable to stop Crypto.com market feed:',
            error.message
        );
    }


    console.log(
        'ZEUS core engine stopped.'
    );
}


/*
============================================================
                    API: ROOT
============================================================
*/

app.get(
    '/',
    (
        req,
        res
    ) => {

        res.sendFile(
            path.join(
                publicDirectory,
                'index.html'
            )
        );
    }
);


/*
============================================================
                    API: STATUS
============================================================
*/

app.get(
    '/api/status',
    async (
        req,
        res
    ) => {

        await rolloverIfNeeded();


        const records =
            await getRecordSummary();


        const active =
            getActivePrediction();


        const predictionSummary =
            getPredictionSummary();


        const liveCryptoMarket =
            normalizeCryptoMarket(
                getCryptoMarket()
            );


        if (
            liveCryptoMarket
        ) {

            engineState.cryptoMarket =
                liveCryptoMarket;
        }


        const cryptoMarket =
            liveCryptoMarket ||
            engineState.cryptoMarket;


        res.json({

            bot:
                'Zeus',

            status:
                engineState.running
                    ? 'ONLINE'
                    : 'OFFLINE',

            mode:
                'PAPER',

            trading:
                'DISABLED',


            records,


            engine: {

                running:
                    engineState.running,

                startedAt:
                    engineState.startedAt,

                lastTickAt:
                    engineState.lastTickAt,

                lastDecisionAt:
                    engineState.lastDecisionAt,

                lastError:
                    engineState.lastError,

                pendingDecision:
                    engineState.pendingDecision,

                currentRound:
                    engineState.currentRound
                        ? {

                            id:
                                engineState.currentRound.id,

                            contract:
                                engineState.currentRound.symbol ||
                                engineState.currentRound.contractId ||
                                null,

                            strike:
                                engineState.currentRound.strike,

                            strikeOperator:
                                engineState.currentRound.strikeOperator,

                            openTime:
                                engineState.currentRound.openTime,

                            closeTime:
                                engineState.currentRound.closeTime,

                            samples:
                                engineState.currentRound.samples.length,

                            requiredSamples:
                                CONFIG.minConfirmationSamples,

                            frozen:
                                engineState.currentRound.frozen,

                            frozenAt:
                                engineState.currentRound.frozenAt,

                            confirmationReady:
                                Boolean(
                                    engineState.currentConfirmation
                                )
                        }
                        : null,

                completedRoundCount:
                    engineState.completedRounds.length
            },


            market: {

                price:
                    engineState.lastMarketSnapshot?.price ??
                    null,

                dataQuality:
                    engineState.lastMarketSnapshot?.dataQuality ??
                    null,

                featureQuality:
                    engineState.lastMarketSnapshot?.features?.quality?.features ??
                    null
            },


            /*
            ----------------------------------------------------
            CRYPTO.COM

            IMPORTANT:
            Both nested market data and top-level fields are
            provided for dashboard compatibility.
            ----------------------------------------------------
            */

            cryptoCom: {

                market:
                    cryptoMarket ||
                    null,

                connected:
                    Boolean(
                        cryptoMarket
                    ),

                active:
                    Boolean(
                        isCryptoMarketUsable(
                            cryptoMarket
                        )
                    ),

                source:
                    cryptoMarket?.source ??
                    null,

                contract:
                    cryptoMarket?.symbol ??
                    cryptoMarket?.contractId ??
                    null,

                title:
                    cryptoMarket?.title ??
                    cryptoMarket?.displayName ??
                    null,

                strike:
                    cryptoMarket?.strike ??
                    null,

                strikeAvailable:
                    cryptoMarket?.strikeAvailable ??
                    false,

                strikeOperator:
                    cryptoMarket?.strikeOperator ??
                    null,

                openTime:
                    cryptoMarket?.openTime ??
                    null,

                closeTime:
                    cryptoMarket?.closeTime ??
                    null,

                openTimestampMs:
                    cryptoMarket?.openTimestampMs ??
                    null,

                closeTimestampMs:
                    cryptoMarket?.closeTimestampMs ??
                    null,

                secondsRemaining:
                    cryptoMarket?.secondsRemaining ??
                    null,

                durationMinutes:
                    cryptoMarket?.durationMinutes ??
                    null,

                activeByTime:
                    Boolean(
                        cryptoMarket?.active
                    ),

                tradable:
                    cryptoMarket?.tradable ??
                    false,

                status:
                    cryptoMarket?.status ??
                    null,

                feed:
                    cryptoPredictionMarket.getStatus()
            },


            prediction: {

                active,

                summary:
                    predictionSummary
            },


            decision:
                engineState.lastDecision,


            resolution:
                engineState.lastResolution,


            timestamp:
                new Date().toISOString()
        });
    }
);


/*
============================================================
                    API: RECORDS
============================================================
*/

app.get(
    '/api/records',
    async (
        req,
        res
    ) => {

        await rolloverIfNeeded();

        res.json(
            await getRecordSummary()
        );
    }
);


/*
============================================================
                    API: HISTORY
============================================================
*/

app.get(
    '/api/history',
    async (
        req,
        res
    ) => {

        const history =
            await getHistory();

        res.json({

            count:
                history.length,

            history
        });
    }
);


/*
============================================================
                    API: MARKET
============================================================
*/

app.get(
    '/api/market',
    (
        req,
        res
    ) => {

        const snapshot =
            marketData.getMarketSnapshot();


        engineState.lastMarketSnapshot =
            snapshot;


        res.json(
            snapshot
        );
    }
);


/*
============================================================
                    API: CRYPTO.COM
============================================================
*/

app.get(
    '/api/crypto',
    (
        req,
        res
    ) => {

        const liveMarket =
            normalizeCryptoMarket(
                getCryptoMarket()
            );


        if (
            liveMarket
        ) {

            engineState.cryptoMarket =
                liveMarket;
        }


        const market =
            liveMarket ||
            engineState.cryptoMarket;


        res.json({

            market,

            active:
                Boolean(
                    isCryptoMarketUsable(
                        market
                    )
                ),

            status:
                market?.status ??
                null,

            waitingReason:
                isCryptoMarketUsable(
                    market
                )
                    ? null
                    : (
                        !market
                            ? 'CRYPTO_COM_CONTRACT_UNAVAILABLE'
                            : !market.strikeAvailable
                                ? 'CRYPTO_COM_STRIKE_UNAVAILABLE'
                                : market.openTimestampMs !== null &&
                                  Date.now() <
                                      market.openTimestampMs
                                    ? 'CRYPTO_COM_CONTRACT_NOT_OPEN'
                                    : 'CRYPTO_COM_CONTRACT_NOT_CURRENT'
                    ),

            timestamp:
                new Date().toISOString()
        });
    }
);


/*
============================================================
                    API: ROUND
============================================================
*/

app.get(
    '/api/round',
    (
        req,
        res
    ) => {

        const market =
            normalizeCryptoMarket(
                getCryptoMarket()
            );


        if (
            market
        ) {

            engineState.cryptoMarket =
                market;
        }


        const activeMarket =
            market ||
            engineState.cryptoMarket;


        const round =
            engineState.currentRound;


        const now =
            Date.now();


        let elapsed =
            null;

        let remaining =
            null;


        if (
            activeMarket?.openTimestampMs !== null &&
            activeMarket?.openTimestampMs !== undefined
        ) {

            elapsed =
                Math.max(
                    0,
                    now -
                    activeMarket.openTimestampMs
                );
        }


        if (
            activeMarket?.closeTimestampMs !== null &&
            activeMarket?.closeTimestampMs !== undefined
        ) {

            remaining =
                Math.max(
                    0,
                    activeMarket.closeTimestampMs -
                    now
                );
        }


        const active =
            Boolean(
                isCryptoMarketUsable(
                    activeMarket
                )
            );


        res.json({

            id:
                round?.id ??
                getCryptoRoundId(
                    activeMarket
                ) ??
                null,

            contract:
                activeMarket?.symbol ??
                activeMarket?.contractId ??
                null,

            title:
                activeMarket?.title ??
                activeMarket?.displayName ??
                null,

            strike:
                activeMarket?.strike ??
                null,

            strikeOperator:
                activeMarket?.strikeOperator ??
                null,

            openTime:
                activeMarket?.openTime ??
                null,

            closeTime:
                activeMarket?.closeTime ??
                null,

            openTimestampMs:
                activeMarket?.openTimestampMs ??
                null,

            closeTimestampMs:
                activeMarket?.closeTimestampMs ??
                null,

            active,

            status:
                activeMarket?.status ??
                (
                    active
                        ? 'ACTIVE'
                        : 'WAITING'
                ),

            elapsedMs:
                elapsed,

            remainingMs:
                remaining,

            elapsedSeconds:
                elapsed !== null
                    ? Math.floor(
                        elapsed /
                        1000
                    )
                    : null,

            remainingSeconds:
                remaining !== null
                    ? Math.ceil(
                        remaining /
                        1000
                    )
                    : null,

            sampleCount:
                round?.samples?.length ??
                0,

            requiredSamples:
                CONFIG.minConfirmationSamples,

            confirmationDurationSeconds:
                CONFIG.currentConfirmationDurationMs /
                1000,

            confirmationReady:
                Boolean(
                    engineState.currentConfirmation
                ),

            confirmation:
                engineState.currentConfirmation
                    ? {

                        roundId:
                            engineState.currentConfirmation.roundId,

                        sampleCount:
                            engineState.currentConfirmation.sampleCount,

                        dataQuality:
                            engineState.currentConfirmation.dataQuality,

                        featureQuality:
                            engineState.currentConfirmation.featureQuality,

                        source:
                            engineState.currentConfirmation.source
                    }
                    : null,

            pendingDecision:
                engineState.pendingDecision,

            timestamp:
                new Date().toISOString()
        });
    }
);


/*
============================================================
                    API: PROBABILITY
============================================================
*/

app.get(
    '/api/probability',
    (
        req,
        res
    ) => {

        res.json(
            engineState.lastProbability ||
            {

                signal:
                    'SKIP',

                reason:
                    'NO_DECISION_YET'
            }
        );
    }
);


/*
============================================================
                    API: SIGNAL
============================================================
*/

app.get(
    '/api/signal',
    (
        req,
        res
    ) => {

        res.json(
            engineState.lastSignal ||
            {

                signal:
                    'SKIP',

                reason:
                    'NO_DECISION_YET'
            }
        );
    }
);


/*
============================================================
                    API: ACTIVE PREDICTION
============================================================
*/

app.get(
    '/api/prediction',
    (
        req,
        res
    ) => {

        res.json({

            active:
                getActivePrediction()
        });
    }
);


/*
============================================================
                    API: ALL PREDICTIONS
============================================================
*/

app.get(
    '/api/predictions',
    (
        req,
        res
    ) => {

        const predictions =
            getPredictions();


        res.json({

            count:
                predictions.length,

            predictions
        });
    }
);


/*
============================================================
                    API: PREDICTION HISTORY
============================================================
*/

app.get(
    '/api/predictions/history',
    (
        req,
        res
    ) => {

        const history =
            getPredictionHistory();


        res.json({

            count:
                history.length,

            history
        });
    }
);


/*
============================================================
                    API: PREDICTION SUMMARY
============================================================
*/

app.get(
    '/api/predictions/summary',
    (
        req,
        res
    ) => {

        res.json(
            getPredictionSummary()
        );
    }
);


/*
============================================================
                    API: ENGINE DEBUG
============================================================
*/

app.get(
    '/api/debug',
    (
        req,
        res
    ) => {

        res.json({

            config:
                CONFIG,

            state: {

                running:
                    engineState.running,

                startedAt:
                    engineState.startedAt,

                lastTickAt:
                    engineState.lastTickAt,

                lastDecisionAt:
                    engineState.lastDecisionAt,

                lastDecision:
                    engineState.lastDecision,

                pendingDecision:
                    engineState.pendingDecision,

                currentRound:
                    engineState.currentRound,

                currentConfirmation:
                    engineState.currentConfirmation,

                completedRounds:
                    engineState.completedRounds,

                cryptoMarket:
                    engineState.cryptoMarket,

                lastProbability:
                    engineState.lastProbability,

                lastSignal:
                    engineState.lastSignal,

                lastPredictionResult:
                    engineState.lastPredictionResult,

                lastResolution:
                    engineState.lastResolution,

                lastError:
                    engineState.lastError
            },

            timestamp:
                new Date().toISOString()
        });
    }
);


/*
============================================================
                    TEST: WIN
============================================================
*/

app.post(
    '/api/test/win',
    async (
        req,
        res
    ) => {

        try {

            const body =
                req.body ||
                {};


            const record =
                await recordWin({

                    test:
                        true,

                    contract:
                        body.contract ||
                        'TEST CONTRACT',

                    prediction:
                        body.prediction ||
                        'YES',

                    note:
                        body.note ||
                        'Test win'
                });


            res.json({

                success:
                    true,

                message:
                    'Test WIN recorded.',

                record
            });

        } catch (error) {

            console.error(
                'Unable to record test WIN:',
                error
            );


            res.status(
                500
            ).json({

                success:
                    false,

                error:
                    error.message
            });
        }
    }
);


/*
============================================================
                    TEST: LOSS
============================================================
*/

app.post(
    '/api/test/loss',
    async (
        req,
        res
    ) => {

        try {

            const body =
                req.body ||
                {};


            const record =
                await recordLoss({

                    test:
                        true,

                    contract:
                        body.contract ||
                        'TEST CONTRACT',

                    prediction:
                        body.prediction ||
                        'YES',

                    note:
                        body.note ||
                        'Test loss'
                });


            res.json({

                success:
                    true,

                message:
                    'Test LOSS recorded.',

                record
            });

        } catch (error) {

            console.error(
                'Unable to record test LOSS:',
                error
            );


            res.status(
                500
            ).json({

                success:
                    false,

                error:
                    error.message
            });
        }
    }
);


/*
============================================================
                    TEST: SKIP
============================================================
*/

app.post(
    '/api/test/skip',
    async (
        req,
        res
    ) => {

        try {

            const body =
                req.body ||
                {};


            const record =
                await recordSkip({

                    test:
                        true,

                    contract:
                        body.contract ||
                        'TEST CONTRACT',

                    prediction:
                        body.prediction ||
                        'NONE',

                    note:
                        body.note ||
                        'Test skip'
                });


            res.json({

                success:
                    true,

                message:
                    'Test SKIP recorded.',

                record
            });

        } catch (error) {

            console.error(
                'Unable to record test SKIP:',
                error
            );


            res.status(
                500
            ).json({

                success:
                    false,

                error:
                    error.message
            });
        }
    }
);


/*
============================================================
                    START SERVER
============================================================
*/

const server =
    app.listen(
        PORT,
        async () => {

            try {
                await initializeRecordManager();
            } catch (error) {
                console.error('Unable to initialize Supabase record manager:', error.message);
                console.error('Zeus will not start until the Supabase environment variables are configured.');
                return;
            }

            console.log('');

            console.log(
                '=================================================='
            );

            console.log(
                '                 ZEUS IS ONLINE'
            );

            console.log(
                '=================================================='
            );

            console.log(
                `Server running on port ${PORT}`
            );

            console.log(
                'Market data: INITIALIZED'
            );

            console.log(
                'Crypto.com prediction feed: READ-ONLY'
            );

            console.log(
                'Probability engine: INITIALIZED'
            );

            console.log(
                'Signal engine: INITIALIZED'
            );

            console.log(
                'Prediction engine: INITIALIZED'
            );

            console.log(
                'Record system: INITIALIZED'
            );

            console.log(
                'Trading mode: PAPER ONLY'
            );

            console.log(
                'Real trades: DISABLED'
            );

            console.log(
                'Dashboard: ENABLED'
            );

            console.log(
                '=================================================='
            );


            const records =
                await getRecordSummary();


            console.log('');

            console.log(
                "TODAY'S RECORD"
            );

            console.log(
                `Date:    ${records.date}`
            );

            console.log(
                `Wins:    ${records.wins}`
            );

            console.log(
                `Losses:  ${records.losses}`
            );

            console.log(
                `Skips:   ${records.skips}`
            );

            console.log(
                `Total:   ${records.totalPredictions}`
            );

            console.log(
                '=================================================='
            );


            await startEngine();
        }
    );


/*
============================================================
                    SHUTDOWN
============================================================
*/

function shutdown(
    signal
) {

    if (
        shuttingDown
    ) {
        return;
    }


    shuttingDown =
        true;


    console.log('');

    console.log(
        `ZEUS received ${signal}. Shutting down...`
    );


    stopEngine();


    server.close(
        () => {

            console.log(
                'ZEUS server stopped.'
            );

            process.exit(
                0
            );
        }
    );


    setTimeout(
        () => {

            process.exit(
                0
            );

        },
        2000
    );
}


process.on(
    'SIGINT',
    () => {

        shutdown(
            'SIGINT'
        );
    }
);


process.on(
    'SIGTERM',
    () => {

        shutdown(
            'SIGTERM'
        );
    }
);


/*
============================================================
                    EXPORTS
============================================================
*/

module.exports = {

    app,

    server,

    CONFIG,

    engineState,

    startEngine,

    stopEngine,

    engineTick,

    makeDecision,

    buildProbabilitySnapshot,

    buildWeightedCombinedSnapshot,

    buildBootstrapSnapshot,

    getCryptoMarket,

    normalizeCryptoMarket,

    isCryptoMarketUsable
};