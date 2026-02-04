// Main Application JS File

$(document).ready(function () {
  console.log("Document Ready");
});

// ===========================
// Config
// ===========================
const filePath = "static/application/data/WestValleyATPNetwork.geojson"; // unused
const serviceURL = "/api/network_geojson.geojson"; // dynamic weighted reference

// Criteria order (prefer Jinja-injected window.CRITERIA)
var CRITERIA =
  window.CRITERIA && Array.isArray(window.CRITERIA) && window.CRITERIA.length
    ? window.CRITERIA
    : [
        "strava",
        "ucatsbicycle",
        "ucatsped",
        "safety",
        "sidewalk",
        "crosswalk",
        "bikelane",
        "bikeconnectivity",
        "pedconnectivity",
      ];

// Discrete classification (Jenks)
var N_CLASSES = 5;

// Color palettes
var priorityColorSpectrum = ["ffe760", "ff5656", "773131"];
var differenceColorSpectrum = ["67a9cf", "f7f7f7", "ef8a62"];
var differenceDomains = [-1, 1];

// ===========================
// Map init
// ===========================
var map = L.map("map").setView([40.688, -112.0], 13);

// ===========================
// Basemaps
// ===========================
var osmAttrib =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

var OpenStreetMap = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: osmAttrib,
  maxZoom: 19,
});

var Grey = L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors ' +
    '&copy; <a href="https://carto.com/attributions">CARTO</a>',
  maxZoom: 20,
});

var Negative = L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors ' +
    '&copy; <a href="https://carto.com/attributions">CARTO</a>',
  maxZoom: 20,
});

var ESRI_Satellite = L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  {
    attribution:
      "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, CNES/Airbus DS, " +
      "USDA, USGS, AeroGRID, IGN, and the GIS User Community",
    maxZoom: 19,
  }
);

// Default basemap
Grey.addTo(map);

// ===========================
// Formatting helpers
// ===========================
function fmt(n, d = 2) {
  if (n === null || n === undefined || n === "") return "";
  const x = Number(n);
  if (!isFinite(x)) return String(n);
  return x.toFixed(d);
}

// ===========================
// Jenks helpers
// ===========================
function jenksBreaks(data, nClasses) {
  const values = data
    .map(Number)
    .filter((v) => isFinite(v))
    .sort((a, b) => a - b);

  if (values.length === 0) return null;

  // If too few unique values, fall back to "unique breaks" padded to length nClasses+1
  const uniq = Array.from(new Set(values));
  if (uniq.length <= nClasses) {
    const b = [values[0], ...uniq.slice(1), values[values.length - 1]];
    while (b.length < nClasses + 1) b.splice(b.length - 1, 0, b[b.length - 2]);
    return b.slice(0, nClasses + 1);
  }

  const n = values.length;
  const mat1 = Array.from({ length: n + 1 }, () => Array(nClasses + 1).fill(0));
  const mat2 = Array.from({ length: n + 1 }, () => Array(nClasses + 1).fill(0));

  for (let i = 1; i <= nClasses; i++) {
    mat1[1][i] = 1;
    mat2[1][i] = 0;
    for (let j = 2; j <= n; j++) mat2[j][i] = Infinity;
  }

  let v = 0.0;

  for (let l = 2; l <= n; l++) {
    let s1 = 0.0;
    let s2 = 0.0;
    let w = 0.0;

    for (let m = 1; m <= l; m++) {
      const i3 = l - m + 1;
      const val = values[i3 - 1];

      s2 += val * val;
      s1 += val;
      w += 1;

      v = s2 - (s1 * s1) / w;
      const i4 = i3 - 1;

      if (i4 !== 0) {
        for (let j = 2; j <= nClasses; j++) {
          if (mat2[l][j] >= v + mat2[i4][j - 1]) {
            mat1[l][j] = i3;
            mat2[l][j] = v + mat2[i4][j - 1];
          }
        }
      }
    }

    mat1[l][1] = 1;
    mat2[l][1] = v;
  }

  const kclass = Array(nClasses + 1).fill(0);
  kclass[nClasses] = values[n - 1];
  kclass[0] = values[0];

  let k = n;
  for (let j = nClasses; j >= 2; j--) {
    const id = Math.floor(mat1[k][j]) - 2;
    kclass[j - 1] = values[id];
    k = Math.floor(mat1[k][j]) - 1;
  }

  return kclass;
}

// ===========================
// Difference styling
// ===========================
var differenceColorScale = chroma.scale(differenceColorSpectrum).domain(differenceDomains);

function differenceColor(feature) {
  return {
    color: differenceColorScale(feature.properties.Difference_Score).hex(),
    weight: 3,
    opacity: 1,
  };
}

// ===========================
// Deterministic chroma colors for stacked bar
// ===========================
function getCriteriaColors(criteria) {
  const colors = {};
  const n = Math.max(1, criteria.length);

  criteria.forEach((c, i) => {
    const hue = (i * 360) / n;
    colors[c] = chroma.lch(65, 55, hue).hex();
  });

  return colors;
}

function buildCompositionStackBar(p, criteria) {
  const total = Number(p.Priority_Score_Composition);
  if (!isFinite(total) || total <= 0) return "";

  const colorMap = getCriteriaColors(criteria);

  let segments = "";
  let legendItems = "";

  criteria.forEach((c) => {
    const comp = Number(p[`${c}_norm_score_composition`]);
    if (!isFinite(comp) || comp <= 0) return;

    const pct = Math.max(0, Math.min(100, (comp / total) * 100));
    const col = colorMap[c];

    segments += `
      <div
        title="${c}: ${fmt(pct, 1)}%"
        style="width:${pct}%; height:12px; background:${col};">
      </div>`;

    legendItems += `
      <div style="display:flex; align-items:center; gap:6px; margin-right:10px; white-space:nowrap;">
        <span style="display:inline-block; width:10px; height:10px; background:${col}; border:1px solid rgba(0,0,0,0.25);"></span>
        <span>${c}</span>
      </div>`;
  });

  return `
    <div style="margin-top:10px;">
      <div style="font-size:11px; opacity:0.9; margin-bottom:6px;">
        <strong>Composition (share of Priority Score)</strong>
      </div>

      <div style="display:flex; width:100%; border:1px solid rgba(0,0,0,0.25); border-radius:3px; overflow:hidden;">
        ${segments}
      </div>

      <div style="display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; font-size:11px; opacity:0.9;">
        ${legendItems}
      </div>

      <div style="font-size:10.5px; opacity:0.75; margin-top:6px;">
        Each color shows the % contribution of that criterion to this segment’s Priority Score.
      </div>
    </div>`;
}

// ===========================
// Popup
// ===========================
function setupPopUp(f, l) {
  const p = f.properties || {};

  const header = `
    <div style="min-width: 460px; max-width: 860px;">
      <div style="font-weight: 700; margin-bottom: 6px;">
        Segment ${p.OBJECTID !== undefined ? p.OBJECTID : ""}
      </div>

      <div style="margin-bottom: 10px;">
        <div><strong>Priority Score (Norm Sum):</strong> ${fmt(p.Priority_Score_Norm, 3)}</div>
        <div><strong>Priority Score (Composition Sum):</strong> ${fmt(p.Priority_Score_Composition, 3)}</div>
        <div><strong>Difference:</strong> ${fmt(p.Difference_Score, 3)}</div>
        <div><strong>Weight Sum:</strong> ${fmt(p.Weight_Sum, 1)}</div>

        <div style="font-size: 11px; opacity: 0.8; margin-top: 6px;">
          <strong>Contribution (Composition)</strong> = (Input × Weight) ÷ Sum(Weights) for this segment.
        </div>

        ${buildCompositionStackBar(p, CRITERIA)}
      </div>

      <div style="font-weight:600; margin-bottom:6px;">Criteria</div>
      <div style="max-height: 300px; overflow:auto; border-top:1px solid rgba(0,0,0,0.1); padding-top:8px;">
        <table style="width:100%; border-collapse: collapse; font-size: 12px;">
          <thead>
            <tr>
              <th style="text-align:left; padding:2px 6px;">Criterion</th>
              <th style="text-align:right; padding:2px 6px;">Input</th>
              <th style="text-align:right; padding:2px 6px;">Weight</th>
              <th style="text-align:right; padding:2px 6px;">Score</th>
              <th style="text-align:right; padding:2px 6px;">Network Max Score</th>
              <th style="text-align:right; padding:2px 6px;">Norm Score (Network)</th>
              <th style="text-align:right; padding:2px 6px;">Contribution (Composition)</th>
            </tr>
          </thead>
          <tbody>
  `;

  let rows = "";
  CRITERIA.forEach((c) => {
    const input = p[`${c}_input`];
    const weight = p[`${c}_weight`];
    const score = p[`${c}_weighted`];
    const networkMax = p[`${c}_network_max_score`];
    const normNetwork = p[`${c}_norm_score_network`];
    const normComposition = p[`${c}_norm_score_composition`];

    const hasSomething =
      input !== undefined ||
      weight !== undefined ||
      score !== undefined ||
      networkMax !== undefined ||
      normNetwork !== undefined ||
      normComposition !== undefined;

    if (hasSomething) {
      rows += `
        <tr>
          <td style="padding: 2px 6px; white-space: nowrap;">${c}</td>
          <td style="padding: 2px 6px; text-align:right;">${fmt(input, 2)}</td>
          <td style="padding: 2px 6px; text-align:right;">${fmt(weight, 1)}</td>
          <td style="padding: 2px 6px; text-align:right;">${fmt(score, 3)}</td>
          <td style="padding: 2px 6px; text-align:right;">${fmt(networkMax, 3)}</td>
          <td style="padding: 2px 6px; text-align:right;">${fmt(normNetwork, 3)}</td>
          <td style="padding: 2px 6px; text-align:right;">${fmt(normComposition, 3)}</td>
        </tr>`;
    }
  });

  const footer = `
          </tbody>
        </table>
      </div>
    </div>
  `;

  const html = header + rows + footer;

  l.bindPopup(html, {
    maxWidth: 860,
    className: "customPopUp",
    autoPanPadding: [20, 20],
  });
}

// ===========================
// Classification state per layer
// ===========================
var CLASS_STATE = {
  norm: { breaks: null, scale: null },
  composition: { breaks: null, scale: null },
};

// build discrete scale + breaks for a given property name
function computeClassState(layer, propName, stateKey) {
  const gj = layer.toGeoJSON();
  const vals = (gj.features || [])
    .map((f) => f.properties && f.properties[propName])
    .filter((v) => v !== undefined);

  const breaks = jenksBreaks(vals, N_CLASSES);
  if (!breaks) return;

  // Force last break >= max
  const vmax = Math.max(...vals.map(Number).filter((v) => isFinite(v)));
  breaks[breaks.length - 1] = Math.max(breaks[breaks.length - 1], vmax);

  CLASS_STATE[stateKey].breaks = breaks;
  CLASS_STATE[stateKey].scale = chroma.scale(priorityColorSpectrum).classes(breaks);

  console.log(`Jenks breaks (${propName}):`, breaks);
}

// ===========================
// Layer styles (two priority layers)
// ===========================
function stylePriorityNorm(feature) {
  const v = feature.properties.Priority_Score_Norm;
  const state = CLASS_STATE.norm;

  if (!state.scale) {
    // fallback continuous
    const cont = chroma.scale(priorityColorSpectrum).domain([0, CRITERIA.length]);
    return { color: cont(v).hex(), weight: 3, opacity: 1 };
  }
  return { color: state.scale(v).hex(), weight: 3, opacity: 1 };
}

function stylePriorityComposition(feature) {
  const v = feature.properties.Priority_Score_Composition;
  const state = CLASS_STATE.composition;

  if (!state.scale) {
    // fallback continuous (composition is typically ~1–3)
    const cont = chroma.scale(priorityColorSpectrum).domain([0, 3]);
    return { color: cont(v).hex(), weight: 3, opacity: 1 };
  }
  return { color: state.scale(v).hex(), weight: 3, opacity: 1 };
}

// Options for three overlays
var priorityNormOptions = { style: stylePriorityNorm, onEachFeature: setupPopUp };
var priorityCompositionOptions = { style: stylePriorityComposition, onEachFeature: setupPopUp };
var differenceOptions = { style: differenceColor, onEachFeature: setupPopUp };

// ===========================
// Layers
// ===========================
var priorityNormLayer = new L.GeoJSON.AJAX(serviceURL, priorityNormOptions);
var priorityCompositionLayer = new L.GeoJSON.AJAX(serviceURL, priorityCompositionOptions);
var differenceLayer = new L.GeoJSON.AJAX(serviceURL, differenceOptions);

// When data loads/refreshed, recompute Jenks breaks for BOTH priority layers
priorityNormLayer.on("data:loaded", function () {
  computeClassState(priorityNormLayer, "Priority_Score_Norm", "norm");
  priorityNormLayer.setStyle(stylePriorityNorm);
  updateLegend();
});

priorityCompositionLayer.on("data:loaded", function () {
  computeClassState(priorityCompositionLayer, "Priority_Score_Composition", "composition");
  priorityCompositionLayer.setStyle(stylePriorityComposition);
  updateLegend();
});

// Default overlay: Priority (Norm Sum)
priorityNormLayer.addTo(map);

// ===========================
// Refresh weights
// ===========================
function refreshGeojson() {
  var new_weights = {};
  $(".slider").each(function () {
    new_weights[this.name] = this.value;
  });

  var req = $.ajax({
    url: "/revise_weights",
    type: "POST",
    data: new_weights,
  });

  req.done(function () {
    priorityNormLayer.refresh();
    priorityCompositionLayer.refresh();
    differenceLayer.refresh();
    console.log("Refreshed Layers.");
  });
}

// ===========================
// Layer control
// ===========================
var baseMaps = {
  Grey: Grey,
  Negative: Negative,
  OpenStreetMap: OpenStreetMap,
  "ESRI Satellite": ESRI_Satellite,
};

var overlayMaps = {
  "Priority (Norm Sum) — Jenks 5 bins": priorityNormLayer,
  "Priority (Composition Sum) — Jenks 5 bins": priorityCompositionLayer,
  "Difference (Norm Sum vs Baseline)": differenceLayer,
};

L.control.layers(baseMaps, overlayMaps).addTo(map);

// Track which legend we should show (based on active overlay)
var ACTIVE_LEGEND = "norm"; // "norm" or "composition"

map.on("overlayadd", function (e) {
  if (e.layer === priorityNormLayer) ACTIVE_LEGEND = "norm";
  if (e.layer === priorityCompositionLayer) ACTIVE_LEGEND = "composition";
  updateLegend();
});

// If user turns off the active one, keep legend as-is (or switch if other is on)
map.on("overlayremove", function (e) {
  // If they removed the active layer, try to pick the other if it is visible
  if (e.layer === priorityNormLayer && map.hasLayer(priorityCompositionLayer)) ACTIVE_LEGEND = "composition";
  if (e.layer === priorityCompositionLayer && map.hasLayer(priorityNormLayer)) ACTIVE_LEGEND = "norm";
  updateLegend();
});

// ===========================
// Legend (5 bins, dynamic)
// ===========================
var legend = L.control({ position: "bottomright" });

function buildLegendHTMLFor(stateKey, title) {
  const state = CLASS_STATE[stateKey];
  let html = `<h6><strong>${title}</strong></h6>`;

  if (!state.breaks || !state.scale) {
    html += `<div style="font-size:11px;opacity:0.8;">Loading breaks…</div>`;
    return html;
  }

  const colors = chroma.scale(priorityColorSpectrum).colors(N_CLASSES);

  html += `<div style="margin-top:6px;">`;
  for (let i = 0; i < N_CLASSES; i++) {
    const a = state.breaks[i];
    const b = state.breaks[i + 1];
    html += `
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
        <i style="background:${colors[i]}; width:12px; height:12px; display:inline-block;"></i>
        <span style="font-size:11px;">${fmt(a, 3)} – ${fmt(b, 3)}</span>
      </div>`;
  }
  html += `</div>`;
  return html;
}

function updateLegend() {
  if (!legend || !legend._container) return;

  if (ACTIVE_LEGEND === "composition") {
    legend._container.innerHTML = buildLegendHTMLFor(
      "composition",
      "Priority (Composition Sum) — Jenks (5 bins)"
    );
  } else {
    legend._container.innerHTML = buildLegendHTMLFor("norm", "Priority (Norm Sum) — Jenks (5 bins)");
  }
}

legend.onAdd = function () {
  var div = L.DomUtil.create("div", "info legend");
  div.innerHTML = buildLegendHTMLFor("norm", "Priority (Norm Sum) — Jenks (5 bins)");
  return div;
};

legend.addTo(map);

// ===========================
// Download button
// ===========================
var download = L.control({ position: "bottomleft" });

download.onAdd = function () {
  var div = L.DomUtil.create("div", "button");
  div.innerHTML =
    "<a href=" + serviceURL + ' download="network.geojson">' + "<h6 class='download'>DOWNLOAD</h6></a>";
  return div;
};

download.addTo(map);

// ===========================
// Sum of weights display
// ===========================
function recomputeWeightedSum() {
  var sliderOutputSum = 0;
  $(".output").each(function () {
    var v = parseFloat($(this).text());
    if (isFinite(v)) sliderOutputSum += v;
  });
  $("h6.sliderTotalSum").text(sliderOutputSum.toFixed(1));
}

recomputeWeightedSum();
$(".slider").on("input", recomputeWeightedSum);
