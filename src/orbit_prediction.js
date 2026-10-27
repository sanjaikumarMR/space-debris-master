import { getStationState, getTleEpoch } from './satellite_util.js';
import { degreesLat, degreesLong, eciToEcf, eciToGeodetic, gstime } from 'satellite.js/lib/index';
import { REAL_EARTH_RADIUS, SCALE_RATIO } from './constants.js';
import { getScaledCoordinates } from './satellite_util.js';

const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MAX_TLE_AGE_DAYS = 30;
const KM_PER_EARTH_RADIUS = 1 / SCALE_RATIO;
const EARTH_GRAVITATIONAL_PARAMETER = 398600.4418;
const SIMULATED_PERIGEE_ALTITUDE_KM = -20;
const PROPAGATION_STEP_SECONDS = 5;

function hasRecentTle(station, date) {
    const epoch = getTleEpoch(station);
    if (!epoch) return false;
    const ageDays = (date.getTime() - epoch.getTime()) / (24 * 60 * 60 * 1000);
    return ageDays >= -1 && ageDays <= MAX_TLE_AGE_DAYS;
}

function orbitPerigeeRadius(position, velocity) {
    const radius = Math.hypot(position.x, position.y, position.z);
    const speedSquared = velocity.x ** 2 + velocity.y ** 2 + velocity.z ** 2;
    const angularMomentum = {
        x: position.y * velocity.z - position.z * velocity.y,
        y: position.z * velocity.x - position.x * velocity.z,
        z: position.x * velocity.y - position.y * velocity.x,
    };
    const angularMomentumSquared = angularMomentum.x ** 2 + angularMomentum.y ** 2 + angularMomentum.z ** 2;
    const specificEnergy = speedSquared / 2 - EARTH_GRAVITATIONAL_PARAMETER / radius;
    const eccentricitySquared = 1 + (2 * specificEnergy * angularMomentumSquared) / EARTH_GRAVITATIONAL_PARAMETER ** 2;
    if (specificEnergy >= 0 || eccentricitySquared < 0 || !Number.isFinite(eccentricitySquared)) {
        return null;
    }
    const semiMajorAxis = -EARTH_GRAVITATIONAL_PARAMETER / (2 * specificEnergy);
    return semiMajorAxis * (1 - Math.sqrt(eccentricitySquared));
}

function gravityAcceleration(position) {
    const radius = Math.hypot(position.x, position.y, position.z);
    const scale = -EARTH_GRAVITATIONAL_PARAMETER / radius ** 3;
    return { x: position.x * scale, y: position.y * scale, z: position.z * scale };
}

function addScaled(vector, derivative, scale) {
    return {
        x: vector.x + derivative.x * scale,
        y: vector.y + derivative.y * scale,
        z: vector.z + derivative.z * scale,
    };
}

function atmosphericAcceleration(position, velocity, date, model) {
    if (!model || !date) return { x: 0, y: 0, z: 0 };
    const radius = Math.hypot(position.x, position.y, position.z);
    const altitudeKm = radius - REAL_EARTH_RADIUS;
    if (altitudeKm > 130 || altitudeKm < 70) return { x: 0, y: 0, z: 0 };

    const density = Math.min(1.225, 1.225 * Math.exp(-Math.max(0, altitudeKm) / 7.2)) *
        model.densityScale;
    const longitude = eciToGeodetic(position, gstime(date)).longitude;
    const theta = gstime(date);
    const eastEcf = { x: -Math.sin(longitude), y: Math.cos(longitude), z: 0 };
    const eastEci = {
        x: eastEcf.x * Math.cos(theta) - eastEcf.y * Math.sin(theta),
        y: eastEcf.x * Math.sin(theta) + eastEcf.y * Math.cos(theta),
        z: 0,
    };
    const atmosphereVelocity = {
        x: -EARTH_ROTATION_RAD_PER_SECOND * position.y + eastEci.x * model.windEastMps / 1000,
        y: EARTH_ROTATION_RAD_PER_SECOND * position.x + eastEci.y * model.windEastMps / 1000,
        z: 0,
    };
    const relativeVelocity = {
        x: velocity.x - atmosphereVelocity.x,
        y: velocity.y - atmosphereVelocity.y,
        z: velocity.z - atmosphereVelocity.z,
    };
    const relativeSpeedMps = Math.hypot(relativeVelocity.x, relativeVelocity.y, relativeVelocity.z) * 1000;
    const accelerationScale = -0.5 * density * model.dragCoefficient * model.referenceAreaM2 /
        model.massKg * relativeSpeedMps;
    return {
        x: relativeVelocity.x * accelerationScale,
        y: relativeVelocity.y * accelerationScale,
        z: relativeVelocity.z * accelerationScale,
    };
}

const EARTH_ROTATION_RAD_PER_SECOND = 7.2921159e-5;

function totalAcceleration(position, velocity, date, atmosphereModel) {
    const gravity = gravityAcceleration(position);
    const drag = atmosphericAcceleration(position, velocity, date, atmosphereModel);
    return {
        x: gravity.x + drag.x,
        y: gravity.y + drag.y,
        z: gravity.z + drag.z,
    };
}

function integrateOrbitStep(position, velocity, stepSeconds, date = null, atmosphereModel = null) {
    const acceleration1 = totalAcceleration(position, velocity, date, atmosphereModel);
    const velocity2 = addScaled(velocity, acceleration1, stepSeconds / 2);
    const position2 = addScaled(position, velocity, stepSeconds / 2);
    const acceleration2 = totalAcceleration(
        position2,
        velocity2,
        date ? new Date(date.getTime() + stepSeconds * 500) : null,
        atmosphereModel
    );
    const velocity3 = addScaled(velocity, acceleration2, stepSeconds / 2);
    const position3 = addScaled(position, velocity2, stepSeconds / 2);
    const acceleration3 = totalAcceleration(
        position3,
        velocity3,
        date ? new Date(date.getTime() + stepSeconds * 500) : null,
        atmosphereModel
    );
    const velocity4 = addScaled(velocity, acceleration3, stepSeconds);
    const position4 = addScaled(position, velocity3, stepSeconds);
    const acceleration4 = totalAcceleration(
        position4,
        velocity4,
        date ? new Date(date.getTime() + stepSeconds * 1000) : null,
        atmosphereModel
    );
    const weightedPositionRate = {
        x: velocity.x + 2 * velocity2.x + 2 * velocity3.x + velocity4.x,
        y: velocity.y + 2 * velocity2.y + 2 * velocity3.y + velocity4.y,
        z: velocity.z + 2 * velocity2.z + 2 * velocity3.z + velocity4.z,
    };
    const weightedAcceleration = {
        x: acceleration1.x + 2 * acceleration2.x + 2 * acceleration3.x + acceleration4.x,
        y: acceleration1.y + 2 * acceleration2.y + 2 * acceleration3.y + acceleration4.y,
        z: acceleration1.z + 2 * acceleration2.z + 2 * acceleration3.z + acceleration4.z,
    };

    return {
        position: addScaled(position, weightedPositionRate, stepSeconds / 6),
        velocity: addScaled(velocity, weightedAcceleration, stepSeconds / 6),
    };
}

export function simulateImmediateDeorbit(
    station,
    startDate,
    allowStaleTle = false,
    estimatedState = null,
    atmosphereModel = null
) {
    if (!allowStaleTle && !hasRecentTle(station, startDate)) {
        throw new Error('A recent TLE (no more than 30 days old) is required for this simulation.');
    }

    const state = estimatedState || getStationState(station, startDate);
    if (!state) throw new Error('Could not propagate this satellite at the selected simulation time.');

    const position = { ...(state.eciPosition || state.position) };
    const velocity = { ...(state.eciVelocity || state.velocity) };
    const radius = Math.hypot(position.x, position.y, position.z);
    const radialSpeed = (
        position.x * velocity.x +
        position.y * velocity.y +
        position.z * velocity.z
    ) / radius;
    const radialVelocity = {
        x: position.x / radius * radialSpeed,
        y: position.y / radius * radialSpeed,
        z: position.z / radius * radialSpeed,
    };
    const tangentialVelocity = {
        x: velocity.x - radialVelocity.x,
        y: velocity.y - radialVelocity.y,
        z: velocity.z - radialVelocity.z,
    };
    const tangentialSpeed = Math.hypot(tangentialVelocity.x, tangentialVelocity.y, tangentialVelocity.z);
    const targetPerigeeRadius = REAL_EARTH_RADIUS + SIMULATED_PERIGEE_ALTITUDE_KM;
    let retrogradeBurn = 0;
    let currentVelocity = velocity;

    if (orbitPerigeeRadius(position, velocity) > targetPerigeeRadius) {
        let low = 0;
        let high = tangentialSpeed;
        for (let iteration = 0; iteration < 60; iteration++) {
            const midpoint = (low + high) / 2;
            const candidateVelocity = {
                x: radialVelocity.x + tangentialVelocity.x * midpoint / tangentialSpeed,
                y: radialVelocity.y + tangentialVelocity.y * midpoint / tangentialSpeed,
                z: radialVelocity.z + tangentialVelocity.z * midpoint / tangentialSpeed,
            };
            const perigeeRadius = orbitPerigeeRadius(position, candidateVelocity);
            if (perigeeRadius !== null && perigeeRadius > targetPerigeeRadius) {
                high = midpoint;
            } else {
                low = midpoint;
            }
        }

        const targetTangentialSpeed = (low + high) / 2;
        retrogradeBurn = tangentialSpeed - targetTangentialSpeed;
        currentVelocity = {
            x: radialVelocity.x + tangentialVelocity.x * targetTangentialSpeed / tangentialSpeed,
            y: radialVelocity.y + tangentialVelocity.y * targetTangentialSpeed / tangentialSpeed,
            z: radialVelocity.z + tangentialVelocity.z * targetTangentialSpeed / tangentialSpeed,
        };
    }

    const path = [];
    let elapsedSeconds = 0;
    let crossing = null;
    let previousPosition = { ...position };
    let previousVelocity = { ...currentVelocity };
    let previousElapsedSeconds = 0;
    const maximumSimulationSeconds = 2 * 60 * 60;
    const integrationStepSeconds = atmosphereModel ? 1 : PROPAGATION_STEP_SECONDS;
    while (elapsedSeconds <= maximumSimulationSeconds) {
        const currentDate = new Date(startDate.getTime() + elapsedSeconds * 1000);
        const currentRadius = Math.hypot(position.x, position.y, position.z);
        if (currentRadius <= REAL_EARTH_RADIUS) {
            let low = 0;
            let high = 1;
            for (let iteration = 0; iteration < 40; iteration++) {
                const midpoint = (low + high) / 2;
                const interpolatedPosition = {
                    x: previousPosition.x + (position.x - previousPosition.x) * midpoint,
                    y: previousPosition.y + (position.y - previousPosition.y) * midpoint,
                    z: previousPosition.z + (position.z - previousPosition.z) * midpoint,
                };
                if (Math.hypot(interpolatedPosition.x, interpolatedPosition.y, interpolatedPosition.z) > REAL_EARTH_RADIUS) {
                    low = midpoint;
                } else {
                    high = midpoint;
                }
            }
            const crossingFraction = (low + high) / 2;
            crossing = {
                position: {
                    x: previousPosition.x + (position.x - previousPosition.x) * crossingFraction,
                    y: previousPosition.y + (position.y - previousPosition.y) * crossingFraction,
                    z: previousPosition.z + (position.z - previousPosition.z) * crossingFraction,
                },
                velocity: {
                    x: previousVelocity.x + (currentVelocity.x - previousVelocity.x) * crossingFraction,
                    y: previousVelocity.y + (currentVelocity.y - previousVelocity.y) * crossingFraction,
                    z: previousVelocity.z + (currentVelocity.z - previousVelocity.z) * crossingFraction,
                },
                date: new Date(startDate.getTime() + (previousElapsedSeconds + (elapsedSeconds - previousElapsedSeconds) * crossingFraction) * 1000),
            };
            path.push(getScaledCoordinates(eciToEcf(crossing.position, gstime(crossing.date))));
            break;
        }

        path.push(getScaledCoordinates(eciToEcf(position, gstime(currentDate))));
        previousPosition = { ...position };
        previousVelocity = { ...currentVelocity };
        previousElapsedSeconds = elapsedSeconds;
        const next = integrateOrbitStep(position, currentVelocity, integrationStepSeconds, currentDate, atmosphereModel);
        position.x = next.position.x;
        position.y = next.position.y;
        position.z = next.position.z;
        currentVelocity = next.velocity;
        elapsedSeconds += integrationStepSeconds;
    }

    if (!crossing) {
        throw new Error('The simulated orbit did not intersect the simplified Earth within two hours.');
    }

    const impact = eciToGeodetic(crossing.position, gstime(crossing.date));
    return {
        path,
        impact: {
            latitude: degreesLat(impact.latitude),
            longitude: degreesLong(impact.longitude),
            date: crossing.date,
            velocityKmPerSecond: Math.hypot(
                crossing.velocity.x,
                crossing.velocity.y,
                crossing.velocity.z
            ),
        },
        burnDeltaV: retrogradeBurn * 1000,
        simulatedPerigeeAltitude: SIMULATED_PERIGEE_ALTITUDE_KM,
    };
}

export function predictOrbit(station, startDate, hours = 24, sampleMinutes = 10, allowStaleTle = false) {
    if (!allowStaleTle && !hasRecentTle(station, startDate)) return [];

    const points = [];
    const sampleCount = Math.ceil((hours * MINUTES_PER_HOUR) / sampleMinutes);

    for (let sample = 0; sample <= sampleCount; sample++) {
        const sampleDate = new Date(startDate.getTime() + sample * sampleMinutes * SECONDS_PER_MINUTE * 1000);
        const state = getStationState(station, sampleDate);
        if (state) points.push(state.position);
    }

    return points;
}

export function estimateBayesianTleState(station, observations, startDate) {
    const uniqueTles = new Map();
    for (const observation of [...observations, station]) {
        const key = `${observation.tleLine1}\n${observation.tleLine2}`;
        uniqueTles.set(key, observation);
    }

    const measurements = [...uniqueTles.values()]
        .map(observation => {
            const epoch = getTleEpoch(observation);
            const state = getStationState(observation, startDate);
            if (!epoch || !state) return null;

            const ageDays = Math.max(0, (startDate.getTime() - epoch.getTime()) / (24 * 60 * 60 * 1000));
            const positionSigmaKm = 2 + ageDays * 0.05;
            const velocitySigmaKmPerSecond = 0.002 + ageDays * 0.00005;
            return {
                epoch,
                values: [
                    state.eciPosition.x,
                    state.eciPosition.y,
                    state.eciPosition.z,
                    state.eciVelocity.x,
                    state.eciVelocity.y,
                    state.eciVelocity.z,
                ],
                variances: [
                    positionSigmaKm ** 2,
                    positionSigmaKm ** 2,
                    positionSigmaKm ** 2,
                    velocitySigmaKmPerSecond ** 2,
                    velocitySigmaKmPerSecond ** 2,
                    velocitySigmaKmPerSecond ** 2,
                ],
            };
        })
        .filter(Boolean)
        .sort((left, right) => left.epoch - right.epoch);

    if (measurements.length === 0) {
        throw new Error('No TLE snapshots could be propagated to the selected simulation time.');
    }

    const state = [...measurements[0].values];
    const covariance = [...measurements[0].variances];
    for (const measurement of measurements.slice(1)) {
        for (let component = 0; component < state.length; component++) {
            const measurementVariance = measurement.variances[component];
            const gain = covariance[component] / (covariance[component] + measurementVariance);
            state[component] += gain * (measurement.values[component] - state[component]);
            covariance[component] *= 1 - gain;
        }
    }

    return {
        position: { x: state[0], y: state[1], z: state[2] },
        velocity: { x: state[3], y: state[4], z: state[5] },
        positionStandardDeviationsKm: covariance.slice(0, 3).map(Math.sqrt),
        velocityStandardDeviationsKmPerSecond: covariance.slice(3, 6).map(Math.sqrt),
        positionUncertaintyKm: Math.sqrt(Math.max(...covariance.slice(0, 3))),
        velocityUncertaintyKmPerSecond: Math.sqrt(Math.max(...covariance.slice(3, 6))),
        measurementCount: measurements.length,
        method: 'identity-observation linear Kalman filter (Bayesian update)',
    };
}

export function predictBayesianTrajectory(estimate, startDate, hours = 24) {
    const stepSeconds = 30;
    const sampleEverySteps = 20;
    const totalSteps = Math.ceil(hours * MINUTES_PER_HOUR * SECONDS_PER_MINUTE / stepSeconds);
    const path = [];
    let position = { ...estimate.position };
    let velocity = { ...estimate.velocity };

    for (let step = 0; step <= totalSteps; step++) {
        if (step % sampleEverySteps === 0 || step === totalSteps) {
            const sampleDate = new Date(startDate.getTime() + step * stepSeconds * 1000);
            path.push(getScaledCoordinates(eciToEcf(position, gstime(sampleDate))));
        }
        if (step < totalSteps) {
            const next = integrateOrbitStep(position, velocity, stepSeconds);
            position = next.position;
            velocity = next.velocity;
        }
    }
    return path;
}

export function simulateHypotheticalBreakup(station, startDate, fragmentCount = 8, hours = 24) {
    if (!hasRecentTle(station, startDate)) {
        throw new Error('A current TLE (no more than 30 days old) is required for a breakup scenario.');
    }
    const state = getStationState(station, startDate);
    if (!state) throw new Error('Could not propagate the selected object for a breakup scenario.');
    if (!Number.isInteger(fragmentCount) || fragmentCount < 2 || fragmentCount > 16) {
        throw new Error('The illustrative breakup must contain between 2 and 16 fragments.');
    }

    const initialPosition = state.eciPosition;
    const initialVelocity = state.eciVelocity;
    const radius = Math.hypot(initialPosition.x, initialPosition.y, initialPosition.z);
    const radial = {
        x: initialPosition.x / radius,
        y: initialPosition.y / radius,
        z: initialPosition.z / radius,
    };
    const angularMomentum = {
        x: initialPosition.y * initialVelocity.z - initialPosition.z * initialVelocity.y,
        y: initialPosition.z * initialVelocity.x - initialPosition.x * initialVelocity.z,
        z: initialPosition.x * initialVelocity.y - initialPosition.y * initialVelocity.x,
    };
    const momentumMagnitude = Math.hypot(angularMomentum.x, angularMomentum.y, angularMomentum.z);
    if (!momentumMagnitude) throw new Error("Could not define the selected object's orbital frame.");
    const normal = {
        x: angularMomentum.x / momentumMagnitude,
        y: angularMomentum.y / momentumMagnitude,
        z: angularMomentum.z / momentumMagnitude,
    };
    const transverse = {
        x: normal.y * radial.z - normal.z * radial.y,
        y: normal.z * radial.x - normal.x * radial.z,
        z: normal.x * radial.y - normal.y * radial.x,
    };
    const totalSeconds = hours * 3600;
    const stepSeconds = 15;
    const sampleEverySteps = 4;
    const fragmentTrajectories = [];

    for (let fragmentIndex = 0; fragmentIndex < fragmentCount; fragmentIndex++) {
        const z = 1 - (2 * fragmentIndex + 1) / fragmentCount;
        const angle = fragmentIndex * Math.PI * (3 - Math.sqrt(5));
        const planarRadius = Math.sqrt(1 - z * z);
        const radialComponent = planarRadius * Math.cos(angle);
        const transverseComponent = planarRadius * Math.sin(angle);
        const normalComponent = z;
        const kickSpeedKmPerSecond = (20 + (fragmentIndex % 4) * 20) / 1000;
        const position = { ...initialPosition };
        let velocity = {
            x: initialVelocity.x + kickSpeedKmPerSecond * (
                radialComponent * radial.x +
                transverseComponent * transverse.x +
                normalComponent * normal.x
            ),
            y: initialVelocity.y + kickSpeedKmPerSecond * (
                radialComponent * radial.y +
                transverseComponent * transverse.y +
                normalComponent * normal.y
            ),
            z: initialVelocity.z + kickSpeedKmPerSecond * (
                radialComponent * radial.z +
                transverseComponent * transverse.z +
                normalComponent * normal.z
            ),
        };
        let previousPosition = { ...position };
        let previousElapsedSeconds = 0;
        let impact = null;
        const path = [];

        for (let step = 0; step <= Math.ceil(totalSeconds / stepSeconds); step++) {
            const elapsedSeconds = Math.min(step * stepSeconds, totalSeconds);
            const sampleDate = new Date(startDate.getTime() + elapsedSeconds * 1000);
            const currentRadius = Math.hypot(position.x, position.y, position.z);
            if (currentRadius <= REAL_EARTH_RADIUS) {
                let low = 0;
                let high = 1;
                for (let iteration = 0; iteration < 32; iteration++) {
                    const midpoint = (low + high) / 2;
                    const candidate = {
                        x: previousPosition.x + (position.x - previousPosition.x) * midpoint,
                        y: previousPosition.y + (position.y - previousPosition.y) * midpoint,
                        z: previousPosition.z + (position.z - previousPosition.z) * midpoint,
                    };
                    if (Math.hypot(candidate.x, candidate.y, candidate.z) > REAL_EARTH_RADIUS) low = midpoint;
                    else high = midpoint;
                }
                const fraction = (low + high) / 2;
                const impactPosition = {
                    x: previousPosition.x + (position.x - previousPosition.x) * fraction,
                    y: previousPosition.y + (position.y - previousPosition.y) * fraction,
                    z: previousPosition.z + (position.z - previousPosition.z) * fraction,
                };
                const impactDate = new Date(startDate.getTime() + (
                    previousElapsedSeconds + (elapsedSeconds - previousElapsedSeconds) * fraction
                ) * 1000);
                const geodetic = eciToGeodetic(impactPosition, gstime(impactDate));
                path.push(getScaledCoordinates(eciToEcf(impactPosition, gstime(impactDate))));
                impact = {
                    latitude: degreesLat(geodetic.latitude),
                    longitude: degreesLong(geodetic.longitude),
                    date: impactDate,
                };
                break;
            }

            if (step % sampleEverySteps === 0 || elapsedSeconds === totalSeconds) {
                path.push(getScaledCoordinates(eciToEcf(position, gstime(sampleDate))));
            }
            if (elapsedSeconds >= totalSeconds) break;

            previousPosition = { ...position };
            previousElapsedSeconds = elapsedSeconds;
            const next = integrateOrbitStep(position, velocity, stepSeconds, sampleDate);
            position.x = next.position.x;
            position.y = next.position.y;
            position.z = next.position.z;
            velocity = next.velocity;
        }

        fragmentTrajectories.push({ path, impact, kickSpeedMps: kickSpeedKmPerSecond * 1000 });
    }

    return {
        fragments: fragmentTrajectories,
        durationHours: hours,
        assumptions: 'Illustrative point fragments with deterministic 20–80 m/s isotropic velocity offsets; central-Earth gravity only. No collision energy, fragment mass/shape, atmosphere, or survival model.',
    };
}

export function findClosestApproach(stationId, stations, startDate, hours = 24, sampleMinutes = 30) {
    if (!hasRecentTle(stations[stationId], startDate)) return null;

    const sampleCount = Math.ceil((hours * MINUTES_PER_HOUR) / sampleMinutes);
    let closest = null;

    for (let sample = 0; sample <= sampleCount; sample++) {
        const sampleDate = new Date(startDate.getTime() + sample * sampleMinutes * SECONDS_PER_MINUTE * 1000);
        const referenceState = getStationState(stations[stationId], sampleDate);
        if (!referenceState) continue;

        for (let otherId = 0; otherId < stations.length; otherId++) {
            if (otherId === stationId) continue;
            if (!hasRecentTle(stations[otherId], sampleDate)) continue;

            const otherState = getStationState(stations[otherId], sampleDate);
            if (!otherState) continue;

            const dx = referenceState.position[0] - otherState.position[0];
            const dy = referenceState.position[1] - otherState.position[1];
            const dz = referenceState.position[2] - otherState.position[2];
            const distanceKm = Math.sqrt(dx * dx + dy * dy + dz * dz) * KM_PER_EARTH_RADIUS;

            if (!closest || distanceKm < closest.distanceKm) {
                closest = { debrisId: otherId, date: sampleDate, distanceKm };
            }
        }
    }

    return closest;
}
