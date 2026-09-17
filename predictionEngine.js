// ============================================================
// ZEUS PROBABILITY ENGINE
// ============================================================
// Converts Zeus market features into:
//   - UP probability
//   - DOWN probability
//   - confidence
//   - signal
//   - transparent component scores
//
// IMPORTANT:
// This is a model score, NOT a guaranteed probability of profit.
// It must be backtested and calibrated before real-money use.
// ============================================================

const CONFIG = {
    // --------------------------------------------------------
    // Signal thresholds
    // --------------------------------------------------------

    minimumFeatureQuality: 60,

    minimumConfidenceForSignal: 58,

    strongConfidence: 70,

    extremeConfidence: 82,

    // --------------------------------------------------------
    // Probability limits
    // --------------------------------------------------------

    minimumProbability: 5,

    maximumProbability: 95,

    // --------------------------------------------------------
    // Component weights
    // --------------------------------------------------------

    weights: {
        momentum: 0.24,
        orderBook: 0.22,
        tradePressure: 0.24,
        volatility: 0.10,
        microstructure: 0.10,
        trend: 0.10
    },

    // --------------------------------------------------------
    // Conflict penalty
    // --------------------------------------------------------

    conflictPenalty: 0.12,

    // --------------------------------------------------------
    // Small neutral zone
    // --------------------------------------------------------

    neutralZone: 0.04
};

// ============================================================
// UTILITY
// ============================================================

function clamp(value, min, max) {
    return Math.max(
        min,
        Math.min(max, value)
    );
}

function safeNumber(value, fallback = 0) {
    const number = Number(value);

    return Number.isFinite(number)
        ? number
        : fallback;
}

function finiteOrNull(value) {
    const number = Number(value);

    return Number.isFinite(number)
        ? number
        : null;
}

function round(value, decimals = 4) {
    if (!Number.isFinite(value)) {
        return null;
    }

    const multiplier =
        Math.pow(10, decimals);

    return (
        Math.round(
            value * multiplier
        ) / multiplier
    );
}

// ============================================================
// FEATURE EXTRACTION
// ============================================================

function getFeatureContainer(snapshot) {
    if (
        snapshot &&
        snapshot.features
    ) {
        return snapshot.features;
    }

    return {};
}

function getOrderBook(snapshot) {
    if (
        snapshot &&
        snapshot.orderBook
    ) {
        return snapshot.orderBook;
    }

    return {};
}

function getTrades(snapshot) {
    if (
        snapshot &&
        snapshot.trades
    ) {
        return snapshot.trades;
    }

    return {};
}

function getMovements(snapshot) {
    if (
        snapshot &&
        snapshot.movements
    ) {
        return snapshot.movements;
    }

    return {};
}

function getVolatility(snapshot) {
    if (
        snapshot &&
        snapshot.volatility
    ) {
        return snapshot.volatility;
    }

    return {};
}

// ============================================================
// NORMALIZATION
// ============================================================

function normalizeRange(
    value,
    negativeLimit,
    positiveLimit
) {
    const number =
        finiteOrNull(value);

    if (number === null) {
        return 0;
    }

    if (
        number >= positiveLimit
    ) {
        return 1;
    }

    if (
        number <= negativeLimit
    ) {
        return -1;
    }

    if (number >= 0) {
        return (
            number /
            positiveLimit
        );
    }

    return (
        number /
        Math.abs(negativeLimit)
    );
}

// ============================================================
// MOMENTUM SCORE
// ============================================================

function calculateMomentumScore(
    snapshot
) {
    const features =
        getFeatureContainer(
            snapshot
        );

    const movements =
        getMovements(snapshot);

    const movement15 =
        finiteOrNull(
            features.momentum15 ??
            features.movement15 ??
            movements[15]
        );

    const movement30 =
        finiteOrNull(
            features.momentum30 ??
            features.movement30 ??
            movements[30]
        );

    const movement60 =
        finiteOrNull(
            features.momentum60 ??
            features.movement60 ??
            movements[60]
        );

    const movement180 =
        finiteOrNull(
            features.momentum180 ??
            features.movement180 ??
            movements[180]
        );

    const movement300 =
        finiteOrNull(
            features.momentum300 ??
            features.movement300 ??
            movements[300]
        );

    const values = [
        movement15,
        movement30,
        movement60,
        movement180,
        movement300
    ].filter(
        value =>
            value !== null
    );

    if (values.length === 0) {
        return {
            score: 0,
            confidence: 0,
            direction: "NEUTRAL",
            components: {
                movement15,
                movement30,
                movement60,
                movement180,
                movement300
            }
        };
    }

    const weightedValues = [];

    if (movement15 !== null) {
        weightedValues.push({
            value: movement15,
            weight: 0.30
        });
    }

    if (movement30 !== null) {
        weightedValues.push({
            value: movement30,
            weight: 0.25
        });
    }

    if (movement60 !== null) {
        weightedValues.push({
            value: movement60,
            weight: 0.20
        });
    }

    if (movement180 !== null) {
        weightedValues.push({
            value: movement180,
            weight: 0.15
        });
    }

    if (movement300 !== null) {
        weightedValues.push({
            value: movement300,
            weight: 0.10
        });
    }

    let weightedMomentum = 0;
    let totalWeight = 0;

    for (const item of weightedValues) {
        weightedMomentum +=
            normalizeRange(
                item.value,
                -0.10,
                0.10
            ) *
            item.weight;

        totalWeight += item.weight;
    }

    if (totalWeight > 0) {
        weightedMomentum /=
            totalWeight;
    }

    const acceleration =
        finiteOrNull(
            features.shortTermAcceleration ??
            features.momentumAcceleration ??
            features.acceleration
        );

    let accelerationScore = 0;

    if (acceleration !== null) {
        accelerationScore =
            normalizeRange(
                acceleration,
                -0.10,
                0.10
            );
    }

    const score =
        clamp(
            weightedMomentum * 0.75 +
            accelerationScore * 0.25,
            -1,
            1
        );

    const confidence =
        Math.abs(score) * 100;

    let direction = "NEUTRAL";

    if (score > 0.05) {
        direction = "UP";
    } else if (score < -0.05) {
        direction = "DOWN";
    }

    return {
        score,
        confidence,
        direction,

        components: {
            movement15,
            movement30,
            movement60,
            movement180,
            movement300,
            acceleration
        }
    };
}

// ============================================================
// ORDER BOOK SCORE
// ============================================================

function calculateOrderBookScore(
    snapshot
) {
    const features =
        getFeatureContainer(
            snapshot
        );

    const orderBook =
        getOrderBook(snapshot);

    const combined =
        orderBook.combined ||
        {};

    const imbalance =
        finiteOrNull(
            features.orderBookImbalance ??
            features.bookImbalance ??
            combined.imbalance
        );

    const imbalance5 =
        finiteOrNull(
            features.imbalance5 ??
            features.fiveLevelImbalance
        );

    const imbalance10 =
        finiteOrNull(
            features.imbalance10 ??
            features.tenLevelImbalance
        );

    const imbalance25 =
        finiteOrNull(
            features.imbalance25 ??
            features.twentyFiveLevelImbalance
        );

    const values = [];

    if (imbalance !== null) {
        values.push({
            value: imbalance,
            weight: 0.20
        });
    }

    if (imbalance5 !== null) {
        values.push({
            value: imbalance5,
            weight: 0.35
        });
    }

    if (imbalance10 !== null) {
        values.push({
            value: imbalance10,
            weight: 0.30
        });
    }

    if (imbalance25 !== null) {
        values.push({
            value: imbalance25,
            weight: 0.15
        });
    }

    if (values.length === 0) {
        return {
            score: 0,
            confidence: 0,
            direction: "NEUTRAL",
            components: {
                imbalance,
                imbalance5,
                imbalance10,
                imbalance25
            }
        };
    }

    let score = 0;
    let totalWeight = 0;

    for (const item of values) {
        score +=
            clamp(
                safeNumber(
                    item.value
                ),
                -1,
                1
            ) *
            item.weight;

        totalWeight +=
            item.weight;
    }

    if (totalWeight > 0) {
        score /=
            totalWeight;
    }

    score =
        clamp(
            score,
            -1,
            1
        );

    let direction = "NEUTRAL";

    if (score > 0.05) {
        direction = "UP";
    } else if (score < -0.05) {
        direction = "DOWN";
    }

    return {
        score,
        confidence:
            Math.abs(score) * 100,
        direction,

        components: {
            imbalance,
            imbalance5,
            imbalance10,
            imbalance25
        }
    };
}

// ============================================================
// TRADE PRESSURE SCORE
// ============================================================

function getTradeWindow(
    snapshot,
    seconds
) {
    const features =
        getFeatureContainer(
            snapshot
        );

    const trades =
        getTrades(snapshot);

    const recent =
        trades[
            `recent${seconds}s`
        ];

    if (recent) {
        return recent;
    }

    const featureWindow =
        features[
            `tradePressure${seconds}s`
        ];

    if (featureWindow) {
        return featureWindow;
    }

    if (
        seconds === 60 &&
        trades.recent60s
    ) {
        return trades.recent60s;
    }

    return null;
}

function calculateTradePressureScore(
    snapshot
) {
    const features =
        getFeatureContainer(
            snapshot
        );

    const windows = [
        {
            seconds: 15,
            weight: 0.30
        },
        {
            seconds: 30,
            weight: 0.30
        },
        {
            seconds: 60,
            weight: 0.40
        }
    ];

    let score = 0;
    let totalWeight = 0;

    const components = {};

    for (const window of windows) {
        const data =
            getTradeWindow(
                snapshot,
                window.seconds
            );

        let imbalance = null;

        if (data) {
            imbalance =
                finiteOrNull(
                    data.imbalance ??
                    data.tradeImbalance
                );
        }

        if (
            imbalance === null
        ) {
            imbalance =
                finiteOrNull(
                    features[
                        `tradeImbalance${window.seconds}`
                    ]
                );
        }

        components[
            `${window.seconds}s`
        ] = imbalance;

        if (
            imbalance === null
        ) {
            continue;
        }

        score +=
            clamp(
                imbalance,
                -1,
                1
            ) *
            window.weight;

        totalWeight +=
            window.weight;
    }

    if (totalWeight > 0) {
        score /=
            totalWeight;
    }

    score =
        clamp(
            score,
            -1,
            1
        );

    let direction = "NEUTRAL";

    if (score > 0.05) {
        direction = "UP";
    } else if (score < -0.05) {
        direction = "DOWN";
    }

    return {
        score,
        confidence:
            Math.abs(score) * 100,
        direction,
        components
    };
}

// ============================================================
// VOLATILITY SCORE
// ============================================================

function calculateVolatilityScore(
    snapshot
) {
    const features =
        getFeatureContainer(
            snapshot
        );

    const volatility =
        getVolatility(snapshot);

    const volatility15 =
        finiteOrNull(
            features.realizedVolatility15 ??
            features.volatility15 ??
            volatility.realized15s
        );

    const volatility30 =
        finiteOrNull(
            features.realizedVolatility30 ??
            features.volatility30 ??
            volatility.realized30s
        );

    const volatility60 =
        finiteOrNull(
            features.realizedVolatility60 ??
            features.volatility60 ??
            volatility.realized60s
        );

    const values = [
        volatility15,
        volatility30,
        volatility60
    ].filter(
        value =>
            value !== null
    );

    if (values.length === 0) {
        return {
            score: 0,
            confidence: 0,
            direction: "NEUTRAL",
            regime: "UNKNOWN",
            components: {
                volatility15,
                volatility30,
                volatility60
            }
        };
    }

    const average =
        values.reduce(
            (sum, value) =>
                sum + value,
            0
        ) /
        values.length;

    const lowThreshold =
        0.00001;

    const highThreshold =
        0.00010;

    let regime;
    let confidence;

    if (
        average <
        lowThreshold
    ) {
        regime = "LOW";
        confidence = 35;
    } else if (
        average >
        highThreshold
    ) {
        regime = "HIGH";
        confidence = 45;
    } else {
        regime = "NORMAL";
        confidence = 80;
    }

    return {
        score: 0,

        confidence,

        direction: "NEUTRAL",

        regime,

        components: {
            volatility15,
            volatility30,
            volatility60,
            average
        }
    };
}

// ============================================================
// MICROSTRUCTURE SCORE
// ============================================================

function calculateMicrostructureScore(
    snapshot
) {
    const features =
        getFeatureContainer(
            snapshot
        );

    const orderBook =
        getOrderBook(snapshot);

    const coinbase =
        orderBook.coinbase ||
        {};

    const kraken =
        orderBook.kraken ||
        {};

    const spread =
        finiteOrNull(
            features.averageSpreadPercent ??
            features.averageSpreadPct ??
            features.spreadPercent
        );

    const exchangeDifference =
        finiteOrNull(
            features.crossExchangeDifferencePercent ??
            features.crossExchangeDifferencePct ??
            features.exchangeDifferencePercent
        );

    const coinbaseSpread =
        finiteOrNull(
            features.coinbaseSpread ??
            coinbase.spread
        );

    const krakenSpread =
        finiteOrNull(
            features.krakenSpread ??
            kraken.spread
        );

    let quality = 70;

    if (
        spread !== null
    ) {
        if (
            spread <
            0.001
        ) {
            quality += 15;
        } else if (
            spread >
            0.01
        ) {
            quality -= 15;
        }
    }

    if (
        exchangeDifference !== null
    ) {
        const absoluteDifference =
            Math.abs(
                exchangeDifference
            );

        if (
            absoluteDifference <
            0.005
        ) {
            quality += 10;
        } else if (
            absoluteDifference >
            0.05
        ) {
            quality -= 20;
        }
    }

    quality =
        clamp(
            quality,
            0,
            100
        );

    return {
        score: 0,

        confidence: quality,

        direction: "NEUTRAL",

        components: {
            averageSpreadPercent:
                spread,

            exchangeDifferencePercent:
                exchangeDifference,

            coinbaseSpread,

            krakenSpread
        }
    };
}

// ============================================================
// TREND SCORE
// ============================================================

function calculateTrendScore(
    snapshot
) {
    const features =
        getFeatureContainer(
            snapshot
        );

    const movements =
        getMovements(snapshot);

    const movement30 =
        finiteOrNull(
            features.momentum30 ??
            features.movement30 ??
            movements[30]
        );

    const movement60 =
        finiteOrNull(
            features.momentum60 ??
            features.movement60 ??
            movements[60]
        );

    const movement180 =
        finiteOrNull(
            features.momentum180 ??
            features.movement180 ??
            movements[180]
        );

    if (
        movement30 === null &&
        movement60 === null &&
        movement180 === null
    ) {
        return {
            score: 0,
            confidence: 0,
            direction: "NEUTRAL",
            components: {
                movement30,
                movement60,
                movement180
            }
        };
    }

    let score = 0;
    let weight = 0;

    if (movement30 !== null) {
        score +=
            normalizeRange(
                movement30,
                -0.10,
                0.10
            ) *
            0.35;

        weight += 0.35;
    }

    if (movement60 !== null) {
        score +=
            normalizeRange(
                movement60,
                -0.10,
                0.10
            ) *
            0.40;

        weight += 0.40;
    }

    if (movement180 !== null) {
        score +=
            normalizeRange(
                movement180,
                -0.15,
                0.15
            ) *
            0.25;

        weight += 0.25;
    }

    if (weight > 0) {
        score /=
            weight;
    }

    score =
        clamp(
            score,
            -1,
            1
        );

    let direction = "NEUTRAL";

    if (score > 0.05) {
        direction = "UP";
    } else if (score < -0.05) {
        direction = "DOWN";
    }

    return {
        score,

        confidence:
            Math.abs(score) * 100,

        direction,

        components: {
            movement30,
            movement60,
            movement180
        }
    };
}

// ============================================================
// SIGNAL CONFLICT DETECTION
// ============================================================

function calculateConflict(
    components
) {
    const directionalComponents = [
        components.momentum,
        components.orderBook,
        components.tradePressure,
        components.trend
    ];

    let bullish = 0;
    let bearish = 0;
    let active = 0;

    for (
        const component
        of directionalComponents
    ) {
        if (!component) {
            continue;
        }

        if (
            component.score >
            CONFIG.neutralZone
        ) {
            bullish++;
            active++;
        } else if (
            component.score <
            -CONFIG.neutralZone
        ) {
            bearish++;
            active++;
        }
    }

    if (active < 2) {
        return {
            conflict: 0,
            bullish,
            bearish,
            active,
            level: "LOW"
        };
    }

    const conflict =
        Math.min(
            bullish,
            bearish
        ) /
        active;

    let level = "LOW";

    if (conflict >= 0.40) {
        level = "HIGH";
    } else if (
        conflict >= 0.25
    ) {
        level = "MEDIUM";
    }

    return {
        conflict,
        bullish,
        bearish,
        active,
        level
    };
}

// ============================================================
// WEIGHTED MODEL SCORE
// ============================================================

function calculateWeightedScore(
    components
) {
    const weights =
        CONFIG.weights;

    let score = 0;
    let weight = 0;

    const entries = [
        [
            components.momentum,
            weights.momentum
        ],
        [
            components.orderBook,
            weights.orderBook
        ],
        [
            components.tradePressure,
            weights.tradePressure
        ],
        [
            components.volatility,
            weights.volatility
        ],
        [
            components.microstructure,
            weights.microstructure
        ],
        [
            components.trend,
            weights.trend
        ]
    ];

    for (
        const [component, componentWeight]
        of entries
    ) {
        if (!component) {
            continue;
        }

        score +=
            safeNumber(
                component.score
            ) *
            componentWeight;

        weight +=
            componentWeight;
    }

    if (weight <= 0) {
        return 0;
    }

    return clamp(
        score / weight,
        -1,
        1
    );
}

// ============================================================
// QUALITY
// ============================================================

function calculateFeatureQuality(
    snapshot
) {
    const direct =
        finiteOrNull(
            snapshot?.featureQuality
        );

    if (direct !== null) {
        return clamp(
            direct,
            0,
            100
        );
    }

    const featureContainer =
        getFeatureContainer(
            snapshot
        );

    const featureQuality =
        finiteOrNull(
            featureContainer.quality ??
            featureContainer.featureQuality
        );

    if (
        featureQuality !== null
    ) {
        return clamp(
            featureQuality,
            0,
            100
        );
    }

    const dataQuality =
        finiteOrNull(
            snapshot?.dataQuality
        );

    if (dataQuality !== null) {
        return clamp(
            dataQuality,
            0,
            100
        );
    }

    return 50;
}

// ============================================================
// PROBABILITY CONVERSION
// ============================================================

function scoreToProbability(
    score
) {
    const strength =
        3.0;

    const positiveProbability =
        1 /
        (
            1 +
            Math.exp(
                -score * strength
            )
        );

    let upProbability =
        positiveProbability *
        100;

    upProbability =
        clamp(
            upProbability,
            CONFIG.minimumProbability,
            CONFIG.maximumProbability
        );

    let downProbability =
        100 -
        upProbability;

    downProbability =
        clamp(
            downProbability,
            CONFIG.minimumProbability,
            CONFIG.maximumProbability
        );

    const total =
        upProbability +
        downProbability;

    upProbability =
        (
            upProbability /
            total
        ) *
        100;

    downProbability =
        (
            downProbability /
            total
        ) *
        100;

    return {
        up: upProbability,
        down: downProbability
    };
}

// ============================================================
// MAIN PROBABILITY ENGINE
// ============================================================

function calculateProbability(
    snapshot
) {
    if (!snapshot) {
        return {
            timestamp: Date.now(),

            signal: "SKIP",

            reason:
                "NO_MARKET_SNAPSHOT",

            upProbability: 50,
            downProbability: 50,

            confidence: 0,

            featureQuality: 0,

            modelScore: 0
        };
    }

    const featureQuality =
        calculateFeatureQuality(
            snapshot
        );

    const momentum =
        calculateMomentumScore(
            snapshot
        );

    const orderBook =
        calculateOrderBookScore(
            snapshot
        );

    const tradePressure =
        calculateTradePressureScore(
            snapshot
        );

    const volatility =
        calculateVolatilityScore(
            snapshot
        );

    const microstructure =
        calculateMicrostructureScore(
            snapshot
        );

    const trend =
        calculateTrendScore(
            snapshot
        );

    const components = {
        momentum,
        orderBook,
        tradePressure,
        volatility,
        microstructure,
        trend
    };

    let modelScore =
        calculateWeightedScore(
            components
        );

    const conflict =
        calculateConflict(
            components
        );

    if (
        conflict.conflict > 0
    ) {
        const penalty =
            conflict.conflict *
            CONFIG.conflictPenalty;

        modelScore *=
            1 -
            penalty;
    }

    if (
        featureQuality <
        CONFIG.minimumFeatureQuality
    ) {
        const qualityRatio =
            featureQuality /
            CONFIG.minimumFeatureQuality;

        modelScore *=
            qualityRatio;
    }

    modelScore =
        clamp(
            modelScore,
            -1,
            1
        );

    let probability =
        scoreToProbability(
            modelScore
        );

    // --------------------------------------------------------
    // Evidence-based confidence
    // --------------------------------------------------------

    const directionalComponents = [
        {
            component: momentum,
            weight: CONFIG.weights.momentum
        },
        {
            component: orderBook,
            weight: CONFIG.weights.orderBook
        },
        {
            component: tradePressure,
            weight: CONFIG.weights.tradePressure
        },
        {
            component: trend,
            weight: CONFIG.weights.trend
        }
    ];

    const modelDirection =
        modelScore > 0
            ? 1
            : modelScore < 0
                ? -1
                : 0;

    let activeWeight = 0;
    let strengthSum = 0;
    let agreementWeight = 0;

    for (const item of directionalComponents) {
        const score =
            safeNumber(
                item.component?.score,
                0
            );

        const absoluteScore =
            Math.abs(score);

        if (
            absoluteScore <=
            CONFIG.neutralZone
        ) {
            continue;
        }

        activeWeight +=
            item.weight;

        strengthSum +=
            absoluteScore *
            item.weight;

        if (
            modelDirection !== 0 &&
            Math.sign(score) ===
                modelDirection
        ) {
            agreementWeight +=
                item.weight;
        }
    }

    const directionalStrength =
        activeWeight > 0
            ? strengthSum /
              activeWeight
            : Math.abs(
                modelScore
            );

    const agreement =
        activeWeight > 0
            ? agreementWeight /
              activeWeight
            : 0;

    const volatilityModifier =
        clamp(
            safeNumber(
                volatility.confidence,
                50
            ) / 100,
            0.50,
            1
        );

    const qualityModifier =
        clamp(
            featureQuality / 100,
            0.50,
            1
        );

    const agreementFactor =
        0.65 +
        agreement * 0.35;

    const volatilityAdjustment =
        0.85 +
        volatilityModifier * 0.15;

    const qualityAdjustment =
        0.90 +
        qualityModifier * 0.10;

    let confidence =
        (
            50 +
            directionalStrength * 50
        ) *
        agreementFactor *
        volatilityAdjustment *
        qualityAdjustment;

    confidence =
        clamp(
            confidence,
            0,
            100
        );

    // --------------------------------------------------------
    // Determine direction
    // --------------------------------------------------------

    let direction =
        probability.up >
        probability.down
            ? "UP"
            : "DOWN";

    // --------------------------------------------------------
    // Determine signal
    // --------------------------------------------------------

    let signal = "SKIP";
    let reason = "";

    if (
        featureQuality <
        CONFIG.minimumFeatureQuality
    ) {
        signal = "SKIP";

        reason =
            "FEATURE_QUALITY_TOO_LOW";
    } else if (
        confidence <
        CONFIG.minimumConfidenceForSignal
    ) {
        signal = "SKIP";

        reason =
            "CONFIDENCE_TOO_LOW";
    } else if (
        conflict.level === "HIGH" &&
        confidence <
            CONFIG.strongConfidence
    ) {
        signal = "SKIP";

        reason =
            "SIGNAL_CONFLICT";
    } else if (
        direction === "UP"
    ) {
        signal = "UP";

        reason =
            "BULLISH_FEATURE_ALIGNMENT";
    } else {
        signal = "DOWN";

        reason =
            "BEARISH_FEATURE_ALIGNMENT";
    }

    // --------------------------------------------------------
    // Confidence classification
    // --------------------------------------------------------

    let confidenceLevel =
        "LOW";

    if (
        confidence >=
        CONFIG.extremeConfidence
    ) {
        confidenceLevel =
            "EXTREME";
    } else if (
        confidence >=
        CONFIG.strongConfidence
    ) {
        confidenceLevel =
            "STRONG";
    } else if (
        confidence >=
        CONFIG.minimumConfidenceForSignal
    ) {
        confidenceLevel =
            "MODERATE";
    }

    // --------------------------------------------------------
    // Final result
    // --------------------------------------------------------

    return {
        timestamp:
            Date.now(),

        signal,

        direction,

        reason,

        upProbability:
            round(
                probability.up,
                2
            ),

        downProbability:
            round(
                probability.down,
                2
            ),

        confidence:
            round(
                confidence,
                2
            ),

        confidenceLevel,

        modelScore:
            round(
                modelScore,
                4
            ),

        featureQuality:
            round(
                featureQuality,
                2
            ),

        conflict: {
            level:
                conflict.level,

            score:
                round(
                    conflict.conflict,
                    4
                ),

            bullishComponents:
                conflict.bullish,

            bearishComponents:
                conflict.bearish,

            activeComponents:
                conflict.active
        },

        components: {
            momentum: {
                score:
                    round(
                        momentum.score,
                        4
                    ),

                confidence:
                    round(
                        momentum.confidence,
                        2
                    ),

                direction:
                    momentum.direction,

                details:
                    momentum.components
            },

            orderBook: {
                score:
                    round(
                        orderBook.score,
                        4
                    ),

                confidence:
                    round(
                        orderBook.confidence,
                        2
                    ),

                direction:
                    orderBook.direction,

                details:
                    orderBook.components
            },

            tradePressure: {
                score:
                    round(
                        tradePressure.score,
                        4
                    ),

                confidence:
                    round(
                        tradePressure.confidence,
                        2
                    ),

                direction:
                    tradePressure.direction,

                details:
                    tradePressure.components
            },

            volatility: {
                score:
                    round(
                        volatility.score,
                        4
                    ),

                confidence:
                    round(
                        volatility.confidence,
                        2
                    ),

                regime:
                    volatility.regime,

                details:
                    volatility.components
            },

            microstructure: {
                score:
                    round(
                        microstructure.score,
                        4
                    ),

                confidence:
                    round(
                        microstructure.confidence,
                        2
                    ),

                details:
                    microstructure.components
            },

            trend: {
                score:
                    round(
                        trend.score,
                        4
                    ),

                confidence:
                    round(
                        trend.confidence,
                        2
                    ),

                direction:
                    trend.direction,

                details:
                    trend.components
            }
        }
    };
}

// ============================================================
// HUMAN-READABLE REPORT
// ============================================================

function printProbabilityReport(
    result
) {
    if (!result) {
        return;
    }

    console.log("");

    console.log(
        "========== ZEUS PROBABILITY ENGINE =========="
    );

    console.log(
        `Signal: ${result.signal}`
    );

    console.log(
        `Direction: ${result.direction || "NEUTRAL"}`
    );

    console.log(
        `UP Probability: ${result.upProbability}%`
    );

    console.log(
        `DOWN Probability: ${result.downProbability}%`
    );

    console.log(
        `Confidence: ${result.confidence}% (${result.confidenceLevel})`
    );

    console.log(
        `Feature Quality: ${result.featureQuality}%`
    );

    console.log(
        `Model Score: ${result.modelScore}`
    );

    console.log(
        `Conflict: ${result.conflict.level}`
    );

    console.log(
        `Reason: ${result.reason}`
    );

    console.log(
        "----------------------------------------------"
    );

    console.log(
        `Momentum: ${
            result.components.momentum.direction
        } (${result.components.momentum.score})`
    );

    console.log(
        `Order Book: ${
            result.components.orderBook.direction
        } (${result.components.orderBook.score})`
    );

    console.log(
        `Trade Pressure: ${
            result.components.tradePressure.direction
        } (${result.components.tradePressure.score})`
    );

    console.log(
        `Volatility: ${
            result.components.volatility.regime
        }`
    );

    console.log(
        `Trend: ${
            result.components.trend.direction
        } (${result.components.trend.score})`
    );

    console.log(
        "=============================================="
    );
}

// ============================================================
// TEST HELPERS
// ============================================================

function createTestSnapshot(overrides = {}) {
    return {
        dataQuality: 90,

        featureQuality: 90,

        movements: {
            15: 0,
            30: 0,
            60: 0,
            180: 0,
            300: 0
        },

        orderBook: {
            combined: {
                imbalance: 0
            }
        },

        trades: {
            recent15s: {
                imbalance: 0
            },

            recent30s: {
                imbalance: 0
            },

            recent60s: {
                imbalance: 0
            }
        },

        volatility: {
            realized15s: 0.000025,
            realized30s: 0.000030,
            realized60s: 0.000035
        },

        features: {
            imbalance5: 0,
            imbalance10: 0,
            imbalance25: 0,

            shortTermAcceleration: 0,

            averageSpreadPercent:
                0.00008,

            crossExchangeDifferencePercent:
                0.0015
        },

        ...overrides
    };
}

// ============================================================
// DIRECT TESTS
// ============================================================
// These tests do NOT connect to an exchange.
// They do NOT trade.
//
// IMPORTANT:
// Every test creates its OWN snapshot.
// This prevents one test from accidentally reusing
// another test's market data.
// ============================================================

if (
    require.main === module
) {
    console.log(
        "=============================================="
    );

    console.log(
        "     ZEUS PROBABILITY ENGINE TESTS"
    );

    console.log(
        "=============================================="
    );

    // ========================================================
    // TEST 1
    // Strong bullish market
    // ========================================================

    console.log("");
    console.log(
        "TEST 1: STRONG BULLISH MARKET"
    );

    const bullishSnapshot =
        createTestSnapshot({
            movements: {
                15: 0.0200,
                30: 0.0350,
                60: 0.0500,
                180: 0.0300,
                300: 0.0150
            },

            orderBook: {
                combined: {
                    imbalance: 0.35
                }
            },

            trades: {
                recent15s: {
                    imbalance: 0.55
                },

                recent30s: {
                    imbalance: 0.62
                },

                recent60s: {
                    imbalance: 0.70
                }
            },

            features: {
                imbalance5: 0.45,
                imbalance10: 0.38,
                imbalance25: 0.20,

                shortTermAcceleration:
                    0.0150,

                averageSpreadPercent:
                    0.00008,

                crossExchangeDifferencePercent:
                    0.0015
            }
        });

    const bullishResult =
        calculateProbability(
            bullishSnapshot
        );

    printProbabilityReport(
        bullishResult
    );

    // ========================================================
    // TEST 2
    // Completely flat market
    // ========================================================

    console.log("");
    console.log(
        "TEST 2: FLAT MARKET"
    );

    const flatSnapshot =
        createTestSnapshot({
            movements: {
                15: 0,
                30: 0,
                60: 0,
                180: 0,
                300: 0
            },

            orderBook: {
                combined: {
                    imbalance: 0
                }
            },

            trades: {
                recent15s: {
                    imbalance: 0
                },

                recent30s: {
                    imbalance: 0
                },

                recent60s: {
                    imbalance: 0
                }
            },

            features: {
                imbalance5: 0,
                imbalance10: 0,
                imbalance25: 0,

                shortTermAcceleration:
                    0,

                averageSpreadPercent:
                    0.00008,

                crossExchangeDifferencePercent:
                    0.0015
            }
        });

    const flatResult =
        calculateProbability(
            flatSnapshot
        );

    printProbabilityReport(
        flatResult
    );

    // ========================================================
    // TEST 3
    // Strong bearish market
    // ========================================================

    console.log("");
    console.log(
        "TEST 3: STRONG BEARISH MARKET"
    );

    const bearishSnapshot =
        createTestSnapshot({
            movements: {
                15: -0.0200,
                30: -0.0350,
                60: -0.0500,
                180: -0.0300,
                300: -0.0150
            },

            orderBook: {
                combined: {
                    imbalance: -0.35
                }
            },

            trades: {
                recent15s: {
                    imbalance: -0.55
                },

                recent30s: {
                    imbalance: -0.62
                },

                recent60s: {
                    imbalance: -0.70
                }
            },

            features: {
                imbalance5: -0.45,
                imbalance10: -0.38,
                imbalance25: -0.20,

                shortTermAcceleration:
                    -0.0150,

                averageSpreadPercent:
                    0.00008,

                crossExchangeDifferencePercent:
                    0.0015
            }
        });

    const bearishResult =
        calculateProbability(
            bearishSnapshot
        );

    printProbabilityReport(
        bearishResult
    );

    // ========================================================
    // TEST 4
    // Realistic mixed market
    // ========================================================

    console.log("");
    console.log(
        "TEST 4: REALISTIC MIXED MARKET"
    );

    const mixedSnapshot =
        createTestSnapshot({
            movements: {
                15: 0.0020,
                30: 0.0080,
                60: 0.0120,
                180: 0.0200,
                300: 0.0100
            },

            orderBook: {
                combined: {
                    imbalance: -0.10
                }
            },

            trades: {
                recent15s: {
                    imbalance: -0.08
                },

                recent30s: {
                    imbalance: -0.12
                },

                recent60s: {
                    imbalance: -0.15
                }
            },

            features: {
                imbalance5: -0.12,
                imbalance10: -0.08,
                imbalance25: -0.04,

                shortTermAcceleration:
                    0.0020,

                averageSpreadPercent:
                    0.000566,

                crossExchangeDifferencePercent:
                    -0.001184
            }
        });

    const mixedResult =
        calculateProbability(
            mixedSnapshot
        );

    printProbabilityReport(
        mixedResult
    );

    // ========================================================
    // TEST 5
    // Poor feature quality
    // ========================================================

    console.log("");
    console.log(
        "TEST 5: POOR FEATURE QUALITY"
    );

    const poorQualitySnapshot =
        createTestSnapshot({
            featureQuality: 35,

            dataQuality: 35,

            movements: {
                15: 0.0400,
                30: 0.0500,
                60: 0.0600,
                180: 0.0400,
                300: 0.0300
            },

            orderBook: {
                combined: {
                    imbalance: 0.50
                }
            },

            trades: {
                recent15s: {
                    imbalance: 0.70
                },

                recent30s: {
                    imbalance: 0.75
                },

                recent60s: {
                    imbalance: 0.80
                }
            },

            features: {
                imbalance5: 0.60,
                imbalance10: 0.55,
                imbalance25: 0.40,

                shortTermAcceleration:
                    0.0200,

                averageSpreadPercent:
                    0.00008,

                crossExchangeDifferencePercent:
                    0.0015
            }
        });

    const poorQualityResult =
        calculateProbability(
            poorQualitySnapshot
        );

    printProbabilityReport(
        poorQualityResult
    );

    // ========================================================
    // TEST 6
    // High conflict
    // ========================================================

    console.log("");
    console.log(
        "TEST 6: HIGH-CONFLICT MARKET"
    );

    const conflictSnapshot =
        createTestSnapshot({
            movements: {
                15: 0.0600,
                30: 0.0600,
                60: 0.0500,
                180: 0.0400,
                300: 0.0300
            },

            orderBook: {
                combined: {
                    imbalance: -0.60
                }
            },

            trades: {
                recent15s: {
                    imbalance: -0.70
                },

                recent30s: {
                    imbalance: -0.65
                },

                recent60s: {
                    imbalance: -0.60
                }
            },

            features: {
                imbalance5: -0.55,
                imbalance10: -0.50,
                imbalance25: -0.40,

                shortTermAcceleration:
                    0.0250,

                averageSpreadPercent:
                    0.00008,

                crossExchangeDifferencePercent:
                    0.0015
            }
        });

    const conflictResult =
        calculateProbability(
            conflictSnapshot
        );

    printProbabilityReport(
        conflictResult
    );

    // ========================================================
    // TEST 7
    // Missing features
    // ========================================================

    console.log("");
    console.log(
        "TEST 7: MISSING FEATURES"
    );

    const missingSnapshot = {
        dataQuality: 90,
        featureQuality: 90
    };

    const missingResult =
        calculateProbability(
            missingSnapshot
        );

    printProbabilityReport(
        missingResult
    );

    // ========================================================
    // TEST SUMMARY
    // ========================================================

    console.log("");
    console.log(
        "=============================================="
    );

    console.log(
        "          ZEUS TEST SUMMARY"
    );

    console.log(
        "=============================================="
    );

    console.log(
        `TEST 1 bullish signal: ${bullishResult.signal}`
    );

    console.log(
        `TEST 2 flat signal: ${flatResult.signal}`
    );

    console.log(
        `TEST 3 bearish signal: ${bearishResult.signal}`
    );

    console.log(
        `TEST 4 mixed signal: ${mixedResult.signal}`
    );

    console.log(
        `TEST 5 poor-quality signal: ${poorQualityResult.signal}`
    );

    console.log(
        `TEST 6 conflict signal: ${conflictResult.signal}`
    );

    console.log(
        `TEST 7 missing-data signal: ${missingResult.signal}`
    );

    console.log(
        "=============================================="
    );

    console.log("");
    console.log(
        "Probability engine tests complete."
    );

    console.log(
        "No exchange connection was made."
    );

    console.log(
        "No trades were placed."
    );

    console.log(
        "=============================================="
    );
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    calculateProbability,
    printProbabilityReport,

    calculateMomentumScore,
    calculateOrderBookScore,
    calculateTradePressureScore,
    calculateVolatilityScore,
    calculateMicrostructureScore,
    calculateTrendScore,
    calculateConflict,

    CONFIG
};