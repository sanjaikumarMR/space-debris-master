const CESIUM_VERSION = '1.127';
const GOOGLE_TILES_SCRIPT = `https://cesium.com/downloads/cesiumjs/releases/${CESIUM_VERSION}/Build/Cesium/Cesium.js`;
const GOOGLE_TILES_STYLES = `https://cesium.com/downloads/cesiumjs/releases/${CESIUM_VERSION}/Build/Cesium/Widgets/widgets.css`;

let viewer = null;
let pointCollection = null;
let satellitePoints = [];
let overlayEntities = new Set();
let placeEntities = new Set();
let viewerReady = false;
let areaEntity = null;
let selectedObjectEntity = null;
let clickedLocationEntity = null;
let locationLookupId = 0;
const locationStatus = document.getElementById('earth-location-status');
const layerVisibility = {
    satellites: true,
    places: true,
    scenarios: true,
};

function loadCesium() {
    if (window.Cesium) return Promise.resolve(window.Cesium);

    return new Promise((resolve, reject) => {
        const existingScript = document.querySelector(`script[src="${GOOGLE_TILES_SCRIPT}"]`);
        if (existingScript) {
            existingScript.addEventListener('load', () => resolve(window.Cesium), { once: true });
            existingScript.addEventListener('error', () => reject(new Error('CesiumJS could not be loaded.')), { once: true });
            return;
        }

        const stylesheet = document.createElement('link');
        stylesheet.rel = 'stylesheet';
        stylesheet.href = GOOGLE_TILES_STYLES;
        document.head.append(stylesheet);

        const script = document.createElement('script');
        script.src = GOOGLE_TILES_SCRIPT;
        script.async = true;
        script.onload = () => resolve(window.Cesium);
        script.onerror = () => reject(new Error('CesiumJS could not be loaded.'));
        document.head.append(script);
    });
}

export async function initializeGoogleEarth(container, onSelect) {
    const configResponse = await fetch('/api/impact/map-config', {
        headers: { Accept: 'application/json' },
    });
    if (!configResponse.ok) {
        throw new Error(`Google Earth configuration returned HTTP ${configResponse.status}.`);
    }
    const config = await configResponse.json();
    if (!config.tilesApiKey) {
        return { enabled: false, message: 'Google Photorealistic 3D Tiles are not configured; using the built-in globe.' };
    }

    const Cesium = await loadCesium();
    if (!Cesium) throw new Error('CesiumJS loaded without its Cesium API.');

    viewer = new Cesium.Viewer(container, {
        animation: false,
        baseLayerPicker: false,
        baseLayer: false,
        fullscreenButton: false,
        geocoder: false,
        homeButton: false,
        infoBox: false,
        navigationHelpButton: false,
        sceneModePicker: false,
        selectionIndicator: false,
        timeline: false,
        requestRenderMode: true,
    });
    try {
        viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#101923');
        viewer.scene.globe.show = true;

        const tileset = await Cesium.Cesium3DTileset.fromUrl(
            `https://tile.googleapis.com/v1/3dtiles/root.json?key=${encodeURIComponent(config.tilesApiKey)}`
        );
        viewer.scene.primitives.add(tileset);

        pointCollection = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
        pointCollection.show = layerVisibility.satellites;
        viewer.screenSpaceEventHandler.setInputAction(click => {
            const picked = viewer.scene.pick(click.position);
            const selectedId = picked && picked.id;
            if (Number.isInteger(selectedId)) {
                onSelect(selectedId);
                return;
            }
            const cartesian = viewer.scene.pickPositionSupported
                ? viewer.scene.pickPosition(click.position)
                : null;
            const surfacePosition = cartesian || viewer.camera.pickEllipsoid(
                click.position,
                viewer.scene.globe.ellipsoid
            );
            if (surfacePosition) {
                const cartographic = Cesium.Cartographic.fromCartesian(surfacePosition);
                lookupClickedLocation(
                    Cesium.Math.toDegrees(cartographic.latitude),
                    Cesium.Math.toDegrees(cartographic.longitude)
                );
            }
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
        viewer.camera.setView({
            destination: Cesium.Cartesian3.fromDegrees(0, 15, 20000000),
        });
        viewerReady = true;
        return { enabled: true, message: 'Google Photorealistic 3D Tiles are active. Satellite positions are propagated from TLE data.' };
    } catch (error) {
        if (viewer && !viewer.isDestroyed()) viewer.destroy();
        viewer = null;
        pointCollection = null;
        satellitePoints = [];
        throw error;
    }
}

async function lookupClickedLocation(latitude, longitude) {
    const lookupId = ++locationLookupId;
    const Cesium = window.Cesium;
    const coordinateText = `${latitude.toFixed(4)}°, ${longitude.toFixed(4)}°`;
    if (locationStatus) locationStatus.textContent = `Looking up ${coordinateText}…`;
    updateClickedLocationLabel(latitude, longitude, 'Looking up place name…');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    try {
        const query = new URLSearchParams({ lat: latitude.toString(), lon: longitude.toString() });
        const response = await fetch(`/api/impact/location?${query}`, {
            headers: { Accept: 'application/json' },
            signal: controller.signal,
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || `Location lookup returned HTTP ${response.status}.`);
        if (lookupId !== locationLookupId) return;

        const placeName = result.name || 'No named place found (possibly ocean or unmapped area)';
        updateClickedLocationLabel(latitude, longitude, placeName);
        if (locationStatus) {
            const source = result.sources && result.sources[0];
            locationStatus.textContent = `${placeName} — ${coordinateText}${source ? ` · ${source.name}` : ''}`;
        }
    } catch (error) {
        if (lookupId !== locationLookupId) return;
        const message = error.name === 'AbortError' ? 'Location lookup timed out.' : error.message;
        updateClickedLocationLabel(latitude, longitude, 'Place name unavailable');
        if (locationStatus) locationStatus.textContent = `${message} Coordinates: ${coordinateText}`;
    } finally {
        clearTimeout(timeoutId);
    }
}

function updateClickedLocationLabel(latitude, longitude, name) {
    if (!viewerReady) return;
    const Cesium = window.Cesium;
    if (!clickedLocationEntity) {
        clickedLocationEntity = viewer.entities.add({
            position: Cesium.Cartesian3.fromDegrees(longitude, latitude, 100),
            point: {
                pixelSize: 9,
                color: Cesium.Color.fromCssColorString('#57d7ff'),
                outlineColor: Cesium.Color.BLACK,
                outlineWidth: 2,
            },
            label: {
                text: '',
                font: '13px sans-serif',
                fillColor: Cesium.Color.WHITE,
                outlineColor: Cesium.Color.BLACK,
                outlineWidth: 3,
                style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                pixelOffset: new Cesium.Cartesian2(0, -20),
                distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 15000000),
            },
        });
    }
    clickedLocationEntity.position = Cesium.Cartesian3.fromDegrees(longitude, latitude, 100);
    clickedLocationEntity.label.text = `${name}\n${latitude.toFixed(4)}°, ${longitude.toFixed(4)}°`;
    clickedLocationEntity.show = layerVisibility.places;
    viewer.scene.requestRender();
}

export function updateGoogleEarthSatellite(id, latitudeRadians, longitudeRadians, altitudeKm) {
    if (!viewerReady || !Number.isInteger(id) || !Number.isFinite(latitudeRadians) ||
        !Number.isFinite(longitudeRadians) || !Number.isFinite(altitudeKm)) return;
    const Cesium = window.Cesium;
    const point = satellitePoints[id] || pointCollection.add({
        id,
        pixelSize: 5,
        color: Cesium.Color.CYAN,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 1,
    });
    point.position = Cesium.Cartesian3.fromRadians(longitudeRadians, latitudeRadians, altitudeKm * 1000);
    satellitePoints[id] = point;
}

export function updateGoogleEarthSelectedObject(id, name, latitudeRadians, longitudeRadians, altitudeKm) {
    if (!viewerReady || !Number.isInteger(id) || !Number.isFinite(latitudeRadians) ||
    !Number.isFinite(longitudeRadians) || !Number.isFinite(altitudeKm)) return;
    const Cesium = window.Cesium;
    const latitude = Cesium.Math.toDegrees(latitudeRadians);
    const longitude = Cesium.Math.toDegrees(longitudeRadians);
    const position = Cesium.Cartesian3.fromRadians(longitudeRadians, latitudeRadians, altitudeKm * 1000);
    const labelText = `${name}\n${latitude.toFixed(3)}°, ${longitude.toFixed(3)}°`;

    if (!selectedObjectEntity) {
    selectedObjectEntity = viewer.entities.add({
        position,
        point: {
            pixelSize: 10,
            color: Cesium.Color.YELLOW,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 2,
        },
        label: {
            text: labelText,
            font: '13px sans-serif',
            fillColor: Cesium.Color.WHITE,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 3,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new Cesium.Cartesian2(0, -18),
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 12000000),
            show: layerVisibility.places,
        },
    });
    } else {
    selectedObjectEntity.position = position;
    selectedObjectEntity.label.text = labelText;
    selectedObjectEntity.label.show = layerVisibility.places;
    }
    viewer.scene.requestRender();
}

export function requestGoogleEarthRender() {
    if (viewerReady) viewer.scene.requestRender();
}

export function setGoogleEarthSatellitesVisible(visible) {
    if (viewerReady && pointCollection) {
        pointCollection.show = visible;
        viewer.scene.requestRender();
    }
}

export function focusGoogleEarthPosition(latitudeRadians, longitudeRadians, altitudeKm) {
    if (!viewerReady) return;
    const Cesium = window.Cesium;
    viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromRadians(longitudeRadians, latitudeRadians, (altitudeKm + 500) * 1000),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
        duration: 1.5,
    });
}

function toCartesian(position) {
    const Cesium = window.Cesium;
    const metersPerScaledUnit = 6371000 / 10;
    return new Cesium.Cartesian3(
        position[2] * metersPerScaledUnit,
        position[0] * metersPerScaledUnit,
        position[1] * metersPerScaledUnit
    );
}

export function addGoogleEarthTrajectory(points, color) {
    if (!viewerReady || points.length < 2) return null;
    const Cesium = window.Cesium;
    const entity = viewer.entities.add({
        polyline: {
            positions: points.map(toCartesian),
            width: 3,
            material: Cesium.Color.fromCssColorString(color),
        },
    });
    overlayEntities.add(entity);
    entity.show = layerVisibility.scenarios;
    viewer.scene.requestRender();
    return entity;
}

export function addGoogleEarthMarker(position, color, size = 10) {
    if (!viewerReady) return null;
    const Cesium = window.Cesium;
    const entity = viewer.entities.add({
        position: toCartesian(position),
        point: {
            pixelSize: size,
            color: Cesium.Color.fromCssColorString(color),
            outlineColor: Cesium.Color.WHITE,
            outlineWidth: 2,
        },
    });
    overlayEntities.add(entity);
    entity.show = layerVisibility.scenarios;
    viewer.scene.requestRender();
    return entity;
}

export function moveGoogleEarthMarker(entity, position) {
    if (viewerReady && entity) {
        entity.position = toCartesian(position);
        viewer.scene.requestRender();
    }
}

export function clearGoogleEarthOverlays() {
    if (!viewerReady) return;
    for (const entity of overlayEntities) viewer.entities.remove(entity);
    overlayEntities = new Set();
    for (const entity of placeEntities) viewer.entities.remove(entity);
    placeEntities = new Set();
    viewer.scene.requestRender();
}

export function addGoogleEarthPlaceMarker({ latitude, longitude, name, description = '' }) {
    if (!viewerReady || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    const Cesium = window.Cesium;
    const entity = viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(longitude, latitude, 100),
        point: {
            pixelSize: 11,
            color: Cesium.Color.fromCssColorString('#ff5252'),
            outlineColor: Cesium.Color.WHITE,
            outlineWidth: 2,
        },
        label: {
            text: `${name}\n${latitude.toFixed(3)}°, ${longitude.toFixed(3)}°${description ? `\n${description}` : ''}`,
            font: '13px sans-serif',
            fillColor: Cesium.Color.WHITE,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 3,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new Cesium.Cartesian2(0, -22),
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 15000000),
            show: layerVisibility.places,
        },
    });
    placeEntities.add(entity);
    viewer.scene.requestRender();
    return entity;
}

export function addGoogleEarthFootprint(center, radiusKm) {
    if (!viewerReady || !Number.isFinite(radiusKm) || radiusKm <= 0) return null;
    const Cesium = window.Cesium;
    const entity = viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(center.longitude, center.latitude, 500),
        ellipse: {
            semiMajorAxis: radiusKm * 1000,
            semiMinorAxis: radiusKm * 1000,
            material: Cesium.Color.fromCssColorString('#ffd166').withAlpha(0.08),
            outline: true,
            outlineColor: Cesium.Color.fromCssColorString('#ffd166'),
            height: 500,
        },
    });
    overlayEntities.add(entity);
    entity.show = layerVisibility.scenarios;
    viewer.scene.requestRender();
    return entity;
}

export function isGoogleEarthReady() {
    return viewerReady;
}

export function setGoogleEarthLayerVisibility(layer, visible) {
    if (!Object.prototype.hasOwnProperty.call(layerVisibility, layer)) return;
    layerVisibility[layer] = visible;
    if (!viewerReady) return;

    if (layer === 'satellites' && pointCollection) {
        pointCollection.show = visible;
    } else if (layer === 'places') {
        if (selectedObjectEntity) selectedObjectEntity.show = visible;
        if (clickedLocationEntity) clickedLocationEntity.show = visible;
        for (const entity of placeEntities) {
            entity.show = visible;
        }
    } else if (layer === 'scenarios') {
        for (const entity of overlayEntities) entity.show = visible;
    }
    viewer.scene.requestRender();
}

export function showGoogleEarthArea({ latitude, longitude, altitude, radius }) {
    if (!viewerReady) return;
    const Cesium = window.Cesium;
    if (areaEntity) viewer.entities.remove(areaEntity);
    areaEntity = viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(longitude, latitude, altitude * 500),
        cylinder: {
            length: altitude * 1000,
            topRadius: radius * 1000,
            bottomRadius: radius * 1000,
            material: Cesium.Color.CYAN.withAlpha(0.14),
            outline: true,
            outlineColor: Cesium.Color.CYAN,
        },
    });
    viewer.scene.requestRender();
}

export function removeGoogleEarthArea() {
    if (viewerReady && areaEntity) {
        viewer.entities.remove(areaEntity);
        viewer.scene.requestRender();
    }
    areaEntity = null;
}
