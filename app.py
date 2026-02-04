import json
import os
from typing import Dict, Any, List, Tuple

from flask import Flask, render_template, request, jsonify, session, Response


app = Flask(__name__)
app.secret_key = os.environ.get("FLASK_SECRET_KEY", "dev-secret-key-change-me")

BASE_GEOJSON_PATH = os.environ.get(
    "BASE_GEOJSON_PATH",
    os.path.join(app.root_path, "static", "application", "data", "WestValleyATPNetwork.geojson"),
)

# -----------------------------------------------------------------------------
# CONFIG
# -----------------------------------------------------------------------------
CRITERIA: List[str] = [
    "strava",
    "ucatsbicycle",
    "ucatsped",
    "safety",
    "sidewalk",
    "crosswalk",
    "bikelane",
    "bikeconnectivity",
    "pedconnectivity",
]

# 0–10 weights (align with your sliders)
DEFAULT_WEIGHTS: Dict[str, float] = {k: 5.0 for k in CRITERIA}

# Map slider names -> GeoJSON property names (source fields in your base GeoJSON)
FIELD_MAP: Dict[str, str] = {
    "strava": "Strava_Score",
    "ucatsbicycle": "UCATBKUse_Score",
    "ucatsped": "UCATWKUse_Score",
    "safety": "Safety_Score",
    "sidewalk": "SidWlk_Score",
    "crosswalk": "Crss_WK_Score",
    "bikelane": "Bike_Ln_Score",
    "bikeconnectivity": "LSBikConnect_Score",
    "pedconnectivity": "PedConnect_Score",
}

# If you want nicer labels in the slider UI, update these:
LABEL_MAP: Dict[str, str] = {
    "strava": "Strava Usage",
    "ucatsbicycle": "UCATS Bicycle Index",
    "ucatsped": "UCATS Pedestrian Index",
    "safety": "Safety Score",
    "sidewalk": "Sidewalk Presence",
    "crosswalk": "Crosswalk Presence",
    "bikelane": "Bicycle Lane Presence",
    "bikeconnectivity": "Bicycle Connectivity",
    "pedconnectivity": "Pedestrian Connectivity",
}

# Which *source* properties to remove from the exported/downloaded GeoJSON
# (We use them for computation, but you asked not to export them.)
SOURCE_SCORE_FIELDS_TO_DROP = set(FIELD_MAP.values())


# -----------------------------------------------------------------------------
# HELPERS
# -----------------------------------------------------------------------------
def _load_geojson(path: str) -> Dict[str, Any]:
    if not os.path.exists(path):
        raise FileNotFoundError(
            f"Missing GeoJSON file: {path}\n"
            f"Expected at static/application/data/WestValleyATPNetwork.geojson.\n"
            f"Either create it or set BASE_GEOJSON_PATH."
        )
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _safe_float(v: Any, default: float = 0.0) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return float(default)


def _parse_weights(form: Dict[str, Any]) -> Dict[str, float]:
    """
    Parse POSTed slider weights, falling back to last session values/defaults.
    Weights expected 0–10 (step 0.5).
    """
    prior = session.get("weights", DEFAULT_WEIGHTS)
    weights: Dict[str, float] = {}

    for k in CRITERIA:
        if k in form:
            weights[k] = _safe_float(form.get(k), default=prior.get(k, DEFAULT_WEIGHTS[k]))
        else:
            weights[k] = _safe_float(prior.get(k, DEFAULT_WEIGHTS[k]), default=DEFAULT_WEIGHTS[k])

        # clamp to [0, 10]
        weights[k] = max(0.0, min(10.0, weights[k]))

    return weights


def _normalize(values: List[float], out_min: float, out_max: float) -> List[float]:
    """Min-max normalize to [out_min, out_max]."""
    if not values:
        return []
    vmin, vmax = min(values), max(values)
    if vmax == vmin:
        # flat -> 0 if centered domain (e.g., [-1,1])
        if out_min < 0 < out_max:
            return [0.0 for _ in values]
        return [out_min for _ in values]
    scale = (out_max - out_min) / (vmax - vmin)
    return [out_min + (v - vmin) * scale for v in values]


def _scale_0_1(values: List[float]) -> List[float]:
    """Scale list to [0,1] by min-max. Flat list -> 0.0."""
    if not values:
        return []
    vmin, vmax = min(values), max(values)
    if vmax == vmin:
        return [0.0 for _ in values]
    return [(v - vmin) / (vmax - vmin) for v in values]


def _compute_per_feature_fields(props: Dict[str, Any], weights: Dict[str, float]) -> Tuple[Dict[str, Any], float]:
    """
    Per-feature calculations.

    Per criterion outputs:
      - <crit>_input
      - <crit>_weight
      - <crit>_score                         = input × weight
      - <crit>_norm_score_composition        = (input×weight) / sum(weights)

    Returns:
      - fields dict (without network max info)
      - weight_sum
    """
    fields: Dict[str, Any] = {}
    weight_sum = 0.0

    for crit in CRITERIA:
        prop_key = FIELD_MAP.get(crit, crit)
        x = _safe_float(props.get(prop_key, 0.0), default=0.0)
        w = _safe_float(weights.get(crit, 0.0), default=0.0)

        score = x * w

        fields[f"{crit}_input"] = x
        fields[f"{crit}_weight"] = w
        fields[f"{crit}_score"] = score

        weight_sum += w

    # composition normalization (within segment)
    if weight_sum > 0:
        for crit in CRITERIA:
            fields[f"{crit}_norm_score_composition"] = fields[f"{crit}_score"] / weight_sum
    else:
        for crit in CRITERIA:
            fields[f"{crit}_norm_score_composition"] = 0.0

    return fields, weight_sum


def _add_network_max_and_norm(fields_list: List[Dict[str, Any]]) -> Dict[str, float]:
    """
    Adds to each fields dict:
      - <crit>_network_max_score            = max(score) across all segments
      - <crit>_norm_score_network           = score / network_max_score

    Returns:
      network_max_by_crit
    """
    network_max_by_crit: Dict[str, float] = {crit: 0.0 for crit in CRITERIA}

    # find max per criterion for score
    for fields in fields_list:
        for crit in CRITERIA:
            v = _safe_float(fields.get(f"{crit}_score", 0.0), default=0.0)
            if v > network_max_by_crit[crit]:
                network_max_by_crit[crit] = v

    # add back to each feature
    for fields in fields_list:
        for crit in CRITERIA:
            max_v = network_max_by_crit.get(crit, 0.0)
            fields[f"{crit}_network_max_score"] = max_v
            score_v = _safe_float(fields.get(f"{crit}_score", 0.0), default=0.0)
            fields[f"{crit}_norm_score_network"] = (score_v / max_v) if max_v > 0 else 0.0

    return network_max_by_crit


def _priority_norm_sum(fields: Dict[str, Any]) -> float:
    """Priority score (norm sum): sum of per-criterion network-normalized scores."""
    return sum(_safe_float(fields.get(f"{crit}_norm_score_network", 0.0)) for crit in CRITERIA)


def _priority_composition_sum(fields: Dict[str, Any]) -> float:
    """
    Priority score (composition sum): sum of per-criterion composition shares.
    This equals: (sum(score_i) / sum(weights)) for the segment.
    """
    return sum(_safe_float(fields.get(f"{crit}_norm_score_composition", 0.0)) for crit in CRITERIA)


def _criterion_diffs(current_fields: Dict[str, Any], prev_fields: Dict[str, Any]) -> Dict[str, Any]:
    """
    Per-criterion diffs (current - prev) for export/download.
    Creates:
      - <crit>_score_diff
      - <crit>_norm_score_network_diff
      - <crit>_norm_score_composition_diff
    """
    out: Dict[str, Any] = {}
    for crit in CRITERIA:
        out[f"{crit}_score_diff"] = _safe_float(current_fields.get(f"{crit}_score", 0.0)) - _safe_float(
            prev_fields.get(f"{crit}_score", 0.0)
        )
        out[f"{crit}_norm_score_network_diff"] = _safe_float(
            current_fields.get(f"{crit}_norm_score_network", 0.0)
        ) - _safe_float(prev_fields.get(f"{crit}_norm_score_network", 0.0))
        out[f"{crit}_norm_score_composition_diff"] = _safe_float(
            current_fields.get(f"{crit}_norm_score_composition", 0.0)
        ) - _safe_float(prev_fields.get(f"{crit}_norm_score_composition", 0.0))
    return out


def _drop_source_scores(props: Dict[str, Any]) -> None:
    """Remove the original source *_Score fields from the outgoing properties (in-place)."""
    for k in list(props.keys()):
        if k in SOURCE_SCORE_FIELDS_TO_DROP:
            props.pop(k, None)


# -----------------------------------------------------------------------------
# ROUTES
# -----------------------------------------------------------------------------
@app.route("/", methods=["GET"])
def index():
    weights = session.get("weights", DEFAULT_WEIGHTS)

    criteria_meta = []
    for k in CRITERIA:
        criteria_meta.append(
            {
                "key": k,
                "label": LABEL_MAP.get(k, k),
                "value": weights.get(k, DEFAULT_WEIGHTS[k]),
            }
        )

    return render_template(
        "index.html",
        criteria_keys=CRITERIA,
        criteria_meta=criteria_meta,
        weights=weights,
        project_title=os.environ.get("PROJECT_TITLE", "West Valley Active Transportation Plan"),
        weight_min=0,
        weight_max=10,
        weight_step=0.5,
    )


@app.route("/revise_weights", methods=["POST"])
def revise_weights():
    # Capture "last run" weights before overwriting
    current = session.get("weights", DEFAULT_WEIGHTS)
    session["prev_weights"] = current

    weights = _parse_weights(request.form)
    session["weights"] = weights

    return jsonify(ok=True, weights=weights, prev_weights=session.get("prev_weights"))


@app.route("/api/network_geojson.geojson", methods=["GET"])
def network_geojson():
    """
    Returns dynamically reweighted FeatureCollection.

    Core outputs (map + popup):
      - Priority_Score_Norm              = sum(<crit>_norm_score_network)
      - Priority_Score_Composition       = sum(<crit>_norm_score_composition)
      - Priority_Score_Scaled            = min-max scale Priority_Score_Norm to [0,1]

      - Difference_Raw                   = current Priority_Score_Norm - last-run Priority_Score_Norm
      - Difference_Score                 = min-max normalize Difference_Raw to [-1,1]

    Also includes per-criterion fields:
      - <crit>_input
      - <crit>_weight
      - <crit>_score
      - <crit>_network_max_score
      - <crit>_norm_score_network
      - <crit>_norm_score_composition

    Export/download additions:
      - <crit>_score_diff
      - <crit>_norm_score_network_diff
      - <crit>_norm_score_composition_diff

    And removes original source score columns (e.g., Strava_Score, etc.).
    """
    weights = session.get("weights", DEFAULT_WEIGHTS)
    prev_weights = session.get("prev_weights", weights)  # first load => no difference

    base_fc = _load_geojson(BASE_GEOJSON_PATH)
    feats = base_fc.get("features", []) or []

    # ---- current fields ----
    current_fields_list: List[Dict[str, Any]] = []
    current_weight_sums: List[float] = []
    for feat in feats:
        props = feat.get("properties") or {}
        fields, weight_sum = _compute_per_feature_fields(props, weights)
        current_fields_list.append(fields)
        current_weight_sums.append(weight_sum)

    _add_network_max_and_norm(current_fields_list)

    current_priority_norm = [_priority_norm_sum(f) for f in current_fields_list]
    current_priority_comp = [_priority_composition_sum(f) for f in current_fields_list]
    current_priority_scaled = _scale_0_1(current_priority_norm)

    # ---- previous (last-run) fields ----
    prev_fields_list: List[Dict[str, Any]] = []
    for feat in feats:
        props = feat.get("properties") or {}
        fields, _ = _compute_per_feature_fields(props, prev_weights)
        prev_fields_list.append(fields)

    _add_network_max_and_norm(prev_fields_list)

    prev_priority_norm = [_priority_norm_sum(f) for f in prev_fields_list]
    prev_priority_comp = [_priority_composition_sum(f) for f in prev_fields_list]

    # ---- differences ----
    diff_raw = [c - p for c, p in zip(current_priority_norm, prev_priority_norm)]
    diff_score = _normalize(diff_raw, -1.0, 1.0) if diff_raw else []

    diff_comp_raw = [c - p for c, p in zip(current_priority_comp, prev_priority_comp)]
    diff_comp_score = _normalize(diff_comp_raw, -1.0, 1.0) if diff_comp_raw else []

    out_fc = {
        "type": "FeatureCollection",
        "name": base_fc.get("name", "network"),
        "crs": base_fc.get("crs"),
        "features": [],
    }

    for i, feat in enumerate(feats):
        props = (feat.get("properties") or {}).copy()

        # remove original source score fields (Strava_Score, etc.)
        _drop_source_scores(props)

        # rollup
        props["Weight_Sum"] = current_weight_sums[i] if i < len(current_weight_sums) else 0.0

        # priority scores used by map/popup
        props["Priority_Score_Norm"] = current_priority_norm[i] if i < len(current_priority_norm) else 0.0
        props["Priority_Score_Composition"] = (
            current_priority_comp[i] if i < len(current_priority_comp) else 0.0
        )
        props["Priority_Score_Scaled"] = (
            current_priority_scaled[i] if i < len(current_priority_scaled) else 0.0
        )

        # differences (norm-based)
        props["Difference_Raw"] = diff_raw[i] if i < len(diff_raw) else 0.0
        props["Difference_Score"] = diff_score[i] if i < len(diff_score) else 0.0

        # differences (composition-based) useful for download/export
        props["Difference_Composition_Raw"] = diff_comp_raw[i] if i < len(diff_comp_raw) else 0.0
        props["Difference_Composition_Score"] = (
            diff_comp_score[i] if i < len(diff_comp_score) else 0.0
        )

        # per-criterion computed fields (current)
        props.update(current_fields_list[i])

        # per-criterion diffs for export/download
        props.update(_criterion_diffs(current_fields_list[i], prev_fields_list[i]))

        out_fc["features"].append(
            {
                "type": "Feature",
                "geometry": feat.get("geometry"),
                "properties": props,
            }
        )

    resp = Response(json.dumps(out_fc), mimetype="application/json")
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    resp.headers["Pragma"] = "no-cache"
    return resp


@app.route("/health", methods=["GET"])
def health():
    return jsonify(
        ok=True,
        base_geojson_exists=os.path.exists(BASE_GEOJSON_PATH),
        base_geojson_path=BASE_GEOJSON_PATH,
        has_prev_weights=("prev_weights" in session),
    )


if __name__ == "__main__":
    # If you run into port collisions / intercepts, change port (e.g., 5055)
    app.run(host="127.0.0.1", port=5000, debug=True)
