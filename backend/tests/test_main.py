from pyproj import Transformer
from fastapi import HTTPException
import pytest

import main
from main import height_for, parse_osm, UMD_CENTER, GenerateRequest, FocusAnalysisRequest, SimulationRequest


def test_heights():
    assert height_for({"height": "12m"}) == (12, "osm_height")
    assert height_for({"height": "10 ft"}) == (3.048, "osm_height")
    assert height_for({"building:levels": "3"}) == (9.600000000000001, "estimated_from_levels")
    assert height_for({}) == (None, "unknown")


def test_osm_parsing():
    t = Transformer.from_crs("EPSG:4326", "EPSG:32618", always_xy=True)
    lat, lon = UMD_CENTER
    x, y = t.transform(lon, lat)
    poly = [
        {"lat": lat, "lon": lon}, {"lat": lat, "lon": lon + 0.0001},
        {"lat": lat + 0.0001, "lon": lon + 0.0001},
        {"lat": lat + 0.0001, "lon": lon}, {"lat": lat, "lon": lon},
    ]
    bs, rs = parse_osm([{"id": 1, "tags": {"building": "yes"}, "geometry": poly}], t, x, y)
    assert len(bs) == 1 and len(rs) == 0
    assert len(bs[0]["outline"]) == 4


def test_request_defaults():
    req = GenerateRequest()
    assert req.radius_m == 500 and req.buildings and req.roads and req.terrain


def test_umd_preset_does_not_require_geoapify_key(monkeypatch):
    monkeypatch.setattr(main, "GEOAPIFY_API_KEY", "")
    assert main.geocode("University of Maryland, College Park")[0:2] == UMD_CENTER


def test_arbitrary_address_requires_geoapify_key(monkeypatch):
    monkeypatch.setattr(main, "GEOAPIFY_API_KEY", "")
    with pytest.raises(HTTPException, match="GEOAPIFY_API_KEY"):
        main.geocode("1600 Pennsylvania Avenue NW, Washington, DC")


def test_focused_polygon_analysis(monkeypatch):
    monkeypatch.setattr(main, "current_wind", lambda lat, lon: {"status": "available", "direction_deg": 180, "speed_kmh": 5})
    request = FocusAnalysisRequest(
        model={"location": {"lat": UMD_CENTER[0], "lon": UMD_CENTER[1], "radius_m": 500}, "buildings": []},
        scope="area", polygon=[[-20, -20], [20, -20], [20, 20], [-20, 20]], grid_size=8,
    )
    result = main.analyze_focused(request)
    assert result["status"] == "completed" and len(result["solar"]["cells"]) == 64


def test_simulation_without_weather_returns_json_status(monkeypatch):
    monkeypatch.setenv("WEATHER_EPWS_DIR", "definitely-missing-weather-folder")
    result = main.simulate(SimulationRequest(model={"location": {}, "buildings": []}))
    assert result["status"] == "unavailable"
    assert result["energyplus"]["status"] == "unavailable"
