# Site2Model AI — Geoapify + OSM + user-owned photo façade MVP

This is an updated version of the working image-and-address application. There is **no Google Maps API**.

## What works

1. **Address → 3D urban context:** Geoapify geocodes a non-demo address; OpenStreetMap Overpass supplies building footprints and roads; optional OpenTopoData SRTM supplies coarse terrain. The preconfigured University of Maryland anchor works without Geoapify.
2. **Select an OSM building:** Click a building in the 3D site viewer. Selected buildings appear orange.
3. **Add your own photographs:** Choose up to eight JPG/PNG/WebP images, each <=8 MB. Select one photograph for a façade preview.
4. **Visual façade attachment:** Use quick non-AI grayscale relief or optional local AI depth inference. The app positions a textured depth panel on the **longest edge** of the selected building's OSM footprint and retains the neighborhood model. Orbit and inspect; export GLB with the attached panel and a JSON with geospatial metadata.
5. **Standalone image relief** remains available as a separate tab.

**Crucial limitations:** Photographs are *not* automatically matched to the correct building edge or camera orientation. The panel has no metric depth calibration and its alignment is a visual assumption. Multiple photographs are accepted for manual selection, **not fused** into a calibrated multiview reconstruction. A complete building reconstruction would require camera calibration, overlapping coverage and photogrammetry or multi-view 3D AI, plus explicit alignment. This MVP does not claim to generate unseen façades or a watertight building. Avoid processing Google Street View screenshots for derivative geometry; use user-owned/authorized images.

## Windows / VS Code quick start

Extract the ZIP. Open the nested `site2model-ai` folder in VS Code, **not the outer ZIP extraction folder**.

**Terminal 1** (from `site2model-ai`):

```powershell
cd backend
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

**Terminal 2** (from `site2model-ai`):

```powershell
cd frontend
npm.cmd install
npm.cmd run dev
```

Visit http://127.0.0.1:5173 (the Vite server listens at 127.0.0.1 by default).

To geocode arbitrary addresses, copy `backend/.env.example` to `backend/.env` and replace the blank value with your private key:

```dotenv
GEOAPIFY_API_KEY=your_private_key_here
```

The backend already loads this file. `.gitignore` prevents `.env` from being committed. **Do not add the Geoapify key to the frontend.**

Overpass building and road data uses several public mirrors. If all mirrors are temporarily unavailable, `OSM_ALLOW_EMPTY_FALLBACK=true` lets the geocoded site and terrain load without showing geometry from a different address; cached OSM data is still preferred whenever available. Set it to `false` if a hard failure is required.

### Optional AI depth mode (larger download)

Use a Python version supported by your PyTorch build (Python 3.11 or 3.12 generally recommended for this project), then in `backend`:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-ai.txt
```

The model `depth-anything/Depth-Anything-V2-Small-hf` downloads on first request, which needs network connectivity. In quick relief mode the backend does not use an AI depth model. **Relative depth does not equal calibrated metric distance.**

## Data ownership and export

Geoapify, OpenStreetMap and OpenTopoData provide geocoding and geographic context. Their respective usage, attribution, and data licenses apply. The browser sends only the chosen photograph to the local FastAPI server for the depth endpoint; this demo does not store photos persistently. The exported GLB includes your selected photo as a texture; only export photos for which you have sufficient rights.

The frontend proxies `/api` to the backend through Vite. **Do not publish the development backend without production safeguards** (authentication, HTTPS, request limits, privacy policy).

## Next stage: genuine multi-view reconstruction

A future reconstruction worker can take 15–50+ overlapping authorized photos, recover cameras via photogrammetry (such as COLMAP), generate a textured point cloud/mesh, then register it to the OSM footprint by control points. It should report scale and confidence, and leave missing or unverifiable geometry blank or visibly inferred. This workflow is not in the current MVP.


## Offline-resilient OSM cache (update)

Successful building/road data is saved in `backend/.osm_cache/`. Requests use cached data for 30 days by default (`OSM_CACHE_SECONDS=2592000`); if all public Overpass servers fail later, the backend uses the older saved response for exactly the same coordinates, radius, and building/road layer selection. Terrain still depends on its own live service. Do not delete `.osm_cache` if you want to reuse sites offline. The cache does not help with a site that has never downloaded successfully. The server logs a warning when stale data is used, and saved data may not reflect recent edits to OSM.
