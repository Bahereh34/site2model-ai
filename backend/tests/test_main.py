from pyproj import Transformer
from fastapi import HTTPException
import pytest

import main
from main import height_for, parse_osm, UMD_CENTER, GenerateRequest


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
