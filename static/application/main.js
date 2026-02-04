// Main Application JS File

$(document).ready(function () {
  console.log("Document Ready");
});

const serviceURL = "/api/network_geojson.geojson";

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

var N_CLASSES = 5;

// Palettes
var priorityColorSpectrum = ["ffe760", "ff5656", "773131"];
var differenceColorSpectrum = ["67a9cf", "f7f7f7", "ef8a62"];

// Difference is already normalized to [-1, 1] by app.py
var DIFFERENCE_BINS = [-1, -0.6, -0.2, 0.2, 0.6, 1];

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
// Helpers
// ===========================
function fmt(n, d = 2) {
  if (n === null || n === undefined || n === "") return "";
  const x = Number(n);
  if (!isFinite(x)) return String(n);
  return x.toFixed(d);
}

// Back-compat: older app versions used `${c}_weighted`, newer uses `${c}_score`
function getScoreProp(p, c) {
  if (p.hasOwnProperty(`${c}_score`)) return p[`${c}_score`];
  if (p.hasOwnProperty(`${c}_weighted`)) return p[`${c}_weighted`];
  return undefined;
}

// ===========================
// Jenks
// ===========================
function jenksBreaks(data, nClasses) {
  const values = data
    .map(Number)
    .filter((v) => isFinite(v))
    .sort((a, b) => a - b);

  if (values.length === 0) return null;

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
// Popup
// ===========================
function setupPopUp(f, l) {
  const p = f.properties || {};

  const barColors = chroma
    .scale([
      "#4C78A8",
      "#F58518",
      "#54A24B",
      "#E45756",
      "#B279A2",
      "#FF9DA6",
      "#9D755D",
      "#BAB0AC",
    ])
    .mode("lch")
    .colors(CRITERIA.length);

  const contribs = CRITERIA.map((c, i) => {
    const v = Number(p[`${c}_norm_score_composition`]);
    return { key: c, val: isFinite(v) ? v : 0, color: barColors[i] };
  });

  const contribTotal = contribs.reduce((acc, o) => acc + o.val, 0);

  const segmentsHtml =
    contribTotal > 0
      ? contribs
          .map((o) => {
            const pct = (o.val / contribTotal) * 100;
            const title = `${o.key}: ${fmt(o.val, 3)} (${fmt(pct, 1)}%)`;
            return `
              <div
                title="${title}"
                style="width:${pct}%; background:${o.color}; height:14px;"
              ></div>`;
          })
          .join("")
      : "";

  const barHtml = `
    <div style="margin: 10px 0 12px 0;">
      <div style="font-weight:600; margin-bottom:6px;">Composition Contribution (stacked)</div>
      <div
        style="
          display:flex;
          width:100%;
          border:1px solid rgba(0,0,0,0.15);
          border-radius:4px;
          overflow:hidden;
          background: rgba(0,0,0,0.04);
        "
      >
        ${segmentsHtml}
      </div>
      <div style="font-size:11px; opacity:0.8; margin-top:6px;">
        Each segment width = that criterion’s share of the composition score (hover for details).
      </div>
    </div>
  `;

  const header = `
    <div style="min-width: 460px; max-width: 860px;">
      <div style="font-weight: 700; margin-bottom: 6px;">
        Segment ${p.OBJECTID !== undefined ? p.OBJECTID : ""}
      </div>

      <div style="margin-bottom: 10px;">
        <div><strong>Priority Score:</strong> ${fmt(p.Priority_Score, 3)}</div>
        <div><strong>Priority Score (Scaled 0–1):</strong> ${fmt(p.Priority_Score_Scaled, 3)}</div>
        <div><strong>Priority Score (Composition Sum):</strong> ${fmt(p.Priority_Score_Composition, 3)}</div>

        <div style="margin-top:6px;">
          <div><strong>Difference (Last Run, Raw):</strong> ${fmt(p.Difference_Raw, 4)}</div>
          <div><strong>Difference (Last Run, Normalized):</strong> ${fmt(p.Difference_Score, 3)}</div>
          <div style="font-size: 11px; opacity: 0.8;">
            Raw = current Priority Score − previous Priority Score.<br>
            Normalized is scaled to [-1, 1] across the network for map coloring.
          </div>
        </div>

        <div style="margin-top:6px;"><strong>Weight Sum:</strong> ${fmt(p.Weight_Sum, 1)}</div>
      </div>

      ${barHtml}

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
  CRITERIA.forEach((c, i) => {
    const score = getScoreProp(p, c);
    rows += `
      <tr>
        <td style="padding: 2px 6px; white-space: nowrap;">
          <span style="display:inline-block;width:10px;height:10px;background:${barColors[i]};border-radius:2px;margin-right:6px;"></span>
          ${c}
        </td>
        <td style="padding: 2px 6px; text-align:right;">${fmt(p[`${c}_input`], 2)}</td>
        <td style="padding: 2px 6px; text-align:right;">${fmt(p[`${c}_weight`], 1)}</td>
        <td style="padding: 2px 6px; text-align:right;">${fmt(score, 3)}</td>
        <td style="padding: 2px 6px; text-align:right;">${fmt(p[`${c}_network_max_score`], 3)}</td>
        <td style="padding: 2px 6px; text-align:right;">${fmt(p[`${c}_norm_score_network`], 3)}</td>
        <td style="padding: 2px 6px; text-align:right;">${fmt(p[`${c}_norm_score_composition`], 3)}</td>
      </tr>`;
  });

  const footer = `
          </tbody>
        </table>
      </div>
    </div>
  `;

  l.bindPopup(header + rows + footer, {
    maxWidth: 860,
    className: "customPopUp",
    autoPanPadding: [20, 20],
  });
}

// ===========================
// Classification state per layer
// ===========================
var CLASS_STATE = {
  score: { breaks: null, scale: null },
  composition: { breaks: null, scale: null },
  scaled: { breaks: null, scale: null },
};

function computeClassState(layer, propName, stateKey) {
  const gj = layer.toGeoJSON();
  const vals = (gj.features || [])
    .map((f) => f.properties && f.properties[propName])
    .filter((v) => v !== undefined);

  const breaks = jenksBreaks(vals, N_CLASSES);
  if (!breaks) return;

  const vmax = Math.max(...vals.map(Number).filter((v) => isFinite(v)));
  breaks[breaks.length - 1] = Math.max(breaks[breaks.length - 1], vmax);

  CLASS_STATE[stateKey].breaks = breaks;
  CLASS_STATE[stateKey].scale = chroma.scale(priorityColorSpectrum).classes(breaks);
}

// ===========================
// Styles
// ===========================
function stylePriorityScore(feature) {
  const v = feature.properties.Priority_Score;
  const state = CLASS_STATE.score;

  if (!state.scale) {
    const cont = chroma.scale(priorityColorSpectrum).domain([0, 30]); // fallback
    return { color: cont(v).hex(), weight: 3, opacity: 1 };
  }
  return { color: state.scale(v).hex(), weight: 3, opacity: 1 };
}

function stylePriorityComposition(feature) {
  const v = feature.properties.Priority_Score_Composition;
  const state = CLASS_STATE.composition;

  if (!state.scale) {
    const cont = chroma.scale(priorityColorSpectrum).domain([0, 3]);
    return { color: cont(v).hex(), weight: 3, opacity: 1 };
  }
  return { color: state.scale(v).hex(), weight: 3, opacity: 1 };
}

function stylePriorityScaled(feature) {
  const v = feature.properties.Priority_Score_Scaled;
  const state = CLASS_STATE.scaled;

  if (!state.scale) {
    const cont = chroma.scale(priorityColorSpectrum).domain([0, 1]);
    return { color: cont(v).hex(), weight: 3, opacity: 1 };
  }
  return { color: state.scale(v).hex(), weight: 3, opacity: 1 };
}

// Highlight layer: scaled in [0.9, 1.0]
function styleTopScaled(feature) {
  const v = feature.properties.Priority_Score_Scaled;
  const c = chroma.scale(priorityColorSpectrum).domain([0, 1])(v).hex();
  return { color: c, weight: 7, opacity: 1 };
}

// Difference: normalized to [-1,1]
var diffScale = chroma.scale(differenceColorSpectrum).domain([-1, 1]);
function styleDifference(feature) {
  const v = feature.properties.Difference_Score;
  return { color: diffScale(v).hex(), weight: 3, opacity: 1 };
}

// ===========================
// Layers
// ===========================
var priorityScoreLayer = new L.GeoJSON.AJAX(serviceURL, {
  style: stylePriorityScore,
  onEachFeature: setupPopUp,
});

var priorityCompositionLayer = new L.GeoJSON.AJAX(serviceURL, {
  style: stylePriorityComposition,
  onEachFeature: setupPopUp,
});

var priorityScaledLayer = new L.GeoJSON.AJAX(serviceURL, {
  style: stylePriorityScaled,
  onEachFeature: setupPopUp,
});

var topScaledLayer = new L.GeoJSON.AJAX(serviceURL, {
  filter: function (feature) {
    const v = Number(feature.properties.Priority_Score_Scaled);
    return isFinite(v) && v >= 0.9 && v <= 1.0;
  },
  style: styleTopScaled,
  onEachFeature: setupPopUp,
});

var differenceLayer = new L.GeoJSON.AJAX(serviceURL, {
  style: styleDifference,
  onEachFeature: setupPopUp,
});

priorityScoreLayer.on("data:loaded", function () {
  computeClassState(priorityScoreLayer, "Priority_Score", "score");
  priorityScoreLayer.setStyle(stylePriorityScore);
  updateLegend();
});

priorityCompositionLayer.on("data:loaded", function () {
  computeClassState(priorityCompositionLayer, "Priority_Score_Composition", "composition");
  priorityCompositionLayer.setStyle(stylePriorityComposition);
  updateLegend();
});

priorityScaledLayer.on("data:loaded", function () {
  computeClassState(priorityScaledLayer, "Priority_Score_Scaled", "scaled");
  priorityScaledLayer.setStyle(stylePriorityScaled);
  updateLegend();
});

topScaledLayer.on("data:loaded", function () {
  try {
    const n = (topScaledLayer.toGeoJSON().features || []).length;
    console.log("Top Scaled (0.9–1.0) features:", n);
  } catch (e) {}
});

// Default overlay
priorityScoreLayer.addTo(map);

// ===========================
// Refresh weights
// ===========================
function refreshGeojson() {
  var new_weights = {};
  $(".slider").each(function () {
    new_weights[this.name] = this.value;
  });

  $.ajax({
    url: "/revise_weights",
    type: "POST",
    data: new_weights,
  }).done(function () {
    priorityScoreLayer.refresh();
    priorityCompositionLayer.refresh();
    priorityScaledLayer.refresh();
    topScaledLayer.refresh();
    differenceLayer.refresh();
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
  "Priority (Score Sum) — Jenks (5 bins)": priorityScoreLayer,
  "Priority (Scaled 0–1) — Jenks (5 bins)": priorityScaledLayer,
  "Top Scaled Segments (0.9–1.0)": topScaledLayer,
  "Priority (Composition Sum) — Jenks (5 bins)": priorityCompositionLayer,
  "Difference (Last Run, Priority Score) — [-1,1]": differenceLayer,
};

L.control.layers(baseMaps, overlayMaps).addTo(map);

// ===========================
// Legend (switches by active overlay)
// ===========================
var legend = L.control({ position: "bottomright" });
var ACTIVE_LEGEND = "score"; // score | scaled | composition | difference

map.on("overlayadd", function (e) {
  if (e.layer === priorityScoreLayer) ACTIVE_LEGEND = "score";
  if (e.layer === priorityScaledLayer) ACTIVE_LEGEND = "scaled";
  if (e.layer === priorityCompositionLayer) ACTIVE_LEGEND = "composition";
  if (e.layer === differenceLayer) ACTIVE_LEGEND = "difference";
  // topScaledLayer does not change legend
  updateLegend();
});

map.on("overlayremove", function (e) {
  if (e.layer === priorityScoreLayer && ACTIVE_LEGEND === "score") {
    if (map.hasLayer(priorityScaledLayer)) ACTIVE_LEGEND = "scaled";
    else if (map.hasLayer(priorityCompositionLayer)) ACTIVE_LEGEND = "composition";
    else if (map.hasLayer(differenceLayer)) ACTIVE_LEGEND = "difference";
  }

  if (e.layer === priorityScaledLayer && ACTIVE_LEGEND === "scaled") {
    if (map.hasLayer(priorityScoreLayer)) ACTIVE_LEGEND = "score";
    else if (map.hasLayer(priorityCompositionLayer)) ACTIVE_LEGEND = "composition";
    else if (map.hasLayer(differenceLayer)) ACTIVE_LEGEND = "difference";
  }

  if (e.layer === priorityCompositionLayer && ACTIVE_LEGEND === "composition") {
    if (map.hasLayer(priorityScoreLayer)) ACTIVE_LEGEND = "score";
    else if (map.hasLayer(priorityScaledLayer)) ACTIVE_LEGEND = "scaled";
    else if (map.hasLayer(differenceLayer)) ACTIVE_LEGEND = "difference";
  }

  if (e.layer === differenceLayer && ACTIVE_LEGEND === "difference") {
    if (map.hasLayer(priorityScoreLayer)) ACTIVE_LEGEND = "score";
    else if (map.hasLayer(priorityScaledLayer)) ACTIVE_LEGEND = "scaled";
    else if (map.hasLayer(priorityCompositionLayer)) ACTIVE_LEGEND = "composition";
  }

  updateLegend();
});

function buildLegendHTMLJenks(stateKey, title) {
  const state = CLASS_STATE[stateKey];
  let html = `<h6><strong>${title}</strong></h6>`;

  if (!state.breaks || !state.scale) {
    html += `<div style="font-size:11px;opacity:0.8;">Loading breaks…</div>`;
    return html;
  }

  const colors = chroma.scale(priorityColorSpectrum).colors(N_CLASSES);
  html += `<div style="margin-top:6px;">`;

  for (let i = 0; i < N_CLASSES; i++) {
    html += `
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
        <i style="background:${colors[i]}; width:12px; height:12px; display:inline-block;"></i>
        <span style="font-size:11px;">${fmt(state.breaks[i], 3)} – ${fmt(state.breaks[i + 1], 3)}</span>
      </div>`;
  }

  html += `</div>`;
  return html;
}

function buildLegendHTMLDifference() {
  let html = `<h6><strong>Difference (Last Run)</strong></h6>`;
  html += `<div style="font-size:11px;opacity:0.8;margin-bottom:6px;">Normalized to [-1, 1]</div>`;

  const colors = chroma.scale(differenceColorSpectrum).colors(N_CLASSES);

  html += `<div style="margin-top:6px;">`;
  for (let i = 0; i < N_CLASSES; i++) {
    const a = DIFFERENCE_BINS[i];
    const b = DIFFERENCE_BINS[i + 1];
    html += `
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
        <i style="background:${colors[i]}; width:12px; height:12px; display:inline-block;"></i>
        <span style="font-size:11px;">${fmt(a, 2)} – ${fmt(b, 2)}</span>
      </div>`;
  }
  html += `</div>`;
  return html;
}

function updateLegend() {
  if (!legend || !legend._container) return;

  if (ACTIVE_LEGEND === "composition") {
    legend._container.innerHTML = buildLegendHTMLJenks(
      "composition",
      "Priority (Composition Sum) — Jenks (5 bins)"
    );
  } else if (ACTIVE_LEGEND === "scaled") {
    legend._container.innerHTML = buildLegendHTMLJenks(
      "scaled",
      "Priority (Scaled 0–1) — Jenks (5 bins)"
    );
  } else if (ACTIVE_LEGEND === "difference") {
    legend._container.innerHTML = buildLegendHTMLDifference();
  } else {
    legend._container.innerHTML = buildLegendHTMLJenks(
      "score",
      "Priority (Score Sum) — Jenks (5 bins)"
    );
  }
}

legend.onAdd = function () {
  var div = L.DomUtil.create("div", "info legend");
  div.innerHTML = buildLegendHTMLJenks("score", "Priority (Score Sum) — Jenks (5 bins)");
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
