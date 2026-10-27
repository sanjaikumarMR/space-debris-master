import { getStationState, getTleEpoch } from './satellite_util.js';
import { getTleHistoryFingerprint, LSTM_MINIMUM_HISTORY } from './trajectory_history.js';

const MODEL_PREFIX = 'space-debris-lstm-';
const METADATA_PREFIX = 'space-debris-lstm-metadata-';
const SEQUENCE_LENGTH = 6;
const FEATURE_COUNT = 7;
const OUTPUT_COUNT = 6;
const POSITION_SCALE_KM = 7000;
const VELOCITY_SCALE_KM_PER_SECOND = 8;

function toNormalizedFeatures(observation, targetDate) {
    const epoch = getTleEpoch(observation);
    const state = getStationState(observation, targetDate);
    if (!epoch || !state) return null;
    const ageDays = (targetDate.getTime() - epoch.getTime()) / 86400000;
    if (ageDays < -1 || !Number.isFinite(ageDays)) return null;
    return [
        state.eciPosition.x / POSITION_SCALE_KM,
        state.eciPosition.y / POSITION_SCALE_KM,
        state.eciPosition.z / POSITION_SCALE_KM,
        state.eciVelocity.x / VELOCITY_SCALE_KM_PER_SECOND,
        state.eciVelocity.y / VELOCITY_SCALE_KM_PER_SECOND,
        state.eciVelocity.z / VELOCITY_SCALE_KM_PER_SECOND,
        Math.min(ageDays, 100) / 100,
    ];
}

function toNormalizedTarget(observation, targetDate) {
    const state = getStationState(observation, targetDate);
    if (!state) return null;
    return [
        state.eciPosition.x / POSITION_SCALE_KM,
        state.eciPosition.y / POSITION_SCALE_KM,
        state.eciPosition.z / POSITION_SCALE_KM,
        state.eciVelocity.x / VELOCITY_SCALE_KM_PER_SECOND,
        state.eciVelocity.y / VELOCITY_SCALE_KM_PER_SECOND,
        state.eciVelocity.z / VELOCITY_SCALE_KM_PER_SECOND,
    ];
}

function buildTrainingSamples(observations) {
    const sorted = [...observations]
        .map(observation => ({ ...observation, epoch: getTleEpoch(observation) }))
        .filter(observation => observation.epoch)
        .sort((left, right) => left.epoch - right.epoch);
    const inputs = [];
    const targets = [];

    for (let targetIndex = SEQUENCE_LENGTH; targetIndex < sorted.length; targetIndex++) {
        const targetObservation = sorted[targetIndex];
        const targetDate = targetObservation.epoch;
        const sequence = sorted.slice(targetIndex - SEQUENCE_LENGTH, targetIndex)
            .map(observation => toNormalizedFeatures(observation, targetDate));
        const absoluteTarget = toNormalizedTarget(targetObservation, targetDate);
        if (sequence.every(Boolean) && absoluteTarget) {
            const baseline = sequence[sequence.length - 1].slice(0, OUTPUT_COUNT);
            inputs.push(sequence);
            targets.push(absoluteTarget.map((value, index) => value - baseline[index]));
        }
    }

    return { inputs, targets };
}

export function getLstmModelMetadata(catalogId) {
    try {
        const serialized = localStorage.getItem(`${METADATA_PREFIX}${catalogId}`);
        return serialized ? JSON.parse(serialized) : null;
    } catch (error) {
        console.warn(`Could not read LSTM model metadata for NORAD ${catalogId}:`, error);
        return null;
    }
}

export function saveLstmModelMetadata(catalogId, metadata) {
    localStorage.setItem(`${METADATA_PREFIX}${catalogId}`, JSON.stringify(metadata));
}

export async function trainLstmModel(catalogId, observations, onEpochEnd = () => {}) {
    if (observations.length < LSTM_MINIMUM_HISTORY) {
        throw new Error(`At least ${LSTM_MINIMUM_HISTORY} distinct historical TLEs are required; found ${observations.length}.`);
    }
    const { inputs, targets } = buildTrainingSamples(observations);
    const validationCount = Math.max(3, Math.ceil(inputs.length * 0.2));
    const trainingCount = inputs.length - validationCount;
    if (trainingCount < 12) {
        throw new Error(`Not enough valid chronological training samples (${inputs.length}); at least 15 are required.`);
    }

    const tf = await import('@tensorflow/tfjs');
    if (typeof document === 'undefined' && !(await tf.setBackend('cpu'))) {
        throw new Error('TensorFlow.js could not initialize its CPU backend in the training worker.');
    }
    await tf.ready();
    const trainingInputs = tf.tensor3d(inputs.slice(0, trainingCount));
    const trainingTargets = tf.tensor2d(targets.slice(0, trainingCount));
    const validationInputs = tf.tensor3d(inputs.slice(trainingCount));
    const validationTargets = tf.tensor2d(targets.slice(trainingCount));
    const model = tf.sequential();
    model.add(tf.layers.lstm({
        units: 16,
        inputShape: [SEQUENCE_LENGTH, FEATURE_COUNT],
        recurrentActivation: 'sigmoid',
    }));
    model.add(tf.layers.dense({ units: OUTPUT_COUNT }));
    model.compile({ optimizer: tf.train.adam(0.005), loss: 'meanSquaredError' });

    let validationPrediction;
    try {
        await model.fit(trainingInputs, trainingTargets, {
            epochs: 60,
            batchSize: Math.min(16, trainingCount),
            shuffle: false,
            validationData: [validationInputs, validationTargets],
            callbacks: [
                tf.callbacks.earlyStopping({ monitor: 'val_loss', patience: 7 }),
                new tf.CustomCallback({
                    onEpochEnd: async epoch => onEpochEnd(epoch + 1, 60),
                }),
            ],
            verbose: 0,
        });
        validationPrediction = model.predict(validationInputs);
        const predictedValues = await validationPrediction.array();
        const actualValues = await validationTargets.array();
        const lstmMse = meanSquaredError(predictedValues, actualValues);
        const baselineValues = actualValues.map(row => row.map(() => 0));
        const persistenceMse = meanSquaredError(baselineValues, actualValues);
        if (!Number.isFinite(lstmMse) || !Number.isFinite(persistenceMse)) {
            throw new Error('LSTM validation produced non-finite error metrics.');
        }

        const metadata = {
            version: 2,
            trainedAt: new Date().toISOString(),
            observationCount: observations.length,
            historyFingerprint: getTleHistoryFingerprint(observations),
            trainingSampleCount: trainingCount,
            validationSampleCount: validationCount,
            validationMse: lstmMse,
            persistenceBaselineMse: persistenceMse,
            beatsPersistenceBaseline: lstmMse < persistenceMse,
        };
        await model.save(`indexeddb://${MODEL_PREFIX}${catalogId}`);
        return metadata;
    } finally {
        if (validationPrediction) validationPrediction.dispose();
        trainingInputs.dispose();
        trainingTargets.dispose();
        validationInputs.dispose();
        validationTargets.dispose();
        model.optimizer.dispose();
        model.dispose();
    }
}

function meanSquaredError(predicted, actual) {
    let sum = 0;
    let count = 0;
    for (let row = 0; row < actual.length; row++) {
        for (let column = 0; column < actual[row].length; column++) {
            const difference = predicted[row][column] - actual[row][column];
            sum += difference * difference;
            count++;
        }
    }
    return sum / count;
}

export async function predictLstmState(catalogId, observations, targetDate, currentHistoryFingerprint) {
    const metadata = getLstmModelMetadata(catalogId);
    if (!metadata) return null;
    if (metadata.version !== 2) {
        throw new Error('The saved LSTM uses an older prediction format. Select this object to retrain it.');
    }
    if (metadata.historyFingerprint !== currentHistoryFingerprint) {
        throw new Error('The saved LSTM was trained on a different TLE history. Import and train it again.');
    }
    const history = [...observations]
        .map(observation => ({ ...observation, epoch: getTleEpoch(observation) }))
        .filter(observation => observation.epoch && observation.epoch <= targetDate)
        .sort((left, right) => left.epoch - right.epoch);
    const sequenceObservations = history.slice(-SEQUENCE_LENGTH);
    if (sequenceObservations.length < SEQUENCE_LENGTH) return null;
    const sequence = sequenceObservations.map(observation => toNormalizedFeatures(observation, targetDate));
    if (!sequence.every(Boolean)) return null;

    const tf = await import('@tensorflow/tfjs');
    await tf.ready();
    let model;
    let input;
    let prediction;
    try {
        model = await tf.loadLayersModel(`indexeddb://${MODEL_PREFIX}${catalogId}`);
        input = tf.tensor3d([sequence]);
        prediction = model.predict(input);
        const residual = (await prediction.array())[0];
        const baseline = sequence[sequence.length - 1].slice(0, OUTPUT_COUNT);
        const values = residual.map((value, index) => value + baseline[index]);
        const state = {
            position: {
                x: values[0] * POSITION_SCALE_KM,
                y: values[1] * POSITION_SCALE_KM,
                z: values[2] * POSITION_SCALE_KM,
            },
            velocity: {
                x: values[3] * VELOCITY_SCALE_KM_PER_SECOND,
                y: values[4] * VELOCITY_SCALE_KM_PER_SECOND,
                z: values[5] * VELOCITY_SCALE_KM_PER_SECOND,
            },
        };
        if (Object.values(state.position).concat(Object.values(state.velocity)).some(value => !Number.isFinite(value))) {
            throw new Error('The saved LSTM model returned an invalid state.');
        }
        return { ...state, metadata };
    } finally {
        if (prediction) prediction.dispose();
        if (input) input.dispose();
        if (model) model.dispose();
    }
}
