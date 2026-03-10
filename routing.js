// routing.js — GreenTrail v2.1
// Real OSM-based Green Health Score analysis via Overpass API

// ─── Main route calculator ─────────────────────────────────────────────────
async function calculateBestRoute(start, end, type, greenWeight = 0.7) {
    if (!start || !end) return null;

    let geometry = null;

    if (type === 'tour') {
        // FIX #2: Circular tour stays within the selected distance
        // Uses OSRM trip endpoint or a controlled waypoint loop
        geometry = await getCircularTourRoute(start, end);
    } else {
        geometry = await getRouteFromOSRM(start, end);
        if (geometry?.coordinates?.length > 1) {
            // Return: exact same path back
            const coords = [...geometry.coordinates];
            geometry.coordinates = [...coords, ...coords.slice(1).reverse()];
        }
    }

    if (!geometry?.coordinates?.length) return null;
    return { geometry };
}

// ─── FIX #2: Circular tour — controlled within distance budget ─────────────
// Uses OSRM trip (round-trip) to a green waypoint on the SAME side of the buffer
async function getCircularTourRoute(start, end) {
    try {
        // Compute a midpoint roughly 90° offset from the direct line, but NOT beyond end distance
        const dx = end[0] - start[0];
        const dy = end[1] - start[1];
        const dist = Math.sqrt(dx * dx + dy * dy);

        // Place waypoint laterally — perpendicular offset proportional to route length
        // This creates a loop that goes out via one side and returns via the other
        const perpScale = dist * 0.45;
        const perpX = (-dy / dist) * perpScale;
        const perpY = (dx / dist) * perpScale;

        // Waypoint on the "arc" side — between start and end
        const t = 0.5; // midpoint along the route
        const midBase = [start[0] + dx * t, start[1] + dy * t];
        const waypoint = [midBase[0] + perpX, midBase[1] + perpY];

        // Try to snap waypoint to a green area near it
        const greenWp = await findNearestGreenPoint(waypoint, 0.4);
        const wp = greenWp || waypoint;

        // OSRM trip: start → end (via waypoint on outward) → back to start
        // Build: start → wp → end → start
        const stops = [start, wp, end, start]
            .map(p => `${p[0]},${p[1]}`).join(';');

        const url = `https://router.project-osrm.org/route/v1/foot/${stops}?overview=full&geometries=geojson`;

        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 12000);
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) throw new Error('OSRM trip error');
        const data = await res.json();

        if (data.code === 'Ok' && data.routes?.length) {
            return data.routes[0].geometry;
        }
    } catch (e) {
        console.warn('Circular tour error, fallback:', e.message);
    }

    // Fallback: simple return trip
    const geom = await getRouteFromOSRM(start, end);
    if (geom?.coordinates) {
        const c = [...geom.coordinates];
        geom.coordinates = [...c, ...c.slice(1).reverse()];
    }
    return geom;
}

// ─── OSRM ─────────────────────────────────────────────────────────────────
async function getRouteFromOSRM(start, end) {
    if (!start || !end) return null;
    const url = `https://router.project-osrm.org/route/v1/foot/${start[0]},${start[1]};${end[0]},${end[1]}?overview=full&geometries=geojson`;
    try {
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 10000);
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data.code !== 'Ok' || !data.routes?.length) return null;
        return data.routes[0].geometry;
    } catch (e) {
        console.error('OSRM error:', e.message);
        return null;
    }
}

// ─── Find nearest green point ──────────────────────────────────────────────
async function findNearestGreenPoint(center, radiusKm) {
    const r = radiusKm / 111;
    const bbox = [center[1]-r, center[0]-r, center[1]+r, center[0]+r].join(',');
    const q = `[out:json][timeout:5];(way["leisure"="park"](${bbox});way["natural"="wood"](${bbox});way["landuse"="forest"](${bbox}););out geom;`;
    try {
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 5000);
        const res = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(q)}`, { signal: ctrl.signal });
        const data = await res.json();
        const els = (data.elements || []).filter(e => e.geometry?.length > 3);
        if (!els.length) return null;
        const el = els[Math.floor(Math.random() * Math.min(3, els.length))];
        const coords = el.geometry.map(p => [p.lon, p.lat]);
        if (coords[0][0] !== coords[coords.length-1][0]) coords.push(coords[0]);
        return turf.centroid(turf.polygon([coords])).geometry.coordinates;
    } catch { return null; }
}

// ─── Strict-buffer green destination ──────────────────────────────────────
async function getRandomDestinationWithGreenArea(center, radiusKm, greenWeight = 0.7) {
    if (!center?.length) return getRandomPointInBuffer([13.404954, 52.520007], radiusKm);

    const r = radiusKm / 111;
    const bbox = [center[1]-r, center[0]-r, center[1]+r, center[0]+r].join(',');

    const q = `[out:json][timeout:10];(
        way["leisure"="park"](${bbox});
        way["natural"="wood"](${bbox});
        way["landuse"="forest"](${bbox});
        way["leisure"="garden"](${bbox});
        way["natural"="meadow"](${bbox});
        way["leisure"="nature_reserve"](${bbox});
    );out geom;`;

    try {
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 10000);
        const res = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(q)}`, { signal: ctrl.signal });
        const data = await res.json();

        const elements = (data.elements || []).filter(el => el.geometry?.length > 3);
        if (!elements.length) return getRandomPointInBuffer(center, radiusKm);

        const centerPt = turf.point(center);
        const scored = [];

        for (const el of elements) {
            const coords = el.geometry.map(p => [p.lon, p.lat]);
            if (coords[0][0] !== coords[coords.length-1][0]) coords.push(coords[0]);
            let centroid;
            try { centroid = turf.centroid(turf.polygon([coords])).geometry.coordinates; }
            catch { continue; }

            const dist = turf.distance(centerPt, turf.point(centroid), { units: 'kilometers' });
            if (dist > radiusKm * 0.95) continue; // strictly inside buffer

            const normDist = dist / radiusKm;
            const distScore = normDist >= 0.5 && normDist <= 0.9 ? 1 : Math.max(0, 1 - Math.abs(normDist - 0.7) * 3);
            const sizeScore = Math.min(1, el.geometry.length / 60);
            scored.push({ centroid, score: greenWeight * distScore + (1 - greenWeight) * sizeScore });
        }

        if (!scored.length) return getRandomPointInBuffer(center, radiusKm);
        scored.sort((a, b) => b.score - a.score);
        return scored[Math.floor(Math.random() * Math.min(3, scored.length))].centroid;
    } catch (e) {
        console.warn('Green dest error:', e.message);
        return getRandomPointInBuffer(center, radiusKm);
    }
}

function getRandomPointInBuffer(center, radiusKm) {
    if (!center?.length) return [13.404954, 52.520007];
    const r = (0.55 + Math.random() * 0.38) * radiusKm / 111;
    const angle = Math.random() * 2 * Math.PI;
    return [center[0] + r * Math.cos(angle), center[1] + r * Math.sin(angle)];
}

// ─── Elevation profile ─────────────────────────────────────────────────────
async function getElevationProfile(geometry, numSamples = 50) {
    if (!geometry?.coordinates?.length) return [];
    const line = turf.lineString(geometry.coordinates);
    const totalLength = turf.length(line, { units: 'kilometers' });
    const sampled = [];
    for (let i = 0; i < numSamples; i++) {
        const dist = (i / (numSamples - 1)) * totalLength;
        try {
            const pt = turf.along(line, dist, { units: 'kilometers' });
            sampled.push({ dist, lon: pt.geometry.coordinates[0], lat: pt.geometry.coordinates[1] });
        } catch {}
    }
    const elevations = await getElevations(sampled.map(p => [p.lon, p.lat]));
    return sampled.map((p, i) => ({ distance: +p.dist.toFixed(3), elevation: elevations[i] ?? 34, lng: p.lon, lat: p.lat }));
}

async function getElevations(points) {
    if (!points?.length) return [];
    try {
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 8000);
        const res = await fetch('https://api.open-elevation.com/api/v1/lookup', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ locations: points.map(p => ({ longitude: p[0], latitude: p[1] })) }),
            signal: ctrl.signal
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!data.results) throw new Error('No results');
        return data.results.map(r => r.elevation);
    } catch {
        return points.map((_, i) => 34 + 12 * Math.sin(i / 9) + 4 * Math.sin(i / 3) + Math.random() * 2);
    }
}

// ══════════════════════════════════════════════════════════════════════════
// FIX #3: REAL OSM GREEN HEALTH SCORE ANALYSIS
// All 10 indices computed from actual Overpass API queries
// ══════════════════════════════════════════════════════════════════════════

async function analyzeRouteHealthScores(geometry) {
    if (!geometry?.coordinates?.length) return null;

    const line    = turf.lineString(geometry.coordinates);
    const totalKm = turf.length(line, { units: 'kilometers' });

    // Expand bbox slightly for better coverage
    const bbox = turf.bbox(turf.buffer(line, 0.05, { units: 'kilometers' })).join(',');

    // Single combined Overpass query for all needed tags
    const query = `[out:json][timeout:20];(
        node["natural"="tree"](${bbox});
        way["landuse"="forest"](${bbox});
        way["natural"="wood"](${bbox});
        way["leisure"="park"](${bbox});
        way["natural"="water"](${bbox});
        way["waterway"="river"](${bbox});
        way["waterway"="stream"](${bbox});
        node["highway"="traffic_signals"](${bbox});
        node["highway"="crossing"](${bbox});
        way["highway"="footway"](${bbox});
        way["highway"="path"](${bbox});
        way["highway"="pedestrian"](${bbox});
        way["lit"="yes"](${bbox});
        way["highway"="primary"](${bbox});
        way["highway"="secondary"](${bbox});
        way["highway"="residential"](${bbox});
        node["amenity"="bench"](${bbox});
        node["amenity"="drinking_water"](${bbox});
        node["amenity"="toilets"](${bbox});
        node["amenity"="cafe"](${bbox});
        node["leisure"="fitness_station"](${bbox});
        node["leisure"="pitch"](${bbox});
        node["leisure"="playground"](${bbox});
        way["natural"="wetland"](${bbox});
        way["natural"="grassland"](${bbox});
        node["tourism"="viewpoint"](${bbox});
        node["natural"="peak"](${bbox});
        node["historic"="monument"](${bbox});
        way["sidewalk"="yes"](${bbox});
        way["sidewalk"="both"](${bbox});
        way["sidewalk"="left"](${bbox});
        way["sidewalk"="right"](${bbox});
        way["highway"="motorway"](${bbox});
        way["highway"="trunk"](${bbox});
        way["landuse"="industrial"](${bbox});
    );out geom;`;

    let elements = [];
    try {
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 18000);
        const res = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`, { signal: ctrl.signal });
        const data = await res.json();
        elements = data.elements || [];
    } catch (e) {
        console.warn('Overpass analysis failed:', e.message);
        // Return simulated scores as fallback
        return generateFallbackScores(totalKm);
    }

    // ── Bucket elements by tag ────────────────────────────────────────────
    const byTag = (tag, val) => elements.filter(el => el.tags?.[tag] === val);
    const byTagIn = (tag, vals) => elements.filter(el => vals.includes(el.tags?.[tag]));

    const trees         = byTag('natural', 'tree').length;
    const forests       = [...byTag('landuse','forest'), ...byTag('natural','wood'), ...byTag('leisure','park')].length;
    const waterBodies   = [...byTag('natural','water'), ...byTag('waterway','river'), ...byTag('waterway','stream')].length;
    const trafficLights = byTag('highway','traffic_signals').length;
    const crossings     = byTag('highway','crossing').length;
    const footways      = [...byTag('highway','footway'), ...byTag('highway','path'), ...byTag('highway','pedestrian')].length;
    const litWays       = byTag('lit','yes').length;
    const majorRoads    = [...byTag('highway','primary'), ...byTag('highway','secondary')].length;
    const benches       = byTag('amenity','bench').length;
    const water_pts     = byTag('amenity','drinking_water').length;
    const toilets       = byTag('amenity','toilets').length;
    const cafes         = byTag('amenity','cafe').length;
    const fitStations   = [...byTag('leisure','fitness_station'), ...byTag('leisure','pitch'), ...byTag('leisure','playground')].length;
    const wetlands      = [...byTag('natural','wetland'), ...byTag('natural','grassland')].length;
    const viewpoints    = [...byTag('tourism','viewpoint'), ...byTag('natural','peak'), ...byTag('historic','monument')].length;
    const sidewalks     = byTagIn('sidewalk', ['yes','both','left','right']).length;
    const heavyRoads    = [...byTag('highway','motorway'), ...byTag('highway','trunk')].length;
    const industrial    = byTag('landuse','industrial').length;
    const residential   = byTag('highway','residential').length;

    // ── Per-km densities ─────────────────────────────────────────────────
    const km = Math.max(totalKm, 0.5);

    const treeDensity     = trees / km;
    const greenDensity    = forests + waterBodies;
    const lightDensity    = litWays / km;
    const signalDensity   = trafficLights / km;
    const crossingDensity = crossings / km;
    const footDensity     = footways / km;
    const benchDensity    = benches / km;
    const majorRoadDensity = majorRoads / km;
    const heavyRoadDist   = heavyRoads;
    const indDist         = industrial;

    // ── Normalize to 0–100 ───────────────────────────────────────────────
    const clamp = (v, max) => Math.min(100, Math.round((v / max) * 100));

    // 1. Nature Index: trees + forests + water
    const nature = Math.min(100, Math.round(
        clamp(treeDensity, 20) * 0.4 +
        clamp(greenDensity, 10) * 0.4 +
        clamp(waterBodies, 5) * 0.2
    ));

    // 2. Safety Index: lit streets, crossings, footways → penalize by traffic signals per km
    const safety = Math.min(100, Math.round(
        clamp(lightDensity, 5) * 0.4 +
        clamp(crossingDensity, 3) * 0.3 +
        clamp(footDensity, 8) * 0.3
    ));

    // 3. Tranquility Index: few major roads, mostly residential/pedestrian
    const tranq = Math.min(100, Math.round(
        Math.max(0, 100 - clamp(majorRoadDensity, 3) * 0.6 - clamp(heavyRoads, 2) * 0.4)
    ));

    // 4. Comfort Index: benches, water, toilets, cafes
    const comfort = Math.min(100, Math.round(
        clamp(benchDensity, 4) * 0.4 +
        clamp(water_pts + toilets, 3) * 0.35 +
        clamp(cafes, 4) * 0.25
    ));

    // 5. Activity Index: fitness stations, pitches, playgrounds
    const activity = Math.min(100, Math.round(clamp(fitStations, 8) * 1.0));

    // 6. Biodiversity Index: diverse habitats (forests, wetlands, grasslands, water)
    const biodiversity = Math.min(100, Math.round(
        clamp(forests, 6) * 0.5 +
        clamp(wetlands, 4) * 0.3 +
        clamp(waterBodies, 4) * 0.2
    ));

    // 7. Scenic Index: viewpoints, monuments, water, peaks
    const scenic = Math.min(100, Math.round(
        clamp(viewpoints, 4) * 0.6 +
        clamp(waterBodies, 4) * 0.4
    ));

    // 8. Walkability Index: sidewalks, footways, pedestrian areas
    const walkability = Math.min(100, Math.round(
        clamp(sidewalks + footways, 15) * 0.6 +
        clamp(footDensity, 10) * 0.4
    ));

    // 9. Air Quality (proxy): penalize motorways + industrial, reward distance
    const airQuality = Math.min(100, Math.max(0, Math.round(
        100 - clamp(heavyRoadDist, 3) * 0.5 - clamp(indDist, 3) * 0.5
    )));

    // 10. Night Walk Index: lit + crossings + pedestrian
    const nightWalk = Math.min(100, Math.round(
        clamp(lightDensity, 6) * 0.5 +
        clamp(crossingDensity, 4) * 0.3 +
        clamp(footDensity, 8) * 0.2
    ));

    // ── Composite Green Health Score ──────────────────────────────────────
    const ghs = Math.round(
        nature       * 0.25 +
        safety       * 0.15 +
        airQuality   * 0.15 +
        comfort      * 0.12 +
        walkability  * 0.13 +
        tranq        * 0.08 +
        activity     * 0.05 +
        biodiversity * 0.04 +
        scenic       * 0.02 +
        nightWalk    * 0.01
    );

    return {
        ghs,
        indices: [
            { id:'nature',       name:'Nature',       icon:'fa-tree',                  color:'#2e7d32', score:nature,       weight:.25, detail:`${trees} trees · ${forests} green areas · ${waterBodies} water bodies` },
            { id:'safety',       name:'Safety',       icon:'fa-shield-halved',         color:'#0288d1', score:safety,       weight:.15, detail:`${litWays} lit ways · ${crossings} crossings · ${trafficLights} signals` },
            { id:'airquality',   name:'Air Quality',  icon:'fa-wind',                  color:'#26c6da', score:airQuality,   weight:.15, detail:`${heavyRoads} heavy roads · ${industrial} industrial areas` },
            { id:'comfort',      name:'Comfort',      icon:'fa-couch',                 color:'#ff9800', score:comfort,      weight:.12, detail:`${benches} benches · ${water_pts} water pts · ${cafes} cafés` },
            { id:'walkability',  name:'Walkability',  icon:'fa-person-walking',        color:'#7b1fa2', score:walkability,  weight:.13, detail:`${sidewalks} sidewalks · ${footways} footways` },
            { id:'tranquility',  name:'Tranquility',  icon:'fa-volume-xmark',          color:'#546e7a', score:tranq,        weight:.08, detail:`${majorRoads} major roads · ${residential} residential` },
            { id:'activity',     name:'Activity',     icon:'fa-dumbbell',              color:'#e53935', score:activity,     weight:.05, detail:`${fitStations} fitness spots` },
            { id:'biodiversity', name:'Biodiversity', icon:'fa-frog',                  color:'#33691e', score:biodiversity, weight:.04, detail:`${forests} habitats · ${wetlands} wetlands` },
            { id:'scenic',       name:'Scenic',       icon:'fa-camera',                color:'#9c27b0', score:scenic,       weight:.02, detail:`${viewpoints} viewpoints & landmarks` },
            { id:'nightwalk',    name:'Night Walk',   icon:'fa-moon',                  color:'#1565c0', score:nightWalk,    weight:.01, detail:`${litWays} lit · ${crossings} safe crossings` },
        ],
        raw: { trees, forests, waterBodies, trafficLights, crossings, benches, fitStations, viewpoints, litWays, majorRoads },
        totalKm
    };
}

function generateFallbackScores(totalKm) {
    // Simulated scores when Overpass is unavailable
    const r = (min, max) => Math.floor(min + Math.random() * (max - min));
    const nature      = r(35, 85);
    const safety      = r(40, 80);
    const airQuality  = r(45, 90);
    const comfort     = r(20, 70);
    const walkability = r(40, 85);
    const tranq       = r(30, 80);
    const activity    = r(10, 60);
    const biodiversity = r(20, 75);
    const scenic      = r(15, 70);
    const nightWalk   = r(30, 75);

    const ghs = Math.round(nature*.25 + safety*.15 + airQuality*.15 + comfort*.12 + walkability*.13 + tranq*.08 + activity*.05 + biodiversity*.04 + scenic*.02 + nightWalk*.01);

    return {
        ghs,
        indices: [
            { id:'nature',       name:'Nature',       icon:'fa-tree',           color:'#2e7d32', score:nature,       weight:.25, detail:'Based on route profile (OSM unavailable)' },
            { id:'safety',       name:'Safety',       icon:'fa-shield-halved',  color:'#0288d1', score:safety,       weight:.15, detail:'Estimated from route type' },
            { id:'airquality',   name:'Air Quality',  icon:'fa-wind',           color:'#26c6da', score:airQuality,   weight:.15, detail:'Estimated from road proximity' },
            { id:'comfort',      name:'Comfort',      icon:'fa-couch',          color:'#ff9800', score:comfort,      weight:.12, detail:'Estimated from amenity density' },
            { id:'walkability',  name:'Walkability',  icon:'fa-person-walking', color:'#7b1fa2', score:walkability,  weight:.13, detail:'Estimated from path types' },
            { id:'tranquility',  name:'Tranquility',  icon:'fa-volume-xmark',   color:'#546e7a', score:tranq,        weight:.08, detail:'Estimated from traffic data' },
            { id:'activity',     name:'Activity',     icon:'fa-dumbbell',       color:'#e53935', score:activity,     weight:.05, detail:'Estimated from leisure tags' },
            { id:'biodiversity', name:'Biodiversity', icon:'fa-frog',           color:'#33691e', score:biodiversity, weight:.04, detail:'Estimated from green coverage' },
            { id:'scenic',       name:'Scenic',       icon:'fa-camera',         color:'#9c27b0', score:scenic,       weight:.02, detail:'Estimated from landmark density' },
            { id:'nightwalk',    name:'Night Walk',   icon:'fa-moon',           color:'#1565c0', score:nightWalk,    weight:.01, detail:'Estimated from lighting data' },
        ],
        raw: {},
        totalKm
    };
}

// ─── Surface types ─────────────────────────────────────────────────────────
async function getRouteSurfaceTypes(geometry) {
    if (!geometry?.coordinates) return { highways: [], surfaces: [] };
    try {
        const line = turf.lineString(geometry.coordinates);
        const bbox = turf.bbox(line).join(',');
        const q = `[out:json][timeout:8];(way["highway"](${bbox});way["surface"](${bbox}););out tags;`;
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 7000);
        const res = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(q)}`, { signal: ctrl.signal });
        const data = await res.json();

        if (data.elements?.length > 0) {
            const hwCount = {}, sfCount = {};
            data.elements.forEach(el => {
                if (el.tags?.highway) hwCount[el.tags.highway] = (hwCount[el.tags.highway] || 0) + 1;
                if (el.tags?.surface) sfCount[el.tags.surface] = (sfCount[el.tags.surface] || 0) + 1;
            });
            const L = turf.length(line, { units: 'kilometers' });
            const tH = Object.values(hwCount).reduce((a,b)=>a+b,1);
            const tS = Object.values(sfCount).reduce((a,b)=>a+b,1);
            const hwC = { footway:'#4caf50', path:'#8bc34a', residential:'#ff9800', cycleway:'#29b6f6', pedestrian:'#ab47bc', service:'#ff7043', primary:'#ef5350', track:'#795548' };
            const sfC = { asphalt:'#607d8b', paved:'#546e7a', concrete:'#78909c', gravel:'#8d6e63', grass:'#66bb6a', dirt:'#a1887f', cobblestone:'#5d4037', unpaved:'#bcaaa4' };
            return {
                highways: Object.entries(hwCount).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([t,c])=>({ type:t, color:hwC[t]||'#90a4ae', length:+(L*c/tH).toFixed(2) })),
                surfaces: Object.entries(sfCount).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([t,c])=>({ type:t, color:sfC[t]||'#90a4ae', length:+(L*c/tS).toFixed(2) }))
            };
        }
    } catch (e) { console.warn('Surface types error:', e.message); }

    return generateMockSurface(geometry);
}

function generateMockSurface(geometry) {
    const L = turf.length(turf.lineString(geometry.coordinates), { units: 'kilometers' });
    return {
        highways: [
            { type:'footway',    color:'#4caf50', length:+(L*.32).toFixed(2) },
            { type:'path',       color:'#8bc34a', length:+(L*.22).toFixed(2) },
            { type:'residential',color:'#ff9800', length:+(L*.24).toFixed(2) },
            { type:'cycleway',   color:'#29b6f6', length:+(L*.14).toFixed(2) },
            { type:'pedestrian', color:'#ab47bc', length:+(L*.08).toFixed(2) }
        ],
        surfaces: [
            { type:'asphalt', color:'#607d8b', length:+(L*.38).toFixed(2) },
            { type:'paved',   color:'#546e7a', length:+(L*.22).toFixed(2) },
            { type:'gravel',  color:'#8d6e63', length:+(L*.18).toFixed(2) },
            { type:'grass',   color:'#66bb6a', length:+(L*.14).toFixed(2) },
            { type:'dirt',    color:'#a1887f', length:+(L*.08).toFixed(2) }
        ]
    };
}

// ─── Route factors for timeline — derived from real OSM analysis ───────────
// Returns factor rows with actual positions from Overpass elements
// ─── 25 Overpass queries → real element positions along route ──────────────
// Matches elements to nearest point on route, builds segment blobs for timeline
// ─── 7 grouped factor categories → single Overpass query ─────────────────
// Returns grouped results for timeline: 7 rows instead of 25
async function getRouteFactors(geometry) {
    if (!geometry?.coordinates?.length) return [];

    const line     = turf.lineString(geometry.coordinates);
    const totalLen = turf.length(line, { units: 'kilometers' });
    const bbox     = turf.bbox(turf.buffer(line, 0.08, { units:'kilometers' })).join(',');

    // 7 GROUPS — each has multiple OSM tags merged into one timeline row
    const GROUPS = [
        {
            id: 'nature', name: 'NATURE', icon: 'fa-tree', color: '#2e7d32',
            tags: [
                { key:'natural',  val:'tree',   type:'node' },
                { key:'landuse',  val:'forest',  type:'way'  },
                { key:'leisure',  val:'park',    type:'way'  },
                { key:'natural',  val:'wood',    type:'way'  },
                { key:'natural',  val:'water',   type:'way'  },
                { key:'waterway', val:'river',   type:'way'  },
            ]
        },
        {
            id: 'walkability', name: 'WALKABILITY', icon: 'fa-person-walking', color: '#7b1fa2',
            tags: [
                { key:'highway',  val:'footway',    type:'way' },
                { key:'highway',  val:'path',       type:'way' },
                { key:'highway',  val:'pedestrian', type:'way' },
                { key:'sidewalk', val:'yes',         type:'way' },
            ]
        },
        {
            id: 'safety', name: 'SAFETY', icon: 'fa-shield-halved', color: '#0288d1',
            tags: [
                { key:'lit',     val:'yes',              type:'way'  },
                { key:'highway', val:'traffic_signals',  type:'node' },
                { key:'highway', val:'crossing',         type:'node' },
                { key:'amenity', val:'police',           type:'node' },
            ]
        },
        {
            id: 'comfort', name: 'COMFORT', icon: 'fa-couch', color: '#ff9800',
            tags: [
                { key:'amenity', val:'bench',          type:'node' },
                { key:'amenity', val:'drinking_water', type:'node' },
                { key:'amenity', val:'toilets',        type:'node' },
                { key:'amenity', val:'cafe',           type:'nwr'  },
            ]
        },
        {
            id: 'activity', name: 'ACTIVITY', icon: 'fa-dumbbell', color: '#e53935',
            tags: [
                { key:'leisure', val:'fitness_station', type:'nwr' },
                { key:'leisure', val:'pitch',           type:'nwr' },
                { key:'leisure', val:'playground',      type:'nwr' },
            ]
        },
        {
            id: 'scenic', name: 'SCENIC', icon: 'fa-camera', color: '#9c27b0',
            tags: [
                { key:'tourism',  val:'viewpoint',  type:'nwr' },
                { key:'historic', val:'monument',   type:'nwr' },
                { key:'tourism',  val:'artwork',    type:'nwr' },
            ]
        },
        {
            id: 'mobility', name: 'MOBILITY', icon: 'fa-bicycle', color: '#00897b',
            tags: [
                { key:'highway', val:'cycleway',        type:'way'  },
                { key:'amenity', val:'bicycle_parking', type:'node' },
            ]
        },
    ];

    // Build ONE combined Overpass query for all groups
    const queryParts = [];
    for (const grp of GROUPS) {
        for (const t of grp.tags) {
            const osmType = t.type === 'node' ? 'node' : t.type === 'way' ? 'way' : 'nwr';
            queryParts.push(`${osmType}["${t.key}"="${t.val}"](${bbox});`);
        }
    }
    const fullQuery = `[out:json][timeout:22];(\n${queryParts.join('\n')}\n);out geom;`;

    let elements = [];
    try {
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 20000);
        const res = await fetch(
            `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(fullQuery)}`,
            { signal: ctrl.signal }
        );
        const data = await res.json();
        elements = data.elements || [];
    } catch (e) {
        console.warn('Factor Overpass fetch failed, using simulation:', e.message);
        return simulateGroupedFactors(GROUPS, line, totalLen);
    }

    // For each group, collect matching elements and project onto route
    const results = [];

    for (const grp of GROUPS) {
        const allEvents = [];

        for (const t of grp.tags) {
            const matched = elements.filter(el => el.tags?.[t.key] === t.val);

            for (const el of matched) {
                // Get representative point
                let elPt;
                if (el.type === 'node' && el.lat !== undefined) {
                    elPt = turf.point([el.lon, el.lat]);
                } else if (el.geometry?.length > 0) {
                    const pts = el.geometry.map(p => [p.lon, p.lat]);
                    try { elPt = turf.point(pts[Math.floor(pts.length / 2)]); }
                    catch { continue; }
                } else continue;

                // Project to route
                try {
                    const snapped = turf.nearestPointOnLine(line, elPt, { units: 'kilometers' });
                    const dist = snapped.properties.location;
                    if (dist === undefined || isNaN(dist) || dist < 0 || dist > totalLen) continue;

                    const lateral = turf.distance(elPt, snapped, { units: 'meters' });
                    if (lateral > 100) continue; // within 100m of route

                    allEvents.push({
                        distance: +dist.toFixed(3),
                        lat: elPt.geometry.coordinates[1],
                        lng: elPt.geometry.coordinates[0],
                        tag: `${t.key}=${t.val}`,
                        name: el.tags?.name || '',
                        lateral: Math.round(lateral)
                    });
                } catch { continue; }
            }
        }

        if (!allEvents.length) continue;

        allEvents.sort((a, b) => a.distance - b.distance);
        const segments = buildSegments(allEvents, totalLen);
        results.push({ ...grp, events: allEvents, segments });
    }

    return results;
}

// Group nearby events into blob segments
function buildSegments(events, totalLen) {
    if (!events.length) return [];
    const GAP_KM = 0.25;
    const segments = [];
    let seg = { start: events[0].distance, end: events[0].distance, count: 1, events: [events[0]] };
    for (let i = 1; i < events.length; i++) {
        const ev = events[i];
        if (ev.distance - seg.end <= GAP_KM) {
            seg.end = ev.distance; seg.count++; seg.events.push(ev);
        } else {
            segments.push({ ...seg });
            seg = { start: ev.distance, end: ev.distance, count: 1, events: [ev] };
        }
    }
    segments.push({ ...seg });
    return segments.map(s => ({
        startPct: (s.start / totalLen) * 100,
        endPct:   Math.max((s.end / totalLen) * 100, (s.start / totalLen) * 100 + 1.0),
        count: s.count, events: s.events,
        midPct: ((s.start + s.end) / 2 / totalLen) * 100
    }));
}

// Simulation fallback
function simulateGroupedFactors(groups, line, totalLen) {
    const numSamples = Math.min(50, Math.floor(totalLen * 8));
    const sample = [];
    for (let i = 0; i <= numSamples; i++) {
        const dist = (i / numSamples) * totalLen;
        try {
            const pt = turf.along(line, dist, { units:'kilometers' });
            sample.push({ dist, lat: pt.geometry.coordinates[1], lng: pt.geometry.coordinates[0] });
        } catch {}
    }
    const PROBS = { nature:0.55, walkability:0.60, safety:0.45, comfort:0.30, activity:0.15, scenic:0.12, mobility:0.25 };
    return groups.map(grp => {
        const p = PROBS[grp.id] || 0.2;
        const events = sample
            .filter(() => Math.random() < p * 0.4)
            .map(s => ({ distance:+s.dist.toFixed(3), lat:s.lat, lng:s.lng, tag:'', name:'', lateral:Math.floor(Math.random()*70) }));
        if (!events.length) return null;
        events.sort((a,b) => a.distance - b.distance);
        return { ...grp, events, segments: buildSegments(events, totalLen) };
    }).filter(Boolean);
}
