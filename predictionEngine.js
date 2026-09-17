'use strict';

/*
============================================================
                 ZEUS PREDICTION ENGINE
============================================================

Purpose:
- Creates paper predictions from the Signal Engine
- Tracks active predictions
- Gives every prediction a unique ID
- Records entry price and entry time
- Calculates the 15-minute expiration time
- Resolves predictions using a supplied final price
- Does NOT place real trades

Flow:

Market Data
     ↓
Feature Engine
     ↓
Probability Engine
     ↓
Signal Engine
     ↓
Prediction Engine
     ↓
PAPER UP / PAPER DOWN / SKIP
============================================================
*/


const CONFIG = {
    // Prediction duration
    predictionDurationMs: 15 * 60 * 1000,

    // Prevent multiple active predictions at once
    allowMultipleActivePredictions: false,

    // Do not create predictions from SKIP signals
    allowSkipPredictions: false,

    // Minimum entry price required
    minimumPrice: 0
};


// ============================================================
// INTERNAL STATE
// ============================================================

const state = {
    predictions: [],
    activePrediction: null,
    nextPredictionNumber: 1
};


// ============================================================
// UTILITY FUNCTIONS
// ============================================================

function safeNumber(value, fallback = 0) {
    const number = Number(value);

    if (!Number.isFinite(number)) {
        return fallback;
    }

    return number;
}


function round(value, decimals = 8) {
    const factor = 10 ** decimals;

    return Math.round(value * factor) / factor;
}


function generatePredictionId() {
    const number =
        String(state.nextPredictionNumber).padStart(6, '0');

    state.nextPredictionNumber += 1;

    return `ZEUS-${number}`;
}


// ============================================================
// GET DIRECTION
// ============================================================

function getDirection(signalResult) {
    if (!signalResult) {
        return 'NEUTRAL';
    }

    const direction =
        String(signalResult.direction || '').toUpperCase();

    const signal =
        String(signalResult.signal || '').toUpperCase();

    if (
        direction === 'UP' ||
        signal === 'UP'
    ) {
        return 'UP';
    }

    if (
        direction === 'DOWN' ||
        signal === 'DOWN'
    ) {
        return 'DOWN';
    }

    return 'NEUTRAL';
}


// ============================================================
// CREATE PAPER PREDICTION
// ============================================================

function createPrediction(signalResult, marketSnapshot) {
    /*
    Validate signal result
    */

    if (!signalResult) {
        return {
            created: false,
            reason: 'NO_SIGNAL_RESULT'
        };
    }


    /*
    SKIP signals do not become predictions
    */

    const signal =
        String(signalResult.signal || '').toUpperCase();

    if (
        signal === 'SKIP' &&
        !CONFIG.allowSkipPredictions
    ) {
        return {
            created: false,
            reason: 'SIGNAL_IS_SKIP'
        };
    }


    /*
    Determine direction
    */

    const direction =
        getDirection(signalResult);

    if (direction === 'NEUTRAL') {
        return {
            created: false,
            reason: 'DIRECTION_NEUTRAL'
        };
    }


    /*
    Prevent duplicate active predictions
    */

    if (
        state.activePrediction &&
        !CONFIG.allowMultipleActivePredictions
    ) {
        return {
            created: false,
            reason: 'ACTIVE_PREDICTION_ALREADY_EXISTS',
            activePredictionId:
                state.activePrediction.id
        };
    }


    /*
    Get current market price
    */

    const price =
        safeNumber(
            marketSnapshot?.price,
            NaN
        );

    if (
        !Number.isFinite(price) ||
        price <= CONFIG.minimumPrice
    ) {
        return {
            created: false,
            reason: 'INVALID_ENTRY_PRICE'
        };
    }


    /*
    Capture timestamps
    */

    const entryTime = new Date();

    const marketExpiration = marketSnapshot?.cryptoMarket?.closeTime
        ? new Date(marketSnapshot.cryptoMarket.closeTime)
        : null;

    const expirationTime =
        marketExpiration && Number.isFinite(marketExpiration.getTime())
            ? marketExpiration
            : new Date(
                entryTime.getTime() +
                CONFIG.predictionDurationMs
            );


    /*
    Create unique ID
    */

    const id =
        generatePredictionId();


    /*
    Build prediction
    */

    const prediction = {
        id,

        status: 'ACTIVE',

        direction,

        signal: signalResult.signal,

        strength:
            signalResult.strength || 'UNKNOWN',

        entryPrice: round(price),

        settlementType:
            marketSnapshot?.cryptoMarket?.strike !== null &&
            marketSnapshot?.cryptoMarket?.strike !== undefined
                ? 'CRYPTO_COM_STRIKE'
                : 'PRICE_DIRECTION',

        strikePrice:
            marketSnapshot?.cryptoMarket?.strike !== null &&
            marketSnapshot?.cryptoMarket?.strike !== undefined
                ? round(Number(marketSnapshot.cryptoMarket.strike), 8)
                : null,

        strikeOperator:
            marketSnapshot?.cryptoMarket?.strikeOperator || null,

        cryptoContractSymbol:
            marketSnapshot?.cryptoMarket?.symbol || null,

        cryptoMarketOpenTime:
            marketSnapshot?.cryptoMarket?.openTime || null,

        cryptoMarketCloseTime:
            marketSnapshot?.cryptoMarket?.closeTime || null,

        entryTime:
            entryTime.toISOString(),

        expirationTime:
            expirationTime.toISOString(),

        upProbability:
            safeNumber(
                signalResult.upProbability,
                50
            ),

        downProbability:
            safeNumber(
                signalResult.downProbability,
                50
            ),

        confidence:
            safeNumber(
                signalResult.confidence,
                0
            ),

        featureQuality:
            safeNumber(
                signalResult.featureQuality,
                0
            ),

        dataQuality:
            safeNumber(
                signalResult.dataQuality,
                0
            ),

        probabilityEdge:
            safeNumber(
                signalResult.probabilityEdge,
                0
            ),

        conflict:
            safeNumber(
                signalResult.conflict,
                0
            ),

        reason:
            signalResult.reason ||
            'ALL_FILTERS_PASSED',

        exitPrice: null,

        exitTime: null,

        result: null,

        priceChange: null,

        priceChangePercent: null,

        durationMs: null
    };


    /*
    Store prediction
    */

    state.predictions.push(prediction);

    state.activePrediction =
        prediction;


    return {
        created: true,
        prediction
    };
}


// ============================================================
// RESOLVE PREDICTION
// ============================================================

function resolvePrediction(predictionId, finalPrice, resolutionTime = new Date()) {
    const prediction =
        state.predictions.find(
            item => item.id === predictionId
        );


    if (!prediction) {
        return {
            resolved: false,
            reason: 'PREDICTION_NOT_FOUND'
        };
    }


    if (prediction.status !== 'ACTIVE') {
        return {
            resolved: false,
            reason: 'PREDICTION_ALREADY_RESOLVED',
            prediction
        };
    }


    const exitPrice =
        safeNumber(
            finalPrice,
            NaN
        );


    if (
        !Number.isFinite(exitPrice) ||
        exitPrice <= CONFIG.minimumPrice
    ) {
        return {
            resolved: false,
            reason: 'INVALID_EXIT_PRICE'
        };
    }


    const exitDate =
        resolutionTime instanceof Date
            ? resolutionTime
            : new Date(resolutionTime);


    /*
    Calculate price movement
    */

    const priceChange =
        exitPrice -
        prediction.entryPrice;


    const priceChangePercent =
        prediction.entryPrice !== 0
            ? (
                priceChange /
                prediction.entryPrice
            ) * 100
            : 0;


    /*
    Determine result

    UP wins when final price > entry price.

    DOWN wins when final price < entry price.

    Exact same price = PUSH.
    */

    let result;

    if (
        prediction.settlementType === 'CRYPTO_COM_STRIKE' &&
        Number.isFinite(prediction.strikePrice)
    ) {
        const operator = prediction.strikeOperator || '>';
        let yesOutcome;

        if (operator === '>=') {
            yesOutcome = exitPrice >= prediction.strikePrice;
        } else if (operator === '=') {
            yesOutcome = exitPrice === prediction.strikePrice;
        } else if (operator === '<=') {
            yesOutcome = exitPrice <= prediction.strikePrice;
        } else if (operator === '<') {
            yesOutcome = exitPrice < prediction.strikePrice;
        } else {
            yesOutcome = exitPrice > prediction.strikePrice;
        }

        const predictedYes = prediction.direction === 'UP';
        result = yesOutcome === predictedYes ? 'WIN' : 'LOSS';
    } else if (exitPrice > prediction.entryPrice) {
        result =
            prediction.direction === 'UP'
                ? 'WIN'
                : 'LOSS';
    } else if (exitPrice < prediction.entryPrice) {
        result =
            prediction.direction === 'DOWN'
                ? 'WIN'
                : 'LOSS';
    } else {
        result = 'PUSH';
    }


    /*
    Update prediction
    */

    prediction.status =
        'RESOLVED';

    prediction.exitPrice =
        round(exitPrice);

    prediction.exitTime =
        exitDate.toISOString();

    prediction.result =
        result;

    prediction.priceChange =
        round(priceChange);

    prediction.priceChangePercent =
        round(
            priceChangePercent,
            6
        );

    prediction.durationMs =
        Math.max(
            0,
            exitDate.getTime() -
            new Date(
                prediction.entryTime
            ).getTime()
        );


    /*
    Clear active prediction
    */

    if (
        state.activePrediction &&
        state.activePrediction.id ===
        prediction.id
    ) {
        state.activePrediction = null;
    }


    return {
        resolved: true,
        prediction
    };
}


// ============================================================
// CHECK FOR EXPIRED PREDICTION
// ============================================================

function isPredictionExpired(
    prediction,
    now = new Date()
) {
    if (!prediction) {
        return false;
    }

    const expiration =
        new Date(
            prediction.expirationTime
        );

    const currentTime =
        now instanceof Date
            ? now
            : new Date(now);

    return (
        currentTime.getTime() >=
        expiration.getTime()
    );
}


// ============================================================
// GET ACTIVE PREDICTION
// ============================================================

function getActivePrediction() {
    return state.activePrediction;
}


// ============================================================
// GET PREDICTION BY ID
// ============================================================

function getPrediction(predictionId) {
    return (
        state.predictions.find(
            item =>
                item.id === predictionId
        ) || null
    );
}


// ============================================================
// GET ALL PREDICTIONS
// ============================================================

function getPredictions() {
    return [
        ...state.predictions
    ];
}


// ============================================================
// GET PREDICTION HISTORY
// ============================================================

function getPredictionHistory() {
    return state.predictions.filter(
        prediction =>
            prediction.status ===
            'RESOLVED'
    );
}


// ============================================================
// GET PREDICTION SUMMARY
// ============================================================

function getPredictionSummary() {
    const predictions =
        state.predictions;


    const resolved =
        predictions.filter(
            prediction =>
                prediction.status ===
                'RESOLVED'
        );


    const wins =
        resolved.filter(
            prediction =>
                prediction.result ===
                'WIN'
        ).length;


    const losses =
        resolved.filter(
            prediction =>
                prediction.result ===
                'LOSS'
        ).length;


    const pushes =
        resolved.filter(
            prediction =>
                prediction.result ===
                'PUSH'
        ).length;


    const active =
        predictions.filter(
            prediction =>
                prediction.status ===
                'ACTIVE'
        ).length;


    const totalResolved =
        wins +
        losses;


    const winRate =
        totalResolved > 0
            ? (
                wins /
                totalResolved
            ) * 100
            : 0;


    return {
        totalPredictions:
            predictions.length,

        active,

        resolved:
            resolved.length,

        wins,

        losses,

        pushes,

        winRate:
            round(winRate, 2)
    };
}


// ============================================================
// PRINT PREDICTION REPORT
// ============================================================

function printPredictionReport(result) {
    console.log('');
    console.log('==============================================');
    console.log('          ZEUS PREDICTION ENGINE');
    console.log('==============================================');


    if (!result) {
        console.log('No result.');
        console.log('==============================================');
        return;
    }


    if (!result.created) {
        console.log(
            `Created: NO`
        );

        console.log(
            `Reason: ${result.reason}`
        );


        if (result.activePredictionId) {
            console.log(
                `Active Prediction: ${
                    result.activePredictionId
                }`
            );
        }

        console.log('----------------------------------------------');
        console.log('No prediction created.');
        console.log('==============================================');

        return;
    }


    const prediction =
        result.prediction;


    console.log(
        `Created: YES`
    );

    console.log(
        `ID: ${prediction.id}`
    );

    console.log(
        `Status: ${prediction.status}`
    );

    console.log(
        `Direction: ${prediction.direction}`
    );

    console.log(
        `Strength: ${prediction.strength}`
    );

    console.log(
        `Entry Price: $${prediction.entryPrice}`
    );

    console.log(
        `Entry Time: ${prediction.entryTime}`
    );

    console.log(
        `Expiration: ${prediction.expirationTime}`
    );

    console.log(
        `UP Probability: ${
            round(
                prediction.upProbability,
                2
            )
        }%`
    );

    console.log(
        `DOWN Probability: ${
            round(
                prediction.downProbability,
                2
            )
        }%`
    );

    console.log(
        `Confidence: ${
            round(
                prediction.confidence,
                2
            )
        }%`
    );

    console.log(
        `Feature Quality: ${
            round(
                prediction.featureQuality,
                2
            )
        }%`
    );

    console.log(
        `Data Quality: ${
            round(
                prediction.dataQuality,
                2
            )
        }%`
    );

    console.log(
        `Probability Edge: ${
            round(
                prediction.probabilityEdge,
                2
            )
        }%`
    );

    console.log(
        `Conflict: ${
            round(
                prediction.conflict,
                4
            )
        }`
    );

    console.log(
        `Reason: ${prediction.reason}`
    );

    console.log('----------------------------------------------');
    console.log('PAPER PREDICTION ONLY');
    console.log('No real trade was placed.');
    console.log('==============================================');
}


// ============================================================
// TESTS
// ============================================================

function runTests() {
    console.log('==============================================');
    console.log('       ZEUS PREDICTION ENGINE TEST');
    console.log('==============================================');


    /*
    --------------------------------------------------------
    TEST 1
    SKIP signal
    Expected: no prediction
    --------------------------------------------------------
    */

    console.log('');
    console.log('TEST 1: SKIP signal');

    const test1 =
        createPrediction(
            {
                signal: 'SKIP',
                direction: 'UP',

                upProbability: 72,
                downProbability: 28,

                confidence: 34,

                featureQuality: 85,
                dataQuality: 90,

                probabilityEdge: 22,

                conflict: 0.10,

                strength: 'WEAK'
            },
            {
                price: 77000
            }
        );

    printPredictionReport(test1);


    /*
    --------------------------------------------------------
    TEST 2
    Strong UP signal
    Expected: prediction created
    --------------------------------------------------------
    */

    console.log('');
    console.log('TEST 2: Strong UP signal');

    const test2 =
        createPrediction(
            {
                signal: 'UP',
                direction: 'UP',

                upProbability: 81,
                downProbability: 19,

                confidence: 76,

                featureQuality: 90,
                dataQuality: 90,

                probabilityEdge: 31,

                conflict: 0.12,

                strength: 'STRONG',

                reason: 'ALL_FILTERS_PASSED'
            },
            {
                price: 77000
            }
        );

    printPredictionReport(test2);


    /*
    --------------------------------------------------------
    TEST 3
    Attempt second prediction while first is active
    Expected: rejected
    --------------------------------------------------------
    */

    console.log('');
    console.log('TEST 3: Duplicate active prediction');

    const test3 =
        createPrediction(
            {
                signal: 'DOWN',
                direction: 'DOWN',

                upProbability: 20,
                downProbability: 80,

                confidence: 78,

                featureQuality: 91,
                dataQuality: 92,

                probabilityEdge: 30,

                conflict: 0.10,

                strength: 'STRONG',

                reason: 'ALL_FILTERS_PASSED'
            },
            {
                price: 77050
            }
        );

    printPredictionReport(test3);


    /*
    --------------------------------------------------------
    TEST 4
    Resolve first prediction as WIN
    --------------------------------------------------------
    */

    console.log('');
    console.log('TEST 4: Resolve UP prediction as WIN');

    const active =
        getActivePrediction();

    if (active) {
        const test4 =
            resolvePrediction(
                active.id,
                77100
            );

        console.log(
            `Resolved: ${
                test4.resolved
                    ? 'YES'
                    : 'NO'
            }`
        );

        if (test4.prediction) {
            console.log(
                `ID: ${
                    test4.prediction.id
                }`
            );

            console.log(
                `Direction: ${
                    test4.prediction.direction
                }`
            );

            console.log(
                `Entry Price: $${
                    test4.prediction.entryPrice
                }`
            );

            console.log(
                `Exit Price: $${
                    test4.prediction.exitPrice
                }`
            );

            console.log(
                `Result: ${
                    test4.prediction.result
                }`
            );

            console.log(
                `Price Change: ${
                    test4.prediction.priceChangePercent
                }%`
            );
        }
    }


    /*
    --------------------------------------------------------
    TEST 5
    Create DOWN prediction after previous one resolved
    Expected: prediction created
    --------------------------------------------------------
    */

    console.log('');
    console.log('TEST 5: Strong DOWN signal');

    const test5 =
        createPrediction(
            {
                signal: 'DOWN',
                direction: 'DOWN',

                upProbability: 18,
                downProbability: 82,

                confidence: 83,

                featureQuality: 94,
                dataQuality: 95,

                probabilityEdge: 32,

                conflict: 0.08,

                strength: 'EXTREME',

                reason: 'ALL_FILTERS_PASSED'
            },
            {
                price: 77100
            }
        );

    printPredictionReport(test5);


    /*
    --------------------------------------------------------
    FINAL SUMMARY
    --------------------------------------------------------
    */

    console.log('');
    console.log('==============================================');
    console.log('        PREDICTION ENGINE SUMMARY');
    console.log('==============================================');

    console.log(
        getPredictionSummary()
    );

    console.log('');

    console.log(
        'Prediction engine test complete.'
    );

    console.log(
        'No real trades were placed.'
    );

    console.log('==============================================');
}


// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    CONFIG,

    createPrediction,

    resolvePrediction,

    isPredictionExpired,

    getActivePrediction,

    getPrediction,

    getPredictions,

    getPredictionHistory,

    getPredictionSummary,

    printPredictionReport,

    state
};


// ============================================================
// STANDALONE TEST
// ============================================================

if (require.main === module) {
    runTests();
}
