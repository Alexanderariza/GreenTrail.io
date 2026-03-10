// script.js — GreenTrail v2.1

document.addEventListener('DOMContentLoaded', () => {

// ══════════════════════════════════════════════════
// MAP INIT — satellite uses real Esri tiles
// ══════════════════════════════════════════════════
const SAT_STYLE = {
    version: 8,
    sources: { sat: { type:'raster', tiles:['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], tileSize:256, attribution:'© Esri © Maxar' } },
    layers: [{ id:'sat', type:'raster', source:'sat' }],
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf'
};

const MAP_STYLES = {
    green:     'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json',
    satellite: SAT_STYLE,
    osm:       'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json'
};

const map = new maplibregl.Map({
    container: 'map',
    style: MAP_STYLES.green,
    center: [13.404954, 52.520007],
    zoom: 12,
    attributionControl: false
});

map.addControl(new maplibregl.AttributionControl({ compact:true }), 'bottom-left');
map.addControl(new maplibregl.NavigationControl({ showCompass:true }), 'bottom-right');
map.addControl(new maplibregl.ScaleControl({ maxWidth:80, unit:'metric' }), 'bottom-left');

// ══════════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════════
let userLocation     = null;
let destination      = null;
let destType         = 'click';
let routeType        = 'return';
let selectedKm       = 5;
let greenWeight      = 0.7;
let currentRouteGeom = null;
let analysisData     = null;
let startMarker      = null;
let destMarker       = null;
let hoverMarker      = null;
let elevChart        = null;
let factorMapMarkers = [];
let wfsParksLoaded   = false;
let wfsGreenLoaded   = false;
let showFactorMkrs   = true;
let currentStyleKey  = 'green';

// ══════════════════════════════════════════════════
// DOCK + DRAWER NAVIGATION
// ══════════════════════════════════════════════════
const drawer   = document.getElementById('drawer');
const backdrop = document.getElementById('drawer-backdrop');
let activePanel = 'route';

function openDrawer(panelId) {
    // Activate dock button
    document.querySelectorAll('.dock-btn').forEach(b => b.classList.remove('active'));
    const dockBtn = document.querySelector(`.dock-btn[data-panel="${panelId}"]`);
    if (dockBtn) dockBtn.classList.add('active');

    // Activate drawer panel
    document.querySelectorAll('.dpanel').forEach(p => p.classList.remove('active'));
    const panel = document.getElementById(`dpanel-${panelId}`);
    if (panel) panel.classList.add('active');

    // Show drawer
    drawer.classList.remove('collapsed');

    // Mobile: show backdrop
    if (window.innerWidth <= 640) {
        backdrop.classList.add('visible');
        drawer.classList.add('open');
    }

    activePanel = panelId;
}

function closeDrawer() {
    drawer.classList.add('collapsed');
    backdrop.classList.remove('visible');
    drawer.classList.remove('open');
    document.querySelectorAll('.dock-btn').forEach(b => b.classList.remove('active'));
}

// Dock buttons
document.querySelectorAll('.dock-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const panelId = btn.dataset.panel;
        if (activePanel === panelId && !drawer.classList.contains('collapsed')) {
            closeDrawer();
        } else {
            openDrawer(panelId);
        }
    });
});

document.getElementById('drawer-close').addEventListener('click', closeDrawer);
backdrop.addEventListener('click', closeDrawer);

// Open route drawer by default
openDrawer('route');

// ══════════════════════════════════════════════════
// GEOLOCATION
// ══════════════════════════════════════════════════
const locText = document.getElementById('loc-text');
const locDot  = document.querySelector('.loc-dot');

if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
        ({ coords }) => {
            userLocation = [coords.longitude, coords.latitude];
            locText.textContent = '📍 Location ready';
            locDot.style.background = '#4caf50';
            startMarker = placeMarker(userLocation, 'start', 'Your location');
            map.flyTo({ center: userLocation, zoom: 13 });
            fetchWeather(coords.latitude, coords.longitude);
            checkBtnState();
        },
        () => {
            userLocation = [13.404954, 52.520007];
            locText.textContent = '⚠ Berlin center';
            locDot.style.background = '#f9a825';
            locDot.classList.remove('pulse');
            startMarker = placeMarker(userLocation, 'start', 'Berlin center');
            fetchWeather(52.520007, 13.404954);
            checkBtnState();
        },
        { timeout: 10000, enableHighAccuracy: false }
    );
} else {
    userLocation = [13.404954, 52.520007];
    locText.textContent = '⚠ No geolocation';
    startMarker = placeMarker(userLocation, 'start', 'Berlin center');
    fetchWeather(52.520007, 13.404954);
}

// ══════════════════════════════════════════════════
// WEATHER — Open-Meteo
// ══════════════════════════════════════════════════
async function fetchWeather(lat, lon) {
    // Open-Meteo free API — full Foreca-style rich data
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
        `&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,uv_index` +
        `&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max,uv_index_max` +
        `&timezone=auto&forecast_days=3`;

    try {
        const res  = await fetch(url);
        const data = await res.json();
        const c    = data.current;
        const d    = data.daily;
        if (!c) return;

        const now  = new Date();
        const hour = now.getHours();
        const isNight = hour < 6 || hour >= 21;

        // WMO weather code → SVG icon class + label
        const wmoIcon = (code, night = false) => {
            if (code === 0)             return { svg: night ? 'moon' : 'sun',           label: night ? 'Clear night' : 'Clear sky' };
            if (code <= 2)              return { svg: night ? 'moon-cloud' : 'sun-cloud',label: 'Partly cloudy' };
            if (code === 3)             return { svg: 'cloud',                           label: 'Overcast' };
            if (code <= 48)             return { svg: 'fog',                             label: 'Foggy' };
            if (code <= 55)             return { svg: 'drizzle',                         label: 'Drizzle' };
            if (code <= 67)             return { svg: 'rain',                            label: 'Rain' };
            if (code <= 77)             return { svg: 'snow',                            label: 'Snow' };
            if (code <= 82)             return { svg: 'rain-shower',                     label: 'Showers' };
            if (code >= 95)             return { svg: 'thunderstorm',                    label: 'Thunderstorm' };
            return { svg: 'cloud', label: 'Cloudy' };
        };

        // SVG weather icons (inline, Foreca-style)
        const ICONS = {
            sun: `<svg viewBox="0 0 40 40" width="32" fill="none"><circle cx="20" cy="20" r="8" fill="#f9a825"/><g stroke="#f9a825" stroke-width="2" stroke-linecap="round">${[0,45,90,135,180,225,270,315].map(a=>{const r=Math.PI*a/180,x1=20+12*Math.cos(r),y1=20+12*Math.sin(r),x2=20+16*Math.cos(r),y2=20+16*Math.sin(r);return`<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;}).join('')}</g></svg>`,
            moon: `<svg viewBox="0 0 40 40" width="32" fill="none"><path d="M22 10a10 10 0 1 0 8 8 7 7 0 0 1-8-8z" fill="#90a4ae"/></svg>`,
            'sun-cloud': `<svg viewBox="0 0 40 40" width="32" fill="none"><circle cx="16" cy="16" r="6" fill="#f9a825"/><ellipse cx="24" cy="26" rx="10" ry="6" fill="#b0bec5"/><ellipse cx="16" cy="28" rx="6" ry="5" fill="#cfd8dc"/></svg>`,
            'moon-cloud': `<svg viewBox="0 0 40 40" width="32" fill="none"><path d="M15 10a7 7 0 0 0 5 6 5 5 0 0 1-5-6z" fill="#90a4ae"/><ellipse cx="24" cy="28" rx="10" ry="6" fill="#b0bec5"/></svg>`,
            cloud: `<svg viewBox="0 0 40 40" width="32" fill="none"><ellipse cx="22" cy="24" rx="12" ry="7" fill="#b0bec5"/><ellipse cx="14" cy="26" rx="8" ry="6" fill="#cfd8dc"/></svg>`,
            fog: `<svg viewBox="0 0 40 40" width="32" fill="none"><rect x="6" y="16" width="28" height="3" rx="1.5" fill="#b0bec5" opacity=".7"/><rect x="8" y="22" width="24" height="3" rx="1.5" fill="#b0bec5" opacity=".5"/><rect x="10" y="28" width="20" height="3" rx="1.5" fill="#b0bec5" opacity=".3"/></svg>`,
            drizzle: `<svg viewBox="0 0 40 40" width="32" fill="none"><ellipse cx="20" cy="18" rx="12" ry="7" fill="#b0bec5"/><line x1="14" y1="27" x2="13" y2="32" stroke="#64b5f6" stroke-width="2" stroke-linecap="round"/><line x1="20" y1="27" x2="19" y2="32" stroke="#64b5f6" stroke-width="2" stroke-linecap="round"/><line x1="26" y1="27" x2="25" y2="32" stroke="#64b5f6" stroke-width="2" stroke-linecap="round"/></svg>`,
            rain: `<svg viewBox="0 0 40 40" width="32" fill="none"><ellipse cx="20" cy="16" rx="13" ry="7" fill="#90a4ae"/><line x1="12" y1="26" x2="10" y2="34" stroke="#1e88e5" stroke-width="2.2" stroke-linecap="round"/><line x1="20" y1="26" x2="18" y2="34" stroke="#1e88e5" stroke-width="2.2" stroke-linecap="round"/><line x1="28" y1="26" x2="26" y2="34" stroke="#1e88e5" stroke-width="2.2" stroke-linecap="round"/></svg>`,
            snow: `<svg viewBox="0 0 40 40" width="32" fill="none"><ellipse cx="20" cy="16" rx="12" ry="7" fill="#b0bec5"/><text x="9" y="34" font-size="14" fill="#90caf9">❄ ❄</text></svg>`,
            'rain-shower': `<svg viewBox="0 0 40 40" width="32" fill="none"><circle cx="16" cy="12" r="5" fill="#f9a825"/><ellipse cx="24" cy="20" rx="11" ry="6" fill="#90a4ae"/><line x1="15" y1="28" x2="13" y2="36" stroke="#1e88e5" stroke-width="2" stroke-linecap="round"/><line x1="23" y1="28" x2="21" y2="36" stroke="#1e88e5" stroke-width="2" stroke-linecap="round"/></svg>`,
            thunderstorm: `<svg viewBox="0 0 40 40" width="32" fill="none"><ellipse cx="20" cy="14" rx="14" ry="8" fill="#78909c"/><polygon points="22,22 16,32 20,30 18,38 26,27 22,29" fill="#f9a825"/></svg>`
        };

        const weather = wmoIcon(c.weather_code, isNight);
        const iconSVG = ICONS[weather.svg] || ICONS.cloud;

        const tempMax = d?.temperature_2m_max?.[0] !== undefined ? Math.round(d.temperature_2m_max[0]) : '--';
        const tempMin = d?.temperature_2m_min?.[0] !== undefined ? Math.round(d.temperature_2m_min[0]) : '--';
        const precip  = d?.precipitation_probability_max?.[0] ?? '--';
        const uv      = d?.uv_index_max?.[0] ?? '--';
        const wind    = Math.round(c.wind_speed_10m);
        const feels   = Math.round(c.apparent_temperature);
        const hum     = c.relative_humidity_2m;
        const temp    = Math.round(c.temperature_2m);

        // Format day name
        const dayName = now.toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long' });

        // Build rich pill
        const pill = document.getElementById('weather-pill');
        pill.innerHTML = `
            <div class="w-icon-wrap" title="${weather.label}">${iconSVG}</div>
            <div class="w-main">
                <div class="w-row1">
                    <span class="w-temp-cur">${temp}°C</span>
                    <span class="w-desc-label">${weather.label}</span>
                </div>
                <div class="w-row2">
                    <span class="w-stat"><i class="fas fa-arrow-up" style="color:#e53935;font-size:.55rem"></i>${tempMax}°</span>
                    <span class="w-stat"><i class="fas fa-arrow-down" style="color:#1e88e5;font-size:.55rem"></i>${tempMin}°</span>
                    <span class="w-stat"><i class="fas fa-tint" style="color:#64b5f6;font-size:.6rem"></i>${precip}%</span>
                    <span class="w-stat"><i class="fas fa-wind" style="color:#78909c;font-size:.6rem"></i>${wind}km/h</span>
                    <span class="w-stat" title="Feels like"><i class="fas fa-thermometer-half" style="color:#ff9800;font-size:.6rem"></i>${feels}°</span>
                </div>
            </div>
            <div class="w-uv" title="UV Index max: ${uv}">UV ${uv}</div>
        `;
        pill.classList.remove('hidden');
        pill.title = `${dayName} · ${weather.label} · Feels like ${feels}°C · Humidity ${hum}%`;
    } catch (e) { console.warn('Weather fetch error:', e); }
}

// ══════════════════════════════════════════════════
// MARKERS
// ══════════════════════════════════════════════════
function placeMarker(lngLat, type, label) {
    const el = document.createElement('div');
    const isStart = type === 'start';
    el.style.cssText = `width:${isStart?12:16}px;height:${isStart?12:16}px;border-radius:50%;background:${isStart?'#2e7d32':'#ff4b4b'};border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,.25),0 0 0 ${isStart?4:5}px ${isStart?'rgba(76,175,80,.2)':'rgba(255,75,75,.15)'};cursor:pointer;`;
    return new maplibregl.Marker({ element:el })
        .setLngLat(lngLat)
        .setPopup(new maplibregl.Popup({ offset:14, closeButton:false }).setHTML(`<span>${label}</span>`))
        .addTo(map);
}

function placeHoverMarker(lngLat) {
    if (!lngLat || isNaN(lngLat[0])) return;
    const el = document.createElement('div');
    el.style.cssText = 'width:10px;height:10px;border-radius:50%;background:#f9a825;border:2px solid white;box-shadow:0 0 8px rgba(249,168,37,.6);pointer-events:none;';
    if (!hoverMarker) hoverMarker = new maplibregl.Marker({ element:el }).setLngLat(lngLat).addTo(map);
    else hoverMarker.setLngLat(lngLat);
}

function removeHoverMarker() {
    if (hoverMarker) { hoverMarker.remove(); hoverMarker = null; }
}

// ══════════════════════════════════════════════════
// DESTINATION MODE TABS
// ══════════════════════════════════════════════════
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

document.querySelectorAll('.km-pill').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.km-pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedKm = parseInt(btn.dataset.km);
        if (destType === 'distance' && userLocation) { updateRadiusCircle(); zoomToBuffer(); destination = null; }
        checkBtnState();
    });
});

// ══════════════════════════════════════════════════
// ROUTE TYPE TABS
// ══════════════════════════════════════════════════
document.querySelectorAll('.tab[data-type]').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab[data-type]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        routeType = btn.dataset.type;
        document.getElementById('type-hint').textContent =
            routeType === 'return' ? 'Same path outward and back' : 'Different path back — completes a loop';
    });
});

// ══════════════════════════════════════════════════
// GREEN WEIGHT SLIDER
// ══════════════════════════════════════════════════
const gSlider = document.getElementById('green-weight');
const gLabel  = document.getElementById('green-pct-label');
gSlider.addEventListener('input', () => {
    greenWeight = gSlider.value / 100;
    gLabel.textContent = `${gSlider.value}%`;
    gSlider.style.background = `linear-gradient(to right, #4caf50 ${gSlider.value}%, #ddd ${gSlider.value}%)`;
});

// ══════════════════════════════════════════════════
// MAP CLICK
// ══════════════════════════════════════════════════
map.on('click', (e) => {
    if (destType !== 'click') return;
    destination = [e.lngLat.lng, e.lngLat.lat];
    if (destMarker) destMarker.setLngLat(destination);
    else destMarker = placeMarker(destination, 'dest', 'Destination');
    checkBtnState();
});
map.on('mousemove', () => { map.getCanvas().style.cursor = destType === 'click' ? 'crosshair' : ''; });

// ══════════════════════════════════════════════════
// RADIUS CIRCLE
// ══════════════════════════════════════════════════
function showRadiusCircle() { if (userLocation) updateRadiusCircle(); }

function updateRadiusCircle() {
    if (!userLocation || destType !== 'distance') return;
    const circle = turf.circle(turf.point(userLocation), selectedKm, { steps:64, units:'kilometers' });
    if (map.getSource('radius-circle')) map.getSource('radius-circle').setData(circle);
    else {
        map.addSource('radius-circle', { type:'geojson', data:circle });
        map.addLayer({ id:'radius-fill', type:'fill', source:'radius-circle', paint:{ 'fill-color':'#ff4b4b','fill-opacity':0.05 } });
        map.addLayer({ id:'radius-line', type:'line', source:'radius-circle', paint:{ 'line-color':'#ff4b4b','line-width':2,'line-dasharray':[5,3],'line-opacity':0.8 } });
    }
}

function zoomToBuffer() {
    if (!userLocation) return;
    const circle = turf.circle(turf.point(userLocation), selectedKm, { steps:32, units:'kilometers' });
    const bbox   = turf.bbox(circle);
    map.fitBounds([[bbox[0],bbox[1]],[bbox[2],bbox[3]]], {
        padding: { top:60, bottom:60, left:window.innerWidth<=640?80:380, right:60 },
        duration:800
    });
}

function removeRadiusCircle() {
    ['radius-fill','radius-line'].forEach(id => { try { if (map.getLayer(id)) map.removeLayer(id); } catch{} });
    try { if (map.getSource('radius-circle')) map.removeSource('radius-circle'); } catch{}
}

function checkBtnState() {
    document.getElementById('calculate-btn').disabled = !(destType === 'distance' || destination);
}

// ══════════════════════════════════════════════════
// CALCULATE ROUTE
// ══════════════════════════════════════════════════
document.getElementById('calculate-btn').addEventListener('click', async () => {
    const btn   = document.getElementById('calculate-btn');
    const start = userLocation || [13.404954, 52.520007];
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Analyzing…';
    btn.disabled  = true;
    clearFactorMapMarkers();

    try {
        if (destType === 'distance') {
            destination = await getRandomDestinationWithGreenArea(start, selectedKm, greenWeight);
            if (!destination) throw new Error('No green area found in radius — try a larger distance');
            if (destMarker) destMarker.setLngLat(destination);
            else destMarker = placeMarker(destination, 'dest', `Green spot (${selectedKm}km)`);
        }

        const route = await calculateBestRoute(start, destination, routeType, greenWeight);
        if (!route?.geometry?.coordinates?.length) throw new Error('No walkable route found — try another destination');

        currentRouteGeom = route.geometry;
        drawRoute(route.geometry);

        // Show scores dock badge
        document.getElementById('dock-scores').style.display = '';
        document.getElementById('dock-export').style.display = '';
        document.getElementById('new-route-btn').classList.remove('hidden');

        // Compute distance
        const line = turf.lineString(route.geometry.coordinates);
        const totalKm = turf.length(line, { units:'kilometers' }).toFixed(2);
        document.getElementById('total-dist-badge').textContent = totalKm + ' km';

        // Slope & difficulty from geometry
        const elevData_p = getElevationProfile(route.geometry, 50);

        // Surface stats
        const surfaceP = getRouteSurfaceTypes(route.geometry);

        // Real OSM analysis
        const analysisP = analyzeRouteHealthScores(route.geometry);

        // Run in parallel
        const [elevResult, surfaceResult, analysisResult] = await Promise.allSettled([
            elevData_p, surfaceP, analysisP
        ]);

        if (analysisResult.status === 'fulfilled' && analysisResult.value) {
            analysisData = analysisResult.value;
            renderScoresPanel(analysisData);
        }

        if (surfaceResult.status === 'fulfilled') {
            renderStats(surfaceResult.value.highways, surfaceResult.value.surfaces);
        }

        // Factor timelines
        const factorData = await getRouteFactors(route.geometry);
        if (factorData?.length) {
            renderFactorTimelines(factorData, route.geometry);
            if (showFactorMkrs) renderFactorMapMarkers(factorData);
        }

        if (elevResult.status === 'fulfilled' && elevResult.value.length) {
            buildElevationChart(elevResult.value);
            openElevPanel(elevResult.value);
        }

        // Auto-switch drawer to scores
        openDrawer('scores');

    } catch (err) {
        showToast('⚠ ' + err.message);
        console.error(err);
    } finally {
        btn.innerHTML = '<i class="fas fa-seedling"></i> Find Green Route';
        btn.disabled  = !(destType === 'distance' || destination);
    }
});

// ══════════════════════════════════════════════════
// NEW ROUTE button
// ══════════════════════════════════════════════════
document.getElementById('new-route-btn').addEventListener('click', resetAll);

function resetAll() {
    clearRoute(); removeRadiusCircle(); removeHoverMarker(); clearFactorMapMarkers();

    if (destMarker)  { destMarker.remove();  destMarker = null; }
    if (startMarker) { startMarker.remove(); startMarker = null; }
    if (userLocation) startMarker = placeMarker(userLocation, 'start', 'Your location');

    destination = null; currentRouteGeom = null; analysisData = null;

    if (elevChart) { elevChart.destroy(); elevChart = null; }

    document.getElementById('elev-panel').classList.add('hidden');
    document.getElementById('factor-timelines').innerHTML = '';
    document.getElementById('highway-stats').innerHTML = '';
    document.getElementById('surface-stats').innerHTML = '';
    document.getElementById('index-grid').innerHTML = '';
    document.getElementById('ghs-score').textContent = '–';
    document.getElementById('diff-badge').textContent = '–';
    document.getElementById('total-dist-badge').textContent = '–';
    document.getElementById('new-route-btn').classList.add('hidden');
    document.getElementById('dock-scores').style.display = 'none';
    document.getElementById('dock-export').style.display = 'none';

    // Reset gauge
    const arc = document.getElementById('ghs-arc');
    if (arc) arc.style.strokeDashoffset = '126';

    checkBtnState();
    openDrawer('route');

    if (destType === 'distance' && userLocation) { showRadiusCircle(); zoomToBuffer(); }
    else map.flyTo({ center: userLocation || [13.404954, 52.520007], zoom: 13 });
}

// ══════════════════════════════════════════════════
// DRAW ROUTE
// ══════════════════════════════════════════════════
function drawRoute(geometry) {
    clearRoute();
    map.addSource('route', { type:'geojson', data:{ type:'Feature', geometry, properties:{} } });
    map.addLayer({ id:'route-glow', type:'line', source:'route', layout:{ 'line-cap':'round','line-join':'round' }, paint:{ 'line-color':'#4caf50','line-width':14,'line-opacity':0.12 } });
    map.addLayer({ id:'route-line', type:'line', source:'route', layout:{ 'line-cap':'round','line-join':'round' }, paint:{ 'line-color':'#2e7d32','line-width':4,'line-opacity':0.93 } });
    try {
        const coords = geometry.coordinates;
        const bounds = coords.reduce((b,c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
        map.fitBounds(bounds, { padding:{ top:70, bottom:250, left:window.innerWidth<=640?70:390, right:70 }, duration:900 });
    } catch {}
}

function clearRoute() {
    ['route-glow','route-line'].forEach(id => { try { if (map.getLayer(id)) map.removeLayer(id); } catch{} });
    try { if (map.getSource('route')) map.removeSource('route'); } catch{}
}

// ══════════════════════════════════════════════════
// SCORES PANEL — render Green Health Score indices
// ══════════════════════════════════════════════════
function renderScoresPanel(data) {
    if (!data) return;

    // GHS gauge
    const ghsScore = data.ghs;
    document.getElementById('ghs-score').textContent = ghsScore;

    // Animate gauge arc (semicircle: dasharray=126, offset = 126 - (score/100 * 126))
    const arc = document.getElementById('ghs-arc');
    if (arc) {
        const offset = 126 - (ghsScore / 100 * 126);
        arc.style.stroke = ghsScore >= 70 ? '#2e7d32' : ghsScore >= 45 ? '#f9a825' : '#ff5252';
        setTimeout(() => { arc.style.strokeDashoffset = offset; }, 100);
    }

    // Difficulty from slope (we'll derive from nature/walkability proxy)
    const difficulty = ghsScore >= 70 ? 'Easy' : ghsScore >= 50 ? 'Medium' : 'Hard';
    const badge = document.getElementById('diff-badge');
    badge.textContent = difficulty;
    badge.className = 'diff-badge ' + (difficulty === 'Easy' ? '' : difficulty === 'Medium' ? 'medium' : 'hard');

    // Index cards
    const grid = document.getElementById('index-grid');
    grid.innerHTML = data.indices.map(idx => `
        <div class="idx-card">
            <div class="idx-card-top">
                <i class="fas ${idx.icon}" style="color:${idx.color}"></i>
                <div class="idx-card-name">${idx.name}</div>
            </div>
            <div class="idx-score-row">
                <div class="idx-bar-wrap">
                    <div class="idx-bar" style="background:${idx.color};width:0%" data-width="${idx.score}%"></div>
                </div>
                <div class="idx-score-val">${idx.score}</div>
            </div>
            <div class="idx-detail">${idx.detail}</div>
        </div>
    `).join('');

    // Animate bars
    requestAnimationFrame(() => {
        grid.querySelectorAll('.idx-bar').forEach(bar => {
            bar.style.width = bar.dataset.width;
        });
    });
}

// ══════════════════════════════════════════════════
// SURFACE STATS
// ══════════════════════════════════════════════════
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
            <span style="flex:1;font-size:.69rem">${s.type}</span>
            <div class="stat-bar-wrap"><div class="stat-bar" style="background:${s.color};width:${(s.length/maxLen*100).toFixed(0)}%"></div></div>
            <span class="stat-km">${s.length}km</span>
        </div>`).join('');
}

// ══════════════════════════════════════════════════
// ELEVATION CHART
// ══════════════════════════════════════════════════
function buildElevationChart(data) {
    const canvas = document.getElementById('elev-canvas');
    if (!canvas) return;
    if (elevChart) { elevChart.destroy(); elevChart = null; }

    elevChart = new Chart(canvas, {
        type: 'line',
        data: {
            labels: data.map(p => p.distance.toFixed(2) + ' km'),
            datasets: [{ data: data.map(p => p.elevation), borderColor:'#2e7d32', backgroundColor:'rgba(76,175,80,.1)', borderWidth:2, pointRadius:0, pointHoverRadius:4, pointHoverBackgroundColor:'#2e7d32', fill:true, tension:0.4 }]
        },
        options: {
            responsive:true, maintainAspectRatio:false,
            interaction:{ mode:'index', intersect:false },
            plugins: {
                legend:{ display:false },
                tooltip:{ backgroundColor:'rgba(27,94,32,.95)', titleColor:'#a5d6a7', bodyColor:'white', titleFont:{ family:'JetBrains Mono', size:9 }, bodyFont:{ family:'JetBrains Mono', size:11 }, callbacks:{ title:i=>i[0].label, label:i=>`${Math.round(i.raw)} m` }, displayColors:false, padding:7 }
            },
            scales: {
                x:{ ticks:{ color:'#7e9a79', font:{ family:'JetBrains Mono', size:7 }, maxTicksLimit:8, maxRotation:0 }, grid:{ color:'rgba(0,0,0,.04)' }, border:{ color:'rgba(0,0,0,.06)' } },
                y:{ ticks:{ color:'#7e9a79', font:{ family:'JetBrains Mono', size:7 }, callback:v=>v+'m' }, grid:{ color:'rgba(0,0,0,.04)' }, border:{ color:'rgba(0,0,0,.06)' } }
            },
            onHover: (evt, elements) => {
                if (elements?.length) { const pt = data[elements[0].index]; if (pt) placeHoverMarker([pt.lng, pt.lat]); }
                else removeHoverMarker();
            }
        }
    });
}

function openElevPanel(data) {
    const panel = document.getElementById('elev-panel');
    panel.classList.remove('hidden', 'minimized');
    const totalDist = data[data.length-1]?.distance ?? 0;
    let gain = 0;
    for (let i = 1; i < data.length; i++) { const d = data[i].elevation - data[i-1].elevation; if (d > 0) gain += d; }
    document.getElementById('elev-dist').textContent = totalDist.toFixed(2) + ' km';
    document.getElementById('elev-gain').textContent = '↑ ' + Math.round(gain) + ' m';
}

// ══════════════════════════════════════════════════
// FACTOR TIMELINES — rows with icon + name + track
// ══════════════════════════════════════════════════
const tooltip  = document.getElementById('factor-tooltip');
const tipIcon  = document.getElementById('ft-tip-icon');
const tipName  = document.getElementById('ft-tip-name');
const tipDist  = document.getElementById('ft-tip-dist');

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
        iconWrap.style.background  = factor.color + '14';
        iconWrap.innerHTML = `<i class="fas ${factor.icon}"></i>`;

        // Name label
        const label = document.createElement('div');
        label.className = 'ft-label';
        label.textContent = factor.name;
        label.title = factor.name;

        // Track
        const track = document.createElement('div');
        track.className = 'ft-track';

        // Baseline (grey line full width)
        const base = document.createElement('div');
        base.className = 'ft-track-base';
        track.appendChild(base);

        // Draw SEGMENTS (blobs) — matches GIF style
        const segs = factor.segments || [];

        segs.forEach((seg, si) => {
            const minWidth = 1.5; // % minimum visible width
            const rawW     = seg.endPct - seg.startPct;
            const w        = Math.max(rawW, minWidth);
            const left     = seg.startPct;

            // Blob element — pill shape, wider = more items
            const blob = document.createElement('div');
            blob.className = 'ft-blob';
            blob.style.left    = `${left}%`;
            blob.style.width   = `${w}%`;
            blob.style.background = factor.color;
            // Larger blobs = more items at that segment
            const opacity = 0.55 + Math.min(0.4, seg.count * 0.08);
            blob.style.opacity = opacity;

            // Click → fly to middle event
            const midEvent = seg.events[Math.floor(seg.events.length / 2)];
            blob.addEventListener('click', () => {
                map.flyTo({ center: [midEvent.lng, midEvent.lat], zoom: 16 });
            });

            // Hover tooltip
            blob.addEventListener('mouseenter', (e) => {
                placeHoverMarker([midEvent.lng, midEvent.lat]);
                tipIcon.className = `fas ${factor.icon}`;
                tipIcon.style.color = factor.color;
                tipName.textContent = factor.name + (seg.count > 1 ? ` ×${seg.count}` : '');
                tipDist.textContent = `${seg.events[0].distance.toFixed(2)}–${seg.events[seg.events.length-1].distance.toFixed(2)} km`;
                tooltip.classList.remove('hidden');
                tooltip.style.left = (e.clientX) + 'px';
                tooltip.style.top  = (e.clientY - 50) + 'px';
                tooltip.style.transform = 'translateX(-50%)';
            });
            blob.addEventListener('mouseleave', () => {
                removeHoverMarker();
                tooltip.classList.add('hidden');
            });

            track.appendChild(blob);

            // Dot on leftmost position (like GIF — first dot is prominent)
            if (si === 0) {
                const dot = document.createElement('div');
                dot.className = 'ft-dot-start';
                dot.style.left       = `${left}%`;
                dot.style.background = factor.color;
                dot.style.borderColor = factor.color;
                track.appendChild(dot);
            }
        });

        // If no segments, skip
        if (!segs.length) return;

        row.appendChild(iconWrap);
        row.appendChild(label);
        row.appendChild(track);
        wrap.appendChild(row);
    });
}

function renderFactorMapMarkers(factors) {
    clearFactorMapMarkers();
    factors.forEach(factor => {
        factor.events.slice(0, 2).forEach(ev => {
            const el = document.createElement('div');
            el.className = 'factor-map-marker';
            el.style.color = factor.color;
            el.style.borderColor = factor.color;
            el.innerHTML = `<i class="fas ${factor.icon}" style="color:${factor.color};font-size:.6rem"></i>`;

            const popup = new maplibregl.Popup({ offset:16, closeButton:false, anchor:'bottom' })
                .setHTML(`<div style="display:flex;align-items:center;gap:6px;font-size:.76rem;font-family:Outfit,sans-serif">
                    <i class="fas ${factor.icon}" style="color:${factor.color}"></i>
                    <div><strong>${factor.name}</strong><br><span style="color:#7e9a79;font-size:.65rem">${ev.distance} km</span></div>
                </div>`);

            factorMapMarkers.push(new maplibregl.Marker({ element:el }).setLngLat([ev.lng,ev.lat]).setPopup(popup).addTo(map));
        });
    });
}

function clearFactorMapMarkers() {
    factorMapMarkers.forEach(m => m.remove());
    factorMapMarkers = [];
}

// ══════════════════════════════════════════════════
// ELEVATION PANEL CONTROLS
// ══════════════════════════════════════════════════
document.getElementById('btn-min').addEventListener('click', () => {
    const panel = document.getElementById('elev-panel');
    panel.classList.toggle('minimized');
    document.querySelector('#btn-min i').className = panel.classList.contains('minimized') ? 'fas fa-chevron-up' : 'fas fa-chevron-down';
});
document.getElementById('btn-close').addEventListener('click', () => {
    document.getElementById('elev-panel').classList.add('hidden');
    removeHoverMarker();
});

// ══════════════════════════════════════════════════
// EXPORT — Google Maps + Apple Maps
// ══════════════════════════════════════════════════
function doExportGmaps() {
    if (!currentRouteGeom?.coordinates?.length) return showToast('Calculate a route first');
    const coords = currentRouteGeom.coordinates;

    // Sample up to 8 intermediate waypoints evenly along route
    // (Google Maps free supports up to 10 waypoints via URL)
    const MAX_WP = 8;
    const origin = coords[0];
    const dest   = coords[coords.length - 1];

    // Sample waypoints — skip first and last
    const wpCoords = [];
    const step = Math.max(1, Math.floor((coords.length - 2) / MAX_WP));
    for (let i = step; i < coords.length - 1; i += step) {
        if (wpCoords.length >= MAX_WP) break;
        wpCoords.push(coords[i]);
    }

    const waypointsStr = wpCoords.map(c => `${c[1]},${c[0]}`).join('|');
    const url = `https://www.google.com/maps/dir/?api=1` +
        `&origin=${origin[1]},${origin[0]}` +
        `&destination=${dest[1]},${dest[0]}` +
        (waypointsStr ? `&waypoints=${encodeURIComponent(waypointsStr)}` : '') +
        `&travelmode=walking`;

    window.open(url, '_blank');
}

function doExportApple() {
    if (!currentRouteGeom?.coordinates?.length) return showToast('Calculate a route first');
    const coords = currentRouteGeom.coordinates;
    const origin = coords[0];
    const dest   = coords[coords.length - 1];

    // Apple Maps URL — only supports saddr/daddr, but we add a label
    // For circular routes the destination is near origin, so we label it
    const isCircular = turf.distance(
        turf.point(coords[0]),
        turf.point(coords[coords.length - 1]),
        { units: 'kilometers' }
    ) < 0.3;

    if (isCircular) {
        // For circular routes, export to mid-route point so Apple shows at least half the trip
        const midCoord = coords[Math.floor(coords.length / 2)];
        window.open(`https://maps.apple.com/?saddr=${origin[1]},${origin[0]}&daddr=${midCoord[1]},${midCoord[0]}&dirflg=w`, '_blank');
    } else {
        window.open(`https://maps.apple.com/?saddr=${origin[1]},${origin[0]}&daddr=${dest[1]},${dest[0]}&dirflg=w`, '_blank');
    }
}

document.getElementById('export-gmaps').addEventListener('click', doExportGmaps);
document.getElementById('export-apple').addEventListener('click', doExportApple);
document.getElementById('export-gmaps2').addEventListener('click', doExportGmaps);
document.getElementById('export-apple2').addEventListener('click', doExportApple);

// ══════════════════════════════════════════════════
// MAP STYLE SELECTOR
// ══════════════════════════════════════════════════
document.querySelectorAll('.layer-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.layer-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentStyleKey = btn.dataset.layer;
        map.setStyle(MAP_STYLES[currentStyleKey]);
        map.once('styledata', () => {
            if (currentRouteGeom) setTimeout(() => drawRoute(currentRouteGeom), 100);
            if (destType === 'distance' && userLocation) setTimeout(() => updateRadiusCircle(), 150);
            wfsParksLoaded = false; wfsGreenLoaded = false;
        });
    });
});

// ══════════════════════════════════════════════════
// WFS + RECOMMENDED ROUTES
// ══════════════════════════════════════════════════
map.on('load', () => { if (destType === 'distance' && userLocation) updateRadiusCircle(); });

document.getElementById('show-parks').addEventListener('change', (e) => {
    if (e.target.checked && !wfsParksLoaded) { try { loadWFSLayer(map,'parks',wfsLayers.parks); wfsParksLoaded=true; } catch{} }
    else { try { toggleWFSLayer(map,'parks',e.target.checked); } catch{} }
});

document.getElementById('show-greenways').addEventListener('change', (e) => {
    if (e.target.checked && !wfsGreenLoaded) { try { loadWFSLayer(map,'greenways',wfsLayers.greenways); wfsGreenLoaded=true; } catch{} }
    else { try { toggleWFSLayer(map,'greenways',e.target.checked); } catch{} }
});

document.getElementById('show-factor-markers').addEventListener('change', (e) => {
    showFactorMkrs = e.target.checked;
    if (!showFactorMkrs) clearFactorMapMarkers();
});

document.getElementById('show-recommended').addEventListener('change', async (e) => {
    if (e.target.checked) await loadRecommendedRoutes();
    else toggleRecommendedRoutes(false);
});

async function loadRecommendedRoutes() {
    const files = ['src/route_1.geojson'];
    for (const [idx, file] of files.entries()) {
        const sid = `rec-${idx}`, lid = `rec-line-${idx}`, gid = `rec-glow-${idx}`;
        if (map.getSource(sid)) { map.setLayoutProperty(lid,'visibility','visible'); map.setLayoutProperty(gid,'visibility','visible'); continue; }
        try {
            const res = await fetch(file);
            if (!res.ok) throw new Error(`${file} not found`);
            const data = await res.json();
            map.addSource(sid, { type:'geojson', data });
            map.addLayer({ id:gid, type:'line', source:sid, layout:{ 'line-cap':'round','line-join':'round' }, paint:{ 'line-color':'#ff9800','line-width':10,'line-opacity':0.1 } });
            map.addLayer({ id:lid, type:'line', source:sid, layout:{ 'line-cap':'round','line-join':'round' }, paint:{ 'line-color':'#ff9800','line-width':3,'line-dasharray':[4,2],'line-opacity':0.9 } });
            map.on('click', lid, (e) => {
                const p = e.features[0]?.properties || {};
                new maplibregl.Popup({ closeButton:true }).setLngLat(e.lngLat)
                    .setHTML(`<div style="font-family:Outfit,sans-serif;line-height:1.5">
                        <strong style="color:#2e7d32"><i class="fas fa-star" style="color:#ff9800"></i> ${p.name||'Recommended Route'}</strong><br>
                        ${p.distance_km?`📏 ${p.distance_km} km<br>`:''}
                        ${p.green_score?`🌿 Green score: ${p.green_score}%<br>`:''}
                        ${p.difficulty?`⚡ ${p.difficulty}<br>`:''}
                        ${p.description?`<small style="color:#7e9a79">${p.description}</small>`:''}
                    </div>`).addTo(map);
            });
            map.on('mouseenter', lid, () => { map.getCanvas().style.cursor = 'pointer'; });
            map.on('mouseleave', lid, () => { map.getCanvas().style.cursor = ''; });
        } catch (err) {
            console.warn(`Could not load ${file}:`, err.message);
            showToast(`Add GeoJSON files to the src/ folder to use Recommended Routes`);
        }
    }
}

function toggleRecommendedRoutes(v) {
    ['src/route_1.geojson'].forEach((_,i) => {
        try { if (map.getLayer(`rec-line-${i}`)) map.setLayoutProperty(`rec-line-${i}`,'visibility',v?'visible':'none'); } catch{}
        try { if (map.getLayer(`rec-glow-${i}`)) map.setLayoutProperty(`rec-glow-${i}`,'visibility',v?'visible':'none'); } catch{}
    });
}

// ══════════════════════════════════════════════════
// ══════════════════════════════════════════════════
// GEOCODER SEARCH — Nominatim
// ══════════════════════════════════════════════════
(function initGeocoder() {
    const input    = document.getElementById('search-input');
    const results  = document.getElementById('search-results');
    const clearBtn = document.getElementById('search-clear');
    if (!input) return;

    let searchTimeout = null;
    let searchMarker  = null;

    input.addEventListener('input', () => {
        const q = input.value.trim();
        clearBtn.classList.toggle('hidden', !q);
        if (!q) { results.classList.add('hidden'); results.innerHTML = ''; return; }
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => runSearch(q), 400);
    });

    clearBtn.addEventListener('click', () => {
        input.value = '';
        clearBtn.classList.add('hidden');
        results.classList.add('hidden');
        results.innerHTML = '';
        if (searchMarker) { searchMarker.remove(); searchMarker = null; }
    });

    async function runSearch(q) {
        try {
            const viewbox = map.getBounds();
            const url = `https://nominatim.openstreetmap.org/search?` +
                `q=${encodeURIComponent(q)}` +
                `&format=json&limit=6&addressdetails=1` +
                `&viewboxlbrt=${viewbox.getWest()},${viewbox.getSouth()},${viewbox.getEast()},${viewbox.getNorth()}` +
                `&bounded=0&accept-language=en`;

            const res  = await fetch(url, { headers: { 'Accept-Language': 'en' } });
            const data = await res.json();

            if (!data.length) {
                results.innerHTML = '<div class="sr-empty">No results found</div>';
                results.classList.remove('hidden');
                return;
            }

            results.innerHTML = data.map((item, i) => {
                const type  = item.type || item.class || '';
                const icon  = typeIcon(type);
                const name  = item.display_name.split(',').slice(0, 2).join(', ');
                const extra = item.display_name.split(',').slice(2, 4).join(', ');
                return `<div class="sr-item" data-idx="${i}" data-lat="${item.lat}" data-lon="${item.lon}" data-name="${encodeURIComponent(name)}">
                    <div class="sr-icon"><i class="fas ${icon}"></i></div>
                    <div class="sr-text">
                        <div class="sr-name">${name}</div>
                        ${extra ? `<div class="sr-sub">${extra.trim()}</div>` : ''}
                    </div>
                </div>`;
            }).join('');

            results.querySelectorAll('.sr-item').forEach(el => {
                el.addEventListener('click', () => {
                    const lat  = parseFloat(el.dataset.lat);
                    const lon  = parseFloat(el.dataset.lon);
                    const name = decodeURIComponent(el.dataset.name);

                    // Fly map to result
                    map.flyTo({ center: [lon, lat], zoom: 15 });

                    // Place destination marker
                    destination = [lon, lat];
                    if (destMarker) destMarker.setLngLat([lon, lat]);
                    else destMarker = placeMarker([lon, lat], 'dest', name);

                    // Update search box
                    input.value = name;
                    results.classList.add('hidden');
                    checkBtnState();

                    // Switch to click mode
                    destType = 'click';
                    document.querySelectorAll('.tab[data-dest]').forEach(b => b.classList.remove('active'));
                    document.querySelector('.tab[data-dest="click"]')?.classList.add('active');
                    document.getElementById('dist-opts')?.classList.add('hidden');
                    removeRadiusCircle();
                });
            });

            results.classList.remove('hidden');
        } catch (e) { console.warn('Geocoder error:', e); }
    }

    // Click outside closes results
    document.addEventListener('click', (e) => {
        if (!e.target.closest('#search-wrap') && !e.target.closest('#search-results')) {
            results.classList.add('hidden');
        }
    });

    function typeIcon(type) {
        const map2 = {
            park:'fa-tree', forest:'fa-tree', garden:'fa-seedling',
            restaurant:'fa-utensils', cafe:'fa-mug-hot',
            museum:'fa-landmark', monument:'fa-monument',
            hospital:'fa-hospital', pharmacy:'fa-prescription-bottle',
            school:'fa-school', university:'fa-graduation-cap',
            bus_stop:'fa-bus', train_station:'fa-train', subway:'fa-train-subway',
            hotel:'fa-bed', shop:'fa-shop', supermarket:'fa-cart-shopping',
            bank:'fa-building-columns', post_office:'fa-envelope',
            water:'fa-water', river:'fa-water', lake:'fa-water',
            street:'fa-road', avenue:'fa-road', square:'fa-circle',
            viewpoint:'fa-binoculars', peak:'fa-mountain',
            playground:'fa-children', sports_centre:'fa-dumbbell',
        };
        return map2[type] || 'fa-location-dot';
    }
})();


// ══════════════════════════════════════════════════
function showToast(msg) {
    const t = document.createElement('div');
    t.className = 'toast'; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 4500);
}

}); // end DOMContentLoaded
