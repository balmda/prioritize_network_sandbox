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

# --- Criteria (edit these per project) ---
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

# Nice labels for UI (optional)
CRITERIA_LABELS: Dict[str, str] = {
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

PROJECT_TITLE = os.environ.get("PROJECT_TITLE", "West Valley Active Transportation Plan")

# Slider scale: 0–10, step 0.5 (frontend enforces; backend clamps)
DEFAULT_WEIGHTS: Dict[str, float] = {k: 5.0 for k in CRITERIA}

# Baseline used for diffs (you can set this however you like)
BASELINE_WEIGHTS: Dict[str, float] = DEFAULT_WEIGHTS.copy()

# Map slider names -> raw input property names in your source GeoJSON
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

# Raw input fields to remove from export/download
RAW_SCORE_FIELDS_TO_DROP = set(FIELD_MAP.values())


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
    Parse slider weights (0–10). Falls back to session prior values/defaults.
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
    """
    Min-max normalize list -> [out_min, out_max].
    Used for Difference_Score in [-1, 1].
    """
    if not values:
        return []
    vmin, vmax = min(values), max(values)
    if vmax == vmin:
        # if domain spans 0, flat values map to 0 for interpretability
        if out_min < 0 < out_max:
            return [0.0 for _ in values]
        return [out_min for _ in values]
    scale = (out_max - out_min) / (vmax - vmin)
    return [out_min + (v - vmin) * scale for v in values]


def _compute_weighted_avg_with_fields(
    props: Dict[str, Any], weights: Dict[str, float]
) -> Tuple[float, float, Dict[str, Any], List[str]]:
    """
    Per-feature computation.

    Returns:
      - priority_score: weighted average of inputs (same scale as input scores)
      - weight_sum: sum of weights (denominator)
      - per_fields: per-criterion fields (input/weight/weighted + composition norm)
      - missing: raw fields not found in source properties
    """
    num = 0.0
    den = 0.0
    missing: List[str] = []
    per_fields: Dict[str, Any] = {}

    # 1) compute weighted contributions and the weighted-average numerator/denominator
    for crit in CRITERIA:
        prop_key = FIELD_MAP.get(crit, crit)
        if prop_key not in props:
            missing.append(prop_key)

        x = _safe_float(props.get(prop_key, 0.0), default=0.0)  # input score
        w = _safe_float(weights.get(crit, 0.0), default=0.0)    # weight

        weighted = w * x
        if w > 0:
            num += weighted
            den += w

        per_fields[f"{crit}_input"] = x
        per_fields[f"{crit}_weight"] = w
        per_fields[f"{crit}_weighted"] = weighted  # "Score"

    # 2) composition normalization (within-segment contribution on same units as Priority Score)
    if den > 0:
        for crit in CRITERIA:
            per_fields[f"{crit}_norm_score_composition"] = per_fields[f"{crit}_weighted"] / den
    else:
        for crit in CRITERIA:
            per_fields[f"{crit}_norm_score_composition"] = 0.0

    priority_score = (num / den) if den > 0 else 1.0
    return priority_score, den, per_fields, missing


def _add_network_norm_fields(per_fields_list: List[Dict[str, Any]]) -> None:
    """
    Adds per-criterion:
      - <crit>_network_max_score  max(Score) across the network for that criterion
      - <crit>_norm_score_network Score / network_max_score   (0..1)
    """
    network_max_by_crit: Dict[str, float] = {crit: 0.0 for crit in CRITERIA}

    # compute network max per criterion
    for fields in per_fields_list:
        for crit in CRITERIA:
            v = _safe_float(fields.get(f"{crit}_weighted", 0.0), default=0.0)
            if v > network_max_by_crit[crit]:
                network_max_by_crit[crit] = v

    # attach max and normalized values
    for fields in per_fields_list:
        for crit in CRITERIA:
            max_v = network_max_by_crit.get(crit, 0.0)
            fields[f"{crit}_network_max_score"] = max_v
            score_v = _safe_float(fields.get(f"{crit}_weighted", 0.0), default=0.0)
            fields[f"{crit}_norm_score_network"] = (score_v / max_v) if max_v > 0 else 0.0


def _add_differences(current_list: List[Dict[str, Any]], baseline_list: List[Dict[str, Any]]) -> None:
    """
    Adds per-criterion differences (current - baseline):
      - <crit>_diff_weighted
      - <crit>_diff_norm_score_network
      - <crit>_diff_norm_score_composition
    """
    for cur, base in zip(current_list, baseline_list):
        for crit in CRITERIA:
            cur_w = _safe_float(cur.get(f"{crit}_weighted", 0.0))
            base_w = _safe_float(base.get(f"{crit}_weighted", 0.0))
            cur[f"{crit}_diff_weighted"] = cur_w - base_w

            cur_nn = _safe_float(cur.get(f"{crit}_norm_score_network", 0.0))
            base_nn = _safe_float(base.get(f"{crit}_norm_score_network", 0.0))
            cur[f"{crit}_diff_norm_score_network"] = cur_nn - base_nn

            cur_nc = _safe_float(cur.get(f"{crit}_norm_score_composition", 0.0))
            base_nc = _safe_float(base.get(f"{crit}_norm_score_composition", 0.0))
            cur[f"{crit}_diff_norm_score_composition"] = cur_nc - base_nc


@app.route("/", methods=["GET"])
def index():
    weights = session.get("weights", DEFAULT_WEIGHTS)

    criteria_meta = []
    for k in CRITERIA:
        criteria_meta.append(
            {
                "key": k,
                "label": CRITERIA_LABELS.get(k, k),
                "value": weights.get(k, DEFAULT_WEIGHTS[k]),
            }
        )

    return render_template(
        "index.html",
        project_title=PROJECT_TITLE,
        criteria_keys=CRITERIA,     # becomes window.CRITERIA in the template
        criteria_meta=criteria_meta # drives Jinja slider loop
    )


@app.route("/revise_weights", methods=["POST"])
def revise_weights():
    weights = _parse_weights(request.form)
    session["weights"] = weights
    return jsonify(ok=True, weights=weights)


@app.route("/api/network_geojson.geojson", methods=["GET"])
def network_geojson():
    """
    Returns dynamically reweighted FeatureCollection for map + download.

    Per criterion:
      - <crit>_input
      - <crit>_weight
      - <crit>_weighted
      - <crit>_network_max_score
      - <crit>_norm_score_network
      - <crit>_norm_score_composition
      - diffs vs baseline for each of the above:
        <crit>_diff_weighted
        <crit>_diff_norm_score_network
        <crit>_diff_norm_score_composition

    Adds rollups:
      - Priority_Score               weighted average on input scale
      - Priority_Score_Norm          sum of norm_score_network across criteria
      - Priority_Score_Composition   sum of norm_score_composition across criteria (== Priority_Score)
      - Difference_Score             normalized to [-1,1] vs baseline Priority_Score
      - Weight_Sum
    """
    weights = session.get("weights", DEFAULT_WEIGHTS)
    base_fc = _load_geojson(BASE_GEOJSON_PATH)
    feats = base_fc.get("features", []) or []

    # Current
    scores_current: List[float] = []
    dens_current: List[float] = []
    current_fields_list: List[Dict[str, Any]] = []

    # Baseline
    scores_base: List[float] = []
    dens_base: List[float] = []
    base_fields_list: List[Dict[str, Any]] = []

    # Compute current + baseline per-feature
    for feat in feats:
        props = feat.get("properties") or {}

        sc, den, fields, _missing = _compute_weighted_avg_with_fields(props, weights)
        scores_current.append(sc)
        dens_current.append(den)
        current_fields_list.append(fields)

        sb, denb, fieldsb, _missingb = _compute_weighted_avg_with_fields(props, BASELINE_WEIGHTS)
        scores_base.append(sb)
        dens_base.append(denb)
        base_fields_list.append(fieldsb)

    # Add network normalization to both lists, then add diffs
    _add_network_norm_fields(current_fields_list)
    _add_network_norm_fields(base_fields_list)
    _add_differences(current_fields_list, base_fields_list)

    # Rollups based on network norm and composition norm
    priority_score_norm_list: List[float] = []
    priority_score_composition_list: List[float] = []

    for fields in current_fields_list:
        s_norm = 0.0
        s_comp = 0.0
        for crit in CRITERIA:
            s_norm += _safe_float(fields.get(f"{crit}_norm_score_network", 0.0), 0.0)
            s_comp += _safe_float(fields.get(f"{crit}_norm_score_composition", 0.0), 0.0)
        priority_score_norm_list.append(s_norm)
        priority_score_composition_list.append(s_comp)

    # Overall difference layer (normalized to [-1,1]) vs baseline Priority_Score
    diffs_overall = [c - b for c, b in zip(scores_current, scores_base)]
    diff_scores = _normalize(diffs_overall, -1.0, 1.0) if diffs_overall else []

    out_fc = {
        "type": "FeatureCollection",
        "name": base_fc.get("name", "network"),
        "crs": base_fc.get("crs"),
        "features": [],
    }

    for i, feat in enumerate(feats):
        base_props = (feat.get("properties") or {}).copy()

        # Drop raw input score columns from export/download
        for k in list(base_props.keys()):
            if k in RAW_SCORE_FIELDS_TO_DROP:
                base_props.pop(k, None)

        # Core totals
        base_props["Priority_Score"] = scores_current[i] if i < len(scores_current) else 1.0
        base_props["Priority_Score_Norm"] = priority_score_norm_list[i] if i < len(priority_score_norm_list) else 0.0
        base_props["Priority_Score_Composition"] = (
            priority_score_composition_list[i] if i < len(priority_score_composition_list) else base_props["Priority_Score"]
        )
        base_props["Difference_Score"] = diff_scores[i] if i < len(diff_scores) else 0.0
        base_props["Weight_Sum"] = dens_current[i] if i < len(dens_current) else 0.0

        # Add per-criterion fields (includes both norms + diffs)
        base_props.update(current_fields_list[i])

        out_fc["features"].append(
            {
                "type": "Feature",
                "geometry": feat.get("geometry"),
                "properties": base_props,
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
        criteria=CRITERIA,
    )


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
