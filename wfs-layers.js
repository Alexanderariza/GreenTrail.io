// wfs-layers.js — GreenTrail v2.1

const wfsLayers = {
    parks: {
        url: 'https://fbinter.stadt-berlin.de/fb/wfs/data/senstadt/s_sondergruen',
        typeName: 'senstadt:s_sondergruen',
        style: {
            type: 'fill',
            paint: {
                'fill-color': '#4caf50',
                'fill-opacity': 0.18,
                'fill-outline-color': '#2e7d32'
            }
        }
    },
    greenways: {
        url: 'https://fbinter.stadt-berlin.de/fb/wfs/data/senstadt/s_radverkehr_netz',
        typeName: 'senstadt:s_radverkehr_netz',
        style: {
            type: 'line',
            paint: {
                'line-color': '#8bc34a',
                'line-width': 2,
                'line-dasharray': [3, 2],
                'line-opacity': 0.8
            }
        }
    }
};

function loadWFSLayer(map, layerId, config) {
    const sourceId = `wfs-${layerId}`;
    if (map.getSource(sourceId)) return;

    const params = new URLSearchParams({
        service: 'WFS', version: '2.0.0', request: 'GetFeature',
        typeNames: config.typeName, outputFormat: 'application/json',
        srsName: 'EPSG:4326', count: '300'
    });

    try {
        map.addSource(sourceId, {
            type: 'geojson',
            data: `${config.url}?${params}`,
            generateId: true
        });

        const layerDef = {
            id: sourceId, type: config.style.type, source: sourceId,
            paint: config.style.paint, layout: { visibility: 'visible' }
        };
        if (config.style.type === 'line') {
            layerDef.layout = { ...layerDef.layout, 'line-cap': 'round', 'line-join': 'round' };
        }
        map.addLayer(layerDef);
    } catch (e) {
        console.warn(`WFS layer "${layerId}" failed:`, e.message);
    }
}

function toggleWFSLayer(map, layerId, visible) {
    const sourceId = `wfs-${layerId}`;
    if (map.getLayer(sourceId)) {
        map.setLayoutProperty(sourceId, 'visibility', visible ? 'visible' : 'none');
    }
}

function removeWFSLayer(map, layerId) {
    const sourceId = `wfs-${layerId}`;
    try {
        if (map.getLayer(sourceId))  map.removeLayer(sourceId);
        if (map.getSource(sourceId)) map.removeSource(sourceId);
    } catch (e) { console.warn(`WFS remove "${layerId}":`, e.message); }
}
