// WEATHER_GLOBE // 3D Orthographic Canvas projection, interactions, and camera systems.

(function() {
  // Constants
  const BASE_RADIUS = 200;
  
  // App state
  let canvas, ctx;
  let gridCanvas, gridCtx;
  let width, height;
  let cx, cy; // Center of screen
  
  // WebGL State Variables
  let renderer, scene, camera;
  let earthMesh, atmosphereMesh;
  let boundaryLinesMesh = null;
  
  // Projection parameters
  let scale = 1.5;
  let targetScale = 1.5;
  let rotX = 0.3; // Angle in radians (latitude rotation)
  let rotY = 1.5; // Angle in radians (longitude rotation)
  let targetRotX = 0.3;
  let targetRotY = 1.5;
  
  // Physics inertia
  let isDragging = false;
  let isRealDrag = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let lastMouseX = 0;
  let lastMouseY = 0;
  let velX = 0;
  let velY = 0;
  let autoRotate = false; // Cancel self-rotation by default
  let idleTime = 0;
  
  // Transitions
  let isAnimating = false;
  let animStart = 0;
  let animDuration = 1200; // ms
  let animFrom = {};
  let animTo = {};

  // Selected details
  let hoveredFeature = null; // { type: 'city'|'mountain'|'basin'|'country', data: ... }
  let activeFocus = null;
  let selectedLocation = null; // { lon, lat, name }

  // Level of detail constants
  const ZOOM_LOD1 = 0.8; // Continents only below this
  const ZOOM_LOD2 = 2.0; // Countries fade in above this
  const ZOOM_LOD3 = 3.5; // Cities and high terrain detail above this

  // Precomputed land cache for ultra-high-speed render loops (O(1) lookups)
  const landCache = new Map();
  
  function getCacheKey(lon, lat) {
    const gridLon = Math.round(lon / 1.5) * 1.5;
    const gridLat = Math.round(lat / 1.5) * 1.5;
    return `${gridLon.toFixed(1)},${gridLat.toFixed(1)}`;
  }
  
  function precomputeLandCache() {
    const t0 = performance.now();
    for (let lat = -84; lat <= 84; lat += 1.5) {
      for (let lon = -180; lon <= 180; lon += 1.5) {
        const country = getCountryAtCoord(lon, lat);
        if (country) {
          landCache.set(getCacheKey(lon, lat), country);
        }
      }
    }
    const t1 = performance.now();
    console.log(`[GIS Engine] Precomputed landmass cache in ${(t1 - t0).toFixed(1)}ms.`);
  }
  
  function getCountryAtCoordCached(lon, lat) {
    return landCache.get(getCacheKey(lon, lat)) || null;
  }

  // Voronoi cell computation for province boundaries to eliminate overlapping rings and grid lines
  let cachedVoronoiCells = null;

  function clipPolygonWithHalfPlane(vertices, mx, my, nx, ny) {
    const result = [];
    if (vertices.length === 0) return result;
    
    let s = vertices[vertices.length - 1];
    let s_inside = ((s[0] - mx) * nx + (s[1] - my) * ny) <= 0;
    
    for (let i = 0; i < vertices.length; i++) {
      const p = vertices[i];
      const p_inside = ((p[0] - mx) * nx + (p[1] - my) * ny) <= 0;
      
      if (p_inside) {
        if (!s_inside) {
          const t = intersectionT(s, p, mx, my, nx, ny);
          result.push([s[0] + t * (p[0] - s[0]), s[1] + t * (p[1] - s[1])]);
        }
        result.push(p);
      } else if (s_inside) {
        const t = intersectionT(s, p, mx, my, nx, ny);
        result.push([s[0] + t * (p[0] - s[0]), s[1] + t * (p[1] - s[1])]);
      }
      s = p;
      s_inside = p_inside;
    }
    return result;
  }

  function intersectionT(s, p, mx, my, nx, ny) {
    const dx = p[0] - s[0];
    const dy = p[1] - s[1];
    const num = (mx - s[0]) * nx + (my - s[1]) * ny;
    const den = dx * nx + dy * ny;
    if (Math.abs(den) < 1e-9) return 0;
    return num / den;
  }

  function computeVoronoiCells(sites) {
    const cells = [];
    for (let i = 0; i < sites.length; i++) {
      const sI = sites[i];
      let poly = [
        [-180, -90],
        [180, -90],
        [180, 90],
        [-180, 90]
      ];
      for (let j = 0; j < sites.length; j++) {
        if (i === j) continue;
        const sJ = sites[j];
        
        const mx = (sI.centroid[0] + sJ.centroid[0]) / 2;
        const my = (sI.centroid[1] + sJ.centroid[1]) / 2;
        
        const nx = sJ.centroid[0] - sI.centroid[0];
        const ny = sJ.centroid[1] - sI.centroid[1];
        
        poly = clipPolygonWithHalfPlane(poly, mx, my, nx, ny);
      }
      cells.push({ name: sI.name, centroid: sI.centroid, polygon: poly });
    }
    return cells;
  }

  function precomputeVoronoiCells() {
    cachedVoronoiCells = {};
    if (!window.GEOGRAPHIC_DATA) return;
    
    if (window.GEOGRAPHIC_DATA.chinaProvinces) {
      cachedVoronoiCells['CHN'] = computeVoronoiCells(window.GEOGRAPHIC_DATA.chinaProvinces);
    }
    if (window.GEOGRAPHIC_DATA.usStates) {
      cachedVoronoiCells['USA'] = computeVoronoiCells(window.GEOGRAPHIC_DATA.usStates);
    }
  }

  // Get marginal sea at coordinate
  function getMarginalSeaAtCoord(lon, lat) {
    if (!window.GEOGRAPHIC_DATA || !window.GEOGRAPHIC_DATA.marginalSeas) return null;
    for (const sea of window.GEOGRAPHIC_DATA.marginalSeas) {
      const b = sea.bounds;
      if (lon >= b.lonMin && lon <= b.lonMax && lat >= b.latMin && lat <= b.latMax) {
        return sea;
      }
    }
    return null;
  }

  // Procedural Digital Elevation mapping (representing mountains, depths, continental shelves)
  function getElevation(lon, lat) {
    let mountainInfluence = 0;
    if (window.GEOGRAPHIC_DATA.mountains) {
      for (const mt of window.GEOGRAPHIC_DATA.mountains) {
        const d = Math.hypot(lon - mt.coord[0], lat - mt.coord[1]);
        if (d < 12) {
          mountainInfluence += Math.max(0, (12 - d) / 12) * 5500;
        }
      }
    }
    
    let trenchInfluence = 0;
    const trenches = [
      { coord: [142.2, 11.3], depth: -11000 },
      { coord: [-66.0, 19.5], depth: -8400 },
      { coord: [-76.5, -20.0], depth: -8000 },
      { coord: [145.0, 40.0], depth: -9000 },
      { coord: [122.0, 20.0], depth: -7500 }
    ];
    for (const tr of trenches) {
      const d = Math.hypot(lon - tr.coord[0], lat - tr.coord[1]);
      if (d < 10) {
        trenchInfluence += Math.max(0, (10 - d) / 10) * tr.depth;
      }
    }

    const isLandPoint = getCountryAtCoordCached(lon, lat) !== null;
    
    const n1 = Math.sin(lon * 0.04) * Math.cos(lat * 0.04);
    const n2 = Math.sin(lon * 0.15 + 1.0) * Math.cos(lat * 0.2 - 0.5) * 0.4;
    const n3 = Math.sin(lon * 0.6) * Math.cos(lat * 0.7) * 0.12;
    const combinedNoise = (n1 + n2 + n3) / 1.52;
    
    if (isLandPoint) {
      let baseElev = 100 + Math.max(0, combinedNoise) * 2500;
      let elev = baseElev + mountainInfluence;
      return Math.min(8850, elev);
    } else {
      let baseDepth = -3500 + combinedNoise * 2000;
      let depth = baseDepth + trenchInfluence;
      return Math.min(-50, depth);
    }
  }

  // Dynamic Hypsometric contour coloring
  // Dynamic Hypsometric contour coloring with desert & basin blending
  function getElevationColor(elev, shade = 1.0, desertFactor = 0, basinFactor = 0) {
    let r, g, b, a = 0.9;
    if (elev >= 0) {
      if (elev >= 3500) {
        // High snowy peaks
        r = 245; g = 250; b = 255; a = 0.95;
      } else if (elev >= 1600) {
        // High mountains - brown
        const t = (elev - 1600) / 1900;
        r = Math.round(135 + (240 - 135) * t);
        g = Math.round(85 + (244 - 85) * t);
        b = Math.round(55 + (248 - 55) * t);
      } else {
        // We can apply desert and basin blend for plains and hills
        let baseR, baseG, baseB;
        if (elev >= 450) {
          // Hills - gold-brown
          const t = (elev - 450) / 1150;
          baseR = Math.round(185 + (135 - 185) * t);
          baseG = Math.round(145 + (85 - 145) * t);
          baseB = Math.round(85 + (55 - 85) * t);
        } else {
          // Plains - green to yellow-green
          const t = elev / 450;
          baseR = Math.round(50 + (185 - 50) * t);
          baseG = Math.round(120 + (145 - 120) * t);
          baseB = Math.round(70 + (85 - 70) * t);
        }
        
        if (desertFactor > 0.2) {
          const t = Math.min(1.0, (desertFactor - 0.2) / 0.8);
          // Blend with beautiful desert sand color: (238, 195, 120)
          r = Math.round(baseR * (1 - t) + 238 * t);
          g = Math.round(baseG * (1 - t) + 195 * t);
          b = Math.round(baseB * (1 - t) + 120 * t);
        } else if (basinFactor > 0.2) {
          const t = Math.min(1.0, (basinFactor - 0.2) / 0.8);
          // Blend with rich deep rainforest green: (25, 95, 45)
          r = Math.round(baseR * (1 - t) + 25 * t);
          g = Math.round(baseG * (1 - t) + 95 * t);
          b = Math.round(baseB * (1 - t) + 45 * t);
        } else {
          r = baseR;
          g = baseG;
          b = baseB;
        }
      }
    } else {
      const d = -elev;
      if (d >= 4500) {
        // Deepest trenches - near black
        r = 3; g = 6; b = 15; a = 0.95;
      } else if (d >= 1800) {
        // Deep ocean - dark blue
        const t = (d - 1800) / 2700;
        r = Math.round(10 - 7 * t);
        g = Math.round(25 - 19 * t);
        b = Math.round(55 - 40 * t);
      } else if (d >= 200) {
        // Deep shelf slope
        const t = (d - 200) / 1600;
        r = Math.round(25 - 15 * t);
        g = Math.round(75 - 50 * t);
        b = Math.round(125 - 70 * t);
      } else {
        // Continental shelf - bright cyan/turquoise
        const t = d / 200;
        r = Math.round(35 - 10 * t);
        g = Math.round(135 - 60 * t);
        b = Math.round(185 - 60 * t);
        a = 0.95;
      }
    }

    // Apply shading factor to create beautiful 3D shadows & highlights
    r = Math.max(0, Math.min(255, Math.round(r * shade)));
    g = Math.max(0, Math.min(255, Math.round(g * shade)));
    b = Math.max(0, Math.min(255, Math.round(b * shade)));

    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }

  /**
   * Initialize canvas elements
   */
  function init(globeCanvasId, gridCanvasId) {
    canvas = document.getElementById(globeCanvasId);
    ctx = canvas.getContext('2d');
    
    gridCanvas = document.getElementById(gridCanvasId);
    gridCtx = gridCanvas.getContext('2d');
    
    precomputeLandCache();
    precomputeVoronoiCells();
    
    initWebGL();
    resize();
    window.addEventListener('resize', resize);
    
    // Bind interactions
    canvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    
    // Start draw loop
    requestAnimationFrame(renderLoop);
  }

  function initWebGL() {
    const webglCanvas = document.getElementById('webgl-canvas');
    if (!webglCanvas) return;
    
    // Initialize width, height, and center immediately to prevent NaN parameter construction,
    // which can throw TypeErrors during canvas sizing or OrthographicCamera creation.
    width = window.innerWidth;
    height = window.innerHeight;
    cx = width / 2;
    cy = height / 2;
    
    // Create WebGL Renderer
    renderer = new THREE.WebGLRenderer({
      canvas: webglCanvas,
      antialias: true,
      alpha: true
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // Limit pixel ratio to 2 for performance
    renderer.setSize(width, height);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    
    // Create Scene
    scene = new THREE.Scene();
    
    // Create Orthographic Camera matching canvas pixel bounds 1:1
    // Position the camera far away and extend the far plane so deep zoom levels (up to x24)
    // never clip the front or back faces of the 3D sphere along the Z depth axis.
    camera = new THREE.OrthographicCamera(-width / 2, width / 2, height / 2, -height / 2, 0.1, 50000);
    camera.position.z = 20000;
    camera.lookAt(0, 0, 0);
    
    // Add volumetric lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.3);
    scene.add(ambientLight);
    
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
    dirLight.position.set(-300, 300, 500); // Volumetric light from top-left front
    scene.add(dirLight);
    
    // Build Earth Sphere Mesh
    const earthGeom = new THREE.SphereGeometry(BASE_RADIUS, 64, 64);
    
    // Fallback material if textures are blocked by CORS/network errors
    const earthMat = new THREE.MeshStandardMaterial({
      color: 0x182436,
      roughness: 0.5,
      metalness: 0.1
    });
    
    earthMesh = new THREE.Mesh(earthGeom, earthMat);
    earthMesh.rotation.order = 'XYZ';
    scene.add(earthMesh);
    
    // Asynchronously load the recommended textures
    const textureLoader = new THREE.TextureLoader();
    
    textureLoader.load(
      'https://threejs.org/examples/textures/planets/earth_atmos_2048.jpg',
      function(colorTex) {
        // Successfully loaded color texture
        colorTex.colorSpace = THREE.SRGBColorSpace || 'srgb';
        earthMat.color.setHex(0xffffff); // Clear slate fallback color
        earthMat.map = colorTex;
        earthMat.needsUpdate = true;
        
        // Load normal map next
        textureLoader.load(
          'https://threejs.org/examples/textures/planets/earth_normal_2048.jpg',
          function(normalTex) {
            earthMat.normalMap = normalTex;
            earthMat.normalScale.set(1.8, 1.8);
            earthMat.needsUpdate = true;
          },
          undefined,
          function(err) {
            console.error('[WebGL Engine] Normal map failed to load, keeping color texture:', err);
          }
        );
      },
      undefined,
      function(err) {
        console.error('[WebGL Engine] Color texture failed to load, utilizing slate fallback material:', err);
      }
    );
    
    // Atmosphere mesh removed — the WebGL Fresnel glow created a visible blue ring
    // around the globe edge that the user found distracting. The 3D Earth texture and
    // province boundary lines are now the sole WebGL elements.

    // Start asynchronous loading of 3D province boundary lines
    loadAndRender3DBoundaries();
  }

  // ======== 3D Province Boundary Lines System ========

  /**
   * Convert geodetic longitude/latitude (degrees) to 3D Cartesian coordinates
   * on a sphere, matching Three.js SphereGeometry's internal UV texture mapping.
   *
   * This ensures boundary lines align perfectly with the Earth texture.
   * Math derivation (Three.js SphereGeometry convention):
   *   phi   = (lon + 180) * PI/180       (azimuthal angle in Three.js)
   *   theta = (90 - lat) * PI/180        (polar colatitude)
   *   X = -R * cos(phi) * sin(theta)
   *   Y =  R * cos(theta)
   *   Z =  R * sin(phi) * sin(theta)
   */
  function projectToSphere(lonDeg, latDeg, radius) {
    const phi = (lonDeg + 180) * Math.PI / 180;
    const theta = (90 - latDeg) * Math.PI / 180;
    const sinTheta = Math.sin(theta);
    return [
      -radius * Math.cos(phi) * sinTheta,
       radius * Math.cos(theta),
       radius * Math.sin(phi) * sinTheta
    ];
  }

  /**
   * Process a GeoJSON coordinate ring into line segment vertex pairs.
   * Each adjacent pair of points [p_i, p_{i+1}] becomes one discrete line segment.
   * Colors array is populated in parallel for per-province vertex coloring.
   */
  function processGeoJSONRing(ring, radius, vertices, cr, cg, cb, colors) {
    for (let i = 0; i < ring.length - 1; i++) {
      const p1 = ring[i];
      const p2 = ring[i + 1];
      const v1 = projectToSphere(p1[0], p1[1], radius);
      const v2 = projectToSphere(p2[0], p2[1], radius);
      vertices.push(v1[0], v1[1], v1[2], v2[0], v2[1], v2[2]);
      colors.push(cr, cg, cb, cr, cg, cb);
    }
  }

  /**
   * Asynchronously fetch high-fidelity China province GeoJSON boundaries
   * from the Aliyun DataV API and render them as merged 3D LineSegments
   * parented to the Earth mesh for automatic rotation/zoom sync.
   *
   * Data Source: https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json
   *
   * To switch to a different region or country, replace the URL:
   *   - China only:    100000_full.json
   *   - Single province: {province_adcode}_full.json  (e.g. 110000 for Beijing)
   *   - Any standard GeoJSON with MultiPolygon/Polygon geometry types works.
   *
   * Falls back to generateFallback3DBoundaries() if the network request fails.
   */
  async function loadAndRender3DBoundaries() {
    const lineRadius = BASE_RADIUS * 1.002; // 0.2% above surface to eliminate z-fighting

    try {
      var geojson = window.CHINA_GEOJSON;
      if (!geojson) {
        console.log('[GIS 3D Engine] window.CHINA_GEOJSON not pre-loaded. Fetching from Aliyun API...');
        const controller = new AbortController();
        const timeoutId = setTimeout(function() { controller.abort(); }, 8000);

        const response = await fetch(
          'https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json',
          { signal: controller.signal }
        );
        clearTimeout(timeoutId);

        if (!response.ok) throw new Error('HTTP ' + response.status);

        geojson = await response.json();
        window.CHINA_GEOJSON = geojson; // Cache globally for exact point-in-polygon geocoding
      }

      var vertices = [];
      var colors = [];
      var featureCount = geojson.features.length;

      for (var fi = 0; fi < featureCount; fi++) {
        var feature = geojson.features[fi];
        var geom = feature.geometry;

        // Per-province chromatic separation using golden ratio hue distribution
        // This ensures that even adjacent provinces get visually distinct colors
        var hue = (fi * 0.618033988749895) % 1.0;
        // Map to warm golden-amber spectrum: red-orange (0.05) -> gold-yellow (0.30)
        var warmAngle = (hue * 0.25 + 0.05) * Math.PI * 2;
        // Compact HSL-to-RGB via cosine phase shift (s≈0.9, l≈0.6)
        var cr = Math.min(1.0, Math.max(0.0, 0.6 + 0.4 * Math.cos(warmAngle)));
        var cg = Math.min(1.0, Math.max(0.0, 0.6 + 0.4 * Math.cos(warmAngle - 2.094)));
        var cb = Math.min(1.0, Math.max(0.0, 0.6 + 0.4 * Math.cos(warmAngle - 4.189)));

        if (geom.type === 'MultiPolygon') {
          for (var pi = 0; pi < geom.coordinates.length; pi++) {
            var polygon = geom.coordinates[pi];
            for (var ri = 0; ri < polygon.length; ri++) {
              processGeoJSONRing(polygon[ri], lineRadius, vertices, cr, cg, cb, colors);
            }
          }
        } else if (geom.type === 'Polygon') {
          for (var ri2 = 0; ri2 < geom.coordinates.length; ri2++) {
            processGeoJSONRing(geom.coordinates[ri2], lineRadius, vertices, cr, cg, cb, colors);
          }
        }
      }

      if (vertices.length > 0 && earthMesh) {
        var geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertices), 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3));

        var material = new THREE.LineBasicMaterial({
          vertexColors: true,
          transparent: true,
          opacity: 0.88,
          depthTest: true,
          depthWrite: false
        });

        var mesh = new THREE.LineSegments(geometry, material);
        // Parent to earthMesh: boundaries automatically rotate, scale, and translate
        // with the Earth, eliminating manual sync and guaranteeing zero drift.
        earthMesh.add(mesh);
        boundaryLinesMesh = mesh;
        console.log('[GIS 3D Engine] Loaded ' + featureCount + ' province boundaries (' + (vertices.length / 6) + ' line segments) from Aliyun DataV API.');
      }

    } catch (err) {
      console.warn('[GIS 3D Engine] GeoJSON fetch failed: ' + err.message + '. Using Voronoi + WORLD_GEOMETRY fallback.');
      generateFallback3DBoundaries(lineRadius);
    }
  }

  /**
   * Generate fallback 3D boundary lines from precomputed Voronoi cells
   * (China provinces, US states) and existing WORLD_GEOMETRY country outlines.
   * This provides instant offline boundaries when the GeoJSON API is unreachable.
   *
   * To replace this with real GeoJSON data, download .json files locally and
   * load them synchronously via <script> tags or via XMLHttpRequest.
   */
  function generateFallback3DBoundaries(lineRadius) {
    var vertices = [];
    var colors = [];

    // ----- China Province Voronoi Boundaries (bright gold) -----
    if (cachedVoronoiCells && cachedVoronoiCells['CHN']) {
      var cr = 1.0, cg = 0.67, cb = 0.0;
      for (var ci = 0; ci < cachedVoronoiCells['CHN'].length; ci++) {
        var cell = cachedVoronoiCells['CHN'][ci];
        if (cell.polygon && cell.polygon.length > 1) {
          for (var i = 0; i < cell.polygon.length; i++) {
            var p1 = cell.polygon[i];
            var p2 = cell.polygon[(i + 1) % cell.polygon.length];
            // Clip to China's approximate geographical bounding box
            if (p1[0] >= 73 && p1[0] <= 136 && p1[1] >= 17 && p1[1] <= 54 &&
                p2[0] >= 73 && p2[0] <= 136 && p2[1] >= 17 && p2[1] <= 54) {
              var v1 = projectToSphere(p1[0], p1[1], lineRadius);
              var v2 = projectToSphere(p2[0], p2[1], lineRadius);
              vertices.push(v1[0], v1[1], v1[2], v2[0], v2[1], v2[2]);
              colors.push(cr, cg, cb, cr, cg, cb);
            }
          }
        }
      }
    }

    // ----- US State Voronoi Boundaries (tech cyan) -----
    if (cachedVoronoiCells && cachedVoronoiCells['USA']) {
      var ucr = 0.27, ucg = 0.95, ucb = 1.0;
      for (var si = 0; si < cachedVoronoiCells['USA'].length; si++) {
        var scell = cachedVoronoiCells['USA'][si];
        if (scell.polygon && scell.polygon.length > 1) {
          for (var j = 0; j < scell.polygon.length; j++) {
            var sp1 = scell.polygon[j];
            var sp2 = scell.polygon[(j + 1) % scell.polygon.length];
            if (sp1[0] >= -130 && sp1[0] <= -65 && sp1[1] >= 24 && sp1[1] <= 50 &&
                sp2[0] >= -130 && sp2[0] <= -65 && sp2[1] >= 24 && sp2[1] <= 50) {
              var sv1 = projectToSphere(sp1[0], sp1[1], lineRadius);
              var sv2 = projectToSphere(sp2[0], sp2[1], lineRadius);
              vertices.push(sv1[0], sv1[1], sv1[2], sv2[0], sv2[1], sv2[2]);
              colors.push(ucr, ucg, ucb, ucr, ucg, ucb);
            }
          }
        }
      }
    }

    if (vertices.length > 0 && earthMesh) {
      var geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertices), 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3));

      var material = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.75,
        depthTest: true,
        depthWrite: false
      });

      var mesh = new THREE.LineSegments(geometry, material);
      earthMesh.add(mesh);
      boundaryLinesMesh = mesh;
      console.log('[GIS 3D Engine] Generated ' + (vertices.length / 6) + ' fallback 3D boundary segments from Voronoi cells.');
    }
  }

  function resize() {
    width = window.innerWidth;
    height = window.innerHeight;
    
    canvas.width = width;
    canvas.height = height;
    
    gridCanvas.width = width;
    gridCanvas.height = height;
    
    cx = width / 2;
    cy = height / 2;
    
    if (renderer) {
      renderer.setSize(width, height);
      camera.left = -width / 2;
      camera.right = width / 2;
      camera.top = height / 2;
      camera.bottom = -height / 2;
      camera.updateProjectionMatrix();
    }
    
    drawBackgroundGrid();
  }

  /**
   * Math 3D -> 2D projection
   * Latitude / Longitude in degrees -> [screenX, screenY, depthZ]
   */
  function project(lonDeg, latDeg, radius) {
    const lon = lonDeg * Math.PI / 180;
    const lat = latDeg * Math.PI / 180;
    
    // 3D Cartesian coordinates (Earth sphere)
    const x = radius * Math.cos(lat) * Math.sin(lon);
    const y = -radius * Math.sin(lat);
    const z = radius * Math.cos(lat) * Math.cos(lon);
    
    // Apply Y-axis rotation (longitude)
    const x1 = x * Math.cos(rotY) - z * Math.sin(rotY);
    const z1 = x * Math.sin(rotY) + z * Math.cos(rotY);
    
    // Apply X-axis rotation (latitude)
    const y2 = y * Math.cos(rotX) - z1 * Math.sin(rotX);
    const z2 = y * Math.sin(rotX) + z1 * Math.cos(rotX);
    
    return [cx + x1, cy + y2, z2];
  }

  /**
   * Math 2D screen -> 3D sphere unrotated -> unrotated Lat/Lon
   */
  function unproject(screenX, screenY, radius) {
    const dx = screenX - cx;
    const dy = screenY - cy;
    
    // Check inside circle
    if (dx * dx + dy * dy > radius * radius) {
      return null;
    }
    
    // Solve for z on the front face of sphere (z > 0)
    const x2 = dx;
    const y2 = dy;
    const z2 = Math.sqrt(radius * radius - x2 * x2 - y2 * y2);
    
    // 1. Reverse X-axis rotation (lat rotation)
    const y1 = y2 * Math.cos(rotX) + z2 * Math.sin(rotX);
    const z1 = z2 * Math.cos(rotX) - y2 * Math.sin(rotX);
    
    // 2. Reverse Y-axis rotation (lon rotation)
    const x = x2 * Math.cos(rotY) + z1 * Math.sin(rotY);
    const z = z1 * Math.cos(rotY) - x2 * Math.sin(rotY);
    const y = y1;
    
    // Translate back to Lat / Lon in degrees
    const lat = Math.asin(-y / radius) * 180 / Math.PI;
    const lon = Math.atan2(x, z) * 180 / Math.PI;
    
    return { lat: lat, lon: lon };
  }

  /**
   * Draw static technical gridlines in background
   */
  function drawBackgroundGrid() {
    gridCtx.clearRect(0, 0, width, height);
    
    gridCtx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
    gridCtx.lineWidth = 1;
    
    // Draw 100px square grids
    const gridSize = 100;
    gridCtx.beginPath();
    for (let x = 0; x < width; x += gridSize) {
      gridCtx.moveTo(x, 0);
      gridCtx.lineTo(x, height);
    }
    for (let y = 0; y < height; y += gridSize) {
      gridCtx.moveTo(0, y);
      gridCtx.lineTo(width, y);
    }
    gridCtx.stroke();
    
    // Draw outer crosshairs
    gridCtx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    gridCtx.beginPath();
    // Center horizontal ticks
    gridCtx.moveTo(24, cy); gridCtx.lineTo(64, cy);
    gridCtx.moveTo(width - 64, cy); gridCtx.lineTo(width - 24, cy);
    // Center vertical ticks
    gridCtx.moveTo(cx, 64); gridCtx.lineTo(cx, 104);
    gridCtx.moveTo(cx, height - 104); gridCtx.lineTo(cx, height - 64);
    gridCtx.stroke();
  }

  /**
   * Point in Polygon collision checker
   */
  function pointInPolygon(pt, ring) {
    let x = pt[0], y = pt[1];
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      let xi = ring[i][0], yi = ring[i][1];
      let xj = ring[j][0], yj = ring[j][1];
      let intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function getCountryAtCoord(lon, lat) {
    if (!window.WORLD_GEOMETRY) return null;
    
    for (const country of window.WORLD_GEOMETRY) {
      if (country.type === "Polygon") {
        if (pointInPolygon([lon, lat], country.coordinates[0])) {
          return country;
        }
      } else if (country.type === "MultiPolygon") {
        for (const poly of country.coordinates) {
          if (pointInPolygon([lon, lat], poly[0])) {
            return country;
          }
        }
      }
    }
    return null;
  }

  /**
   * Interaction Handlers
   */
  function onMouseDown(e) {
    if (isAnimating) return;
    isDragging = true;
    isRealDrag = false;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    autoRotate = false;
    idleTime = 0;
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
    velX = 0;
    velY = 0;
  }

  function onMouseMove(e) {
    if (isDragging) {
      if (!isRealDrag) {
        const dist = Math.hypot(e.clientX - dragStartX, e.clientY - dragStartY);
        if (dist > 3) {
          isRealDrag = true;
          // Set lastMouseX/Y to current to prevent jump
          lastMouseX = e.clientX;
          lastMouseY = e.clientY;
        }
      }

      if (isRealDrag) {
        const dx = e.clientX - lastMouseX;
        const dy = e.clientY - lastMouseY;
        
        // Speed adjustments based on scale
        const factor = 0.005 / scale;
        // Reverse drag delta direction as requested
        targetRotY -= dx * factor;
        targetRotX -= dy * factor;
        
        // Constrain X rotation to prevent going upside down
        targetRotX = Math.max(-Math.PI/2.2, Math.min(Math.PI/2.2, targetRotX));
        
        // Keep velocity matching the dragging delta
        velY = -dx * factor;
        velX = -dy * factor;
        
        lastMouseX = e.clientX;
        lastMouseY = e.clientY;
      }
    }
    
    // Handle hover coordinates calculation
    updateHoverState(e.clientX, e.clientY);
  }

  function onMouseUp(e) {
    isDragging = false;
  }

  function onWheel(e) {
    e.preventDefault();
    if (isAnimating) return;
    
    autoRotate = false;
    idleTime = 0;
    
    // Zoom log calculation
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    targetScale = Math.max(0.5, Math.min(24.0, targetScale * factor));
    
    document.getElementById('hud-scale').textContent = `缩放倍率: x${targetScale.toFixed(2)}`;
  }

  function updateHoverState(mouseX, mouseY) {
    const r = BASE_RADIUS * scale;
    const geo = unproject(mouseX, mouseY, r);
    
    if (!geo) {
      hoveredFeature = null;
      if (typeof window.APP_CONTROLLER !== 'undefined') {
        window.APP_CONTROLLER.onGlobeHover(null);
      }
      return;
    }
    
    // Round geo coords
    const hLat = geo.lat;
    const hLon = geo.lon;

    // Check continents at lower zoom levels (LOD1 & LOD2)
    if (scale <= ZOOM_LOD2) {
      for (const cont of window.GEOGRAPHIC_DATA.continents) {
        const [sx, sy, sz] = project(cont.centroid[0], cont.centroid[1], r);
        if (sz > 0) {
          const dist = Math.hypot(mouseX - sx, mouseY - sy);
          if (dist < 28) { // 28px hit radius around the continent text label
            hoveredFeature = { type: 'continent', data: cont, coords: [cont.centroid[1], cont.centroid[0]] };
            if (typeof window.APP_CONTROLLER !== 'undefined') {
              window.APP_CONTROLLER.onGlobeHover(hoveredFeature);
            }
            return;
          }
        }
      }
    }

    // Terrain features hover checking bypassed per user request
    if (scale >= ZOOM_LOD3) {
      // Check cities
      for (const city of window.GEOGRAPHIC_DATA.cities) {
        const [sx, sy, sz] = project(city.coord[0], city.coord[1], r);
        if (sz > 0) {
          const dist = Math.hypot(mouseX - sx, mouseY - sy);
          if (dist < 10) {
            hoveredFeature = { type: 'city', data: city, coords: [hLat, hLon] };
            window.APP_CONTROLLER.onGlobeHover(hoveredFeature);
            return;
          }
        }
      }
    }

    // Default to country check
    let country = getCountryAtCoordCached(hLon, hLat);
    if (!country) {
      country = getCountryAtCoord(hLon, hLat);
    }
    
    if (country) {
      hoveredFeature = { type: 'country', data: country, coords: [hLat, hLon] };
    } else {
      // Check marginal seas
      const sea = getMarginalSeaAtCoord(hLon, hLat);
      if (sea) {
        hoveredFeature = { type: 'ocean', data: { name: sea.name, isMarginal: true, desc: sea.desc }, coords: [hLat, hLon] };
      } else {
        // Oceans
        let bestOcean = "海洋网格";
        let minDist = Infinity;
        for (const oc of window.GEOGRAPHIC_DATA.oceans) {
          const dist = Math.hypot(hLon - oc.centroid[0], hLat - oc.centroid[1]);
          if (dist < minDist) {
            minDist = dist;
            bestOcean = oc.name;
          }
        }
        hoveredFeature = { type: 'ocean', data: { name: bestOcean }, coords: [hLat, hLon] };
      }
    }
    
    if (typeof window.APP_CONTROLLER !== 'undefined') {
      window.APP_CONTROLLER.onGlobeHover(hoveredFeature);
    }
  }

  /**
   * Fly camera smoothly to target coordinates
   */
  function flyTo(lon, lat, targetZoom = 3.5, duration = 1200) {
    isAnimating = true;
    animStart = performance.now();
    animDuration = duration;
    autoRotate = false;
    idleTime = 0;
    // Zero out velocities to prevent post-flight drifting
    velX = 0;
    velY = 0;
    
    // Normalize target rotY based on coordinates:
    // Globe projects matching central meridians
    let targetY = lon * Math.PI / 180;
    let targetX = -lat * Math.PI / 180;
    
    // Keep targetRotX bounds
    targetX = Math.max(-Math.PI/2.2, Math.min(Math.PI/2.2, targetX));
    
    // Normalize rotY so rotation goes the shortest path
    const dRotY = (targetY - rotY) % (Math.PI * 2);
    const shortestY = dRotY - (Math.round(dRotY / (Math.PI * 2)) * Math.PI * 2);
    targetY = rotY + shortestY;
    
    animFrom = {
      scale: scale,
      rotX: rotX,
      rotY: rotY
    };
    
    animTo = {
      scale: targetZoom,
      rotX: targetX,
      rotY: targetY
    };
    
    targetScale = targetZoom;
    targetRotX = targetX;
    targetRotY = targetY;
  }

  /**
   * Easing function (Cubic Out)
   */
  function easeOutCubic(x) {
    return 1 - Math.pow(1 - x, 3);
  }

  /**
   * Core Draw Loop
   */
  function renderLoop(time) {
    // 1. Update rotations based on animations or inertia dragging
    if (isAnimating) {
      const elapsed = time - animStart;
      const progress = Math.min(1.0, elapsed / animDuration);
      const ease = easeOutCubic(progress);
      
      scale = animFrom.scale + (animTo.scale - animFrom.scale) * ease;
      rotX = animFrom.rotX + (animTo.rotX - animFrom.rotX) * ease;
      rotY = animFrom.rotY + (animTo.rotY - animFrom.rotY) * ease;
      
      if (progress >= 1.0) {
        isAnimating = false;
      }
    } else {
      // Decay velocity and apply
      rotY += velY;
      rotX += velX;
      
      // Interpolate smooth zoom
      scale += (targetScale - scale) * 0.1;
      rotX += (targetRotX - rotX) * 0.1;
      rotY += (targetRotY - rotY) * 0.15;
      
      if (isDragging) {
        velX *= 0.8;
        velY *= 0.8;
      } else {
        // Friction decay
        velX *= 0.95;
        velY *= 0.95;
        
        // Auto-rotation cancelled based on user request - idle loops disabled.
      }
      
      // Strict X rotation lock bounds
      rotX = Math.max(-Math.PI/2.2, Math.min(Math.PI/2.2, rotX));
      targetRotX = rotX;
    }
    
    // 2. Clear canvas
    ctx.clearRect(0, 0, width, height);
    
    const r = BASE_RADIUS * scale;
    
    // 3. Render Three.js WebGL Earth
    if (earthMesh && renderer) {
      // Synchronize sizes based on camera scale factor
      earthMesh.scale.setScalar(scale);
      
      // Aspect-ratio clipping and coordinates projection sync:
      // The orthographic camera frustum is set strictly during resize to match the window
      // dimensions 1:1. This guarantees that 1 unit in 3D world space matches exactly
      // 1 pixel on the 2D canvas, aligning the vector borders perfectly with the WebGL sphere.
      // Clipping on high zoom is avoided by the extended Z depth clipping range.
      
      // Synchronize mesh rotation: match the 2D canvas Rx(rotX) * Ry(-rotY) convention.
      // With 'XYZ' order the matrix is Rx(rx) * Ry(ry), so rx = -rotX, ry = -rotY - PI/2.
      earthMesh.rotation.y = -rotY - Math.PI / 2;
      earthMesh.rotation.x = -rotX;
      
      renderer.render(scene, camera);
    }
    
    // 4. Clip drawings strictly to the circular globe sphere boundaries
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    
    // Draw Globe Surface Elements inside bounds (province vector outlines, country borders, hovered highlight glows)
    drawGlobeSurface(r);
    
    ctx.restore(); // Restore clip bounds

    // 6. Draw foreground overlay items (pins, labels) that reside on front surface but need to bleed out texts
    drawGlobeOverlays(r);
    
    // Frame timer logic (FPS counter)
    if (typeof lastFrameTime !== 'undefined') {
      const fps = Math.round(1000 / (performance.now() - lastFrameTime));
      document.getElementById('hud-fps').textContent = `FPS: ${fps}`;
    }
    window.lastFrameTime = performance.now();
    
    requestAnimationFrame(renderLoop);
  }

  function drawAtmosphere(radius) {
    ctx.save();
    
    // Dynamic atmospheric thick circular gradient using soft sage terrain tones
    const grad = ctx.createRadialGradient(cx, cy, radius - 4, cx, cy, radius + 15);
    grad.addColorStop(0, 'rgba(120, 155, 126, 0.0)');
    grad.addColorStop(0.3, 'rgba(120, 155, 126, 0.04)');
    grad.addColorStop(0.85, 'rgba(120, 155, 126, 0.12)');
    grad.addColorStop(1.0, 'rgba(120, 155, 126, 0.0)');
    
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, radius + 16, 0, Math.PI * 2);
    ctx.fill();
    
    // Fine boundary rim line in soft sage tone
    ctx.strokeStyle = 'rgba(120, 155, 126, 0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();
    
    ctx.restore();
  }

  function drawOuterTechHUD(radius) {
    ctx.save();
    ctx.strokeStyle = 'rgba(120, 155, 126, 0.08)';
    ctx.lineWidth = 1;
    
    // Outer dynamic dashboard coordinate rings
    ctx.beginPath();
    ctx.arc(cx, cy, radius + 40, 0, Math.PI * 2);
    ctx.stroke();
    
    ctx.setLineDash([2, 8]);
    ctx.beginPath();
    ctx.arc(cx, cy, radius + 60, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    
    ctx.restore();
  }

  function getCountryTerrainColor(id, isHovered) {
    if (isHovered) {
      return 'rgba(69, 243, 255, 0.45)'; // Cyber cyan highlighted tint
    }
    
    // Custom terrain palette matching names.txt IDs
    const iceZone = ['ANT', 'CAN', 'RUS', 'GRE', 'NOR', 'SWE', 'FIN', 'ICE'];
    const desertZone = ['AUS', 'EGY', 'ALG', 'LIB', 'SAU', 'YEM', 'OMA', 'PAK', 'AFG', 'IRA', 'KAZ', 'MNG', 'MON', 'SUD'];
    const rainforestZone = ['BRA', 'IND', 'COL', 'VEN', 'PER', 'ECU', 'THA', 'VIE', 'PHI', 'MAL', 'NIG', 'KEN', 'GAB', 'REP', 'DEM'];
    
    if (iceZone.includes(id)) {
      return 'rgba(235, 245, 254, 0.9)'; // Vivid snowy glacier white
    }
    if (desertZone.includes(id)) {
      return 'rgba(240, 196, 125, 0.9)'; // Rich golden desert sand
    }
    if (rainforestZone.includes(id)) {
      return 'rgba(34, 128, 62, 0.9)'; // Vivid tropical rainforest green
    }
    
    // Default: Temperate fertile grasslands / forests
    return 'rgba(76, 155, 94, 0.9)'; // Healthy grass meadow green
  }

  function drawGlobeSurface(radius) {
    // WebGL handles the solid ocean background, depth trenches, elevation terrain textures, and sphere shading.
    // The 2D canvas acts as a high-fidelity vector GIS layer, drawing administrative lines and country borders.

    // 1. Draw Continental Shelf Coastline Glow
    // This gives a beautiful vector neon glow around all coastlines!
    if (window.WORLD_GEOMETRY) {
      ctx.save();
      for (const country of window.WORLD_GEOMETRY) {
        ctx.strokeStyle = 'rgba(69, 243, 255, 0.08)';
        ctx.lineWidth = Math.min(12, 6 * scale);
        if (country.type === "Polygon") {
          drawPoly(country.coordinates, radius, false, true);
        } else if (country.type === "MultiPolygon") {
          for (const poly of country.coordinates) {
            drawPoly(poly, radius, false, true);
          }
        }
      }
      ctx.restore();
    }

    // 2. Province boundaries are now rendered as 3D WebGL lines (loadAndRender3DBoundaries)
    // so the 2D canvas Voronoi province outlines are no longer needed.

    // 3. Draw crisp Country Boundaries and hovered country neon glow
    if (scale >= ZOOM_LOD1 && window.WORLD_GEOMETRY) {
      let opacity = 0.15;
      if (scale > ZOOM_LOD2) opacity = 0.4;
      
      for (const country of window.WORLD_GEOMETRY) {
        const isHovered = hoveredFeature && hoveredFeature.type === 'country' && hoveredFeature.data.id === country.id;
        
        ctx.strokeStyle = isHovered ? 'rgba(69, 243, 255, 0.95)' : `rgba(255, 255, 255, ${opacity})`;
        ctx.lineWidth = isHovered ? 1.5 : 0.6;
        
        if (country.type === "Polygon") {
          drawPoly(country.coordinates, radius, false, true);
        } else if (country.type === "MultiPolygon") {
          for (const poly of country.coordinates) {
            drawPoly(poly, radius, false, true);
          }
        }
        
        // Add dynamic glowing neon fill overlay if hovered to make it pop
        if (isHovered) {
          ctx.fillStyle = 'rgba(69, 243, 255, 0.15)';
          if (country.type === "Polygon") {
            drawPoly(country.coordinates, radius, true, false);
          } else if (country.type === "MultiPolygon") {
            for (const poly of country.coordinates) {
              drawPoly(poly, radius, true, false);
            }
          }
        }
      }
    }


    // 5. Draw Time Zone Lines (时区线) in a sleek tech-cyan dotted vertical style
    ctx.save();
    ctx.strokeStyle = 'rgba(69, 243, 255, 0.20)'; // Technical subtle sci-fi cyan
    ctx.lineWidth = 0.6;
    ctx.setLineDash([1, 3]); // Tech dotted line
    
    for (let k = -12; k <= 11; k++) {
      const lon = k * 15 + 7.5;
      ctx.beginPath();
      let firstPt = true;
      // Draw from pole to pole in small steps to project curved lines accurately on a sphere
      for (let lat = -80; lat <= 80; lat += 2) {
        const [sx, sy, sz] = project(lon, lat, radius);
        if (sz > 0) {
          if (firstPt) {
            ctx.moveTo(sx, sy);
            firstPt = false;
          } else {
            ctx.lineTo(sx, sy);
          }
        } else {
          firstPt = true;
        }
      }
      ctx.stroke();
    }
    
    ctx.restore();

    // 6. Draw the Equator Line (赤道线) in a bright technical orange/gold dashed style
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 100, 50, 0.65)'; // High-visibility technical orange
    ctx.lineWidth = 1.0;
    ctx.setLineDash([4, 4]); // Clean 4px dashed line
    ctx.beginPath();
    let firstEquator = true;
    for (let lon = -180; lon <= 180; lon += 1) {
      const [sx, sy, sz] = project(lon, 0, radius);
      if (sz > 0) {
        if (firstEquator) {
          ctx.moveTo(sx, sy);
          firstEquator = false;
        } else {
          ctx.lineTo(sx, sy);
        }
      } else {
        firstEquator = true;
      }
    }
    ctx.stroke();
    
    // Add text label for Equator in technical sans-serif
    const [esx, esy, esz] = project(0, 0, radius);
    if (esz > 0) {
      ctx.fillStyle = 'rgba(255, 100, 50, 0.8)';
      ctx.font = 'bold 7px var(--font-tech)';
      ctx.textAlign = 'center';
      ctx.fillText('EQUATOR / 赤道', esx, esy - 4);
    }
    ctx.restore();
  }

  function drawPoly(rings, radius, fill = false, stroke = true) {
    for (const ring of rings) {
      ctx.beginPath();
      let first = true;
      for (const pt of ring) {
        const [sx, sy, sz] = project(pt[0], pt[1], radius);
        if (sz > 0) {
          if (first) {
            ctx.moveTo(sx, sy);
            first = false;
          } else {
            ctx.lineTo(sx, sy);
          }
        } else {
          first = true;
        }
      }
      if (fill) {
        ctx.fill();
      }
      if (stroke) {
        ctx.stroke();
      }
    }
  }

  function drawPolyPath(rings, radius) {
    for (const ring of rings) {
      let first = true;
      for (const pt of ring) {
        const [sx, sy, sz] = project(pt[0], pt[1], radius);
        if (sz > 0) {
          if (first) {
            ctx.moveTo(sx, sy);
            first = false;
          } else {
            ctx.lineTo(sx, sy);
          }
        } else {
          first = true;
        }
      }
    }
  }

  function drawOceanTrenches(radius) {
    const trenches = [
      { name: "马里亚纳海沟", coord: [142.2, 11.3], depth: -11000, radius: 8 },
      { name: "波多黎各海沟", coord: [-66.0, 19.5], depth: -8400, radius: 7 },
      { name: "秘鲁-智利海沟", coord: [-76.5, -20.0], depth: -8000, radius: 7 },
      { name: "千岛海沟", coord: [145.0, 40.0], depth: -9000, radius: 6 },
      { name: "琉球海沟", coord: [122.0, 20.0], depth: -7500, radius: 5 }
    ];
    for (const tr of trenches) {
      const [sx, sy, sz] = project(tr.coord[0], tr.coord[1], radius);
      if (sz > 0) {
        const r_tr = Math.max(12, tr.radius * scale * 3.5);
        const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, r_tr);
        grad.addColorStop(0, 'rgba(2, 4, 10, 0.9)');
        grad.addColorStop(0.5, 'rgba(5, 12, 25, 0.6)');
        grad.addColorStop(1.0, 'rgba(5, 12, 25, 0.0)');
        
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(sx, sy, r_tr, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function drawSmoothElevationTerrain(radius) {
    // 1. Fill each country with its beautiful physical terrain base color (follows high-detail country boundaries!)
    if (window.WORLD_GEOMETRY) {
      for (const country of window.WORLD_GEOMETRY) {
        const isHovered = hoveredFeature && hoveredFeature.type === 'country' && hoveredFeature.data.id === country.id;
        const color = getCountryTerrainColor(country.id, isHovered);
        
        ctx.fillStyle = color;
        if (country.type === "Polygon") {
          drawPoly(country.coordinates, radius, true, false);
        } else if (country.type === "MultiPolygon") {
          for (const poly of country.coordinates) {
            drawPoly(poly, radius, true, false);
          }
        }
      }
    }

    // 2. Draw smooth, trans-national deserts and basins as large vector radial gradients (zero blockiness!)
    if (window.GEOGRAPHIC_DATA.basins) {
      for (const bs of window.GEOGRAPHIC_DATA.basins) {
        let colorCenter, colorOuter;
        if (bs.type === 'DESERT' || bs.type === 'DESERT_BASIN') {
          // Beautiful desert sand color
          colorCenter = 'rgba(238, 195, 120, 0.75)';
          colorOuter = 'rgba(238, 195, 120, 0.0)';
        } else {
          // Beautiful rainforest green color
          colorCenter = 'rgba(25, 95, 45, 0.65)';
          colorOuter = 'rgba(25, 95, 45, 0.0)';
        }
        drawRadialGradientOverlay(bs.coord[0], bs.coord[1], bs.radius, colorCenter, colorOuter, radius);
      }
    }

    // 3. Draw smooth mountain range chains (Himalayas, Andes, Rockies, Alps, Great Dividing Range, Urals)
    const ranges = [
      // Himalayas
      { start: [70, 33], end: [98, 27], steps: 7 },
      // Andes
      { start: [-72, -55], end: [-70, 10], steps: 14 },
      // Rockies
      { start: [-115, 32], end: [-120, 60], steps: 11 },
      // Alps
      { start: [5, 44], end: [15, 47], steps: 5 },
      // Great Dividing Range (Australia East Coast)
      { start: [145, -38], end: [142, -15], steps: 6 },
      // Urals
      { start: [60, 50], end: [60, 67], steps: 6 }
    ];

    for (const range of ranges) {
      for (let s = 0; s <= range.steps; s++) {
        const t = s / range.steps;
        const lon = range.start[0] + (range.end[0] - range.start[0]) * t;
        const lat = range.start[1] + (range.end[1] - range.start[1]) * t;
        
        const [sx, sy, sz] = project(lon, lat, radius);
        if (sz > 0) {
          const screenR = 6.0 * (Math.PI * radius / 180);
          const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, screenR);
          grad.addColorStop(0, 'rgba(165, 110, 75, 0.45)'); // Warm mountain range brown
          grad.addColorStop(0.4, 'rgba(125, 80, 50, 0.25)');
          grad.addColorStop(1.0, 'rgba(0, 0, 0, 0)');
          
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(sx, sy, screenR, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // 4. Draw individual high snowy peaks as prominent relief gradients
    if (window.GEOGRAPHIC_DATA.mountains) {
      for (const mt of window.GEOGRAPHIC_DATA.mountains) {
        const [sx, sy, sz] = project(mt.coord[0], mt.coord[1], radius);
        if (sz > 0) {
          const screenR = 5.0 * (Math.PI * radius / 180);
          const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, screenR);
          grad.addColorStop(0, 'rgba(255, 255, 255, 0.9)'); // Snowy white peak
          grad.addColorStop(0.25, 'rgba(195, 135, 95, 0.7)'); // Medium brown peak slope
          grad.addColorStop(0.55, 'rgba(135, 85, 55, 0.35)'); // Outer peak slope
          grad.addColorStop(1.0, 'rgba(0, 0, 0, 0)');
          
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(sx, sy, screenR, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  function drawRadialGradientOverlay(lon, lat, geoRadius, colorCenter, colorOuter, radius) {
    const [sx, sy, sz] = project(lon, lat, radius);
    if (sz <= 0) return;
    
    const screenR = geoRadius * (Math.PI * radius / 180);
    if (screenR <= 1) return;
    
    const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, screenR);
    grad.addColorStop(0, colorCenter);
    grad.addColorStop(1, colorOuter);
    
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(sx, sy, screenR, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawAdministrativeBoundaries(radius) {
    if (!window.WORLD_GEOMETRY) return;
    
    // Find China and USA features (handle both standard CHN/USA and geometry-compiled CHI/UNI)
    const targetCountries = window.WORLD_GEOMETRY.filter(c => c.id === 'CHN' || c.id === 'CHI' || c.id === 'USA' || c.id === 'UNI');
    
    for (const country of targetCountries) {
      ctx.save();
      
      // Build clipping path strictly inside this country's landmass
      ctx.beginPath();
      if (country.type === "Polygon") {
        drawPolyPath(country.coordinates, radius);
      } else if (country.type === "MultiPolygon") {
        for (const poly of country.coordinates) {
          drawPolyPath(poly, radius);
        }
      }
      ctx.clip();
      
      // 1. Draw Province Boundaries via mathematically precise cached Voronoi cells
      const countryKey = (country.id === 'CHN' || country.id === 'CHI') ? 'CHN' : 'USA';
      const cells = cachedVoronoiCells ? cachedVoronoiCells[countryKey] : null;
      
      if (cells) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
        ctx.lineWidth = 0.8;
        ctx.setLineDash([]);
        
        for (const cell of cells) {
          if (cell.polygon && cell.polygon.length > 0) {
            ctx.beginPath();
            let first = true;
            for (const pt of cell.polygon) {
              const [sx, sy, sz] = project(pt[0], pt[1], radius);
              if (sz > 0) {
                if (first) {
                  ctx.moveTo(sx, sy);
                  first = false;
                } else {
                  ctx.lineTo(sx, sy);
                }
              } else {
                first = true;
              }
            }
            ctx.closePath();
            ctx.stroke();
          }
        }
      }
      
      ctx.restore();
    }
  }

  function drawGlobeOverlays(radius) {
    ctx.save();
    
    // A. Label Oceans and Continents (ZOOM_LOD1)
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    if (scale <= ZOOM_LOD2) {
      // Oceans
      ctx.font = '9px var(--font-tech)';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
      for (const oc of window.GEOGRAPHIC_DATA.oceans) {
        const [sx, sy, sz] = project(oc.centroid[0], oc.centroid[1], radius);
        if (sz > 20) {
          ctx.fillText(oc.name, sx, sy);
        }
      }
      
      // Continents
      for (const cont of window.GEOGRAPHIC_DATA.continents) {
        const [sx, sy, sz] = project(cont.centroid[0], cont.centroid[1], radius);
        if (sz > 20) {
          const isHovered = hoveredFeature && hoveredFeature.type === 'continent' && hoveredFeature.data.id === cont.id;
          if (isHovered) {
            ctx.fillStyle = '#45f3ff'; // Stark tech-cyan accent for focused continent
            ctx.font = 'bold 11px var(--font-tech)';
            ctx.fillText(`[ ${cont.name} ]`, sx, sy);
            
            // Draw subtle targeting ring
            ctx.strokeStyle = 'rgba(69, 243, 255, 0.5)';
            ctx.lineWidth = 1.0;
            ctx.beginPath();
            ctx.arc(sx, sy, 22, 0, Math.PI * 2);
            ctx.stroke();
          } else {
            ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
            ctx.font = 'bold 10px var(--font-tech)';
            ctx.fillText(`[ ${cont.name} ]`, sx, sy);
          }
        }
      }
    }

    // D. Show marginal seas (when scale > ZOOM_LOD2)
    if (scale > ZOOM_LOD2 && window.GEOGRAPHIC_DATA.marginalSeas) {
      ctx.font = 'italic 9px var(--font-tech)';
      ctx.fillStyle = 'rgba(69, 243, 255, 0.45)';
      for (const sea of window.GEOGRAPHIC_DATA.marginalSeas) {
        const [sx, sy, sz] = project(sea.centroid[0], sea.centroid[1], radius);
        if (sz > 0) {
          ctx.fillText(sea.name, sx, sy);
        }
      }
    }

    // B. Show country names (ZOOM_LOD2 to ZOOM_LOD3)
    if (scale > ZOOM_LOD1 && scale <= ZOOM_LOD3 && window.WORLD_GEOMETRY) {
      ctx.font = '8px var(--font-tech)';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
      
      // Render simple country label anchors based on centroid logic
      for (let i = 0; i < window.WORLD_GEOMETRY.length; i += 3) { // Staggered to prevent cluttering
        const country = window.WORLD_GEOMETRY[i];
        // Fetch approximate single point
        if (country.coordinates && country.coordinates[0]) {
          const pt = country.coordinates[0][0][0] ? country.coordinates[0][0][0] : country.coordinates[0][0];
          if (pt && pt[0]) {
            const [sx, sy, sz] = project(pt[0], pt[1], radius);
            if (sz > 50) {
              ctx.fillText(country.name, sx, sy);
            }
          }
        }
      }
    }

    // C. High detail: Show cities (ZOOM_LOD3)
    if (scale > ZOOM_LOD2) {

      // 3. Cities crosshairs
      for (const city of window.GEOGRAPHIC_DATA.cities) {
        const [sx, sy, sz] = project(city.coord[0], city.coord[1], radius);
        if (sz > 0) {
          const isHovered = hoveredFeature && hoveredFeature.type === 'city' && hoveredFeature.data.name === city.name;
          
          ctx.strokeStyle = isHovered ? '#ffffff' : 'rgba(255, 255, 255, 0.4)';
          ctx.lineWidth = 0.8;
          
          // Draw standard Bauhaus crosshair symbol '+'
          ctx.beginPath();
          ctx.moveTo(sx - 4, sy); ctx.lineTo(sx + 4, sy);
          ctx.moveTo(sx, sy - 4); ctx.lineTo(sx, sy + 4);
          ctx.stroke();
          
          if (isHovered) {
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(sx, sy, 1.5, 0, Math.PI * 2);
            ctx.fill();
          }

          // Render city text next to it
          ctx.textAlign = 'left';
          ctx.font = '9px var(--font-tech)';
          ctx.fillStyle = isHovered ? '#ffffff' : 'rgba(255, 255, 255, 0.65)';
          ctx.fillText(city.name, sx + 8, sy + 1);
          ctx.textAlign = 'center';
        }
      }
    }

    // Draw high-tech targeted location reticle/marker
    if (selectedLocation) {
      const [sx, sy, sz] = project(selectedLocation.lon, selectedLocation.lat, radius);
      if (sz > 0) {
        ctx.save();
        
        // 1. Tech-cyan targeting circle
        ctx.strokeStyle = '#45f3ff'; // neon tech cyan
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(sx, sy, 12, 0, Math.PI * 2);
        ctx.stroke();

        // 2. Pulse outer ring using sine wave
        const pulse = 12 + 6 * Math.sin(performance.now() * 0.008);
        ctx.strokeStyle = 'rgba(69, 243, 255, 0.4)';
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.arc(sx, sy, pulse, 0, Math.PI * 2);
        ctx.stroke();

        // 3. Bauhaus targeted crosshair marks
        ctx.strokeStyle = '#45f3ff';
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.moveTo(sx - 18, sy); ctx.lineTo(sx - 8, sy);
        ctx.moveTo(sx + 8, sy); ctx.lineTo(sx + 18, sy);
        ctx.moveTo(sx, sy - 18); ctx.lineTo(sx, sy - 8);
        ctx.moveTo(sx, sy + 8); ctx.lineTo(sx, sy + 18);
        ctx.stroke();

        // 4. Centered target dot
        ctx.fillStyle = '#45f3ff';
        ctx.beginPath();
        ctx.arc(sx, sy, 2, 0, Math.PI * 2);
        ctx.fill();

        // 5. Technical details label text
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 9px var(--font-tech)';
        ctx.textAlign = 'left';
        ctx.fillText(`[ 定位坐标锚定: ${selectedLocation.name} ]`, sx + 22, sy - 4);
        
        ctx.fillStyle = 'rgba(69, 243, 255, 0.85)';
        ctx.font = '8px var(--font-tech)';
        ctx.fillText(`LAT:${selectedLocation.lat.toFixed(2)} LON:${selectedLocation.lon.toFixed(2)}`, sx + 22, sy + 6);
        
        ctx.restore();
      }
    }

    ctx.restore();
  }

  function getFeatureAtScreen(mouseX, mouseY) {
    const r = BASE_RADIUS * scale;
    const geo = unproject(mouseX, mouseY, r);
    if (!geo) return null;

    const hLat = geo.lat;
    const hLon = geo.lon;

    // 1. Check cities first (most precise click)
    let bestCity = null;
    let minCityDist = Infinity;
    for (const city of window.GEOGRAPHIC_DATA.cities) {
      const [sx, sy, sz] = project(city.coord[0], city.coord[1], r);
      if (sz > 0) {
        const dist = Math.hypot(mouseX - sx, mouseY - sy);
        if (dist < 18 && dist < minCityDist) { // 18px hit radius for double-click city selection
          minCityDist = dist;
          bestCity = { type: 'city', data: city, coords: [city.coord[1], city.coord[0]] };
        }
      }
    }
    if (bestCity) return bestCity;

    // Mountains and basins selection bypassed per user request

    // 4. Check continents (at lower zoom levels)
    if (scale <= ZOOM_LOD2) {
      for (const cont of window.GEOGRAPHIC_DATA.continents) {
        const [sx, sy, sz] = project(cont.centroid[0], cont.centroid[1], r);
        if (sz > 0) {
          const dist = Math.hypot(mouseX - sx, mouseY - sy);
          if (dist < 28) {
            return { type: 'continent', data: cont, coords: [cont.centroid[1], cont.centroid[0]] };
          }
        }
      }
    }

    // 5. Default to country check
    let country = getCountryAtCoordCached(hLon, hLat);
    if (!country) {
      country = getCountryAtCoord(hLon, hLat);
    }
    if (country) {
      return { type: 'country', data: country, coords: [hLat, hLon] };
    }

    // 6. Check marginal seas
    const sea = getMarginalSeaAtCoord(hLon, hLat);
    if (sea) {
      return { type: 'ocean', data: { name: sea.name, isMarginal: true, desc: sea.desc }, coords: [hLat, hLon] };
    }

    // 7. Oceans
    let bestOcean = "海洋网格";
    let minDist = Infinity;
    for (const oc of window.GEOGRAPHIC_DATA.oceans) {
      const dist = Math.hypot(hLon - oc.centroid[0], hLat - oc.centroid[1]);
      if (dist < minDist) {
        minDist = dist;
        bestOcean = oc.name;
      }
    }
    return { type: 'ocean', data: { name: bestOcean }, coords: [hLat, hLon] };
  }

  function setSelectedLocation(lon, lat, name) {
    if (lon === null || lat === null) {
      selectedLocation = null;
    } else {
      selectedLocation = { lon: lon, lat: lat, name: name };
    }
  }

  // Export properties
  window.GLOBE_ENGINE = {
    init: init,
    project: project,
    unproject: unproject,
    getFeatureAtScreen: getFeatureAtScreen,
    getCountryAtCoordCached: getCountryAtCoordCached,
    flyTo: flyTo,
    stopDrag: function() { isDragging = false; isRealDrag = false; velX = 0; velY = 0; },
    getRotations: function() { return { rotX: rotX, rotY: rotY }; },
    getScale: function() { return scale; },
    getCenter: function() { return { cx: cx, cy: cy }; },
    setRotations: function(rx, ry) { targetRotX = rx; targetRotY = ry; rotX = rx; rotY = ry; },
    setSelectedLocation: setSelectedLocation
  };
})();
