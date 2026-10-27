const reverseGeocodeCache = new Map();
const satelliteMassCache = new Map();

const WIKIDATA_MASS_UNITS_TO_KG = new Map([
    ['Q11570', 1],
    ['Q41803', 0.001],
]);

async function fetchJson(url, serviceName) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    try {
        const response = await fetch(url, {
            headers: { Accept: 'application/json' },
            signal: controller.signal,
        });
        if (!response.ok) {
            throw new Error(`${serviceName} returned HTTP ${response.status}.`);
        }
        return await response.json();
    } finally {
        clearTimeout(timeoutId);
    }
}

function normalizeSearchName(value) {
    return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function massFromEntity(entity) {
    const claims = entity.claims && entity.claims.P2067;
    if (!Array.isArray(claims)) return null;
    for (const claim of claims) {
        const quantity = claim.mainsnak && claim.mainsnak.datavalue && claim.mainsnak.datavalue.value;
        if (!quantity || !quantity.amount || !quantity.unit) continue;
        const amount = Number(quantity.amount);
        const unitId = quantity.unit.split('/').pop();
        const conversion = WIKIDATA_MASS_UNITS_TO_KG.get(unitId);
        if (Number.isFinite(amount) && amount > 0 && conversion) {
            return amount * conversion;
        }
    }
    return null;
}

export async function lookupSatelliteMass(objectName) {
    const key = normalizeSearchName(objectName);
    const debrisName = /(^| )(deb|debris|fragment|fragmentation|r b|rocket body|stage)( |$)/.test(key);
    if (satelliteMassCache.has(key)) return satelliteMassCache.get(key);

    const searchTerms = [...new Set([
        objectName.trim(),
        objectName.replace(/\s*\([^)]*\)\s*/g, ' ').trim(),
    ].filter(Boolean))];
    const searchResults = [];
    try {
        for (const searchTerm of searchTerms) {
            const searchUrl = new URL('https://www.wikidata.org/w/api.php');
            searchUrl.search = new URLSearchParams({
                action: 'wbsearchentities',
                search: searchTerm,
                language: 'en',
                format: 'json',
                type: 'item',
                limit: '8',
                origin: '*',
            });
            const search = await fetchJson(searchUrl, 'Wikidata');
            searchResults.push(...(search.search || []).map(result => ({ ...result, searchTerm })));
        }
    } catch (error) {
        return { massKg: null, source: null, error: `Object mass lookup unavailable: ${error.message}` };
    }

    const candidates = searchResults.filter(result => {
        const label = normalizeSearchName(result.label || '');
        const description = (result.description || '').toLocaleLowerCase();
        const matchedAlias = normalizeSearchName(result.match && result.match.text || '');
        const exactName = label && (
            label === key ||
            (!debrisName && (
                (key.startsWith(`${label} `) && key.length - label.length <= 18) ||
                (matchedAlias && key.startsWith(`${matchedAlias} `) && key.length - matchedAlias.length <= 18)
            ))
        );
        const spacecraftDescription = /(satellite|spacecraft|space station|space vehicle|space probe|rocket body)/.test(description);
        return exactName && spacecraftDescription;
    });

    for (const candidate of candidates) {
        try {
            const entityUrl = `https://www.wikidata.org/wiki/Special:EntityData/${encodeURIComponent(candidate.id)}.json`;
            const data = await fetchJson(entityUrl, 'Wikidata entity lookup');
            const massKg = massFromEntity(data.entities && data.entities[candidate.id]);
            if (massKg !== null) {
                const result = {
                    massKg,
                    matchedName: candidate.label,
                    source: `https://www.wikidata.org/wiki/${encodeURIComponent(candidate.id)}`,
                    error: null,
                };
                satelliteMassCache.set(key, result);
                return result;
            }
        } catch (error) {
            return { massKg: null, source: null, error: `Wikidata mass lookup failed: ${error.message}` };
        }
    }

    const result = {
        massKg: null,
        source: null,
        error: candidates.length
            ? 'A matching Wikidata item was found, but it has no convertible mass value.'
            : debrisName
                ? 'This catalog entry is debris. Its fragment mass is not listed; the parent satellite mass cannot be substituted.'
                : 'No clearly matching satellite/spacecraft record was found.',
    };
    satelliteMassCache.set(key, result);
    return result;
}

export async function getImpactRegion(latitude, longitude) {
    const key = `${latitude.toFixed(2)},${longitude.toFixed(2)}`;
    if (reverseGeocodeCache.has(key)) return reverseGeocodeCache.get(key);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    try {
        const query = new URLSearchParams({ lat: latitude.toString(), lon: longitude.toString() });
        const response = await fetch(`/api/impact/location?${query}`, {
            headers: { Accept: 'application/json' },
            signal: controller.signal,
        });
        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.error || `Map lookup returned HTTP ${response.status}.`);
        }
        const region = {
            name: result.name || null,
            population: Number.isFinite(result.population) ? result.population : null,
            populationSource: result.populationSource || null,
            sources: Array.isArray(result.sources) ? result.sources : [],
            error: result.note || (result.errors && result.errors.join(' ')) || null,
        };
        reverseGeocodeCache.set(key, region);
        return region;
    } catch (error) {
        const result = {
            name: null,
            population: null,
            populationSource: null,
            sources: [],
            error: error.name === 'AbortError' ? 'Map lookup timed out.' : `Map lookup failed: ${error.message}`,
        };
        reverseGeocodeCache.set(key, result);
        return result;
    } finally {
        clearTimeout(timeoutId);
    }
}

export async function getGroundedImpactSummary(scenario) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 45000);
    try {
        const response = await fetch('/api/impact/summary', {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(scenario),
            signal: controller.signal,
        });
        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.error || `AI summary returned HTTP ${response.status}.`);
        }
        return result;
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new Error('The evidence-grounded AI summary timed out.');
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}

export function getScenarioEnvelopeRadiusKm(center, impacts) {
    if (!impacts.length) return null;
    const radians = Math.PI / 180;
    const offsets = impacts.map(impact => {
        const latitudeDelta = (impact.latitude - center.latitude) * radians;
        const longitudeDelta = (((impact.longitude - center.longitude + 540) % 360) - 180) * radians;
        const latitude1 = center.latitude * radians;
        const latitude2 = impact.latitude * radians;
        const haversine = Math.sin(latitudeDelta / 2) ** 2 +
            Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(longitudeDelta / 2) ** 2;
        return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(haversine)));
    }).sort((left, right) => left - right);
    return offsets[Math.ceil(offsets.length * 0.9) - 1];
}
