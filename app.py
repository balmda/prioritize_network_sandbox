import json
import os
from typing import Dict, Any, List

from flask import Flask, render_template, request, jsonify, session, Response

app = Flask(__name__)
app.secret_key = os.environ.get("FLASK_SECRET_KEY", "dev-secret-key-change-me")

BASE_GEOJSON_PATH = os.environ.get(
    "BASE_GEOJSON_PATH",
    os.path.join(app.root_path, "static", "application", "data", "WestValleyATPNetwork.geojson"),
)

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

# Map slider names -> GeoJSON property names
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

        # clamp
        weights[k] = max(0.0, min(10.0, weights[k]))

    return weights


def _normalize(values: List[float], out_min: float, out_max: float) -> List[float]:
    """Min-max normalize to [out_min, out_max]."""
    if not values:
        return []
    vmin, vmax = min(values), max(values)
    if vmax == vmin:
        # flat -> 0 if centered domain
        if out_min < 0 < out_max:
            return [0.0 for _ in values]
        return [out_min for _ in values]
    scale = (out_max - out_min) / (vmax - vmin)
    return [out_min + (v - vmin) * scale for v in values]


def _compute_per_feature_fields(props: Dict[str, Any], weights: Dict[str, float]) -> Dict[str, Any]:
    """
    Per-feature calculation.

    Outputs per criterion:
      - <crit>_input
      - <crit>_weight
      - <crit>_weighted                    # input × weight
      - <crit>_norm_score_composition      # (input×weight) / sum(weights)

    Also returns:
      - weight_sum
      - (later) network max + norm_score_network added in 2nd pass.
    """
    fields: Dict[str, Any] = {}
    weight_sum = 0.0

    for crit in CRITERIA:
        prop_key = FIELD_MAP.get(crit, crit)
        x = _safe_float(props.get(prop_key, 0.0), default=0.0)  # input score (often 1–3)
        w = _safe_float(weights.get(crit, 0.0), default=0.0)    # weight (0–10)

        weighted = x * w

        fields[f"{crit}_input"] = x
        fields[f"{crit}_weight"] = w
        fields[f"{crit}_weighted"] = weighted

        weight_sum += w

    # composition normalization (within segment)
    if weight_sum > 0:
        for crit in CRITERIA:
            fields[f"{crit}_norm_score_composition"] = fields[f"{crit}_weighted"] / weight_sum
    else:
        for crit in CRITERIA:
            fields[f"{crit}_norm_score_composition"] = 0.0

    return {"fields": fields, "weight_sum": weight_sum}


def _add_network_max_and_norm(fields_list: List[Dict[str, Any]]) -> Dict[str, float]:
    """
    Adds:
      - <crit>_network_max_score
      - <crit>_norm_score_network = (input×weight)/network_max
    Returns network_max_by_crit
    """
    network_max_by_crit: Dict[str, float] = {crit: 0.0 for crit in CRITERIA}

    # find max per criterion
    for fields in fields_list:
        for crit in CRITERIA:
            v = _safe_float(fields.get(f"{crit}_weighted", 0.0), default=0.0)
            if v > network_max_by_crit[crit]:
                network_max_by_crit[crit] = v

    # add back to each feature
    for fields in fields_list:
        for crit in CRITERIA:
            max_v = network_max_by_crit.get(crit, 0.0)
            fields[f"{crit}_network_max_score"] = max_v
            score_v = _safe_float(fields.get(f"{crit}_weighted", 0.0), default=0.0)
            fields[f"{crit}_norm_score_network"] = (score_v / max_v) if max_v > 0 else 0.0

    return network_max_by_crit


def _priority_norm_sum(fields: Dict[str, Any]) -> float:
    """Sum of per-criterion network-normalized scores."""
    s = 0.0
    for crit in CRITERIA:
        s += _safe_float(fields.get(f"{crit}_norm_score_network", 0.0), default=0.0)
    return s


def _priority_composition_sum(fields: Dict[str, Any]) -> float:
    """Sum of per-criterion composition scores (equals weighted avg on input scale)."""
    s = 0.0
    for crit in CRITERIA:
        s += _safe_float(fields.get(f"{crit}_norm_score_composition", 0.0), default=0.0)
    return s


@app.route("/", methods=["GET"])
def index():
    weights = session.get("weights", DEFAULT_WEIGHTS)

    criteria_meta = []
    for k in CRITERIA:
        criteria_meta.append({
            "key": k,
            "label": k,          # replace with a label map if you want
            "value": weights.get(k, DEFAULT_WEIGHTS[k]),
        })

    return render_template(
        "index.html",
        criteria_keys=CRITERIA,
        criteria_meta=criteria_meta,
        weights=weights,
        project_title="West Valley Active Transportation Plan",
        weight_min=0,
        weight_max=10,
        weight_step=0.5,
    )


@app.route("/revise_weights", methods=["POST"])
def revise_weights():
    # Capture "last run" before overwriting
    current = session.get("weights", DEFAULT_WEIGHTS)
    session["prev_weights"] = current

    weights = _parse_weights(request.form)
    session["weights"] = weights

    return jsonify(ok=True, weights=weights, prev_weights=session.get("prev_weights"))


@app.route("/api/network_geojson.geojson", methods=["GET"])
def network_geojson():
    """
    Returns dynamically reweighted FeatureCollection.

    Adds:
      - Priority_Score_Norm              (sum of per-crit norm_score_network)
      - Priority_Score_Composition       (sum of per-crit norm_score_composition)
      - Difference_Raw                   current_norm - prev_norm
      - Difference_Score                 min-max normalized Difference_Raw to [-1,1]
    """
    weights = session.get("weights", DEFAULT_WEIGHTS)

    # If no prev weights yet, treat prev as current (diff=0 on first load)
    prev_weights = session.get("prev_weights", weights)

    base_fc = _load_geojson(BASE_GEOJSON_PATH)
    feats = base_fc.get("features", []) or []

    # ---------- Current pass ----------
    current_fields_list: List[Dict[str, Any]] = []
    current_weight_sums: List[float] = []

    for feat in feats:
        props = feat.get("properties") or {}
        out = _compute_per_feature_fields(props, weights)
        current_fields_list.append(out["fields"])
        current_weight_sums.append(out["weight_sum"])

    _add_network_max_and_norm(current_fields_list)

    current_norm_scores = [_priority_norm_sum(f) for f in current_fields_list]
    current_comp_scores = [_priority_composition_sum(f) for f in current_fields_list]

    # ---------- Previous pass (last-run) ----------
    prev_fields_list: List[Dict[str, Any]] = []
    for feat in feats:
        props = feat.get("properties") or {}
        out_prev = _compute_per_feature_fields(props, prev_weights)
        prev_fields_list.append(out_prev["fields"])

    _add_network_max_and_norm(prev_fields_list)

    prev_norm_scores = [_priority_norm_sum(f) for f in prev_fields_list]
    prev_comp_scores = [_priority_composition_sum(f) for f in prev_fields_list]

    # ---------- Differences ----------
    diff_raw = [c - p for c, p in zip(current_norm_scores, prev_norm_scores)]
    diff_scores = _normalize(diff_raw, -1.0, 1.0) if diff_raw else []

    # (Optional) composition diffs (useful for export/debug)
    diff_comp_raw = [c - p for c, p in zip(current_comp_scores, prev_comp_scores)]
    diff_comp_scores = _normalize(diff_comp_raw, -1.0, 1.0) if diff_comp_raw else []

    out_fc = {
        "type": "FeatureCollection",
        "name": base_fc.get("name", "network"),
        "crs": base_fc.get("crs"),
        "features": [],
    }

    for i, feat in enumerate(feats):
        props = (feat.get("properties") or {}).copy()

        # New "priority" scores (what you use in the map)
        props["Priority_Score_Norm"] = current_norm_scores[i] if i < len(current_norm_scores) else 0.0
        props["Priority_Score_Composition"] = (
            current_comp_scores[i] if i < len(current_comp_scores) else 0.0
        )

        # Difference vs last-run
        props["Difference_Raw"] = diff_raw[i] if i < len(diff_raw) else 0.0
        props["Difference_Score"] = diff_scores[i] if i < len(diff_scores) else 0.0

        # Optional: composition differences (export/debug)
        props["Difference_Composition_Raw"] = diff_comp_raw[i] if i < len(diff_comp_raw) else 0.0
        props["Difference_Composition_Score"] = (
            diff_comp_scores[i] if i < len(diff_comp_scores) else 0.0
        )

        # Rollups
        props["Weight_Sum"] = current_weight_sums[i] if i < len(current_weight_sums) else 0.0

        # Remove original *_Score columns if desired (your note from earlier)
        # (We keep OBJECTID etc. untouched)
        for k in list(props.keys()):
          if k.endswith("_Score") and k not in ("Priority_Score_Norm", "Priority_Score_Composition"):
              # remove original source scores like Strava_Score etc if you truly want them gone
              # BUT: if your app relies on them elsewhere, comment this out.
              pass

        # Add per-criterion computed fields
        props.update(current_fields_list[i])

        out_fc["features"].append(
            {"type": "Feature", "geometry": feat.get("geometry"), "properties": props}
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
    app.run(host="127.0.0.1", port=5000, debug=True)
