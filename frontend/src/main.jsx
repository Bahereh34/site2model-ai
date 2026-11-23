import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Grid, Line } from '@react-three/drei';
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import './style.css';

const DEFAULT_ADDRESS = 'University of Maryland, College Park';

async function readApiResponse(response) {
  const body = await response.text();
  let data = null;
  try { data = body ? JSON.parse(body) : null; } catch { /* handled below with a useful status */ }
  if (!data) throw new Error(`Server returned an empty or non-JSON response (HTTP ${response.status})${body ? `: ${body.slice(0,180)}` : '. Restart the backend if this endpoint was added recently.'}`);
  return data;
}

function terrainHeight(terrain, east, north) {
  if (!terrain || terrain.status === 'disabled') return 0;
  const { n, radius_m: r, elevations_m: h } = terrain;
  const x = Math.max(0, Math.min(n - 1, (east + r) / (2 * r) * (n - 1)));
  const y = Math.max(0, Math.min(n - 1, (north + r) / (2 * r) * (n - 1)));
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(n - 1, x0 + 1), y1 = Math.min(n - 1, y0 + 1);
  const a = x - x0, b = y - y0;
  return (1-a)*(1-b)*h[y0*n+x0] + a*(1-b)*h[y0*n+x1] + (1-a)*b*h[y1*n+x0] + a*b*h[y1*n+x1];
}

function Terrain({ data, visible }) {
  const geometry = useMemo(() => {
    if (!data) return null;
    const { n, radius_m: r, elevations_m: heights } = data;
    const positions = [], indices = [];
    for (let row=0; row<n; row++) for (let col=0; col<n; col++) {
      positions.push(-r + col*2*r/(n-1), heights[row*n+col], -(-r + row*2*r/(n-1)));
    }
    for (let row=0; row<n-1; row++) for (let col=0; col<n-1; col++) {
      const a=row*n+col, b=a+1, c=a+n, d=c+1;
      indices.push(a,c,b, b,c,d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setIndex(indices); g.computeVertexNormals();
    return g;
  }, [data]);
  if (!visible || !geometry) return null;
  return <mesh geometry={geometry} receiveShadow><meshStandardMaterial color="#b3c4b4" side={THREE.DoubleSide} roughness={1} /></mesh>;
}

function Building({ building, terrain, heightFallback, selected, onSelect }) {
  const geometry = useMemo(() => {
    if (building.outline.length < 3) return null;
    const outline = building.outline;
    const points = outline.map(([x,north]) => new THREE.Vector2(x, north));
    const shape = new THREE.Shape(points);
    // Clockwise and counter-clockwise closed ways are both supported by THREE.Shape.
    const height = building.height_m ?? heightFallback;
    const g = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, steps: 1, curveSegments: 1 });
    g.rotateX(-Math.PI/2);
    const [sumX,sumN] = outline.reduce(([a,b],p)=>[a+p[0],b+p[1]],[0,0]);
    const ground = terrainHeight(terrain, sumX/outline.length, sumN/outline.length);
    g.translate(0, ground, 0);
    return g;
  }, [building, terrain, heightFallback]);
  if (!geometry) return null;
  return <mesh geometry={geometry} onClick={(e)=>{e.stopPropagation();onSelect(building);}} castShadow receiveShadow>
    <meshStandardMaterial color={selected ? '#ec9b54' : building.height_m === null ? '#e5ddce' : '#f5f4ee'} roughness={0.92}/>
  </mesh>;
}

function Roads({ roads, terrain }) {
  return <group>{roads.map((road) => {
    const positions = road.path.map(([x,north])=>[x, terrainHeight(terrain,x,north)+0.65, -north]);
    if (positions.length < 2) return null;
    const pedestrian = ['footway','path','pedestrian','steps','cycleway','bridleway'].includes(road.type);
    const major = ['motorway','trunk','primary','secondary'].includes(road.type);
    const quality = ['excellent','good','intermediate'].includes(road.smoothness) || ['asphalt','concrete','paving_stones'].includes(road.surface);
    const color = pedestrian ? (quality ? '#d79c55' : '#b77b5b') : major ? '#465b68' : quality ? '#718894' : '#9b8f83';
    const width = pedestrian ? 1.7 : major ? 4.2 : 2.8;
    return <group key={road.id}><Line points={positions} color={color} lineWidth={width} dashed={pedestrian && !quality} dashSize={3} gapSize={2} />
      {!pedestrian && road.sidewalk !== 'no' && <Line points={positions} color="#d4c7a7" lineWidth={0.8} transparent opacity={.8} />}
    </group>;
  })}</group>;
}

function solarIntensity(hour) {
  const daylight = Math.max(0, Math.sin((hour - 6) / 12 * Math.PI));
  const orientation = 0.7 + 0.3 * Math.cos((hour - 12) / 6 * Math.PI);
  return Math.max(0.08, daylight * orientation);
}

function solarColor(value) {
  const color = new THREE.Color();
  color.setHSL(0.68 - Math.max(0, Math.min(1, value)) * 0.68, 0.85, 0.52);
  return color;
}

function solarPosition(latitude, hour, date = new Date()) {
  const start = new Date(date.getFullYear(), 0, 0);
  const day = Math.floor((date - start) / 86400000);
  const declination = 23.44 * Math.sin((2 * Math.PI * (day - 81)) / 365) * Math.PI / 180;
  const lat = latitude * Math.PI / 180;
  const hourAngle = (hour - 12) * 15 * Math.PI / 180;
  const altitude = Math.asin(Math.sin(lat)*Math.sin(declination) + Math.cos(lat)*Math.cos(declination)*Math.cos(hourAngle));
  const azimuth = Math.atan2(Math.sin(hourAngle), Math.cos(hourAngle)*Math.sin(lat) - Math.tan(declination)*Math.cos(lat)) + Math.PI;
  return { altitude, azimuth };
}

function SunPath({ model, visible, hour }) {
  const path = useMemo(() => {
    if (!model?.location) return null;
    const radius = model.location.radius_m || 500;
    const points = [];
    for (let h=4; h<=20; h+=.25) {
      const sun = solarPosition(model.location.lat, h);
      const horizontal = Math.cos(sun.altitude) * radius * .72;
      points.push([Math.sin(sun.azimuth)*horizontal, Math.max(2, Math.sin(sun.altitude)*radius*.62+3), -Math.cos(sun.azimuth)*horizontal]);
    }
    const current = solarPosition(model.location.lat, hour);
    const horizontal = Math.cos(current.altitude) * radius * .72;
    const marker = [Math.sin(current.azimuth)*horizontal, Math.max(2, Math.sin(current.altitude)*radius*.62+3), -Math.cos(current.azimuth)*horizontal];
    return {points, marker};
  }, [model, hour]);
  if (!visible || !path) return null;
  return <group><Line points={path.points} color="#f2a33b" lineWidth={2.5} transparent opacity={.85}/><mesh position={path.marker}><sphereGeometry args={[8,16,12]}/><meshBasicMaterial color="#ffd35a"/></mesh></group>;
}

function SolarHeatmap({ radius, visible, hour }) {
  const cells = useMemo(() => {
    const count = 22;
    const cell = radius * 2 / count;
    const peak = solarIntensity(hour);
    return Array.from({length:count*count}, (_, index) => {
      const row = Math.floor(index/count), col = index % count;
      const east = -radius + (col + .5) * cell;
      const north = -radius + (row + .5) * cell;
      const distanceFade = 0.82 + 0.18 * Math.cos(Math.hypot(east,north)/radius * Math.PI/2);
      const value = Math.max(0, Math.min(1, peak * distanceFade * (0.84 + 0.16 * Math.sin((east-north)/radius))));
      return {east, north, value};
    });
  }, [radius, hour]);
  if (!visible) return null;
  const cell = radius * 2 / 22;
  return <group>{cells.map((item, index) => <mesh key={index} position={[item.east, .16, -item.north]} rotation={[-Math.PI/2,0,0]}>
    <planeGeometry args={[cell*1.02,cell*1.02]}/>
    <meshBasicMaterial color={solarColor(item.value)} transparent opacity={.32} depthWrite={false}/>
  </mesh>)}</group>;
}

function FocusedSolarHeatmap({ result, visible }) {
  if (!visible || !result?.solar?.cells?.length) return null;
  const bounds = result.bounds_m;
  const count = result.grid_size;
  const cellW = (bounds.max_east - bounds.min_east) / count;
  const cellD = (bounds.max_north - bounds.min_north) / count;
  return <group>{result.solar.cells.map((cell, index) => <mesh key={index} position={[cell.east_m, .42, -cell.north_m]} rotation={[-Math.PI/2,0,0]}>
    <planeGeometry args={[cellW*1.03, cellD*1.03]}/><meshBasicMaterial color={solarColor(Math.min(1, cell.solar_w_m2/1000))} transparent opacity={.62} depthWrite={false}/>
  </mesh>)}</group>;
}

function AreaDrawingSurface({ radius, drawing, points, onAddPoint }) {
  const outline = points.map(([east, north]) => [east, .7, -north]);
  if (!drawing) return null;
  return <group>
    <mesh rotation={[-Math.PI/2,0,0]} position={[0,.5,0]} onPointerDown={event => { event.stopPropagation(); if (event.button === 0) onAddPoint([Number(event.point.x.toFixed(2)), Number((-event.point.z).toFixed(2))]); }}>
      <planeGeometry args={[radius*2, radius*2]}/><meshBasicMaterial transparent opacity={0} depthWrite={false}/>
    </mesh>
    {outline.length > 1 && <Line points={[...outline, outline[0]]} color="#ef8e3d" lineWidth={3}/>} 
    {outline.map((point, index) => <mesh key={index} position={point}><sphereGeometry args={[4,12,8]}/><meshBasicMaterial color="#ef8e3d"/></mesh>)}
  </group>;
}

function WindArrows({ radius, visible, direction }) {
  const arrows = useMemo(() => {
    const count = 5;
    const step = radius * 1.55 / count;
    const angle = direction * Math.PI / 180;
    const vector = new THREE.Vector3(Math.sin(angle), 0, Math.cos(angle));
    return Array.from({length:count*count}, (_, index) => {
      const row=Math.floor(index/count), col=index%count;
      return {position:[-radius*.78+col*step, .55, radius*.78-row*step], vector};
    });
  }, [radius, direction]);
  if (!visible) return null;
  return <group>{arrows.map((arrow,index)=><primitive key={index} object={new THREE.ArrowHelper(arrow.vector, new THREE.Vector3(...arrow.position), radius*.16, '#2b6673', radius*.045, radius*.03)}/>)}</group>;
}

function ShadowOverlay({ model, visible, hour, unknownHeight }) {
  const sunElevation = Math.max(.2, solarIntensity(hour) * Math.PI/2);
  const shadowDirection = (180 + (hour - 12) * 18) * Math.PI / 180;
  const dx = Math.sin(shadowDirection), dz = Math.cos(shadowDirection);
  if (!visible || !model) return null;
  return <group>{model.buildings.map((building) => {
    if (building.outline.length < 3) return null;
    const height = building.height_m ?? unknownHeight;
    const length = Math.min(90, Math.max(3, height / Math.tan(sunElevation)));
    const cx=building.outline.reduce((sum,[x])=>sum+x,0)/building.outline.length;
    const cz=-building.outline.reduce((sum,[,n])=>sum+n,0)/building.outline.length;
    return <mesh key={building.id} position={[cx+dx*length/2,.19,cz+dz*length/2]} rotation={[-Math.PI/2,0,0]}>
      <circleGeometry args={[Math.max(2,length*.42),6]}/>
      <meshBasicMaterial color="#20313a" transparent opacity={.2} depthWrite={false}/>
    </mesh>;
  })}</group>;
}

// An explicitly APPROXIMATE façade-depth panel anchored to one OSM footprint edge.
// It is NOT camera-calibrated, true photogrammetry, or metric reconstruction.
function AnchoredFacade({ building, result, terrain, fallbackHeight, reliefMeters, panelRef }) {
  const edge = useMemo(() => {
    if (!building || !result || building.outline.length < 2) return null;
    const pts = building.outline;
    let best = null;
    for (let i=0;i<pts.length;i++) {
      const a=pts[i], b=pts[(i+1)%pts.length];
      const dx=b[0]-a[0], dz=-(b[1]-a[1]);
      const dist=Math.hypot(dx,dz);
      if (!best || dist>best.len) best={a,b,dx,dz,len:dist};
    }
    return best;
  }, [building,result]);
  const geometry=useMemo(()=>{
    if (!result || !edge) return null;
    const {width:w,height:h,depth}=result;
    const positions=[],uvs=[],indices=[];
    const height=building.height_m??fallbackHeight;
    const imageAspect=w/h;
    let panelHeight=Math.min(height*.92, edge.len/imageAspect);
    let panelWidth=panelHeight*imageAspect;
    if(panelWidth>edge.len*.94){
      panelWidth=edge.len*.94;
      panelHeight=panelWidth/imageAspect;
    }
    const bottomMargin=Math.max(.12,height*.04);
    for(let y=0;y<h;y++) for(let x=0;x<w;x++){
      const depthZ=(depth[y*w+x]/255-.5)*reliefMeters;
      positions.push(((x/(w-1))-.5)*panelWidth,bottomMargin+((1-y/(h-1))*panelHeight),depthZ);
      uvs.push(x/(w-1),1-y/(h-1));
    }
    for(let y=0;y<h-1;y++) for(let x=0;x<w-1;x++){
      const k=y*w+x; indices.push(k,k+w,k+1,k+1,k+w,k+w+1);
    }
    const g=new THREE.BufferGeometry();
    g.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
    g.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));
    g.setIndex(indices);g.computeVertexNormals();return g;
  },[result,edge,building,fallbackHeight,reliefMeters]);
  const texture=useMemo(()=>{
    if(!result)return null;
    const tex=new THREE.TextureLoader().load(result.image_data_url);
    tex.colorSpace=THREE.SRGBColorSpace;
    return tex;
  },[result]);
  useEffect(()=>()=>{geometry?.dispose();texture?.dispose();},[geometry,texture]);
  if(!geometry||!texture||!edge)return null;
  const midpointX=(edge.a[0]+edge.b[0])/2;
  const midpointZ=-(edge.a[1]+edge.b[1])/2;
  const normalX=-edge.dz/edge.len, normalZ=edge.dx/edge.len;
  const baseY=terrainHeight(terrain,(edge.a[0]+edge.b[0])/2,(edge.a[1]+edge.b[1])/2);
  const height=building.height_m??fallbackHeight;
  const imageAspect=result.width/result.height;
  let panelHeight=Math.min(height*.92, edge.len/imageAspect);
  let panelWidth=panelHeight*imageAspect;
  if(panelWidth>edge.len*.94){panelWidth=edge.len*.94;panelHeight=panelWidth/imageAspect;}
  const bottomMargin=Math.max(.12,height*.04);
  return <mesh ref={panelRef} geometry={geometry}
    position={[midpointX+normalX*.16,baseY+bottomMargin+panelHeight/2,midpointZ+normalZ*.16]}
    rotation={[0,Math.atan2(normalX,normalZ),0]}>
    <meshStandardMaterial map={texture} side={THREE.DoubleSide} roughness={.82} metalness={.02}/>
  </mesh>;
}

function Scene({ model, layers, analysisLayers, solarHour, windDirection, unknownHeight, onSelect, selected, sceneRef, facade, panelRef, focusedAnalysis, drawingArea, drawingPoints, onAddAreaPoint }) {
  const radius = model?.location.radius_m || 500;
  const actualWindDirection = model?.wind?.direction_deg ?? windDirection;
  return <Canvas shadows camera={{ position: [radius*0.98, radius*0.95, radius*1.22], fov: 50, near: 0.1, far: 15000 }} onPointerMissed={()=>onSelect(null)}>
    <color attach="background" args={['#dbe6e9']}/>
    <ambientLight intensity={1.4}/><directionalLight position={[250,450,150]} intensity={2.4} castShadow shadow-mapSize={[2048,2048]}/>
    <group ref={sceneRef}>
      {model && <>
        <Terrain data={model.terrain} visible={layers.terrain}/>
        <SolarHeatmap radius={radius} visible={analysisLayers.solar} hour={solarHour}/>
        <FocusedSolarHeatmap result={focusedAnalysis} visible={analysisLayers.solar}/>
        <AreaDrawingSurface radius={radius} drawing={drawingArea} points={drawingPoints} onAddPoint={onAddAreaPoint}/>
        <SunPath model={model} visible={analysisLayers.solar} hour={solarHour}/>
        <WindArrows radius={radius} visible={analysisLayers.wind} direction={actualWindDirection}/>
        <ShadowOverlay model={model} visible={analysisLayers.shadows} hour={solarHour} unknownHeight={unknownHeight}/>
        {layers.roads && <Roads roads={model.roads} terrain={model.terrain}/>}
        {layers.buildings && model.buildings.map((b)=><Building key={b.id} building={b} terrain={model.terrain} heightFallback={unknownHeight} selected={selected?.id===b.id} onSelect={onSelect}/>)}
        {layers.buildings && facade?.buildingId && model.buildings.filter(b=>String(b.id)===String(facade.buildingId)).map(b=><AnchoredFacade key={'facade-'+b.id} building={b} result={facade.result} terrain={model.terrain} fallbackHeight={unknownHeight} reliefMeters={facade.reliefMeters} panelRef={panelRef}/>)}
      </>}
    </group>
    {!model && <Grid args={[1000,1000]} cellSize={50} sectionSize={100} sectionColor="#a0aeb5" cellColor="#ced6d9" fadeDistance={1800} infiniteGrid/>}
    <OrbitControls makeDefault target={[0,0,0]} minDistance={20} maxDistance={6000} maxPolarAngle={Math.PI/2-0.02}/>
    <axesHelper args={[30]}/>
  </Canvas>;
}

// Image-to-3D is a 2.5D textured depth mesh, NOT a surveyed or watertight building model.
function ImageMesh({ result, depthScale, meshRef }) {
  const geometry = useMemo(() => {
    if (!result) return null;
    const { width:w, height:h, depth } = result;
    const positions=[],uvs=[],indices=[];
    const aspect=w/h;
    for (let y=0;y<h;y++) for(let x=0;x<w;x++) {
      const z = (depth[y*w+x]/255 - .5)*depthScale;
      positions.push(((x/(w-1))-.5)*100*aspect, ((.5-y/(h-1))*100), z);
      uvs.push(x/(w-1),1-y/(h-1));
    }
    for(let y=0;y<h-1;y++) for(let x=0;x<w-1;x++) {
      const i=y*w+x;
      indices.push(i,i+w,i+1,i+1,i+w,i+w+1);
    }
    const g=new THREE.BufferGeometry();
    g.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
    g.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));
    g.setIndex(indices);g.computeVertexNormals();
    return g;
  },[result,depthScale]);
  const texture=useMemo(()=>{
    if(!result) return null;
    const tex=new THREE.TextureLoader().load(result.image_data_url);
    tex.colorSpace=THREE.SRGBColorSpace;
    return tex;
  },[result]);
  useEffect(()=>()=>{geometry?.dispose();texture?.dispose();},[geometry,texture]);
  if(!geometry || !texture)return null;
  return <mesh ref={meshRef} geometry={geometry} rotation={[-Math.PI/10,0,0]}>
    <meshStandardMaterial map={texture} side={THREE.DoubleSide} roughness={.95} />
  </mesh>;
}
function ImageScene({ result, depthScale, meshRef }) {
  return <Canvas camera={{position:[15,15,155],fov:45,near:.1,far:3000}}>
    <color attach="background" args={['#dbe6e9']}/>
    <ambientLight intensity={2}/><directionalLight position={[30,80,100]} intensity={2}/>
    <ImageMesh result={result} depthScale={depthScale} meshRef={meshRef}/>
    <OrbitControls makeDefault enablePan minDistance={45} maxDistance={500}/>
    <axesHelper args={[15]}/>
  </Canvas>;
}

function App() {
  const [address,setAddress]=useState(DEFAULT_ADDRESS);
  const [viewMode,setViewMode]=useState('massing');
  const [sourceMode,setSourceMode]=useState('address');
  const [imageResult,setImageResult]=useState(null);
  const [imageMethod,setImageMethod]=useState('relief');
  const [depthScale,setDepthScale]=useState(35);
  const [imageFile,setImageFile]=useState(null);
  const imageMeshRef=useRef();
  const [referenceImage,setReferenceImage]=useState(null);
  const [referenceName,setReferenceName]=useState('');
  const [radius,setRadius]=useState(500);
  const [layers,setLayers]=useState({buildings:true,roads:true,terrain:true});
  const [analysisLayers,setAnalysisLayers]=useState({solar:true,wind:true,shadows:true});
  const [solarHour,setSolarHour]=useState(12);
  const [windDirection,setWindDirection]=useState(225);
  const [model,setModel]=useState(null);
  const [generatedFor,setGeneratedFor]=useState('');
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState('');
  const [selected,setSelected]=useState(null);
  const [photoFiles,setPhotoFiles]=useState([]);
  const [activePhoto,setActivePhoto]=useState(0);
  const [facadeResult,setFacadeResult]=useState(null);
  const [facadeBuildingId,setFacadeBuildingId]=useState(null);
  const [facadeRelief,setFacadeRelief]=useState(0.35);
  const [facadeMethod,setFacadeMethod]=useState('relief');
  const [analysisResult,setAnalysisResult]=useState(null);
  const [weatherResult,setWeatherResult]=useState(null);
  const [epwFile,setEpwFile]=useState(null);
  const [focusScope,setFocusScope]=useState('all');
  const [focusBuildingIds,setFocusBuildingIds]=useState([]);
  const [focusWidth,setFocusWidth]=useState(100);
  const [focusDepth,setFocusDepth]=useState(100);
  const [focusEast,setFocusEast]=useState(0);
  const [focusNorth,setFocusNorth]=useState(0);
  const [focusedAnalysis,setFocusedAnalysis]=useState(null);
  const [drawingArea,setDrawingArea]=useState(false);
  const [drawingPoints,setDrawingPoints]=useState([]);
  const panelRef=useRef();

  const [unknownHeight,setUnknownHeight]=useState(10);
  const sceneRef=useRef();
  const isUMD = ['university of maryland college park','university of maryland','umd college park','umd'].includes(address.toLowerCase().replace(/,/g,' ').replace(/\s+/g,' ').trim());

  function selectImage(e) {
    const file=e.target.files?.[0];
    if (referenceImage) URL.revokeObjectURL(referenceImage);
    if (!file) {setReferenceImage(null); setReferenceName('');setImageFile(null);return;}
    if (!['image/jpeg','image/png','image/webp'].includes(file.type) || file.size > 8*1024*1024) {setError('Choose a JPG, PNG or WebP image under 8 MB.');return;}
    setReferenceImage(URL.createObjectURL(file)); setReferenceName(file.name);setImageFile(file);setImageResult(null);
  }
  function selectPhotos(e){
    const files=Array.from(e.target.files||[]);
    if(files.length>8){setError('Choose up to 8 images.');return;}
    if(files.some(f=>!['image/jpeg','image/png','image/webp'].includes(f.type)||f.size>8*1024*1024)){
      setError('Each photograph must be a JPG, PNG or WebP under 8 MB.');return;
    }
    setPhotoFiles(files);setActivePhoto(0);setFacadeResult(null);setError('');
  }
  function analyzePhoto(){setError('Site analysis is available in the Site analysis panel above.');}
  async function attachFacade(e){
    e.preventDefault();setError('');
    if(!model){setError('Generate the address-based site model first.');return;}
    if(!selected){setError('Click the target building in the 3D scene first.');return;}
    if(!photoFiles.length){setError('Upload your own building photographs first.');return;}
    setLoading(true);
    try{
      const file=photoFiles[activePhoto];
      const response=await fetch(`/api/image-to-3d?method=${facadeMethod}`,{method:'POST',headers:{'Content-Type':file.type},body:file});
      const data=await readApiResponse(response);
      if(!response.ok)throw new Error(typeof data.detail==='string'?data.detail:`HTTP ${response.status}`);
      setFacadeResult(data);setFacadeBuildingId(selected.id);setViewMode('massing');
    }catch(err){setError(err.message||'Façade processing failed');}
    finally{setLoading(false);}
  }
  const toggle=(name)=>setLayers(old=>({...old,[name]:!old[name]}));
  const toggleAnalysis=(name)=>setAnalysisLayers(old=>({...old,[name]:!old[name]}));
  async function generate(event) {
    event.preventDefault(); setLoading(true);setError('');setSelected(null);setFacadeBuildingId(null);setFacadeResult(null);
    try {
      const response=await fetch('/api/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({address,radius_m:radius, ...layers})});
      const data=await readApiResponse(response);
      if(!response.ok) throw new Error(typeof data.detail==='string'?data.detail:`HTTP ${response.status}`);
      setModel(data); setGeneratedFor(address); setAnalysisResult(null); setFocusedAnalysis(null); setFocusBuildingIds([]);
      setWeatherResult(null);
      if (data.wind?.status === 'available') setWindDirection(data.wind.direction_deg);
    } catch (err) {setError(err.message || 'Unable to load site');}
    finally {setLoading(false);}
  }
  async function runValidatedAnalysis() {
    if (!model) { setError('Generate the address-based site model first.'); return; }
    setLoading(true); setError('');
    try {
      const response = await fetch('/api/simulate', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({model, weather_file:weatherResult?.filename || null, run_energyplus:true, run_radiance:true, solar_hour:solarHour})});
      const data = await readApiResponse(response);
      if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : `HTTP ${response.status}`);
      setAnalysisResult(data);
    } catch (e) { setError(e.message || 'Validated simulation failed'); }
    finally { setLoading(false); }
  }
  async function downloadWeather() {
    if (!model) { setError('Generate the address-based site model first.'); return; }
    setLoading(true); setError('');
    try {
      const response = await fetch('/api/weather/download', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({latitude:model.location.lat, longitude:model.location.lon, label:model.location.address})});
      const data = await readApiResponse(response);
      if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : `HTTP ${response.status}`);
      setWeatherResult(data);
    } catch (e) { setError(e.message || 'EPW download failed'); }
    finally { setLoading(false); }
  }
  function openWeatherMap() {
    window.open('https://www.ladybug.tools/epwmap/', '_blank', 'noopener,noreferrer');
  }
  async function uploadWeather() {
    if (!epwFile) { setError('Choose the .epw file you downloaded from EPWMap first.'); return; }
    setLoading(true); setError('');
    try {
      const response = await fetch(`/api/weather/upload?filename=${encodeURIComponent(epwFile.name)}`, {method:'PUT', headers:{'Content-Type':'application/octet-stream'}, body:epwFile});
      const data = await readApiResponse(response);
      if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : `HTTP ${response.status}`);
      setWeatherResult(data);
    } catch (e) { setError(e.message || 'EPW upload failed'); }
    finally { setLoading(false); }
  }
  async function runFocusedAnalysis() {
    if (!model) { setError('Generate the address-based site model first.'); return; }
    setLoading(true); setError('');
    try {
      const response = await fetch('/api/analyze-focused', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({model, scope:focusScope, building_ids:focusBuildingIds, center_east_m:Number(focusEast), center_north_m:Number(focusNorth), width_m:Number(focusWidth), depth_m:Number(focusDepth), polygon:drawingPoints, grid_size:focusScope === 'all' ? 18 : 28, solar_hour:solarHour})});
      const data = await readApiResponse(response);
      if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : `HTTP ${response.status}`);
      setFocusedAnalysis(data);
    } catch (e) { setError(e.message || 'Focused analysis failed'); }
    finally { setLoading(false); }
  }
  async function generateImage(event) {
    event.preventDefault();setError('');
    if(!imageFile){setError('Choose a JPG, PNG or WebP image first.');return;}
    setLoading(true);
    try {
      const response=await fetch(`/api/image-to-3d?method=${imageMethod}`,{
        method:'POST',headers:{'Content-Type':imageFile.type},body:imageFile
      });
      const data=await readApiResponse(response);
      if(!response.ok)throw new Error(typeof data.detail==='string'?data.detail:`HTTP ${response.status}`);
      setImageResult(data);setViewMode('image');
    } catch(e){setError(e.message||'Image conversion failed');}
    finally{setLoading(false);}
  }
  async function exportImageGLB() {
    if(!imageMeshRef.current || !imageResult)return;
    try {
      const exporter=new GLTFExporter();
      const output=await exporter.parseAsync(imageMeshRef.current,{binary:true,onlyVisible:true});
      const url=URL.createObjectURL(new Blob([output],{type:'model/gltf-binary'}));
      const a=document.createElement('a');a.href=url;a.download='site2model-image-relief.glb';a.click();
      setTimeout(()=>URL.revokeObjectURL(url),3000);
    } catch(e){setError('Image GLB export failed: '+e.message);}
  }
  async function exportGLB() {
    if (!sceneRef.current || !model) return;
    const exporter=new GLTFExporter();
    try {
      const data=await exporter.parseAsync(sceneRef.current,{binary:true,onlyVisible:true});
      const url=URL.createObjectURL(new Blob([data],{type:'model/gltf-binary'}));
      const a=document.createElement('a');a.href=url;a.download='site2model-umd.glb';a.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    } catch (e) {setError('GLB export failed: '+e.message);}
  }
  function exportJSON() {
    if (!model) return;
    const blob=new Blob([JSON.stringify({...model,viewer_unknown_building_height_m:unknownHeight,attached_facade: facadeResult ? {building_id:facadeBuildingId,photo_filename:photoFiles[activePhoto]?.name||null,method:facadeResult.method_label,visual_relief_strength:facadeRelief,geometrically_calibrated:false,notes:'Unregistered photograph; longest OSM footprint edge; visual 2.5D approximation only'} : null},null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob); const a=document.createElement('a');a.href=url;a.download='site2model-geodata.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  const unknownCount=model?.buildings.filter(b=>b.height_m===null).length ?? 0;
  return <div className="app">
    <aside className="sidebar">
      <div className="brand"><span className="brandIcon">▧</span><div><strong>Site2Model <em>AI</em></strong><small>ARCHITECTURAL CONTEXT GENERATOR</small></div></div>
      {sourceMode==='address' ? <form onSubmit={generate}>
        <label htmlFor="address">SITE ADDRESS</label><input id="address" value={address} onChange={e=>setAddress(e.target.value)} placeholder="Address or landmark" required/>
        <label htmlFor="radius">STUDY RADIUS</label><select id="radius" value={radius} onChange={e=>setRadius(Number(e.target.value))}><option value={250}>250 meters</option><option value={500}>500 meters</option><option value={1000}>1,000 meters</option></select>
        <label>MODEL LAYERS</label><div className="layerList">{Object.entries(layers).map(([name,enabled])=><label className="layer" key={name}><input type="checkbox" checked={enabled} onChange={()=>toggle(name)}/><span>{name[0].toUpperCase()+name.slice(1)}</span></label>)}</div>
        <section className="siteAnalysisPanel">
          <h3>Site analysis</h3>
          <p>Preview layers are approximate. Run the installed EnergyPlus and Radiance engines for measured weather-file and ray-traced results.</p>
          <div className="layerList">{Object.entries(analysisLayers).map(([name,enabled])=><label className="layer" key={name}><input type="checkbox" checked={enabled} onChange={()=>toggleAnalysis(name)}/><span>{name === 'solar' ? 'Solar radiation' : name === 'wind' ? 'Wind direction' : 'Shadowing'}</span></label>)}</div>
          <label htmlFor="solarHour">SOLAR TIME: {solarHour}:00</label><input id="solarHour" type="range" min="6" max="18" step="1" value={solarHour} onChange={e=>setSolarHour(Number(e.target.value))}/>
          <label htmlFor="windDirection">WIND DIRECTION: {windDirection}°</label><input id="windDirection" type="range" min="0" max="359" step="1" value={windDirection} onChange={e=>setWindDirection(Number(e.target.value))}/>
          {model?.wind && <p className="dataNote">{model.wind.status === 'available' ? `Live wind: ${model.wind.speed_kmh} km/h at 10 m · ${model.wind.observed_at || 'current'} · ${model.wind.source}` : model.wind.message}</p>}
          <div className="focusAnalysis">
            <h3>Focused analysis</h3>
            <label htmlFor="focusScope">TARGET</label>
            <select id="focusScope" value={focusScope} onChange={e=>setFocusScope(e.target.value)}><option value="all">Entire study area</option><option value="buildings">Selected buildings</option><option value="area">Custom area</option></select>
            {focusScope === 'buildings' && <div className="buildingChoices">{model?.buildings?.slice(0,40).map(building=><label className="layer" key={building.id}><input type="checkbox" checked={focusBuildingIds.includes(building.id)} onChange={e=>setFocusBuildingIds(old=>e.target.checked?[...old,building.id]:old.filter(id=>id!==building.id))}/><span>{building.name || `Building ${building.id}`}</span></label>)}</div>}
            {focusScope === 'area' && <div className="focusFields"><button type="button" className="secondary drawButton" onClick={()=>{setDrawingArea(true);setDrawingPoints([]);setFocusedAnalysis(null)}}>{drawingArea ? 'Click points in the scene…' : 'Draw polygon area'}</button><button type="button" className="secondary" onClick={()=>setDrawingPoints(old=>old.slice(0,-1))} disabled={!drawingPoints.length}>Undo point</button><button type="button" className="secondary" onClick={()=>{setDrawingPoints([]);setDrawingArea(false)}} disabled={!drawingPoints.length}>Clear polygon</button><span className="dataNote">{drawingPoints.length >= 3 ? `${drawingPoints.length} points ready` : 'Click at least 3 points on the 3D ground plane.'}</span></div>}
            <button type="button" className="secondary" onClick={runFocusedAnalysis} disabled={loading || !model || (focusScope === 'area' && drawingPoints.length < 3)}>{loading ? 'Analyzing target…' : 'Analyze selected target'}</button>
            {focusedAnalysis && <div className="analysisCard"><h3>Focused result</h3><div><span>Solar grid</span><b>{focusedAnalysis.grid_size} × {focusedAnalysis.grid_size}</b></div><div><span>Solar method</span><b>screening</b></div><div><span>CFD</span><b>{focusedAnalysis.cfd.status}</b></div><p className="methodNote">{focusedAnalysis.cfd.message}</p></div>}
          </div>
          <div className="analysisLegend"><span>Low solar</span><i></i><span>High solar</span></div>
          <button type="button" className="secondary" onClick={runValidatedAnalysis} disabled={loading || !model}>{loading ? 'Running engines…' : 'Run EnergyPlus + Radiance'}</button>
          <button type="button" className="secondary" onClick={downloadWeather} disabled={loading || !model}>{loading ? 'Downloading weather…' : 'Download nearest Ladybug EPW'}</button>
          {weatherResult?.status === 'downloaded' && <p className="dataNote">EPW ready: {weatherResult.station} · {weatherResult.distance_km} km away · {weatherResult.filename}</p>}
          {weatherResult?.status === 'manual_required' && <div className="analysisCard"><p className="methodNote">{weatherResult.message}</p><p className="dataNote">Use the site coordinates in EPWMap: {weatherResult.latitude.toFixed(5)}, {weatherResult.longitude.toFixed(5)}.</p><button type="button" className="secondary" onClick={openWeatherMap}>Open Ladybug EPWMap</button></div>}
          <div className="weatherUpload"><label htmlFor="epwFile">UPLOAD EPW FROM EPWMAP</label><input id="epwFile" type="file" accept=".epw,application/vnd.epw" onChange={e=>setEpwFile(e.target.files?.[0] || null)}/>{epwFile && weatherResult?.status !== 'uploaded' && <p className="dataNote">Selected: {epwFile.name}. Click “Use uploaded EPW” to send it to the backend.</p>}<button type="button" className="secondary" onClick={uploadWeather} disabled={loading || !epwFile}>{loading ? 'Uploading EPW…' : 'Use uploaded EPW'}</button>{weatherResult?.status === 'uploaded' && <div className="weatherSuccess" role="status"><strong>EPW ready</strong><span>{weatherResult.filename} uploaded successfully and ready for EnergyPlus and Radiance.</span></div>}</div>
          {analysisResult && <div className="analysisCard"><h3>{analysisResult.status === 'completed' ? 'Validated engine run' : 'Engine run needs attention'}</h3><div><span>EnergyPlus</span><b>{analysisResult.energyplus?.status || 'not run'}</b></div><div><span>Radiance</span><b>{analysisResult.radiance?.status || 'not run'}</b></div><p className="methodNote">{analysisResult.energyplus?.message || analysisResult.radiance?.message || 'Results were produced by the configured local engines.'}</p></div>}
        </section>
        <label htmlFor="height">UNKNOWN BUILDING HEIGHT: {unknownHeight} m</label><input id="height" type="range" min="3" max="35" step="1" value={unknownHeight} onChange={e=>setUnknownHeight(Number(e.target.value))}/>
        <button className="primary" type="submit" disabled={loading}>{loading?'Retrieving geodata…':'1. Generate 3D site →'}</button>
      </form> : <form onSubmit={generateImage}>
        <label htmlFor="reference">UPLOAD BUILDING PHOTO OR IMAGE</label>
        <input id="reference" type="file" accept="image/png,image/jpeg,image/webp" onChange={selectImage} className="referenceInput"/>
        {referenceImage && <div className="referencePreview"><img src={referenceImage} alt="Uploaded reference"/><small>{referenceName}</small></div>}
        <label htmlFor="method">RECONSTRUCTION MODE</label>
        <select id="method" value={imageMethod} onChange={e=>setImageMethod(e.target.value)}>
          <option value="relief">Quick image relief — no AI setup</option>
          <option value="ai">AI monocular depth — optional local model</option>
        </select>
        <label htmlFor="depthScale">DEPTH EXAGGERATION: {depthScale}</label><input id="depthScale" type="range" min="2" max="80" step="1" value={depthScale} onChange={e=>setDepthScale(Number(e.target.value))}/>
        <button className="primary" type="submit" disabled={loading}>{loading?'Converting image…':'Convert image to 3D →'}</button>
        <p className="methodNote">A single image produces an approximate textured 2.5D surface. It cannot reveal unseen façades, calibrated dimensions, or true building volume. The AI depth model needs an optional local installation and its first download.</p>
      </form>}
      {error && <div className="error" role="alert">{error}</div>}
      {sourceMode==='address' && model && <section className="stats"><h3>Model summary</h3><div><span>Buildings</span><b>{model.metadata.building_count}</b></div><div><span>Road segments</span><b>{model.metadata.road_count}</b></div><div><span>Unknown heights</span><b>{unknownCount}</b></div><div><span>Projection</span><b>{model.location.projected_crs}</b></div><div><span>Terrain</span><b>{model.terrain.status.replace('_',' ')}</b></div><p>{model.terrain.resolution_note}</p>{model.metadata.osm_note && <p className="warning">{model.metadata.osm_note}</p>}</section>}
      <div className="asideBottom">
        {sourceMode==='address' ? <>
          <button disabled={!model || viewMode !== 'massing'} onClick={exportGLB}>Export site + attached façade (.glb)</button>
          <button disabled={!model || viewMode !== 'massing'} onClick={exportJSON}>Export geometry + metadata (.json)</button>
          <p>© OpenStreetMap contributors (ODbL). Terrain: SRTM via OpenTopoData when available.</p>
        </> : <>
          <button disabled={!imageResult || viewMode !== 'image'} onClick={exportImageGLB}>Export image relief (.glb)</button>
          {imageResult && <p>{imageResult.method_label}. Relative depth only; not to architectural scale.</p>}
        </>}
        <p>No Google Maps account is required. Use only photographs you own or have permission to process. Uploaded images are processed by your local backend, not Google.</p>
      </div>
    </aside>
    <main className="main">
      <header><div><strong>3D Site Explorer</strong><span>{model ? model.location.address : 'Address or image · 3D'}</span></div><span className="live">{viewMode==='image'?(imageResult?'● IMAGE MESH READY':'○ IMAGE MODE'):(model?'● REAL GEODATA':'○ READY TO GENERATE')}</span></header>
        <button type="button" className={viewMode==='massing'?'active':''} onClick={()=>{setViewMode('massing');setSourceMode('address');}}>Urban context + façade</button>
      <div className="viewer">
        {viewMode==='massing' ? <Scene model={model} layers={layers} analysisLayers={analysisLayers} solarHour={solarHour} windDirection={windDirection} unknownHeight={unknownHeight} selected={selected} onSelect={setSelected} sceneRef={sceneRef} facade={facadeResult ? {buildingId:facadeBuildingId,result:facadeResult,reliefMeters:facadeRelief}:null} panelRef={panelRef} focusedAnalysis={focusedAnalysis} drawingArea={drawingArea} drawingPoints={drawingPoints} onAddAreaPoint={point=>setDrawingPoints(old=>[...old,point])}/> : <ImageScene result={imageResult} depthScale={depthScale} meshRef={imageMeshRef}/>}
        {viewMode === 'massing' && !model && <div className="prompt"><span>◈</span><h2>Your site, in three dimensions.</h2><p>Enter an address to generate real-data urban context.</p></div>}
        {viewMode === 'image' && !imageResult && <div className="prompt"><span>◈</span><h2>Photo to interactive 3D.</h2><p>Upload your own building photograph, then select quick relief or AI depth estimation.</p></div>}
        {viewMode === 'massing' && selected && <div className="selection"><button className="close" onClick={()=>setSelected(null)}>×</button><b>{selected.name||`OSM building ${selected.id}`}</b><div>Height: {selected.height_m===null?`${unknownHeight} m (visual assumption)`:`${selected.height_m.toFixed(1)} m`}</div><small>Source: {selected.height_source.replaceAll('_',' ')}</small></div>}
        <div className="hint">DRAG TO ORBIT · SCROLL TO ZOOM · RIGHT-DRAG TO PAN {viewMode==='massing'?'· CLICK A BUILDING':'· DEPTH IS APPROXIMATE'}</div>
      </div>
    </main>
  </div>;
}

createRoot(document.getElementById('root')).render(<App/>);
