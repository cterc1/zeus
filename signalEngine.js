'use strict';

/*
============================================================
                    ZEUS SIGNAL ENGINE
============================================================

Purpose:
- Takes the result from probabilityEngine.js
- Decides whether Zeus should:
    UP
    DOWN
    SKIP
- Applies safety filters before allowing a signal
- Provides detailed diagnostics explaining every decision
- Does NOT place trades
- Does NOT connect to exchanges
- Does NOT modify market data

Flow:

Market Data
     ↓
Feature Engine
     ↓
Probability Engine
     ↓
Signal Engine
     ↓
UP / DOWN / SKIP
============================================================
*/


const CONFIG = {
    // ========================================================
    // CORE QUALITY FILTERS
    // ========================================================

    // Minimum feature quality required
    minimumFeatureQuality: 60,

    // Minimum confidence required for any signal
    minimumConfidence: 50,

    // Strong confidence threshold
    strongConfidence: 70,

    // Very strong confidence threshold
    extremeConfidence: 82,


    // ========================================================
    // PROBABILITY FILTERS
    // ========================================================

    // Minimum probability advantage over 50%
    minimumProbabilityEdge: 5,

    // Stronger probability edge
    strongProbabilityEdge: 15,

    // Extreme probability edge
    extremeProbabilityEdge: 25,

    // Require a meaningful difference between UP and DOWN
    minimumProbabilityDifference: 6,


    // ========================================================
    // CONFLICT FILTERS
    // ========================================================

    // Maximum acceptable conflict before skipping
    maximumConflict: 0.55,

    // Above this level, require strong confidence
    highConflict: 0.35,


    // ========================================================
    // DATA QUALITY
    // ========================================================

    // Minimum acceptable data quality
    minimumDataQuality: 60,


    // ========================================================
    // BORDERLINE PROTECTION
    // ========================================================

    // Additional confidence buffer.

    // Set to zero so the configured minimumConfidence
    // is the actual minimum required.
    borderlineConfidenceBuffer: 0
};


// ============================================================
// UTILITY FUNCTIONS
// ============================================================

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}


function safeNumber(value, fallback = 0) {
    const number = Number(value);

    if (!Number.isFinite(number)) {
        return fallback;
    }

    return number;
}


function round(value, decimals = 4) {
    const factor = 10 ** decimals;

    return Math.round(
        safeNumber(value, 0) * factor
    ) / factor;
}


// ============================================================
// NORMALIZE PROBABILITY
// ============================================================

function getProbabilities(probabilityResult) {
    const upProbability = clamp(
        safeNumber(
            probabilityResult?.upProbability,
            50
        ),
        0,
        100
    );


    const downProbability = clamp(
        safeNumber(
            probabilityResult?.downProbability,
            50
        ),
        0,
        100
    );


    return {
        upProbability,
        downProbability
    };
}


// ============================================================
// DETERMINE RAW DIRECTION
// ============================================================

function determineDirection(
    upProbability,
    downProbability
) {
    if (upProbability > downProbability) {
        return 'UP';
    }


    if (downProbability > upProbability) {
        return 'DOWN';
    }


    return 'NEUTRAL';
}


// ============================================================
// CALCULATE PROBABILITY EDGE
// ============================================================

function calculateProbabilityEdge(
    upProbability,
    downProbability
) {
    const strongestProbability = Math.max(
        upProbability,
        downProbability
    );


    return Math.max(
        0,
        strongestProbability - 50
    );
}


// ============================================================
// CALCULATE PROBABILITY DIFFERENCE
// ============================================================

function calculateProbabilityDifference(
    upProbability,
    downProbability
) {
    return Math.abs(
        upProbability - downProbability
    );
}


// ============================================================
// CONFIDENCE CHECK
// ============================================================

function checkConfidence(confidence) {
    const value = safeNumber(
        confidence,
        0
    );


    const minimumRequired =
        CONFIG.minimumConfidence +
        CONFIG.borderlineConfidenceBuffer;


    if (value < minimumRequired) {
        return {
            passed: false,
            reason: 'CONFIDENCE_TOO_LOW',
            value,
            required: minimumRequired
        };
    }


    return {
        passed: true,
        reason: 'CONFIDENCE_ACCEPTABLE',
        value,
        required: minimumRequired
    };
}


// ============================================================
// FEATURE QUALITY CHECK
// ============================================================

function checkFeatureQuality(featureQuality) {
    const value = safeNumber(
        featureQuality,
        0
    );


    if (
        value <
        CONFIG.minimumFeatureQuality
    ) {
        return {
            passed: false,
            reason: 'FEATURE_QUALITY_TOO_LOW',
            value,
            required: CONFIG.minimumFeatureQuality
        };
    }


    return {
        passed: true,
        reason: 'FEATURE_QUALITY_ACCEPTABLE',
        value,
        required: CONFIG.minimumFeatureQuality
    };
}


// ============================================================
// DATA QUALITY CHECK
// ============================================================

function checkDataQuality(dataQuality) {
    const value = safeNumber(
        dataQuality,
        0
    );


    if (
        value <
        CONFIG.minimumDataQuality
    ) {
        return {
            passed: false,
            reason: 'DATA_QUALITY_TOO_LOW',
            value,
            required: CONFIG.minimumDataQuality
        };
    }


    return {
        passed: true,
        reason: 'DATA_QUALITY_ACCEPTABLE',
        value,
        required: CONFIG.minimumDataQuality
    };
}


// ============================================================
// CONFLICT CHECK
// ============================================================

function checkConflict(
    conflict,
    confidence
) {
    const conflictValue = clamp(
        safeNumber(
            conflict,
            0
        ),
        0,
        1
    );


    const confidenceValue = safeNumber(
        confidence,
        0
    );


    /*
    ========================================================
    HIGH CONFLICT
    ========================================================

    If the individual market components strongly disagree,
    Zeus becomes more selective.

    A strong-confidence signal may still pass moderate
    conflict, but extreme conflict is rejected.
    */

    if (
        conflictValue >
        CONFIG.maximumConflict
    ) {
        return {
            passed: false,
            reason: 'CONFLICT_TOO_HIGH',
            value: conflictValue,
            maximum: CONFIG.maximumConflict,
            confidence: confidenceValue
        };
    }


    if (
        conflictValue >
        CONFIG.highConflict &&
        confidenceValue <
        CONFIG.strongConfidence
    ) {
        return {
            passed: false,
            reason:
                'HIGH_CONFLICT_REQUIRES_STRONG_CONFIDENCE',
            value: conflictValue,
            threshold: CONFIG.highConflict,
            requiredConfidence:
                CONFIG.strongConfidence,
            confidence: confidenceValue
        };
    }


    return {
        passed: true,
        reason: 'CONFLICT_ACCEPTABLE',
        value: conflictValue,
        maximum: CONFIG.maximumConflict,
        confidence: confidenceValue
    };
}


// ============================================================
// PROBABILITY EDGE CHECK
// ============================================================

function checkProbabilityEdge(
    upProbability,
    downProbability
) {
    const edge =
        calculateProbabilityEdge(
            upProbability,
            downProbability
        );


    const difference =
        calculateProbabilityDifference(
            upProbability,
            downProbability
        );


    if (
        edge <
        CONFIG.minimumProbabilityEdge
    ) {
        return {
            passed: false,
            reason:
                'PROBABILITY_EDGE_TOO_SMALL',

            edge,
            difference,

            requiredEdge:
                CONFIG.minimumProbabilityEdge,

            requiredDifference:
                CONFIG.minimumProbabilityDifference
        };
    }


    if (
        difference <
        CONFIG.minimumProbabilityDifference
    ) {
        return {
            passed: false,
            reason:
                'PROBABILITY_DIFFERENCE_TOO_SMALL',

            edge,
            difference,

            requiredEdge:
                CONFIG.minimumProbabilityEdge,

            requiredDifference:
                CONFIG.minimumProbabilityDifference
        };
    }


    return {
        passed: true,
        reason:
            'PROBABILITY_EDGE_ACCEPTABLE',

        edge,
        difference,

        requiredEdge:
            CONFIG.minimumProbabilityEdge,

        requiredDifference:
            CONFIG.minimumProbabilityDifference
    };
}


// ============================================================
// DETERMINE SIGNAL STRENGTH
// ============================================================

function determineSignalStrength(
    confidence,
    probabilityEdge,
    conflict
) {
    const confidenceValue =
        safeNumber(
            confidence,
            0
        );


    const edge =
        safeNumber(
            probabilityEdge,
            0
        );


    const conflictValue =
        safeNumber(
            conflict,
            0
        );


    /*
    ========================================================
    EXTREME
    ========================================================
    */

    if (
        confidenceValue >=
            CONFIG.extremeConfidence &&

        edge >=
            CONFIG.extremeProbabilityEdge &&

        conflictValue <= 0.20
    ) {
        return 'EXTREME';
    }


    /*
    ========================================================
    STRONG
    ========================================================
    */

    if (
        confidenceValue >=
            CONFIG.strongConfidence &&

        edge >=
            CONFIG.strongProbabilityEdge &&

        conflictValue <=
            CONFIG.highConflict
    ) {
        return 'STRONG';
    }


    /*
    ========================================================
    NORMAL
    ========================================================
    */

    if (
        confidenceValue >=
            CONFIG.minimumConfidence &&

        edge >=
            CONFIG.minimumProbabilityEdge
    ) {
        return 'NORMAL';
    }


    return 'WEAK';
}


// ============================================================
// BUILD DIAGNOSTICS
// ============================================================

function buildDiagnostics({
    direction,
    probabilityCheck,
    confidenceCheck,
    featureCheck,
    dataCheck,
    conflictCheck,
    strength
}) {
    const filters = {
        direction: {
            passed: direction !== 'NEUTRAL',
            reason:
                direction !== 'NEUTRAL'
                    ? 'DIRECTION_AVAILABLE'
                    : 'DIRECTION_NEUTRAL'
        },

        featureQuality: featureCheck,

        dataQuality: dataCheck,

        confidence: confidenceCheck,

        probability: probabilityCheck,

        conflict: conflictCheck,

        strength: {
            passed: strength !== 'WEAK',
            reason:
                strength !== 'WEAK'
                    ? 'SIGNAL_STRENGTH_ACCEPTABLE'
                    : 'SIGNAL_STRENGTH_TOO_WEAK'
        }
    };


    const failedFilters = Object.entries(
        filters
    )
        .filter(([, result]) => !result.passed)
        .map(([name, result]) => ({
            filter: name,
            reason: result.reason
        }));


    return {
        passed:
            failedFilters.length === 0,

        failedFilters,

        filters
    };
}


// ============================================================
// BUILD RESULT
// ============================================================

function buildResult({
    signal,
    direction,
    reason,
    upProbability,
    downProbability,
    probabilityEdge,
    probabilityDifference,
    confidence,
    featureQuality,
    dataQuality,
    conflict,
    strength,
    diagnostics
}) {
    return {
        signal,
        direction,
        reason,

        upProbability,
        downProbability,

        probabilityEdge,
        probabilityDifference,

        confidence,
        featureQuality,
        dataQuality,
        conflict,

        strength,

        diagnostics
    };
}


// ============================================================
// MAIN SIGNAL DECISION
// ============================================================

function evaluateSignal(probabilityResult) {
    if (!probabilityResult) {
        return {
            signal: 'SKIP',
            direction: 'NEUTRAL',
            reason: 'NO_PROBABILITY_RESULT',

            upProbability: 50,
            downProbability: 50,

            probabilityEdge: 0,
            probabilityDifference: 0,

            confidence: 0,
            featureQuality: 0,
            dataQuality: 0,
            conflict: 0,

            strength: 'WEAK',

            diagnostics: {
                passed: false,

                failedFilters: [
                    {
                        filter: 'probabilityResult',
                        reason: 'NO_PROBABILITY_RESULT'
                    }
                ],

                filters: {}
            }
        };
    }


    const {
        upProbability,
        downProbability
    } = getProbabilities(
        probabilityResult
    );


    const confidence =
        safeNumber(
            probabilityResult.confidence,
            0
        );


    const featureQuality =
        safeNumber(
            probabilityResult.featureQuality,
            0
        );


    /*
    ========================================================
    CONFLICT EXTRACTION
    ========================================================

    probabilityEngine.js may return:

        conflict: {
            level,
            score,
            bullishComponents,
            bearishComponents,
            activeComponents
        }

    Zeus needs the numeric score.
    */

    const conflict = clamp(
        safeNumber(
            probabilityResult.conflict?.score ??
            probabilityResult.conflict,
            0
        ),
        0,
        1
    );


    /*
    ========================================================
    DATA QUALITY EXTRACTION
    ========================================================

    If probabilityEngine provides dataQuality,
    use it.

    Otherwise featureQuality is used as the fallback.
    */

    const dataQuality =
        safeNumber(
            probabilityResult.dataQuality,
            featureQuality
        );


    /*
    ========================================================
    RAW DIRECTION
    ========================================================
    */

    const direction =
        determineDirection(
            upProbability,
            downProbability
        );


    /*
    ========================================================
    RUN EVERY FILTER
    ========================================================

    We calculate ALL filters before deciding what to return.

    This means diagnostics can tell us exactly what failed
    instead of hiding everything behind the first failure.
    */

    const probabilityCheck =
        checkProbabilityEdge(
            upProbability,
            downProbability
        );


    const confidenceCheck =
        checkConfidence(
            confidence
        );


    const featureCheck =
        checkFeatureQuality(
            featureQuality
        );


    const dataCheck =
        checkDataQuality(
            dataQuality
        );


    const conflictCheck =
        checkConflict(
            conflict,
            confidence
        );


    const probabilityEdge =
        probabilityCheck.edge;


    const probabilityDifference =
        probabilityCheck.difference;


    /*
    ========================================================
    PRELIMINARY STRENGTH
    ========================================================
    */

    const preliminaryStrength =
        determineSignalStrength(
            confidence,
            probabilityEdge,
            conflict
        );


    /*
    ========================================================
    DIAGNOSTICS
    ========================================================
    */

    const diagnostics =
        buildDiagnostics({
            direction,

            probabilityCheck,

            confidenceCheck,

            featureCheck,

            dataCheck,

            conflictCheck,

            strength:
                preliminaryStrength
        });


    /*
    ========================================================
    SAFETY FILTERS
    ========================================================
    */

    if (
        direction ===
        'NEUTRAL'
    ) {
        return buildResult({
            signal: 'SKIP',

            direction,

            reason:
                'DIRECTION_NEUTRAL',

            upProbability,
            downProbability,

            probabilityEdge,

            probabilityDifference,

            confidence,

            featureQuality,

            dataQuality,

            conflict,

            strength: 'WEAK',

            diagnostics
        });
    }


    if (
        !featureCheck.passed
    ) {
        return buildResult({
            signal: 'SKIP',

            direction,

            reason:
                featureCheck.reason,

            upProbability,
            downProbability,

            probabilityEdge,

            probabilityDifference,

            confidence,

            featureQuality,

            dataQuality,

            conflict,

            strength: 'WEAK',

            diagnostics
        });
    }


    if (
        !dataCheck.passed
    ) {
        return buildResult({
            signal: 'SKIP',

            direction,

            reason:
                dataCheck.reason,

            upProbability,
            downProbability,

            probabilityEdge,

            probabilityDifference,

            confidence,

            featureQuality,

            dataQuality,

            conflict,

            strength: 'WEAK',

            diagnostics
        });
    }


    if (
        !confidenceCheck.passed
    ) {
        return buildResult({
            signal: 'SKIP',

            direction,

            reason:
                confidenceCheck.reason,

            upProbability,
            downProbability,

            probabilityEdge,

            probabilityDifference,

            confidence,

            featureQuality,

            dataQuality,

            conflict,

            strength: 'WEAK',

            diagnostics
        });
    }


    if (
        !probabilityCheck.passed
    ) {
        return buildResult({
            signal: 'SKIP',

            direction,

            reason:
                probabilityCheck.reason,

            upProbability,
            downProbability,

            probabilityEdge,

            probabilityDifference,

            confidence,

            featureQuality,

            dataQuality,

            conflict,

            strength: 'WEAK',

            diagnostics
        });
    }


    if (
        !conflictCheck.passed
    ) {
        return buildResult({
            signal: 'SKIP',

            direction,

            reason:
                conflictCheck.reason,

            upProbability,
            downProbability,

            probabilityEdge,

            probabilityDifference,

            confidence,

            featureQuality,

            dataQuality,

            conflict,

            strength: 'WEAK',

            diagnostics
        });
    }


    /*
    ========================================================
    SIGNAL PASSED ALL FILTERS
    ========================================================
    */

    const strength =
        determineSignalStrength(
            confidence,
            probabilityEdge,
            conflict
        );


    if (
        strength ===
        'WEAK'
    ) {
        return buildResult({
            signal: 'SKIP',

            direction,

            reason:
                'SIGNAL_STRENGTH_TOO_WEAK',

            upProbability,
            downProbability,

            probabilityEdge,

            probabilityDifference,

            confidence,

            featureQuality,

            dataQuality,

            conflict,

            strength,

            diagnostics
        });
    }


    /*
    ========================================================
    FINAL SIGNAL
    ========================================================
    */

    return buildResult({
        signal: direction,

        direction,

        reason:
            'ALL_FILTERS_PASSED',

        upProbability,

        downProbability,

        probabilityEdge,

        probabilityDifference,

        confidence,

        featureQuality,

        dataQuality,

        conflict,

        strength,

        diagnostics: {
            ...diagnostics,

            passed: true,

            failedFilters: []
        }
    });
}


// ============================================================
// SIGNAL REPORT
// ============================================================

function printSignalReport(result) {
    console.log('');

    console.log(
        '=============================================='
    );

    console.log(
        '             ZEUS SIGNAL ENGINE'
    );

    console.log(
        '=============================================='
    );


    console.log(
        `Signal: ${result.signal}`
    );


    console.log(
        `Direction: ${result.direction}`
    );


    console.log(
        `UP Probability: ${round(
            result.upProbability,
            2
        )}%`
    );


    console.log(
        `DOWN Probability: ${round(
            result.downProbability,
            2
        )}%`
    );


    console.log(
        `Probability Edge: ${round(
            result.probabilityEdge,
            2
        )}%`
    );


    console.log(
        `Probability Difference: ${round(
            result.probabilityDifference,
            2
        )}%`
    );


    console.log(
        `Confidence: ${round(
            result.confidence,
            2
        )}%`
    );


    console.log(
        `Feature Quality: ${round(
            result.featureQuality,
            2
        )}%`
    );


    console.log(
        `Data Quality: ${round(
            result.dataQuality,
            2
        )}%`
    );


    console.log(
        `Conflict: ${round(
            result.conflict,
            4
        )}`
    );


    console.log(
        `Strength: ${result.strength}`
    );


    console.log(
        `Reason: ${result.reason}`
    );


    /*
    ========================================================
    FILTER DIAGNOSTICS
    ========================================================
    */

    if (
        result.diagnostics
    ) {
        console.log(
            '----------------------------------------------'
        );

        console.log(
            `Filters Passed: ${
                result.diagnostics.passed
                    ? 'YES'
                    : 'NO'
            }`
        );


        if (
            result.diagnostics.failedFilters &&
            result.diagnostics.failedFilters.length
        ) {
            console.log(
                'Failed Filters:'
            );


            for (
                const failure
                of result.diagnostics.failedFilters
            ) {
                console.log(
                    `  - ${failure.filter}: ${failure.reason}`
                );
            }
        } else {
            console.log(
                'Failed Filters: NONE'
            );
        }
    }


    console.log(
        '----------------------------------------------'
    );


    console.log(
        'No trades were placed.'
    );


    console.log(
        '=============================================='
    );
}


// ============================================================
// TEST CASES
// ============================================================

function runTests() {
    console.log(
        '=============================================='
    );

    console.log(
        '       ZEUS SIGNAL ENGINE TEST'
    );

    console.log(
        '=============================================='
    );


    /*
    ========================================================
    TEST 1
    Weak confidence.

    Expected:
    SKIP
    ========================================================
    */

    console.log('');
    console.log(
        'TEST 1: Weak confidence'
    );


    const test1 =
        evaluateSignal({
            signal: 'SKIP',

            direction: 'UP',

            upProbability: 72.14,

            downProbability: 27.86,

            confidence: 34.09,

            featureQuality: 85,

            dataQuality: 90,

            conflict: 0.10
        });


    printSignalReport(
        test1
    );


    /*
    ========================================================
    TEST 2
    Strong UP signal.

    Expected:
    UP
    ========================================================
    */

    console.log('');
    console.log(
        'TEST 2: Strong UP signal'
    );


    const test2 =
        evaluateSignal({
            signal: 'UP',

            direction: 'UP',

            upProbability: 81,

            downProbability: 19,

            confidence: 76,

            featureQuality: 90,

            dataQuality: 90,

            conflict: 0.12
        });


    printSignalReport(
        test2
    );


    /*
    ========================================================
    TEST 3
    Strong DOWN signal.

    Expected:
    DOWN
    ========================================================
    */

    console.log('');
    console.log(
        'TEST 3: Strong DOWN signal'
    );


    const test3 =
        evaluateSignal({
            signal: 'DOWN',

            direction: 'DOWN',

            upProbability: 21,

            downProbability: 79,

            confidence: 74,

            featureQuality: 88,

            dataQuality: 90,

            conflict: 0.14
        });


    printSignalReport(
        test3
    );


    /*
    ========================================================
    TEST 4
    Poor feature quality.

    Expected:
    SKIP
    ========================================================
    */

    console.log('');
    console.log(
        'TEST 4: Poor feature quality'
    );


    const test4 =
        evaluateSignal({
            signal: 'UP',

            direction: 'UP',

            upProbability: 82,

            downProbability: 18,

            confidence: 80,

            featureQuality: 45,

            dataQuality: 90,

            conflict: 0.10
        });


    printSignalReport(
        test4
    );


    /*
    ========================================================
    TEST 5
    High conflict.

    Expected:
    SKIP
    ========================================================
    */

    console.log('');
    console.log(
        'TEST 5: High conflict'
    );


    const test5 =
        evaluateSignal({
            signal: 'UP',

            direction: 'UP',

            upProbability: 79,

            downProbability: 21,

            confidence: 62,

            featureQuality: 90,

            dataQuality: 90,

            conflict: 0.60
        });


    printSignalReport(
        test5
    );


    /*
    ========================================================
    TEST 6
    Borderline NORMAL signal.

    This specifically verifies that the new
    50% confidence / 5% edge thresholds work.

    Expected:
    UP
    ========================================================
    */

    console.log('');
    console.log(
        'TEST 6: Borderline usable UP signal'
    );


    const test6 =
        evaluateSignal({
            signal: 'UP',

            direction: 'UP',

            upProbability: 57,

            downProbability: 43,

            confidence: 55,

            featureQuality: 90,

            dataQuality: 90,

            conflict: 0.20
        });


    printSignalReport(
        test6
    );


    /*
    ========================================================
    TEST 7
    Moderate conflict with strong confidence.

    Expected:
    UP

    This verifies Zeus can still accept a strong signal
    when conflict is above the normal level but below
    the maximum allowed conflict.
    ========================================================
    */

    console.log('');
    console.log(
        'TEST 7: Moderate conflict with strong confidence'
    );


    const test7 =
        evaluateSignal({
            signal: 'UP',

            direction: 'UP',

            upProbability: 78,

            downProbability: 22,

            confidence: 72,

            featureQuality: 90,

            dataQuality: 90,

            conflict: 0.40
        });


    printSignalReport(
        test7
    );


    console.log('');

    console.log(
        '=============================================='
    );

    console.log(
        'Signal engine test complete.'
    );

    console.log(
        'No trades were placed.'
    );

    console.log(
        '=============================================='
    );
}


// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    CONFIG,

    evaluateSignal,

    determineDirection,

    calculateProbabilityEdge,

    calculateProbabilityDifference,

    checkConfidence,

    checkFeatureQuality,

    checkDataQuality,

    checkConflict,

    checkProbabilityEdge,

    determineSignalStrength,

    printSignalReport
};


// ============================================================
// STANDALONE TEST
// ============================================================

if (
    require.main === module
) {
    runTests();
}