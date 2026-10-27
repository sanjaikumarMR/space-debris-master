const GEMINI_MODEL = 'gemini-2.5-flash';
const REQUEST_TIMEOUT_MS = 12000;
const MASS_UNITS_TO_KG = new Map([
    ['Q11570', 1],
    ['Q41803', 0.001],
]);
const objectEvidenceCache = new Map();
const locationEvidenceCache = new Map();
const EVIDENCE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const rateLimitWindows = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const objectProfileCache = new Map();

function enforceRateLimit(res, endpoint, limit) {
    const now = Date.now();
    let window = rateLimitWindows.get(endpoint);
    if (!window || now >= window.resetAt) {
        window = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
        rateLimitWindows.set(endpoint, window);
    }
    if (window.count >= limit) {
        res.setHeader('Retry-After', Math.ceil((window.resetAt - now) / 1000).toString());
        sendJson(res, 429, { error: 'This endpoint is temporarily rate-limited. Please try again shortly.' });
        return false;
    }
    window.count++;
    return true;
}

async function fetchJson(url, serviceName, options = {}) {
    const response = await fetch(url, {
        headers: { Accept: 'application/json', ...(options.headers || {}) },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ...options,
    });
    if (!response.ok) {
        throw new Error(`${serviceName} returned HTTP ${response.status}.`);
    }
    return response.json();
}

function normalizeName(value) {
    return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function extractMassKg(entity) {
    const claims = entity && entity.claims && entity.claims.P2067;
    if (!Array.isArray(claims)) return null;
    for (const claim of claims) {
        const quantity = claim.mainsnak && claim.mainsnak.datavalue && claim.mainsnak.datavalue.value;
        if (!quantity || !quantity.amount || !quantity.unit) continue;
        const amount = Number(quantity.amount);
        const factor = MASS_UNITS_TO_KG.get(quantity.unit.split('/').pop());
        if (Number.isFinite(amount) && amount > 0 && factor) return amount * factor;
    }
    return null;
}

async function retrieveObjectEvidence(name) {
    const normalizedName = normalizeName(name);
    const cached = objectEvidenceCache.get(normalizedName);
    if (cached && Date.now() - cached.cachedAt < EVIDENCE_CACHE_TTL_MS) return cached.value;
    const isDebris = /(^| )(deb|debris|fragment|fragmentation|r b|rocket body|stage)( |$)/.test(normalizedName);
    const searchUrl = new URL('https://www.wikidata.org/w/api.php');
    searchUrl.search = new URLSearchParams({
        action: 'wbsearchentities',
        search: name,
        language: 'en',
        format: 'json',
        type: 'item',
        limit: '8',
        origin: '*',
    });
    const search = await fetchJson(searchUrl, 'Wikidata');
    const candidates = (search.search || []).filter(item => {
        const label = normalizeName(item.label || '');
        const alias = normalizeName(item.match && item.match.text || '');
        const description = (item.description || '').toLocaleLowerCase();
        const exactName = label === normalizedName ||
            (!isDebris && alias && normalizedName.startsWith(`${alias} `) &&
                normalizedName.length - alias.length <= 18);
        return exactName &&
            /(satellite|spacecraft|space station|space vehicle|space probe|rocket body)/.test(description);
    }).slice(0, 3);

    for (const candidate of candidates) {
        const entityUrl = `https://www.wikidata.org/wiki/Special:EntityData/${encodeURIComponent(candidate.id)}.json`;
        const data = await fetchJson(entityUrl, 'Wikidata entity lookup');
        const entity = data.entities && data.entities[candidate.id];
        const massKg = extractMassKg(entity);
        if (massKg !== null) {
            const evidence = {
                name: candidate.label,
                description: candidate.description,
                massKg,
                source: `https://www.wikidata.org/wiki/${encodeURIComponent(candidate.id)}`,
            };
            objectEvidenceCache.set(normalizedName, { value: evidence, cachedAt: Date.now() });
            return evidence;
        }
    }

    const evidence = {
        name: candidates[0] ? candidates[0].label : null,
        description: candidates[0] ? candidates[0].description : null,
        massKg: null,
        source: candidates[0]
            ? `https://www.wikidata.org/wiki/${encodeURIComponent(candidates[0].id)}`
            : null,
        note: isDebris
            ? 'The selected catalog entry is debris; parent-object mass is not substituted for unknown fragment mass.'
            : 'No clearly matching public mass record was found.',
    };
    objectEvidenceCache.set(normalizedName, { value: evidence, cachedAt: Date.now() });
    return evidence;
}

async function retrieveWikipediaArticle(query, exactTitle) {
    const url = new URL('https://en.wikipedia.org/w/api.php');
    url.search = new URLSearchParams({
        action: 'query',
        list: 'search',
        srsearch: query,
        format: 'json',
        srlimit: '5',
    });
    const search = await fetchJson(url, 'Wikipedia search');
    const results = search.query && search.query.search || [];
    const article = exactTitle
        ? results.find(result => normalizeName(result.title) === normalizeName(exactTitle))
        : results.find(result => normalizeName(result.title) === normalizeName(query));
    if (!article) return null;

    const extractUrl = new URL('https://en.wikipedia.org/w/api.php');
    extractUrl.search = new URLSearchParams({
        action: 'query',
        prop: 'extracts',
        exintro: '1',
        explaintext: '1',
        titles: article.title,
        format: 'json',
    });
    const pageData = await fetchJson(extractUrl, 'Wikipedia article');
    const pages = pageData.query && pageData.query.pages || {};
    const page = Object.values(pages)[0];
    if (!page || !page.extract) return null;
    return {
        title: page.title,
        extract: page.extract.slice(0, 8000),
        source: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`,
    };
}

async function retrieveCelestrakSatcat(noradId) {
    const url = new URL('https://celestrak.org/satcat/records.php');
    url.search = new URLSearchParams({ CATNR: noradId, FORMAT: 'json' });
    const result = await fetchJson(url, 'CelesTrak SATCAT');
    const record = Array.isArray(result)
        ? result.find(item => String(item.NORAD_CAT_ID) === noradId)
        : null;
    if (!record) return null;
    const fields = [
        'OBJECT_NAME',
        'OBJECT_ID',
        'NORAD_CAT_ID',
        'OBJECT_TYPE',
        'OPS_STATUS_CODE',
        'OWNER',
        'LAUNCH_DATE',
        'LAUNCH_SITE',
        'DECAY_DATE',
        'PERIOD',
        'INCLINATION',
        'APOGEE',
        'PERIGEE',
        'RCS',
    ];
    return {
        ...Object.fromEntries(fields
            .filter(field => record[field] !== undefined && record[field] !== null && record[field] !== '')
            .map(field => [field, record[field]])),
        source: `https://celestrak.org/satcat/records.php?CATNR=${encodeURIComponent(noradId)}`,
    };
}

async function retrieveObjectProfile(name, noradId, internationalDesignator, latitude, longitude) {
    const cacheKey = normalizeName(`${name}|${noradId}|${internationalDesignator}`);
    const cached = objectProfileCache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < EVIDENCE_CACHE_TTL_MS) {
        return { ...cached.value, map: await getGoogleMapConfig(latitude, longitude) };
    }

    const normalizedName = normalizeName(name);
    const familyName = normalizedName.match(/^(yaogan 30)(?: [a-z]{1,2})?$/);
    let objectEvidence;
    let retrievalErrors = [];
    try {
        objectEvidence = await retrieveObjectEvidence(name);
    } catch (error) {
        retrievalErrors.push(`Wikidata lookup unavailable: ${error.message}`);
        objectEvidence = { name: null, description: null, massKg: null, source: null };
    }
    const hasExactRecord = objectEvidence.name &&
        normalizeName(objectEvidence.name) === normalizedName;
    let profileCandidate = hasExactRecord || objectEvidence.name ? objectEvidence : null;
    if (!profileCandidate && familyName) {
        try {
            profileCandidate = await retrieveObjectEvidence('Yaogan 30');
        } catch (error) {
            retrievalErrors.push(`Yaogan family lookup unavailable: ${error.message}`);
        }
    }
    const isFamilyRecord = Boolean(profileCandidate && !hasExactRecord);
    let satcat = null;
    try {
        satcat = await retrieveCelestrakSatcat(noradId);
    } catch (error) {
        retrievalErrors.push(`CelesTrak catalog lookup unavailable: ${error.message}`);
    }
    let article = null;
    let articleError = null;
    try {
        article = await retrieveWikipediaArticle(
            familyName ? 'Yaogan' : name,
            familyName ? 'Yaogan' : name
        );
        if (!article && familyName) {
            article = await retrieveWikipediaArticle('Yaogan', 'Yaogan');
        }
    } catch (error) {
        articleError = error.message;
    }

    const sources = [];
    if (profileCandidate && profileCandidate.source) {
        sources.push({
            name: 'Wikidata',
            url: profileCandidate.source,
            scope: isFamilyRecord ? 'Related Yaogan 30 family record, not a confirmed individual match.' : 'Object-name record.',
        });
    }
    if (article) {
        sources.push({
            name: 'Wikipedia',
            url: article.source,
            scope: familyName ? 'Yaogan program/family context, not a biography of this individual catalog object.' : 'Article matching the search.',
        });
    }
    sources.push({
        name: 'CelesTrak catalog lookup',
        url: `https://celestrak.org/satcat/records.php?CATNR=${encodeURIComponent(noradId)}`,
        scope: 'NORAD catalog reference; the app’s selected name and international designator come from the selected TLE.',
    });
    sources.push({
        name: 'N2YO tracking reference',
        url: `https://www.n2yo.com/satellite/?s=${encodeURIComponent(noradId)}`,
        scope: 'Independent NORAD-ID tracking page for cross-checking the selected catalog identity.',
    });

    const profile = {
        selectedName: name,
        noradId,
        internationalDesignator,
        satcat,
        profile: profileCandidate
            ? {
                name: profileCandidate.name,
                description: profileCandidate.description,
                massKg: profileCandidate.massKg,
                note: profileCandidate.note || null,
                familyLevel: isFamilyRecord,
            }
            : null,
        article,
        sources,
        note: [
            articleError ? `Wikipedia retrieval unavailable: ${articleError}` : null,
            ...retrievalErrors,
        ].filter(Boolean).join(' ') || null,
        map: null,
        aiSummary: null,
        aiSummaryNote: null,
    };
    if (!hasExactRecord && !profile.note) {
        profile.note = 'No exact individual-object record was matched. Any related article or family entry is context only, not confirmation of this satellite’s individual mission or status.';
    }
    if (process.env.GEMINI_API_KEY) {
        try {
            profile.aiSummary = await generateObjectSummary(profile);
        } catch (error) {
            profile.aiSummaryNote = `Gemini summary unavailable: ${error.message}`;
        }
    } else {
        profile.aiSummaryNote = 'Gemini is not configured; retrieved source details are shown without AI-generated claims.';
    }

    if ((profile.profile || profile.article) && retrievalErrors.length === 0) {
        objectProfileCache.set(cacheKey, { value: profile, cachedAt: Date.now() });
    }
    return { ...profile, map: await getGoogleMapConfig(latitude, longitude) };
}

async function getGoogleMapConfig(latitude, longitude) {
    const apiKey = process.env.GOOGLE_MAPS_EMBED_KEY;
    if (!apiKey) return { url: null, note: 'Configure a referrer-restricted Google Maps Embed API key to show an interactive satellite map.' };
    const url = new URL('https://www.google.com/maps/embed/v1/view');
    url.search = new URLSearchParams({
        key: apiKey,
        center: `${latitude},${longitude}`,
        zoom: '4',
        maptype: 'satellite',
    });
    return {
        url: url.toString(),
        note: 'Google Maps satellite imagery is not live imagery. The existing globe shows the TLE-propagated object position.',
    };
}

async function generateObjectSummary(profile) {
    const evidence = {
        selectedTleName: profile.selectedName,
        noradCatalogId: profile.noradId,
        internationalDesignator: profile.internationalDesignator,
        relatedWikidataRecord: profile.profile,
        wikipediaArticle: profile.article && {
            title: profile.article.title,
            extract: profile.article.extract,
            source: profile.article.source,
        },
        rule: 'Do not claim a family record or article describes the individual satellite unless the evidence says so.',
    };
    const url = new URL(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`);
    const response = await fetchJson(url, 'Gemini object summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
        body: JSON.stringify({
            contents: [{
                parts: [{
                    text: `Summarize this space-object record in 3-5 sentences using only the supplied evidence. Distinguish the selected TLE name/NORAD identifier from family-level facts. Explicitly say when the individual object's mission, operator, mass, or status is not confirmed by the evidence. Do not infer classified purpose, capabilities, or operational status. Retrieved evidence:\n${JSON.stringify(evidence)}`,
                }],
            }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 300 },
        }),
    });
    const text = response.candidates && response.candidates[0] &&
        response.candidates[0].content && response.candidates[0].content.parts
        ? response.candidates[0].content.parts.map(part => part.text || '').join('').trim()
        : '';
    if (!text) throw new Error('Gemini returned no summary text.');
    return text;
}

async function retrieveOsmLocation(latitude, longitude) {
    const url = new URL('https://nominatim.openstreetmap.org/reverse');
    url.search = new URLSearchParams({
        format: 'jsonv2',
        lat: latitude,
        lon: longitude,
        zoom: '6',
        extratags: '1',
    });
    const result = await fetchJson(url, 'OpenStreetMap Nominatim', {
        headers: { 'User-Agent': 'SpaceDebrisPrediction/1.0', 'Accept-Language': 'en' },
    });
    const address = result.address || {};
    const name = [
        address.city || address.town || address.village || address.county || address.state,
        address.country,
    ].filter(Boolean).join(', ') || result.name || null;
    const population = Number(result.extratags && result.extratags.population);
    return {
        name,
        population: Number.isFinite(population) && population > 0 ? population : null,
        source: result.extratags && result.extratags.population
            ? `https://www.openstreetmap.org/${result.osm_type}/${result.osm_id}`
            : `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=6/${latitude}/${longitude}`,
        note: name ? null : 'OpenStreetMap returned no named feature at the coordinate.',
    };
}

async function retrieveGoogleLocation(latitude, longitude) {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) return null;
    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.search = new URLSearchParams({
        latlng: `${latitude},${longitude}`,
        key: apiKey,
        language: 'en',
    });
    const result = await fetchJson(url, 'Google Maps Geocoding');
    if (result.status !== 'OK' && result.status !== 'ZERO_RESULTS') {
        throw new Error(`Google Maps Geocoding returned ${result.status}.`);
    }
    const feature = (result.results || []).find(item =>
        (item.types || []).some(type => ['natural_feature', 'administrative_area_level_1', 'country'].includes(type))
    ) || (result.results || [])[0];
    if (!feature) return null;
    return {
        name: feature.formatted_address,
        types: feature.types || [],
        source: `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`,
    };
}

async function retrieveLocationEvidence(latitude, longitude) {
    const cacheKey = `${latitude.toFixed(2)},${longitude.toFixed(2)}`;
    const cached = locationEvidenceCache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < EVIDENCE_CACHE_TTL_MS) return cached.value;
    let osm = null;
    let osmError = null;
    try {
        osm = await retrieveOsmLocation(latitude, longitude);
    } catch (error) {
        osmError = error.message;
    }

    let google = null;
    let googleError = null;
    if (!osm || !osm.name) {
        try {
            google = await retrieveGoogleLocation(latitude, longitude);
        } catch (error) {
            googleError = error.message;
        }
    }
    const selectedLocation = google && google.name ? google : osm;
    const sources = [];
    if (osm && osm.source) sources.push({ name: 'OpenStreetMap', url: osm.source });
    if (google && google.name) sources.push({ name: 'Google Maps Geocoding', url: google.source });

    const evidence = {
        name: selectedLocation && selectedLocation.name,
        source: selectedLocation === google && google ? 'Google Maps Geocoding' : 'OpenStreetMap',
        population: osm && osm.population,
        populationSource: osm && osm.population ? osm.source : null,
        sources,
        note: selectedLocation && selectedLocation.name
            ? null
            : osmError || googleError
                ? null
                : 'No named map feature was returned. The impact coordinate may be offshore or unmapped.',
        errors: [osmError, googleError].filter(Boolean),
    };
    locationEvidenceCache.set(cacheKey, { value: evidence, cachedAt: Date.now() });
    return evidence;
}

function validateScenario(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        const error = new Error('The scenario request must be a JSON object.');
        error.statusCode = 400;
        throw error;
    }
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const latitude = Number(body.latitude);
    const longitude = Number(body.longitude);
    const footprintRadiusKm = Number(body.footprintRadiusKm);
    const impactSpeedKmPerSecond = Number(body.impactSpeedKmPerSecond);
    const tleAgeDays = Number(body.tleAgeDays);
    if (!name || name.length > 200) {
        const error = new Error('A valid selected object name is required.');
        error.statusCode = 400;
        throw error;
    }
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
        const error = new Error('Latitude must be between -90 and 90.');
        error.statusCode = 400;
        throw error;
    }
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
        const error = new Error('Longitude must be between -180 and 180.');
        error.statusCode = 400;
        throw error;
    }
    if (!Number.isFinite(footprintRadiusKm) || footprintRadiusKm < 0 || footprintRadiusKm > 20038) {
        const error = new Error('Footprint radius must be between 0 and 20,038 km.');
        error.statusCode = 400;
        throw error;
    }
    if (!Number.isFinite(impactSpeedKmPerSecond) || impactSpeedKmPerSecond < 0 || impactSpeedKmPerSecond > 20) {
        const error = new Error('Impact speed must be between 0 and 20 km/s.');
        error.statusCode = 400;
        throw error;
    }
    if (!Number.isFinite(tleAgeDays) || tleAgeDays < -1 || tleAgeDays > 100000) {
        const error = new Error('TLE age is invalid.');
        error.statusCode = 400;
        throw error;
    }
    return { name, latitude, longitude, footprintRadiusKm, impactSpeedKmPerSecond, tleAgeDays };
}

async function generateGroundedSummary(scenario, objectEvidence, locationEvidence) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        const error = new Error('Gemini RAG is not configured. Add GEMINI_API_KEY to the Render environment variables.');
        error.statusCode = 503;
        throw error;
    }
    const evidence = {
        selectedObject: scenario.name,
        publishedObjectMassKg: objectEvidence.massKg,
        massRecordName: objectEvidence.name,
        massRecordDescription: objectEvidence.description,
        massRecordNote: objectEvidence.note || null,
        massRecordSource: objectEvidence.source,
        impactCoordinate: { latitude: scenario.latitude, longitude: scenario.longitude },
        mappedRegion: locationEvidence.name,
        mappedPopulationTag: locationEvidence.population,
        mappedPopulationWarning: 'A feature population total is not an estimate of people within the impact footprint.',
        footprintRadiusKm: scenario.footprintRadiusKm,
        modeledSurfaceIntersectionSpeedKmPerSecond: scenario.impactSpeedKmPerSecond,
        tleAgeDays: scenario.tleAgeDays,
        mapSources: locationEvidence.sources,
        assumptions: [
            'The de-orbit propagation is a simplified spherical-Earth scenario.',
            'A footprint from state sensitivity cases is not a confidence region or event probability.',
            'No verified fragment survival, impact physics, weather, local gridded population, damage, or casualty data are available.',
            'Do not estimate casualties or claim a damage radius.',
            'Do not treat catalog total mass as surviving fragment mass.',
            'If mass or location facts are absent, explicitly say they are unknown.',
        ],
    };
    const prompt = `You are a cautious space-debris risk evidence assistant. Use only the retrieved JSON evidence below; do not add outside facts or make unsupported forecasts. Write a short plain-language summary with sections: "Retrieved facts", "What the modeled footprint means", and "What is unknown". State that this is a hypothetical illustration, not an operational impact prediction. Never calculate or guess damage, exposed people, fatalities, or a casualty probability. If population is only a mapped feature total, explain it is not the population inside the footprint. Do not suggest that the orbital LSTM predicts mass or damage.\n\nRetrieved evidence:\n${JSON.stringify(evidence)}`;
    const url = new URL(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`);
    const response = await fetchJson(url, 'Gemini', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 450 },
        }),
    });
    const text = response.candidates && response.candidates[0] &&
        response.candidates[0].content && response.candidates[0].content.parts
        ? response.candidates[0].content.parts.map(part => part.text || '').join('').trim()
        : '';
    if (!text) throw new Error('Gemini returned no summary text.');
    return {
        text,
        model: GEMINI_MODEL,
        evidence: { object: objectEvidence, location: locationEvidence },
    };
}

function sendJson(res, status, body) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(body));
}

async function handleImpactAssessmentRequest(req, res) {
    if (req.method === 'GET' && req.url.startsWith('/map-config')) {
        sendJson(res, 200, {
            tilesApiKey: process.env.GOOGLE_MAPS_TILES_KEY || null,
            note: 'This browser key must be restricted to your application referrer and the Google Map Tiles API.',
        });
        return;
    }

    if (req.method === 'GET' && req.url.startsWith('/object')) {
        if (!enforceRateLimit(res, 'object', 60)) return;
        const url = new URL(req.url, 'http://localhost');
        const name = url.searchParams.get('name') || '';
        const noradId = url.searchParams.get('noradId') || '';
        const internationalDesignator = url.searchParams.get('internationalDesignator') || '';
        const latitude = Number(url.searchParams.get('lat'));
        const longitude = Number(url.searchParams.get('lon'));
        if (!name.trim() || name.length > 200 || !/^\d{1,9}$/.test(noradId) ||
            !Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
            !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
            sendJson(res, 400, { error: 'Valid name, NORAD ID, latitude, and longitude are required.' });
            return;
        }
        try {
            sendJson(res, 200, await retrieveObjectProfile(
                name.trim(),
                noradId,
                internationalDesignator.slice(0, 20),
                latitude,
                longitude
            ));
        } catch (error) {
            sendJson(res, 502, { error: error.message });
        }
        return;
    }

    if (req.method === 'GET' && req.url.startsWith('/location')) {
        if (!enforceRateLimit(res, 'location', 120)) return;
        const url = new URL(req.url, 'http://localhost');
        const latitude = Number(url.searchParams.get('lat'));
        const longitude = Number(url.searchParams.get('lon'));
        if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
            !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
            sendJson(res, 400, { error: 'Valid lat and lon query parameters are required.' });
            return;
        }
        try {
            sendJson(res, 200, await retrieveLocationEvidence(latitude, longitude));
        } catch (error) {
            sendJson(res, 502, { error: error.message });
        }
        return;
    }

    if (req.method !== 'POST' || !req.url.startsWith('/summary')) {
        sendJson(res, 404, { error: 'Use GET /map-config, GET /object, GET /location, or POST /summary.' });
        return;
    }
    if (!process.env.GEMINI_API_KEY) {
        sendJson(res, 503, { error: 'Gemini RAG is not configured. Add GEMINI_API_KEY to the server environment.' });
        return;
    }
    if (!enforceRateLimit(res, 'summary', 20)) return;

    let body;
    try {
        const chunks = [];
        let length = 0;
        for await (const chunk of req) {
            length += chunk.length;
            if (length > 16000) {
                sendJson(res, 413, { error: 'The scenario request is too large.' });
                return;
            }
            chunks.push(chunk);
        }
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
        sendJson(res, 400, { error: `Invalid JSON request: ${error.message}` });
        return;
    }

    try {
        const scenario = validateScenario(body);
        const [objectEvidence, locationEvidence] = await Promise.all([
            retrieveObjectEvidence(scenario.name),
            retrieveLocationEvidence(scenario.latitude, scenario.longitude),
        ]);
        const summary = await generateGroundedSummary(scenario, objectEvidence, locationEvidence);
        sendJson(res, 200, summary);
    } catch (error) {
        sendJson(res, error.statusCode || 502, { error: error.message });
    }
}

module.exports = { handleImpactAssessmentRequest };
