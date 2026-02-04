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

  // ---------- helpers ----------
  function fmt(n, d = 2) {
    if (n === null || n === undefined || n === "") return "";
    const x = Number(n);
    if (!isFinite(x)) return String(n);
    return x.toFixed(d);
  }

  // Deterministic colors based on criterion index
  // (stable across sessions + machines)
  const barColors = chroma
    .scale(["#4C78A8", "#F58518", "#54A24B", "#E45756", "#B279A2", "#FF9DA6", "#9D755D", "#BAB0AC"])
    .mode("lch")
    .colors(CRITERIA.length);

  // ---------- compute stacked bar data ----------
  // We'll use composition contributions (these sum to Priority_Score_Composition)
  // contribution = <crit>_norm_score_composition
  const contribs = CRITERIA.map((c, i) => {
    const v = Number(p[`${c}_norm_score_composition`]);
    return {
      key: c,
      val: isFinite(v) ? v : 0,
      color: barColors[i],
    };
  });

  const contribTotal = contribs.reduce((acc, o) => acc + o.val, 0);

  // Convert contributions to percent widths
  // If total is 0, just show empty bar.
  const segmentsHtml =
    contribTotal > 0
      ? contribs
          .map((o) => {
            const pct = (o.val / contribTotal) * 100;
            const title = `${o.key}: ${fmt(o.val, 3)} (${fmt(pct, 1)}%)`;
            return `
              <div
                title="${title}"
                style="
                  width:${pct}%;
                  background:${o.color};
                  height:14px;
                "
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

  // ---------- header ----------
  const header = `
    <div style="min-width: 460px; max-width: 860px;">
      <div style="font-weight: 700; margin-bottom: 6px;">
        Segment ${p.OBJECTID !== undefined ? p.OBJECTID : ""}
      </div>

      <div style="margin-bottom: 10px;">
        <div><strong>Priority Score (Norm Sum):</strong> ${fmt(p.Priority_Score_Norm, 3)}</div>
        <div><strong>Priority Score (Composition Sum):</strong> ${fmt(p.Priority_Score_Composition, 3)}</div>

        <div style="margin-top:6px;">
          <div><strong>Difference (Last Run, Raw):</strong> ${fmt(p.Difference_Raw, 4)}</div>
          <div><strong>Difference (Last Run, Normalized):</strong> ${fmt(p.Difference_Score, 3)}</div>
          <div style="font-size: 11px; opacity: 0.8;">
            Raw = current Priority (Norm Sum) − previous Priority (Norm Sum).<br>
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

  // ---------- rows ----------
  let rows = "";
  CRITERIA.forEach((c, i) => {
    rows += `
      <tr>
        <td style="padding: 2px 6px; white-space: nowrap;">
          <span style="display:inline-block;width:10px;height:10px;background:${barColors[i]};border-radius:2px;margin-right:6px;"></span>
          ${c}
        </td>
        <td style="padding: 2px 6px; text-align:right;">${fmt(p[`${c}_input`], 2)}</td>
        <td style="padding: 2px 6px; text-align:right;">${fmt(p[`${c}_weight`], 1)}</td>
        <td style="padding: 2px 6px; text-align:right;">${fmt(p[`${c}_weighted`], 3)}</td>
        <td style="padding: 2px 6px; text-align:right;">${fmt(p[`${c}_network_max_score`], 3)}</td>
        <td style="padding: 2px 6px; text-align:right;">${fmt(p[`${c}_norm_score_network`], 3)}</td>
        <td style="padding: 2px 6px; text-align:right;">${fmt(p[`${c}_norm_score_composition`], 3)}</td>
      </tr>`;
  });

  // ---------- footer ----------
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
  norm: { breaks: null, scale: null },
  composition: { breaks: null, scale: null },
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
function stylePriorityNorm(feature) {
  const v = feature.properties.Priority_Score_Norm;
  const state = CLASS_STATE.norm;

  if (!state.scale) {
    const cont = chroma.scale(priorityColorSpectrum).domain([0, CRITERIA.length]);
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

// Difference: normalized to [-1,1]
var diffScale = chroma.scale(differenceColorSpectrum).domain([-1, 1]);

function styleDifference(feature) {
  const v = feature.properties.Difference_Score;
  return { color: diffScale(v).hex(), weight: 3, opacity: 1 };
}

// ===========================
// Layers
// ===========================
var priorityNormLayer = new L.GeoJSON.AJAX(serviceURL, { style: stylePriorityNorm, onEachFeature: setupPopUp });
var priorityCompositionLayer = new L.GeoJSON.AJAX(serviceURL, {
  style: stylePriorityComposition,
  onEachFeature: setupPopUp,
});
var differenceLayer = new L.GeoJSON.AJAX(serviceURL, { style: styleDifference, onEachFeature: setupPopUp });

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

// Default overlay
priorityNormLayer.addTo(map);

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
    priorityNormLayer.refresh();
    priorityCompositionLayer.refresh();
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
  "Priority (Norm Sum) — Jenks (5 bins)": priorityNormLayer,
  "Priority (Composition Sum) — Jenks (5 bins)": priorityCompositionLayer,
  "Difference (Last Run, Norm Sum) — [-1,1]": differenceLayer,
};

L.control.layers(baseMaps, overlayMaps).addTo(map);

// ===========================
// Legend (switches by active overlay)
// ===========================
var legend = L.control({ position: "bottomright" });
var ACTIVE_LEGEND = "norm"; // norm | composition | difference

map.on("overlayadd", function (e) {
  if (e.layer === priorityNormLayer) ACTIVE_LEGEND = "norm";
  if (e.layer === priorityCompositionLayer) ACTIVE_LEGEND = "composition";
  if (e.layer === differenceLayer) ACTIVE_LEGEND = "difference";
  updateLegend();
});

map.on("overlayremove", function (e) {
  // If the active legend layer was removed, prefer another active overlay
  if (e.layer === priorityNormLayer && ACTIVE_LEGEND === "norm") {
    if (map.hasLayer(priorityCompositionLayer)) ACTIVE_LEGEND = "composition";
    else if (map.hasLayer(differenceLayer)) ACTIVE_LEGEND = "difference";
  }
  if (e.layer === priorityCompositionLayer && ACTIVE_LEGEND === "composition") {
    if (map.hasLayer(priorityNormLayer)) ACTIVE_LEGEND = "norm";
    else if (map.hasLayer(differenceLayer)) ACTIVE_LEGEND = "difference";
  }
  if (e.layer === differenceLayer && ACTIVE_LEGEND === "difference") {
    if (map.hasLayer(priorityNormLayer)) ACTIVE_LEGEND = "norm";
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
  } else if (ACTIVE_LEGEND === "difference") {
    legend._container.innerHTML = buildLegendHTMLDifference();
  } else {
    legend._container.innerHTML = buildLegendHTMLJenks("norm", "Priority (Norm Sum) — Jenks (5 bins)");
  }
}

legend.onAdd = function () {
  var div = L.DomUtil.create("div", "info legend");
  div.innerHTML = buildLegendHTMLJenks("norm", "Priority (Norm Sum) — Jenks (5 bins)");
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
