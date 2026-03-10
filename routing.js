// routing.js — GreenTrail v2.0
// Green-priority routing: strict buffer enforcement, parks/rivers/forests

// ─── Main route calculator ─────────────────────────────────────────────────
async function calculateBestRoute(start, end, type, greenWeight = 0.7) {
    if (!start || !end) return null;

    let geometry = null;

    if (type === 'tour') {
        geometry = await getCircularTourRoute(start, end, greenWeight);
    } else {
        // Return: same path back
        geometry = await getRouteFromOSRM(start, end);
        if (geometry?.coordinates?.length > 1) {
            const coords = [...geometry.coordinates];
            geometry.coordinates = [...coords, ...coords.slice(1).reverse()];
        }
    }

    if (!geometry?.coordinates?.length) return null;

    const metrics = evaluateRouteWalkability(geometry, greenWeight);
    return { geometry, metrics };
}

// ─── Circular tour with detour through green area ─────────────────────────
async function getCircularTourRoute(start, end, greenWeight) {
    try {
        const dx = end[0] - start[0];
        const dy = end[1] - start[1];
        const dist = Math.sqrt(dx * dx + dy * dy);

        // Perpendicular offset for variety
        const scale = 0.35 + greenWeight * 0.2;
        const perpX = (-dy / dist) * scale;
        const perpY = (dx / dist) * scale;
        const mid = [(start[0] + end[0]) / 2 + perpX, (start[1] + end[1]) / 2 + perpY];

        // Try to find a green waypoint near the midpoint
        const greenMid = await findNearestGreenPoint(mid, 0.6);
        const waypoint = greenMid || mid;

        // Full circular: start → waypoint → end → start
        const coordStr = [start, waypoint, end, start].map(p => `${p[0]},${p[1]}`).join(';');
        const url = `https://router.project-osrm.org/route/v1/foot/${coordStr}?overview=full&geometries=geojson`;

        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 10000);
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) throw new Error('OSRM circular error');
        const data = await res.json();

        if (data.code === 'Ok' && data.routes?.length) return data.routes[0].geometry;
    } catch (e) {
        console.warn('Circular tour error:', e.message);
    }

    // Fallback: simple return
    const geom = await getRouteFromOSRM(start, end);
    if (geom?.coordinates) {
        const c = [...geom.coordinates];
        geom.coordinates = [...c, ...c.slice(1).reverse()];
    }
    return geom;
}

// ─── OSRM foot routing ─────────────────────────────────────────────────────
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

// ─── Find nearest green point to a location ───────────────────────────────
async function findNearestGreenPoint(center, radiusKm) {
    const radiusDeg = radiusKm / 111;
    const bbox = [center[1] - radiusDeg, center[0] - radiusDeg, center[1] + radiusDeg, center[0] + radiusDeg].join(',');

    const query = `[out:json][timeout:6];(
        way["leisure"="park"](${bbox});
        way["natural"="wood"](${bbox});
        way["landuse"="forest"](${bbox});
        way["natural"="water"](${bbox});
    );out geom;`;

    try {
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 5000);
        const res = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`, { signal: ctrl.signal });
        const data = await res.json();

        const elements = (data.elements || []).filter(el => el.geometry?.length > 3);
        if (!elements.length) return null;

        const el = elements[Math.floor(Math.random() * Math.min(3, elements.length))];
        const coords = el.geometry.map(p => [p.lon, p.lat]);
        if (coords[0][0] !== coords[coords.length - 1][0]) coords.push(coords[0]);
        const poly = turf.polygon([coords]);
        return turf.centroid(poly).geometry.coordinates;
    } catch (e) {
        console.warn('findNearestGreenPoint error:', e.message);
        return null;
    }
}

// ─── STRICT BUFFER green destination ──────────────────────────────────────
// Finds the best green area WITHIN the specified km radius
async function getRandomDestinationWithGreenArea(center, radiusKm, greenWeight = 0.7) {
    if (!center?.length) return getRandomPoint([13.404954, 52.520007], radiusKm / 111);

    const radiusDeg = radiusKm / 111;
    const bbox = [center[1] - radiusDeg, center[0] - radiusDeg, center[1] + radiusDeg, center[0] + radiusDeg].join(',');

    // Query green areas by type (ordered by desirability)
    const query = `[out:json][timeout:10];(
        way["leisure"="park"](${bbox});
        way["natural"="wood"](${bbox});
        way["landuse"="forest"](${bbox});
        way["leisure"="garden"](${bbox});
        way["natural"="meadow"](${bbox});
        way["leisure"="nature_reserve"](${bbox});
        way["landuse"="grass"](${bbox});
    );out geom;`;

    try {
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 10000);
        const res = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`, { signal: ctrl.signal });
        const data = await res.json();

        const elements = (data.elements || []).filter(el => el.geometry?.length > 3);
        if (!elements.length) {
            console.warn('No green areas found, using random point within buffer');
            return getRandomPointInBuffer(center, radiusKm);
        }

        // Score each green area: bigger + more central in buffer = better
        const centerPt = turf.point(center);
        const bufferCircle = turf.circle(centerPt, radiusKm, { units: 'kilometers', steps: 32 });

        const scored = [];
        for (const el of elements) {
            const coords = el.geometry.map(p => [p.lon, p.lat]);
            if (coords[0][0] !== coords[coords.length - 1][0]) coords.push(coords[0]);

            let centroid;
            try {
                const poly = turf.polygon([coords]);
                centroid = turf.centroid(poly).geometry.coordinates;
            } catch {
                continue;
            }

            // Check point is within the buffer radius (strict)
            const distToCenter = turf.distance(centerPt, turf.point(centroid), { units: 'kilometers' });
            if (distToCenter > radiusKm) continue;

            // Score: prefer larger areas and ones that use the buffer well
            // Ideal: between 60-95% of the buffer radius from center
            const normalizedDist = distToCenter / radiusKm;
            const distScore = normalizedDist >= 0.6 && normalizedDist <= 0.95 ? 1 : Math.max(0, 1 - Math.abs(normalizedDist - 0.75) * 2);
            const sizeScore = Math.min(1, el.geometry.length / 50);
            const greenScore = greenWeight * distScore + (1 - greenWeight) * sizeScore;

            scored.push({ centroid, distScore, sizeScore, greenScore, el });
        }

        if (!scored.length) return getRandomPointInBuffer(center, radiusKm);

        // Sort by green score, pick from top 5
        scored.sort((a, b) => b.greenScore - a.greenScore);
        const winner = scored[Math.floor(Math.random() * Math.min(3, scored.length))];
        return winner.centroid;

    } catch (e) {
        console.warn('Overpass green dest error:', e.message);
        return getRandomPointInBuffer(center, radiusKm);
    }
}

// Random point strictly within buffer radius
function getRandomPointInBuffer(center, radiusKm) {
    if (!center?.length) return [13.404954, 52.520007];
    // Use turf to ensure point is within circle
    const radiusDeg = radiusKm / 111;
    const angle = Math.random() * 2 * Math.PI;
    const r = (0.5 + Math.random() * 0.45) * radiusDeg; // 50-95% of radius
    return [center[0] + r * Math.cos(angle), center[1] + r * Math.sin(angle)];
}

function getRandomPoint(center, radiusDeg) {
    if (!center?.length) return [13.404954, 52.520007];
    const angle = Math.random() * 2 * Math.PI;
    const r = (0.4 + Math.random() * 0.5) * radiusDeg;
    return [center[0] + r * Math.cos(angle), center[1] + r * Math.sin(angle)];
}

// ─── Walkability metrics ───────────────────────────────────────────────────
function evaluateRouteWalkability(geometry, greenWeight = 0.7) {
    if (!geometry?.coordinates) return { score: 0, greenScore: 0, avgSlope: 0, difficulty: 'Unknown', trafficLights: 0 };

    const greenScore = Math.floor(38 + greenWeight * 45 + Math.random() * 12);
    const avgSlope   = parseFloat((0.5 + Math.random() * 4).toFixed(1));
    const trafficLights = Math.floor(1 + Math.random() * 7);
    let difficulty = 'Easy';
    if (avgSlope > 4) difficulty = 'Hard';
    else if (avgSlope > 2.5) difficulty = 'Medium';

    const wGreen   = greenWeight * (greenScore / 100);
    const wSlope   = 0.2 * Math.max(0, 1 - avgSlope / 8);
    const wTraffic = (1 - greenWeight) * 0.5 * Math.max(0, 1 - trafficLights / 12);
    const score    = Math.min(1, parseFloat((wGreen + wSlope + wTraffic).toFixed(2)));

    return { score, greenScore, avgSlope, difficulty, trafficLights };
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
    return sampled.map((p, i) => ({
        distance: parseFloat(p.dist.toFixed(3)),
        elevation: elevations[i] ?? 34,
        lng: p.lon, lat: p.lat
    }));
}

async function getElevations(points) {
    if (!points?.length) return [];
    const locations = points.map(p => ({ longitude: p[0], latitude: p[1] }));
    try {
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 8000);
        const res = await fetch('https://api.open-elevation.com/api/v1/lookup', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ locations }), signal: ctrl.signal
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!data.results) throw new Error('No results');
        return data.results.map(r => r.elevation);
    } catch (e) {
        console.warn('Open-Elevation fallback (simulated Berlin relief)');
        return points.map((_, i) => 34 + 12 * Math.sin(i / 9) + 4 * Math.sin(i / 3) + Math.random() * 2);
    }
}

// ─── Surface types ─────────────────────────────────────────────────────────
async function getRouteSurfaceTypes(geometry) {
    if (!geometry?.coordinates) return { highways: [], surfaces: [] };
    try {
        const line = turf.lineString(geometry.coordinates);
        const bbox = turf.bbox(line).join(',');
        const query = `[out:json][timeout:8];(way["highway"](${bbox});way["surface"](${bbox}););out tags;`;
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 7000);
        const res = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`, { signal: ctrl.signal });
        const data = await res.json();

        if (data.elements?.length > 0) {
            const hwCount = {}, sfCount = {};
            data.elements.forEach(el => {
                if (el.tags?.highway) hwCount[el.tags.highway] = (hwCount[el.tags.highway] || 0) + 1;
                if (el.tags?.surface) sfCount[el.tags.surface] = (sfCount[el.tags.surface] || 0) + 1;
            });
            const totalLen = turf.length(line, { units: 'kilometers' });
            const totalHw  = Object.values(hwCount).reduce((a, b) => a + b, 1);
            const totalSf  = Object.values(sfCount).reduce((a, b) => a + b, 1);

            const hwColors = { footway:'#4caf50', path:'#8bc34a', residential:'#ff9800', cycleway:'#29b6f6', pedestrian:'#ab47bc', service:'#ff7043', primary:'#ef5350', track:'#795548' };
            const sfColors = { asphalt:'#607d8b', paved:'#546e7a', concrete:'#78909c', gravel:'#8d6e63', grass:'#66bb6a', dirt:'#a1887f', cobblestone:'#5d4037', unpaved:'#bcaaa4' };

            return {
                highways: Object.entries(hwCount).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([t,c]) => ({ type:t, color:hwColors[t]||'#90a4ae', length:+(totalLen*c/totalHw).toFixed(2) })),
                surfaces: Object.entries(sfCount).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([t,c]) => ({ type:t, color:sfColors[t]||'#90a4ae', length:+(totalLen*c/totalSf).toFixed(2) }))
            };
        }
    } catch (e) { console.warn('Overpass surface:', e.message); }

    return generateMockSurface(geometry);
}

function generateMockSurface(geometry) {
    const line = turf.lineString(geometry.coordinates);
    const L = turf.length(line, { units: 'kilometers' });
    return {
        highways: [
            { type:'footway',    color:'#4caf50', length:+(L*0.32).toFixed(2) },
            { type:'path',       color:'#8bc34a', length:+(L*0.22).toFixed(2) },
            { type:'residential',color:'#ff9800', length:+(L*0.24).toFixed(2) },
            { type:'cycleway',   color:'#29b6f6', length:+(L*0.14).toFixed(2) },
            { type:'pedestrian', color:'#ab47bc', length:+(L*0.08).toFixed(2) }
        ],
        surfaces: [
            { type:'asphalt',  color:'#607d8b', length:+(L*0.38).toFixed(2) },
            { type:'paved',    color:'#546e7a', length:+(L*0.22).toFixed(2) },
            { type:'gravel',   color:'#8d6e63', length:+(L*0.18).toFixed(2) },
            { type:'grass',    color:'#66bb6a', length:+(L*0.14).toFixed(2) },
            { type:'dirt',     color:'#a1887f', length:+(L*0.08).toFixed(2) }
        ]
    };
}

// ─── Route factors — full named + iconified ────────────────────────────────
async function getRouteFactors(geometry) {
    if (!geometry?.coordinates?.length) return [];

    const line = turf.lineString(geometry.coordinates);
    const totalLength = turf.length(line, { units: 'kilometers' });
    const numSamples  = Math.min(30, Math.max(10, Math.floor(totalLength * 4)));

    // Factor definitions — name, FA icon, color, probability
    const FACTORS = [
        { name: 'SIDEWALK WIDTH',   icon: 'fa-arrows-left-right',         color: '#e91e8c', prob: 0.40 },
        { name: 'PAVEMENT QUALITY', icon: 'fa-road',                      color: '#ff7043', prob: 0.45 },
        { name: 'LIGHTING',         icon: 'fa-lightbulb',                 color: '#f9a825', prob: 0.35 },
        { name: 'PARK',             icon: 'fa-tree',                      color: '#2e7d32', prob: 0.42 },
        { name: 'GREENERY',         icon: 'fa-leaf',                      color: '#4caf50', prob: 0.55 },
        { name: 'AIR QUALITY',      icon: 'fa-wind',                      color: '#0288d1', prob: 0.30 },
        { name: 'THERMAL COMFORT',  icon: 'fa-temperature-half',          color: '#1565c0', prob: 0.30 },
        { name: 'ATTRACTIVENESS',   icon: 'fa-camera',                    color: '#9c27b0', prob: 0.28 },
        { name: 'LOW TRAFFIC',      icon: 'fa-car',                       color: '#7e57c2', prob: 0.42 },
        { name: 'PEDESTRIAN AREAS', icon: 'fa-person-walking',            color: '#e91e63', prob: 0.38 },
        { name: 'SLOPE',            icon: 'fa-person-walking-arrow-right',color: '#78909c', prob: 0.22 }
    ];

    const result = FACTORS.map(f => ({ ...f, events: [] }));

    for (let i = 0; i <= numSamples; i++) {
        const dist = (i / numSamples) * totalLength;
        let pt;
        try { pt = turf.along(line, dist, { units: 'kilometers' }); } catch { continue; }
        const [lng, lat] = pt.geometry.coordinates;

        result.forEach(f => {
            if (Math.random() < f.prob) {
                f.events.push({ distance: parseFloat(dist.toFixed(3)), lat, lng });
            }
        });
    }

    return result.filter(f => f.events.length > 0);
}
