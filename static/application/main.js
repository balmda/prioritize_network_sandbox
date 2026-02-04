// Main Application JS File

$(document).ready(function () {
  console.log("Document Ready");
});

const filePath = "static/application/data/WestValleyATPNetwork.geojson"; // unused
const serviceURL = "/api/network_geojson.geojson"; // dynamic weighted reference

// Palette for the ramp
var priorityColorSpectrum = ["ffe760", "ff5656", "773131"];
var differenceColorSpectrum = ["67a9cf", "f7f7f7", "ef8a62"];

// Criteria order (injected from Jinja via window.CRITERIA)
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

// Priority norm range is roughly [0, #criteria]
var PRIORITY_NORM_MAX = CRITERIA.length;

// Domains / palettes
var valueDomains = [0, PRIORITY_NORM_MAX];
var differenceDomains = [-1, 1];

var priorityOptions = { style: priorityColor, onEachFeature: setupPopUp };
var differenceOptions = { style: differenceColor, onEachFeature: setupPopUp };

var map = L.map("map").setView([40.688, -112.0], 13);

// ===========================
// Basemap Options
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
// Style Network
// ===========================
priorityColorScale = chroma.scale(priorityColorSpectrum).domain(valueDomains);
differenceColorScale = chroma.scale(differenceColorSpectrum).domain(differenceDomains);

// IMPORTANT: color ramp uses Priority_Score_Norm now
function priorityColor(feature) {
  return {
    color: priorityColorScale(feature.properties.Priority_Score_Norm),
    weight: 3,
    opacity: 1,
  };
}

function differenceColor(feature) {
  return {
    color: differenceColorScale(feature.properties.Difference_Score),
    weight: 3,
    opacity: 1,
  };
}

// ===========================
// Popup helpers
// ===========================
function fmt(n, d = 2) {
  if (n === null || n === undefined || n === "") return "";
  const x = Number(n);
  if (!isFinite(x)) return String(n);
  return x.toFixed(d);
}

/**
 * Deterministic palette based on criteria order using chroma.
 * Same criteria list (and order) => same colors every time.
 */
function getCriteriaColors(criteria) {
  const colors = {};
  const n = Math.max(1, criteria.length);

  criteria.forEach((c, i) => {
    const hue = (i * 360) / n;
    const col = chroma.lch(65, 55, hue).hex();
    colors[c] = col;
  });

  return colors;
}

/**
 * Stacked bar: percent contribution of each criterion
 * to Priority_Score_Composition.
 */
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
// Add Network & Refresh
// ===========================
var priorityLayer = new L.GeoJSON.AJAX(serviceURL, priorityOptions);
var differenceLayer = new L.GeoJSON.AJAX(serviceURL, differenceOptions);

priorityLayer.addTo(map);

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
    priorityLayer.refresh();
    differenceLayer.refresh();
    console.log("Refreshed Layers.");
  });
}

// ===========================
// Layer Control
// ===========================
var baseMaps = {
  Grey: Grey,
  Negative: Negative,
  OpenStreetMap: OpenStreetMap,
  "ESRI Satellite": ESRI_Satellite,
};

var overlayMaps = {
  Prioritization: priorityLayer,
  "Score Change": differenceLayer,
};

L.control.layers(baseMaps, overlayMaps).addTo(map);

// ===========================
// Legend (now for Priority_Score_Norm)
// ===========================
var legend = L.control({ position: "bottomright" });

legend.onAdd = function () {
  var div = L.DomUtil.create("div", "info legend");

  var grades = [0, PRIORITY_NORM_MAX / 2, PRIORITY_NORM_MAX];
  var labels = ["Low", "Medium", "High"];

  div.innerHTML = "<h6><strong> Priority (Norm Sum) </strong></h6><br>";

  for (var i = 0; i < grades.length; i++) {
    div.innerHTML +=
      '<i style="background:' +
      priorityColorScale(grades[i]) +
      '"></i> ' +
      '<h6 class="legendText">' +
      labels[i] +
      "</h6><br>";
  }

  return div;
};

legend.addTo(map);

// ===========================
// Download Button
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
// Create Sum of Elements
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
