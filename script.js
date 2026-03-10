// script.js — GreenTrail v2.0

document.addEventListener('DOMContentLoaded', () => {

// ═══════════════════════════════════════════════════
// MAP INIT
// FIX #5: proper satellite tile URL (MapTiler free tiles)
// ═══════════════════════════════════════════════════
const MAP_STYLES = {
    green:     'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json',
    satellite: {
        version: 8,
        sources: {
            'satellite-tiles': {
                type: 'raster',
                tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
                tileSize: 256,
                attribution: '© Esri © Maxar © Earthstar Geographics'
            }
        },
        layers: [{ id: 'satellite', type: 'raster', source: 'satellite-tiles', minzoom: 0, maxzoom: 22 }],
        glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf'
    },
    osm: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json'
};

const map = new maplibregl.Map({
    container: 'map',
    style: MAP_STYLES.green,
    center: [13.404954, 52.520007],
    zoom: 12,
    attributionControl: false
});

map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'bottom-right');
map.addControl(new maplibregl.ScaleControl({ maxWidth: 80, unit: 'metric' }), 'bottom-left');

// ═══════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════
let userLocation     = null;
let destination      = null;
let destType         = 'click';
let routeType        = 'return';
let selectedKm       = 5;
let greenWeight      = 0.7;
let routeActive      = false;
let elevChart        = null;
let currentElevData  = [];
let hoverMarker      = null;
let startMarker      = null;
let destMarker       = null;
let currentRouteGeom = null; // stored for export
let wfsParksLoaded   = false;
let wfsGreenLoaded   = false;
let recRoutesLoaded  = false;
let factorMapMarkers = []; // markers on map for factors
let currentStyle     = 'green';

// ═══════════════════════════════════════════════════
// GEOLOCATION
// ═══════════════════════════════════════════════════
const locText = document.getElementById('loc-text');
const locDot  = document.querySelector('.loc-dot');

if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
        ({ coords }) => {
            userLocation = [coords.longitude, coords.latitude];
            locText.textContent = '📍 Location acquired';
            locDot.style.background = '#4caf50';
            startMarker = placeMarker(userLocation, 'start', 'Your location');
            map.flyTo({ center: userLocation, zoom: 13 });
            fetchWeather(coords.latitude, coords.longitude);
            checkBtnState();
        },
        () => {
            userLocation = [13.404954, 52.520007];
            locText.textContent = '⚠ Using Berlin center';
            locDot.style.background = '#f9a825';
            locDot.classList.remove('pulse');
            startMarker = placeMarker(userLocation, 'start', 'Berlin center');
            fetchWeather(52.520007, 13.404954);
            checkBtnState();
        },
        { timeout: 10000, enableHighAccuracy: false }
    );
} else {
    locText.textContent = '⚠ Geolocation not supported';
    userLocation = [13.404954, 52.520007];
    startMarker = placeMarker(userLocation, 'start', 'Berlin center');
    fetchWeather(52.520007, 13.404954);
}

// ═══════════════════════════════════════════════════
// WEATHER — Open-Meteo (free, no API key)
// ═══════════════════════════════════════════════════
async function fetchWeather(lat, lon) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&hourly=relative_humidity_2m,wind_speed_10m&timezone=auto&forecast_days=1`;
    try {
        const res  = await fetch(url);
        const data = await res.json();
        const cw   = data.current_weather;
        if (!cw) return;

        const emoji = c => c === 0 ? '☀️' : c <= 2 ? '⛅' : c <= 48 ? '🌫' : c <= 67 ? '🌧' : c <= 77 ? '❄️' : c <= 82 ? '🌦' : c >= 95 ? '⛈' : '🌤';
        const desc  = c => c === 0 ? 'Clear sky' : c <= 2 ? 'Partly cloudy' : c <= 48 ? 'Foggy' : c <= 67 ? 'Rainy' : c <= 77 ? 'Snowing' : c <= 82 ? 'Showers' : c >= 95 ? 'Thunderstorm' : 'Cloudy';

        const hourIdx = new Date().getHours();
        const hum = data.hourly?.relative_humidity_2m?.[hourIdx] ?? '--';

        document.getElementById('w-icon').textContent = emoji(cw.weathercode);
        document.getElementById('w-temp').textContent = `${Math.round(cw.temperature)}°C`;
        document.getElementById('w-desc').textContent = desc(cw.weathercode);
        document.getElementById('w-wind').innerHTML   = `<i class="fas fa-wind"></i> ${cw.windspeed} km/h`;
        document.getElementById('w-hum').innerHTML    = `<i class="fas fa-tint"></i> ${hum}%`;
        document.getElementById('weather-widget').classList.remove('hidden');
    } catch (e) { console.warn('Weather failed:', e.message); }
}

// ═══════════════════════════════════════════════════
// MARKERS
// ═══════════════════════════════════════════════════
function placeMarker(lngLat, type, label) {
    const el = document.createElement('div');
    const isStart = type === 'start';
    el.style.cssText = `
        width:${isStart?14:18}px; height:${isStart?14:18}px; border-radius:50%;
        background:${isStart?'#2e7d32':'#ff4b4b'};
        border:3px solid white;
        box-shadow: 0 2px 8px rgba(0,0,0,.25), 0 0 0 ${isStart?4:5}px ${isStart?'rgba(76,175,80,.25)':'rgba(255,75,75,.2)'};
        cursor:pointer;
    `;
    return new maplibregl.Marker({ element: el })
        .setLngLat(lngLat)
        .setPopup(new maplibregl.Popup({ offset: 14, closeButton: false }).setHTML(`<span>${label}</span>`))
        .addTo(map);
}

function placeHoverMarker(lngLat) {
    if (!lngLat || isNaN(lngLat[0])) return;
    const el = document.createElement('div');
    el.style.cssText = `width:10px;height:10px;border-radius:50%;background:#f9a825;border:2px solid white;box-shadow:0 0 8px rgba(249,168,37,.6);pointer-events:none;`;
    if (!hoverMarker) {
        hoverMarker = new maplibregl.Marker({ element: el }).setLngLat(lngLat).addTo(map);
    } else {
        hoverMarker.setLngLat(lngLat);
    }
}

function removeHoverMarker() {
    if (hoverMarker) { hoverMarker.remove(); hoverMarker = null; }
}

// ═══════════════════════════════════════════════════
// DESTINATION MODE TABS
// ═══════════════════════════════════════════════════
document.querySelectorAll('.tab[data-dest]').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab[data-dest]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        destType = btn.dataset.dest;

        document.getElementById('dist-opts').classList.toggle('hidden', destType !== 'distance');

        if (destType === 'distance') {
            if (userLocation) { showRadiusCircle(); zoomToBuffer(); }
            if (destMarker) { destMarker.remove(); destMarker = null; destination = null; }
        } else {
            removeRadiusCircle();
        }
        checkBtnState();
    });
});

// ─── KM pills ──────────────────────────────────────
document.querySelectorAll('.km-pill').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.km-pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedKm = parseInt(btn.dataset.km);
        if (destType === 'distance' && userLocation) {
            updateRadiusCircle();
            zoomToBuffer();
            destination = null;
        }
        checkBtnState();
    });
});

// ═══════════════════════════════════════════════════
// ROUTE TYPE TABS
// ═══════════════════════════════════════════════════
document.querySelectorAll('.tab[data-type]').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab[data-type]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        routeType = btn.dataset.type;
        document.getElementById('type-hint').textContent =
            routeType === 'return' ? 'Same path outward and back' : 'Calculates a different return path — circular loop';
    });
});

// ═══════════════════════════════════════════════════
// GREEN WEIGHT SLIDER
// ═══════════════════════════════════════════════════
const gSlider = document.getElementById('green-weight');
const gLabel  = document.getElementById('green-pct-label');
gSlider.addEventListener('input', () => {
    greenWeight = gSlider.value / 100;
    gLabel.textContent = `${gSlider.value}%`;
    gSlider.style.background = `linear-gradient(to right, #4caf50 ${gSlider.value}%, #ddd ${gSlider.value}%)`;
});

// ═══════════════════════════════════════════════════
// MAP CLICK — place destination
// ═══════════════════════════════════════════════════
map.on('click', (e) => {
    if (destType !== 'click') return;
    destination = [e.lngLat.lng, e.lngLat.lat];
    if (destMarker) destMarker.setLngLat(destination);
    else destMarker = placeMarker(destination, 'dest', 'Destination');
    checkBtnState();
});

map.on('mousemove', () => {
    if (destType === 'click') map.getCanvas().style.cursor = 'crosshair';
    else map.getCanvas().style.cursor = '';
});

// ═══════════════════════════════════════════════════
// FIX #1: RADIUS CIRCLE — strictly bounds the buffer
// ═══════════════════════════════════════════════════
function showRadiusCircle() {
    if (!userLocation) return;
    updateRadiusCircle();
}

function updateRadiusCircle() {
    if (!userLocation || destType !== 'distance') return;

    const center = turf.point(userLocation);
    const circle = turf.circle(center, selectedKm, { steps: 64, units: 'kilometers' });

    if (map.getSource('radius-circle')) {
        map.getSource('radius-circle').setData(circle);
    } else {
        map.addSource('radius-circle', { type: 'geojson', data: circle });
        map.addLayer({
            id: 'radius-fill', type: 'fill', source: 'radius-circle',
            paint: { 'fill-color': '#ff4b4b', 'fill-opacity': 0.05 }
        });
        map.addLayer({
            id: 'radius-line', type: 'line', source: 'radius-circle',
            paint: { 'line-color': '#ff4b4b', 'line-width': 2, 'line-dasharray': [5, 3], 'line-opacity': 0.8 }
        });
    }
}

// FIX #1: Zoom map to fit the buffer circle
function zoomToBuffer() {
    if (!userLocation) return;
    const center = turf.point(userLocation);
    const circle = turf.circle(center, selectedKm, { steps: 32, units: 'kilometers' });
    const bbox   = turf.bbox(circle);
    map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], {
        padding: { top: 40, bottom: 40, left: 320, right: 60 },
        duration: 800
    });
}

function removeRadiusCircle() {
    ['radius-fill', 'radius-line'].forEach(id => { try { if (map.getLayer(id)) map.removeLayer(id); } catch{} });
    try { if (map.getSource('radius-circle')) map.removeSource('radius-circle'); } catch{}
}

// ═══════════════════════════════════════════════════
// CHECK BUTTON STATE
// ═══════════════════════════════════════════════════
function checkBtnState() {
    const btn = document.getElementById('calculate-btn');
    btn.disabled = !(destType === 'distance' || destination);
}

// ═══════════════════════════════════════════════════
// CALCULATE ROUTE
// ═══════════════════════════════════════════════════
document.getElementById('calculate-btn').addEventListener('click', async () => {
    const btn   = document.getElementById('calculate-btn');
    const start = userLocation || [13.404954, 52.520007];
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Finding green route…';
    btn.disabled  = true;

    clearFactorMapMarkers();

    try {
        if (destType === 'distance') {
            // FIX #1: strict buffer enforcement in routing.js
            destination = await getRandomDestinationWithGreenArea(start, selectedKm, greenWeight);
            if (!destination) throw new Error('Could not find a green area within the selected radius');

            if (destMarker) destMarker.setLngLat(destination);
            else destMarker = placeMarker(destination, 'dest', `Green spot (${selectedKm} km)`);
        }

        const route = await calculateBestRoute(start, destination, routeType, greenWeight);
        if (!route?.geometry?.coordinates?.length) throw new Error('No walkable route found — try another destination');

        currentRouteGeom = route.geometry;
        drawRoute(route.geometry);
        showMetrics(route.metrics);

        // Show total distance
        const line = turf.lineString(route.geometry.coordinates);
        const totalKm = turf.length(line, { units: 'kilometers' }).toFixed(2);
        document.getElementById('total-dist-badge').textContent = totalKm + ' km';

        document.getElementById('results').classList.remove('hidden');

        // FIX #2: New Route button appears
        document.getElementById('new-route-btn').classList.remove('hidden');

        // Async loads
        const [surfaceData, factorData, elevData] = await Promise.allSettled([
            getRouteSurfaceTypes(route.geometry),
            getRouteFactors(route.geometry),
            getElevationProfile(route.geometry, 50)
        ]);

        if (surfaceData.status === 'fulfilled') renderStats(surfaceData.value.highways, surfaceData.value.surfaces);
        if (factorData.status === 'fulfilled' && factorData.value.length > 0) {
            renderFactorTimelines(factorData.value, route.geometry);
            renderFactorMapMarkers(factorData.value); // FIX #2: icons on map
        }
        if (elevData.status === 'fulfilled' && elevData.value.length > 0) {
            currentElevData = elevData.value;
            buildElevationChart(elevData.value);
            openElevPanel(elevData.value);
        }

    } catch (err) {
        showToast('⚠ ' + err.message);
        console.error(err);
    } finally {
        btn.innerHTML = '<i class="fas fa-seedling"></i> Find Green Route';
        btn.disabled  = !(destType === 'distance' || destination);
    }
});

// ═══════════════════════════════════════════════════
// FIX #3: NEW ROUTE button — full reset
// ═══════════════════════════════════════════════════
document.getElementById('new-route-btn').addEventListener('click', resetAll);

function resetAll() {
    clearRoute();
    removeRadiusCircle();
    removeHoverMarker();
    clearFactorMapMarkers();

    if (destMarker)  { destMarker.remove();  destMarker = null; }
    if (startMarker) { startMarker.remove(); startMarker = null; }

    if (userLocation) startMarker = placeMarker(userLocation, 'start', 'Your location');

    destination      = null;
    currentRouteGeom = null;

    if (elevChart) { elevChart.destroy(); elevChart = null; }
    currentElevData = [];

    document.getElementById('results').classList.add('hidden');
    document.getElementById('elev-panel').classList.add('hidden');
    document.getElementById('factor-timelines').innerHTML = '';
    document.getElementById('highway-stats').innerHTML = '';
    document.getElementById('surface-stats').innerHTML = '';
    document.getElementById('new-route-btn').classList.add('hidden');

    checkBtnState();

    // Restore radius circle if in distance mode
    if (destType === 'distance' && userLocation) {
        showRadiusCircle();
        zoomToBuffer();
    } else {
        map.flyTo({ center: userLocation || [13.404954, 52.520007], zoom: 13 });
    }
}

// ═══════════════════════════════════════════════════
// DRAW ROUTE
// ═══════════════════════════════════════════════════
function drawRoute(geometry) {
    clearRoute();

    map.addSource('route', { type: 'geojson', data: { type: 'Feature', geometry, properties: {} } });

    map.addLayer({ id: 'route-glow', type: 'line', source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#4caf50', 'line-width': 14, 'line-opacity': 0.12 }
    });
    map.addLayer({ id: 'route-line', type: 'line', source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#2e7d32', 'line-width': 4, 'line-opacity': 0.93 }
    });

    // Fit map to route (accounting for panel width)
    try {
        const coords = geometry.coordinates;
        const bounds = coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
        map.fitBounds(bounds, { padding: { top: 60, bottom: 240, left: 320, right: 60 }, duration: 900 });
    } catch (e) { console.warn('fitBounds:', e); }
}

function clearRoute() {
    ['route-glow', 'route-line'].forEach(id => { try { if (map.getLayer(id)) map.removeLayer(id); } catch{} });
    try { if (map.getSource('route')) map.removeSource('route'); } catch{}
}

// ═══════════════════════════════════════════════════
// METRICS
// ═══════════════════════════════════════════════════
function showMetrics(m) {
    if (!m) return;
    document.getElementById('green-score').textContent    = m.greenScore ?? '--';
    document.getElementById('avg-slope').textContent      = m.avgSlope ?? '--';
    document.getElementById('traffic-lights').textContent = m.trafficLights ?? '--';
    document.getElementById('walk-index').textContent     = typeof m.score === 'number' ? m.score.toFixed(2) : '--';

    const badge = document.getElementById('diff-badge');
    badge.textContent = m.difficulty ?? '--';
    badge.className   = 'diff-badge ' + (m.difficulty === 'Easy' ? '' : m.difficulty === 'Medium' ? 'medium' : 'hard');
}

// ═══════════════════════════════════════════════════
// SURFACE STATS
// ═══════════════════════════════════════════════════
function renderStats(highways, surfaces) {
    renderStatList('highway-stats', highways);
    renderStatList('surface-stats', surfaces);
}

function renderStatList(id, items) {
    const el = document.getElementById(id);
    if (!el || !items?.length) return;
    const maxLen = Math.max(...items.map(i => i.length), 0.1);
    el.innerHTML = items.map(s => `
        <div class="stat-item">
            <div class="stat-dot" style="background:${s.color}"></div>
            <span style="flex:1;font-size:.71rem;color:#4a6045">${s.type}</span>
            <div class="stat-bar-wrap"><div class="stat-bar" style="background:${s.color};width:${(s.length/maxLen*100).toFixed(0)}%"></div></div>
            <span class="stat-km">${s.length} km</span>
        </div>`).join('');
}

// ═══════════════════════════════════════════════════
// ELEVATION CHART
// ═══════════════════════════════════════════════════
function buildElevationChart(data) {
    const canvas = document.getElementById('elev-canvas');
    if (!canvas) return;
    if (elevChart) { elevChart.destroy(); elevChart = null; }

    elevChart = new Chart(canvas, {
        type: 'line',
        data: {
            labels: data.map(p => p.distance.toFixed(2) + ' km'),
            datasets: [{
                data: data.map(p => p.elevation),
                borderColor: '#2e7d32',
                backgroundColor: 'rgba(76,175,80,.1)',
                borderWidth: 2, pointRadius: 0, pointHoverRadius: 4,
                pointHoverBackgroundColor: '#2e7d32',
                fill: true, tension: 0.4
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(27,94,32,.95)',
                    titleColor: '#a5d6a7', bodyColor: 'white',
                    titleFont: { family: 'JetBrains Mono', size: 10 },
                    bodyFont: { family: 'JetBrains Mono', size: 12 },
                    callbacks: { title: i => i[0].label, label: i => `${Math.round(i.raw)} m a.s.l.` },
                    displayColors: false, padding: 8
                }
            },
            scales: {
                x: { ticks: { color: '#7e9a79', font: { family: 'JetBrains Mono', size: 8 }, maxTicksLimit: 8, maxRotation: 0 }, grid: { color: 'rgba(0,0,0,.04)' }, border: { color: 'rgba(0,0,0,.08)' } },
                y: { ticks: { color: '#7e9a79', font: { family: 'JetBrains Mono', size: 8 }, callback: v => v + 'm' }, grid: { color: 'rgba(0,0,0,.04)' }, border: { color: 'rgba(0,0,0,.08)' } }
            },
            onHover: (evt, elements) => {
                if (elements?.length) {
                    const pt = data[elements[0].index];
                    if (pt) placeHoverMarker([pt.lng, pt.lat]);
                } else { removeHoverMarker(); }
            }
        }
    });
}

function openElevPanel(data) {
    const panel = document.getElementById('elev-panel');
    panel.classList.remove('hidden', 'minimized');
    const totalDist = data[data.length - 1]?.distance ?? 0;
    let gain = 0;
    for (let i = 1; i < data.length; i++) {
        const d = data[i].elevation - data[i - 1].elevation;
        if (d > 0) gain += d;
    }
    document.getElementById('elev-dist').textContent = totalDist.toFixed(2) + ' km';
    document.getElementById('elev-gain').textContent = '↑ ' + Math.round(gain) + ' m';
}

// ═══════════════════════════════════════════════════
// FIX #2: FACTOR TIMELINES + MAP MARKERS
// Rows with icon + full name + colored track + hover tooltip
// ═══════════════════════════════════════════════════
function renderFactorTimelines(factors, geometry) {
    const wrap = document.getElementById('factor-timelines');
    if (!wrap) return;
    wrap.innerHTML = '';

    const line     = turf.lineString(geometry.coordinates);
    const totalLen = turf.length(line, { units: 'kilometers' });

    factors.forEach(factor => {
        const row = document.createElement('div');
        row.className = 'ft-row';

        // Icon circle
        const iconWrap = document.createElement('div');
        iconWrap.className = 'ft-icon-wrap';
        iconWrap.style.color = factor.color;
        iconWrap.style.borderColor = factor.color;
        iconWrap.style.background  = factor.color + '18';
        iconWrap.innerHTML = `<i class="fas ${factor.icon}"></i>`;

        // Full name label
        const label = document.createElement('div');
        label.className = 'ft-label';
        label.textContent = factor.name;
        label.title = factor.name;

        // Track
        const track = document.createElement('div');
        track.className = 'ft-track';

        // Colored base line on track
        const trackLine = document.createElement('div');
        trackLine.className = 'ft-track-line';
        trackLine.style.background = factor.color;
        track.appendChild(trackLine);

        // Dots
        factor.events.forEach(ev => {
            const pct = totalLen > 0 ? (ev.distance / totalLen) * 100 : 0;
            const dot = document.createElement('div');
            dot.className = 'ft-dot';
            dot.style.left       = `${pct}%`;
            dot.style.background = factor.color;

            // Hover → show tooltip + map marker
            dot.addEventListener('mouseenter', (e) => {
                placeHoverMarker([ev.lng, ev.lat]);
                showFactorTooltip(e, factor, ev);
            });
            dot.addEventListener('mouseleave', () => {
                removeHoverMarker();
                hideFactorTooltip();
            });
            dot.addEventListener('click', () => {
                map.flyTo({ center: [ev.lng, ev.lat], zoom: 16 });
            });

            track.appendChild(dot);
        });

        row.appendChild(iconWrap);
        row.appendChild(label);
        row.appendChild(track);
        wrap.appendChild(row);
    });
}

// Tooltip on hover
const tooltip = document.getElementById('factor-tooltip');
const tipIcon = document.getElementById('ft-tip-icon');
const tipName = document.getElementById('ft-tip-name');
const tipDist = document.getElementById('ft-tip-dist');

function showFactorTooltip(e, factor, ev) {
    tipIcon.className = `fas ${factor.icon}`;
    tipIcon.style.color = factor.color;
    tipName.textContent = factor.name;
    tipDist.textContent = `at ${ev.distance} km`;

    tooltip.classList.remove('hidden');
    const rect = e.target.getBoundingClientRect();
    tooltip.style.left = (rect.left + rect.width / 2) + 'px';
    tooltip.style.top  = (rect.top) + 'px';
}

function hideFactorTooltip() {
    tooltip.classList.add('hidden');
}

// FIX #2: Place small icon markers on the map for factor events
function renderFactorMapMarkers(factors) {
    clearFactorMapMarkers();

    // Only show major factors to avoid clutter (max 3 events per factor)
    const priorityFactors = ['PARK', 'GREENERY', 'LIGHTING', 'TRAFFIC_LIGHTS', 'LOW TRAFFIC'];

    factors.forEach(factor => {
        const events = factor.events.slice(0, 3); // max 3 markers per factor
        events.forEach(ev => {
            const el = document.createElement('div');
            el.className = 'factor-map-marker';
            el.style.color = factor.color;
            el.style.borderColor = factor.color;
            el.innerHTML = `<i class="fas ${factor.icon}" style="color:${factor.color}"></i>`;
            el.title = factor.name;

            el.addEventListener('mouseenter', () => {
                // Show popup-like tooltip
                el.style.transform = 'scale(1.3)';
            });
            el.addEventListener('mouseleave', () => {
                el.style.transform = 'scale(1)';
            });

            const popup = new maplibregl.Popup({ offset: 16, closeButton: false, anchor: 'bottom' })
                .setHTML(`<div style="display:flex;align-items:center;gap:6px;font-size:.78rem;font-family:Outfit,sans-serif">
                    <i class="fas ${factor.icon}" style="color:${factor.color}"></i>
                    <div><strong style="color:#1a2318">${factor.name}</strong><br><span style="color:#7e9a79;font-size:.68rem">${ev.distance} km</span></div>
                </div>`);

            const marker = new maplibregl.Marker({ element: el })
                .setLngLat([ev.lng, ev.lat])
                .setPopup(popup)
                .addTo(map);

            factorMapMarkers.push(marker);
        });
    });
}

function clearFactorMapMarkers() {
    factorMapMarkers.forEach(m => m.remove());
    factorMapMarkers = [];
}

// ═══════════════════════════════════════════════════
// FIX #4: EXPORT TO GOOGLE MAPS / APPLE MAPS
// ═══════════════════════════════════════════════════
document.getElementById('export-gmaps').addEventListener('click', () => {
    if (!currentRouteGeom?.coordinates?.length) return showToast('Calculate a route first');

    const coords = currentRouteGeom.coordinates;
    const origin = coords[0];
    const dest   = coords[coords.length - 1];

    // Waypoints (sample middle of route for direction guidance)
    const mid = coords[Math.floor(coords.length / 2)];

    const url = `https://www.google.com/maps/dir/?api=1&origin=${origin[1]},${origin[0]}&destination=${dest[1]},${dest[0]}&waypoints=${mid[1]},${mid[0]}&travelmode=walking`;
    window.open(url, '_blank');
});

document.getElementById('export-apple').addEventListener('click', () => {
    if (!currentRouteGeom?.coordinates?.length) return showToast('Calculate a route first');

    const coords = currentRouteGeom.coordinates;
    const origin = coords[0];
    const dest   = coords[coords.length - 1];

    // Apple Maps URL scheme (works on iOS, shows directions on desktop via web)
    const url = `https://maps.apple.com/?saddr=${origin[1]},${origin[0]}&daddr=${dest[1]},${dest[0]}&dirflg=w`;
    window.open(url, '_blank');
});

// ═══════════════════════════════════════════════════
// ELEVATION PANEL CONTROLS
// ═══════════════════════════════════════════════════
document.getElementById('btn-min').addEventListener('click', () => {
    const panel = document.getElementById('elev-panel');
    panel.classList.toggle('minimized');
    const icon = document.querySelector('#btn-min i');
    icon.className = panel.classList.contains('minimized') ? 'fas fa-chevron-up' : 'fas fa-chevron-down';
});

document.getElementById('btn-close').addEventListener('click', () => {
    document.getElementById('elev-panel').classList.add('hidden');
    removeHoverMarker();
});

// ═══════════════════════════════════════════════════
// FIX #5: MAP STYLE SELECTOR — real satellite tiles
// ═══════════════════════════════════════════════════
document.querySelectorAll('.layer-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.layer-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        const layer = btn.dataset.layer;
        currentStyle = layer;

        map.setStyle(MAP_STYLES[layer]);

        // After style change, re-add route if active
        map.once('styledata', () => {
            if (currentRouteGeom) {
                setTimeout(() => drawRoute(currentRouteGeom), 100);
            }
            if (destType === 'distance' && userLocation) {
                setTimeout(() => updateRadiusCircle(), 150);
            }
            // Reset WFS loaded flags (layers need to be re-added)
            wfsParksLoaded = false;
            wfsGreenLoaded = false;
        });
    });
});

// ═══════════════════════════════════════════════════
// WFS OVERLAYS
// ═══════════════════════════════════════════════════
map.on('load', () => {
    if (destType === 'distance' && userLocation) updateRadiusCircle();
});

document.getElementById('show-parks').addEventListener('change', (e) => {
    if (e.target.checked && !wfsParksLoaded) {
        try { loadWFSLayer(map, 'parks', wfsLayers.parks); wfsParksLoaded = true; }
        catch (err) { console.warn(err); }
    } else {
        try { toggleWFSLayer(map, 'parks', e.target.checked); } catch {}
    }
});

document.getElementById('show-greenways').addEventListener('change', (e) => {
    if (e.target.checked && !wfsGreenLoaded) {
        try { loadWFSLayer(map, 'greenways', wfsLayers.greenways); wfsGreenLoaded = true; }
        catch (err) { console.warn(err); }
    } else {
        try { toggleWFSLayer(map, 'greenways', e.target.checked); } catch {}
    }
});

// ═══════════════════════════════════════════════════
// FIX #6: RECOMMENDED ROUTES — load from src/route_1.geojson
// ═══════════════════════════════════════════════════
document.getElementById('show-recommended').addEventListener('change', async (e) => {
    if (e.target.checked) {
        await loadRecommendedRoutes();
    } else {
        toggleRecommendedRoutes(false);
    }
});

async function loadRecommendedRoutes() {
    // Load all available route files from src/
    const routeFiles = ['src/route_1.geojson']; // Add more here as they're added

    for (const [idx, file] of routeFiles.entries()) {
        const sourceId = `rec-route-${idx}`;
        const lineId   = `rec-route-line-${idx}`;
        const glowId   = `rec-route-glow-${idx}`;

        if (map.getSource(sourceId)) {
            // Already loaded, just toggle visibility
            map.setLayoutProperty(lineId, 'visibility', 'visible');
            map.setLayoutProperty(glowId, 'visibility', 'visible');
            continue;
        }

        try {
            const res  = await fetch(file);
            if (!res.ok) throw new Error(`${file} not found`);
            const data = await res.json();

            map.addSource(sourceId, { type: 'geojson', data });

            // Glow
            map.addLayer({
                id: glowId, type: 'line', source: sourceId,
                layout: { 'line-cap': 'round', 'line-join': 'round' },
                paint: { 'line-color': '#ff9800', 'line-width': 10, 'line-opacity': 0.12 }
            });

            // Main line (orange dashed — distinct from user route)
            map.addLayer({
                id: lineId, type: 'line', source: sourceId,
                layout: { 'line-cap': 'round', 'line-join': 'round' },
                paint: { 'line-color': '#ff9800', 'line-width': 3, 'line-dasharray': [4, 2], 'line-opacity': 0.9 }
            });

            // Click popup with route info
            map.on('click', lineId, (e) => {
                const props = e.features[0]?.properties || {};
                new maplibregl.Popup({ closeButton: true })
                    .setLngLat(e.lngLat)
                    .setHTML(`<div class="rec-route-popup">
                        <strong><i class="fas fa-star" style="color:#ff9800"></i> ${props.name || 'Recommended Route'}</strong>
                        ${props.distance_km ? `<span>📏 ${props.distance_km} km</span>` : ''}
                        ${props.green_score ? `<span>🌿 Green score: ${props.green_score}%</span>` : ''}
                        ${props.difficulty  ? `<span>⚡ ${props.difficulty}</span>` : ''}
                        ${props.description ? `<small>${props.description}</small>` : ''}
                    </div>`)
                    .addTo(map);
            });

            map.on('mouseenter', lineId, () => { map.getCanvas().style.cursor = 'pointer'; });
            map.on('mouseleave', lineId, () => { map.getCanvas().style.cursor = ''; });

            console.info(`Recommended route loaded: ${file}`);
        } catch (err) {
            console.warn(`Could not load ${file}:`, err.message);
            showToast(`Note: ${file} not found. Add GeoJSON files to the src/ folder.`);
        }
    }
}

function toggleRecommendedRoutes(visible) {
    const routeFiles = ['src/route_1.geojson'];
    routeFiles.forEach((_, idx) => {
        const lineId = `rec-route-line-${idx}`;
        const glowId = `rec-route-glow-${idx}`;
        try {
            if (map.getLayer(lineId)) map.setLayoutProperty(lineId, 'visibility', visible ? 'visible' : 'none');
            if (map.getLayer(glowId)) map.setLayoutProperty(glowId, 'visibility', visible ? 'visible' : 'none');
        } catch {}
    });
}

// ═══════════════════════════════════════════════════
// TOAST
// ═══════════════════════════════════════════════════
function showToast(msg) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 4500);
}

}); // end DOMContentLoaded
