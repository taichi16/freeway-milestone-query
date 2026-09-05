/**
 * 國道百公尺里程查詢系統 - 前端主程式 (app.js)
 * 包含 IndexedDB 管理、CSV 下載與解析、地圖 (Canvas/動態視區過濾)、極速最近鄰查詢與一鍵更新
 */

// ==========================================================================
// 1. IndexedDB 核心模組 (Promise 封裝)
// ==========================================================================
const DB_NAME = 'Freeway_Milestone_DB';
const DB_VERSION = 1;
const STORE_NAME = 'app_data';

function getDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };
        request.onsuccess = (e) => resolve(e.target.result);
        request.onerror = (e) => reject(e.target.error);
    });
}

function dbGet(key) {
    return getDB().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    }));
}

function dbSet(key, val) {
    return getDB().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(val, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    }));
}

// ==========================================================================
// 2. 全域狀態與變數
// ==========================================================================
let allMilestones = [];          // 10,088 筆里程樁扁平數據
let roadGrouped = {};            // 依國道名稱分組 (國1, 國3...) 且已排序
let map = null;                  // Leaflet 地圖實例
let canvasRenderer = null;       // Leaflet Canvas 渲染器 (繪製 100m 點)

// 地圖圖層組 (Layer Groups)
let roadLinesLayer = null;       // 國道主線折線圖層組 (永遠繪製)
let milestonePointsLayer = null; // 里程圓點圖層組 (大比例尺時動態繪製)
let searchVisualLayer = null;    // 查詢標記與連接線圖層組
let currentTileLayer = null;     // 當前底圖圖層實例
let currentTheme = 'light';      // 當前色彩主題 ('light' 或 'dark')
let currentBaseMapId = 'nlsc';   // 當前淺色底圖偏好 ('nlsc', 'esriLight', 'osm')
let layerControl = null;         // Leaflet 圖層控制元件

// 免費、免 API Key、無浮水印的優質圖資配置
const BASEMAP_CONFIG = {
    // 1. 臺灣通用電子地圖 (內政部國土測繪中心) - 台灣官方級別詳細圖資，路網與交流道最精確
    nlsc: {
        name: '🇹🇼 臺灣通用電子地圖',
        create: () => L.tileLayer('https://wmts.nlsc.gov.tw/wmts/EMAP/default/GoogleMapsCompatible/{z}/{y}/{x}', {
            attribution: '&copy; <a href="https://maps.nlsc.gov.tw/" target="_blank" rel="noopener">內政部國土測繪中心</a>',
            maxZoom: 19
        })
    },
    // 2. ESRI 極簡淺灰底圖 - 數據視覺化無干擾簡潔白灰風格 (無浮水印)
    esriLight: {
        name: '⚪ 極簡淺灰底圖',
        create: () => L.layerGroup([
            L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
                attribution: 'Tiles &copy; Esri',
                maxZoom: 16
            }),
            L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}', {
                maxZoom: 16
            })
        ])
    },
    // 3. OpenStreetMap 開放街圖
    osm: {
        name: '🌍 OpenStreetMap',
        create: () => L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
            maxZoom: 19
        })
    },
    // 4. ESRI 深灰極簡底圖 - 深色模式專用 (無浮水印)
    esriDark: {
        name: '🌙 深黑極簡底圖',
        create: () => L.layerGroup([
            L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
                attribution: 'Tiles &copy; Esri',
                maxZoom: 16
            }),
            L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', {
                maxZoom: 16
            })
        ])
    }
};

// 當前選取狀態
let selectedMilestone = null;    // 當前選取的里程樁
let queryCoordinates = null;     // 使用者輸入/點擊的座標 [lat, lng]
let activeRoad = null;           // 當前選取/高亮的國道 (如 '國1')
let currentTab = 'coords';       // 當前分頁 ('coords', 'roads', 'about')

// ==========================================================================
// 3. 初始化與資料載入
// ==========================================================================
document.addEventListener('DOMContentLoaded', async () => {
    // 初始化色彩主題 (預設淺色，自快取讀取)
    initTheme();

    // 渲染 Lucide SVG 圖標
    lucide.createIcons();
    
    // 初始化 Leaflet 地圖
    initMap();
    
    // 設定自動偵測 GitHub 儲存庫連結
    setupRepoLink();
    
    // 綁定 DOM 事件
    bindEvents();
    
    // 開始資料庫載入與更新流程
    await loadDataFlow();
});

/**
 * 初始化主題模式
 */
function initTheme() {
    const savedTheme = localStorage.getItem('freeway_theme') || 'light';
    currentBaseMapId = localStorage.getItem('freeway_basemap') || 'nlsc';
    applyTheme(savedTheme, false);
}

/**
 * 切換深淺色彩主題
 */
function toggleTheme() {
    const nextTheme = currentTheme === 'light' ? 'dark' : 'light';
    applyTheme(nextTheme, true);
}

/**
 * 套用主題設定 (更新 DOM, 按鈕圖示與地圖圖層)
 */
function applyTheme(theme, save = true) {
    currentTheme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    if (save) {
        localStorage.setItem('freeway_theme', theme);
    }
    
    // 更新主題按鈕圖示與懸浮標題
    const themeBtn = document.getElementById('theme-toggle-btn');
    const themeIcon = document.getElementById('theme-icon');
    if (themeIcon) {
        if (theme === 'light') {
            themeIcon.setAttribute('data-lucide', 'moon');
            if (themeBtn) themeBtn.setAttribute('title', '切換為深色模式');
        } else {
            themeIcon.setAttribute('data-lucide', 'sun');
            if (themeBtn) themeBtn.setAttribute('title', '切換為淺色模式');
        }
        lucide.createIcons();
    }
    
    // 若地圖已初始化，動態更新底圖圖層與控制選單
    if (map) {
        setupLayerControl();
    }
}

/**
 * 建立與更新 Leaflet 底圖圖層控制選單 (Layer Switcher)
 */
function setupLayerControl() {
    if (!map) return;
    
    // 移除舊有圖層切換控制項
    if (layerControl) {
        map.removeControl(layerControl);
        layerControl = null;
    }
    
    // 移除現有底圖圖層
    if (currentTileLayer) {
        map.removeLayer(currentTileLayer);
        currentTileLayer = null;
    }
    
    if (currentTheme === 'light') {
        const lightBaseMaps = {
            '🇹🇼 臺灣通用電子地圖': BASEMAP_CONFIG.nlsc.create(),
            '⚪ 極簡淺灰底圖': BASEMAP_CONFIG.esriLight.create(),
            '🌍 OpenStreetMap': BASEMAP_CONFIG.osm.create()
        };
        
        // 依使用者的偏好載入對應圖層
        const defaultLayer = currentBaseMapId === 'esriLight' ? lightBaseMaps['⚪ 極簡淺灰底圖']
                           : currentBaseMapId === 'osm' ? lightBaseMaps['🌍 OpenStreetMap']
                           : lightBaseMaps['🇹🇼 臺灣通用電子地圖'];
        
        currentTileLayer = defaultLayer;
        currentTileLayer.addTo(map);
        if (currentTileLayer.bringToBack) {
            currentTileLayer.bringToBack();
        }
        
        // 加入圖層控制面板 (右上角)
        layerControl = L.control.layers(lightBaseMaps, null, {
            position: 'topright',
            collapsed: true
        }).addTo(map);
        
        // 監聽圖層切換並記憶偏好
        map.on('baselayerchange', (e) => {
            currentTileLayer = e.layer;
            if (e.name.includes('通用電子地圖')) {
                currentBaseMapId = 'nlsc';
            } else if (e.name.includes('淺灰')) {
                currentBaseMapId = 'esriLight';
            } else if (e.name.includes('OpenStreetMap')) {
                currentBaseMapId = 'osm';
            }
            localStorage.setItem('freeway_basemap', currentBaseMapId);
            if (currentTileLayer.bringToBack) {
                currentTileLayer.bringToBack();
            }
        });
    } else {
        // 深色模式下直接載入深黑極簡底圖 (無浮水印)
        currentTileLayer = BASEMAP_CONFIG.esriDark.create();
        currentTileLayer.addTo(map);
        if (currentTileLayer.bringToBack) {
            currentTileLayer.bringToBack();
        }
    }
}

/**
 * 載入資料流程 (檢查快取 -> 載入/下載)
 */
async function loadDataFlow() {
    const loadingOverlay = document.getElementById('loading-overlay');
    const loadingProgress = document.getElementById('loading-progress');
    const loadingStatus = document.getElementById('loading-status');
    
    try {
        loadingStatus.textContent = "正在檢查本地快取...";
        loadingProgress.style.width = "15%";
        
        const cachedMeta = await dbGet('metadata');
        const cachedData = await dbGet('milestones');
        
        if (cachedMeta && cachedData && cachedData.length > 0) {
            loadingStatus.textContent = "正在自快取載入國道里程點...";
            loadingProgress.style.width = "60%";
            
            allMilestones = cachedData;
            processMilestones();
            
            loadingProgress.style.width = "100%";
            setTimeout(() => {
                loadingOverlay.classList.add('fade-out');
            }, 300);
            
            updateVersionStatus(cachedMeta);
            return;
        }
        
        // 無快取，下載最新版本
        loadingStatus.textContent = "首次載入，正在讀取版本配置...";
        loadingProgress.style.width = "30%";
        
        const metaRes = await fetch('metadata.json?t=' + Date.now());
        if (!metaRes.ok) throw new Error("下載 metadata 失敗");
        const meta = await metaRes.json();
        
        loadingStatus.textContent = `正在下載里程數據 (${(meta.csv_size / 1024).toFixed(1)} KB)...`;
        loadingProgress.style.width = "60%";
        
        const csvRes = await fetch('data/freeway_milestones.csv?t=' + Date.now());
        if (!csvRes.ok) throw new Error("下載里程 CSV 失敗");
        const csvText = await csvRes.text();
        
        loadingStatus.textContent = "正在重組資料庫...";
        loadingProgress.style.width = "85%";
        
        // 解析 CSV 數據
        allMilestones = parseCSVData(csvText);
        
        // 快取至 IndexedDB
        await dbSet('metadata', meta);
        await dbSet('milestones', allMilestones);
        
        processMilestones();
        
        loadingProgress.style.width = "100%";
        loadingStatus.textContent = "載入完成！";
        
        setTimeout(() => {
            loadingOverlay.classList.add('fade-out');
        }, 500);
        
        updateVersionStatus(meta);
        
    } catch (error) {
        console.error("初始化資料流失敗:", error);
        loadingStatus.textContent = "載入失敗，請檢查網路連線並重新整理網頁！";
        loadingStatus.style.color = "#ef4444";
        document.getElementById('loading-title').textContent = "系統載入錯誤";
    }
}

/**
 * 解析里程 CSV (欄位: road,direction,km,milestone,lat,lng,elevation)
 */
function parseCSVData(csvText) {
    const parsed = Papa.parse(csvText, {
        header: true,
        skipEmptyLines: true
    });
    
    const results = [];
    parsed.data.forEach((row, index) => {
        const lat = parseFloat(row.lat);
        const lng = parseFloat(row.lng);
        const road = row.road;
        if (isNaN(lat) || isNaN(lng) || !road) return;
        
        results.push({
            id: index,
            road: road,
            direction: row.direction || 'M',
            km: parseInt(row.km) || 0,
            milestone: row.milestone || '',
            lat: lat,
            lng: lng,
            elevation: row.elevation ? parseFloat(row.elevation).toFixed(2) : '-'
        });
    });
    
    return results;
}

/**
 * 預處理里程資料 (按國道分組與物理排序)
 */
function processMilestones() {
    roadGrouped = {};
    
    allMilestones.forEach(p => {
        if (!roadGrouped[p.road]) {
            roadGrouped[p.road] = [];
        }
        roadGrouped[p.road].push(p);
    });
    
    // 將每條國道之里程樁按累積公尺排序
    for (let r in roadGrouped) {
        roadGrouped[r].sort((a, b) => a.km - b.km);
    }
    
    // 渲染左側國道列表分頁
    renderRoadList();
    
    // 繪製地圖上的所有國道路網軌跡線 (Polyline)
    drawAllRoadLinesOnMap();
}

// ==========================================================================
// 4. 地圖渲染與視區優化 (Canvas & Viewport Filter)
// ==========================================================================
function initMap() {
    map = L.map('map', {
        zoomControl: true,
        attributionControl: true
    }).setView([23.7, 120.95], 8);
    
    // 依目前主題與底圖偏好載入無浮水印圖資與圖層切換選單
    setupLayerControl();
    
    // 建立專用 Canvas 渲染器以追求超高效能
    canvasRenderer = L.canvas();
    
    // 初始化圖層組
    roadLinesLayer = L.layerGroup().addTo(map);
    milestonePointsLayer = L.layerGroup().addTo(map);
    searchVisualLayer = L.layerGroup().addTo(map);
    
    // 地圖縮放/平移時，觸發里程圓點的動態視區過濾繪製
    map.on('zoomend moveend', () => {
        updateMilestonePointsOnMap();
    });
    
    // 地圖點擊：自動查詢最近里程樁
    map.on('click', (e) => {
        const lat = e.latlng.lat;
        const lng = e.latlng.lng;
        
        // 顯示懸浮 Toast
        showMapToast("已在地圖上選取座標，正在尋找最近里程...");
        
        // 填入輸入欄位
        document.getElementById('input-lat').value = lat.toFixed(6);
        document.getElementById('input-lng').value = lng.toFixed(6);
        
        // 執行查詢
        findNearestMilestones(lat, lng);
    });
}

/**
 * 顯示地圖懸浮通知
 */
function showMapToast(text) {
    const toast = document.getElementById('map-toast');
    toast.textContent = text;
    toast.classList.remove('hide');
    setTimeout(() => {
        toast.classList.add('hide');
    }, 2500);
}

/**
 * 繪製國道路網折線 (小於 11 級只看得到線，超流暢)
 */
function drawAllRoadLinesOnMap() {
    roadLinesLayer.clearLayers();
    
    for (let roadName in roadGrouped) {
        const pts = roadGrouped[roadName];
        if (pts.length < 2) continue;
        
        const latLngs = pts.map(p => [p.lat, p.lng]);
        
        // 國道使用綠色系線段，配合主題
        L.polyline(latLngs, {
            color: '#059669',
            weight: 3.5,
            opacity: 0.7,
            dashArray: '2, 5' // 虛線使高架/一般路段看起來更具設計感
        }).addTo(roadLinesLayer);
    }
}

/**
 * 核心效能優化：根據當前 Viewport 與 Zoom 渲染里程樁圓點 (Canvas 繪製)
 */
function updateMilestonePointsOnMap() {
    milestonePointsLayer.clearLayers();
    
    const zoom = map.getZoom();
    // 效能門檻：縮放層級小於 11 時，不顯示 10,000 點里程點，防止畫面過於雜亂與手機卡頓
    if (zoom < 11) return;
    
    const bounds = map.getBounds();
    
    // 決定要過濾的里程點集合：若有指定 activeRoad 則只畫該國道；否則過濾全部
    const sourcePoints = activeRoad ? (roadGrouped[activeRoad] || []) : allMilestones;
    
    // 獲取目前螢幕內 (Viewport) 的點
    const visiblePoints = sourcePoints.filter(p => bounds.contains([p.lat, p.lng]));
    
    // 為防止地圖縮放至 11-12 級時，視區內點依然過多 (如跨縣市)，限制 Canvas 單次繪製上限為 1200 點
    const renderLimit = 1200;
    const pointsToDraw = visiblePoints.slice(0, renderLimit);
    
    pointsToDraw.forEach(p => {
        // 使用 CircleMarker + Canvas 渲染器，1ms 可畫上千個點且不佔 DOM 節點
        const marker = L.circleMarker([p.lat, p.lng], {
            renderer: canvasRenderer,
            radius: 4.5,
            fillColor: '#059669',
            color: '#ffffff',
            weight: 1.5,
            opacity: 0.95,
            fillOpacity: 0.9
        });
        
        // 點擊事件
        marker.on('click', (e) => {
            L.DomEvent.stopPropagation(e); // 阻止地圖 click 事件觸發二次查詢
            selectMilestone(p);
        });
        
        // 綁定提示 Popup
        marker.bindPopup(`
            <div style="font-weight:bold; font-size:13px; color:var(--accent-color); margin-bottom:2px;">${p.road} • ${p.milestone}</div>
            <div style="font-size:12px;">方向：${getDirectionLabel(p.direction)}</div>
            <div style="margin-top:4px;"><a href="javascript:void(0)" onclick="window.appSelectFreewayPt(${p.id})" style="color:var(--accent-color); font-weight:bold;">選取此點 &rarr;</a></div>
        `);
        
        marker.addTo(milestonePointsLayer);
    });
    
    // 全域註冊點擊連結回呼
    window.appSelectFreewayPt = (id) => {
        const found = allMilestones.find(x => x.id === id);
        if (found) selectMilestone(found);
    };
}

/**
 * 清除與重置查詢視覺標記 (輸入點、最近點、連接線)
 */
function clearSearchVisuals() {
    searchVisualLayer.clearLayers();
}

/**
 * 在地圖上繪製查詢點、最近鄰點與虛線連接，並調整地圖區域以容納兩者
 */
function drawSearchQueryOnMap(queryLatLng, closestPoint) {
    clearSearchVisuals();
    
    const targetLatLng = [closestPoint.lat, closestPoint.lng];
    
    // 1. 繪製使用者查詢輸入點 (琥珀金/橘黃光圈)
    const queryMarker = L.marker(queryLatLng, {
        icon: L.divIcon({
            className: 'query-pin',
            html: `<div style="
                width: 14px; 
                height: 14px; 
                background-color: #d97706; 
                border: 2px solid #ffffff; 
                border-radius: 50%;
                box-shadow: 0 0 10px rgba(217, 119, 6, 0.6), 0 2px 4px rgba(0,0,0,0.2);
            "></div>`,
            iconSize: [14, 14],
            iconAnchor: [7, 7]
        })
    }).addTo(searchVisualLayer);
    queryMarker.bindPopup(`<div style="font-size:12px; font-weight:bold;">您的查詢座標：<br>${queryLatLng[0].toFixed(6)}, ${queryLatLng[1].toFixed(6)}</div>`);
    
    // 2. 繪製最近里程點 (國道綠大發光點)
    const targetMarker = L.marker(targetLatLng, {
        icon: L.divIcon({
            className: 'target-pin',
            html: `<div style="
                width: 18px; 
                height: 18px; 
                background-color: #059669; 
                border: 3px solid #ffffff; 
                border-radius: 50%;
                box-shadow: 0 0 14px rgba(5, 150, 105, 0.6), 0 2px 5px rgba(0,0,0,0.25);
            "></div>`,
            iconSize: [18, 18],
            iconAnchor: [9, 9]
        })
    }).addTo(searchVisualLayer);
    
    targetMarker.bindPopup(`
        <div style="font-weight:bold; font-size:13px; color:#059669;">最近里程：${closestPoint.road} ${closestPoint.milestone}</div>
        <div style="font-size:12px;">海平面高度：${closestPoint.elevation}m</div>
    `);
    
    // 3. 連接虛線
    L.polyline([queryLatLng, targetLatLng], {
        color: '#d97706',
        weight: 2.5,
        opacity: 0.85,
        dashArray: '5, 5'
    }).addTo(searchVisualLayer);
    
    // 4. 自動適應地圖視角，讓使用者同時看到兩點
    const bounds = L.latLngBounds([queryLatLng, targetLatLng]);
    map.fitBounds(bounds, {
        padding: [80, 80],
        maxZoom: 16,
        animate: true,
        duration: 1.2
    });
}

// ==========================================================================
// 5. 最近鄰查詢引擎 (Euclidean 1ms + Haversine 距離)
// ==========================================================================

/**
 * Haversine 經緯度公式計算兩點間的實際地表球面距離 (公尺)
 */
function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // 地球半徑 (公尺)
    const phi1 = lat1 * Math.PI / 180;
    const phi2 = lat2 * Math.PI / 180;
    const deltaPhi = (lat2 - lat1) * Math.PI / 180;
    const deltaLambda = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
              Math.cos(phi1) * Math.cos(phi2) *
              Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c; // 回傳公尺數
}

/**
 * 尋找距離目標座標最近的里程樁
 */
function findNearestMilestones(lat, lng) {
    queryCoordinates = [lat, lng];
    
    const t0 = performance.now();
    
    // 核心效能點：第一階段使用「歐氏距離平方」(Euclidean Dist Squared) 快速比對
    // 僅使用加減與乘法，無三角函數、無平方根開方，10,000 點比對僅需 0.5 ~ 1 毫秒
    let candidates = allMilestones.map(p => {
        const dLat = lat - p.lat;
        const dLng = lng - p.lng;
        const distSq = dLat * dLat + dLng * dLng;
        return { point: p, distSq: distSq };
    });
    
    // 依平方距離升序排序
    candidates.sort((a, b) => a.distSq - b.distSq);
    
    // 篩選出歐氏距離最近的前 5 筆候選點
    const topCandidates = candidates.slice(0, 5);
    
    // 第二階段對前 5 點計算精確 Haversine 球面距離
    const results = topCandidates.map(c => {
        const dist = haversineDistance(lat, lng, c.point.lat, c.point.lng);
        return {
            point: c.point,
            distance: dist
        };
    });
    
    // 再次依精確距離排序 (確保高架與平面平行路段順序正確)
    results.sort((a, b) => a.distance - b.distance);
    
    const t1 = performance.now();
    console.log(`最近鄰查詢時間: ${(t1 - t0).toFixed(3)} 毫秒`);
    
    // 渲染結果列表
    renderSearchResults(results);
    
    // 預設選取最近的那一個點
    if (results.length > 0) {
        selectMilestone(results[0].point, results[0].distance);
        // 地圖繪製
        drawSearchQueryOnMap(queryCoordinates, results[0].point);
    }
}

/**
 * 渲染最近比對結果列表
 */
function renderSearchResults(results) {
    const listEl = document.getElementById('results-list');
    listEl.innerHTML = '';
    
    document.getElementById('search-welcome').classList.add('hide');
    document.getElementById('search-results-section').classList.remove('hide');
    
    results.forEach((res, index) => {
        const p = res.point;
        const dist = res.distance;
        
        const li = document.createElement('li');
        li.dataset.id = p.id;
        li.dataset.dist = dist;
        if (selectedMilestone && selectedMilestone.id === p.id) li.classList.add('active');
        
        // 格式化距離：小於 1000m 顯示公尺，大於顯示公里
        const distStr = dist < 1000 ? `${Math.round(dist)} 公尺` : `${(dist / 1000).toFixed(2)} 公里`;
        
        li.innerHTML = `
            <div class="list-item-left">
                <i data-lucide="navigation" class="list-icon"></i>
                <div>
                    <div class="list-item-title">${p.road} • ${p.milestone}</div>
                    <div class="list-item-sub">方向：${getDirectionLabel(p.direction)} • 海拔: ${p.elevation}m</div>
                </div>
            </div>
            <span class="distance-text">${distStr}</span>
        `;
        
        li.addEventListener('click', () => {
            selectMilestone(p, dist);
            drawSearchQueryOnMap(queryCoordinates, p);
        });
        
        listEl.appendChild(li);
    });
    
    lucide.createIcons({ attrs: { class: 'list-icon' } });
}

// ==========================================================================
// 6. 介面渲染與分頁切換
// ==========================================================================

/**
 * 渲染國道公路列表分頁 (Tab 2)
 */
function renderRoadList() {
    const listEl = document.getElementById('road-list');
    listEl.innerHTML = '';
    
    const roads = Object.keys(roadGrouped).sort((a, b) => {
        return a.localeCompare(b, 'zh-Hant-TW', { numeric: true });
    });
    
    roads.forEach(road => {
        const pts = roadGrouped[road];
        const count = pts.length;
        const start = pts[0].milestone;
        const end = pts[count-1].milestone;
        
        const li = document.createElement('li');
        li.dataset.road = road;
        if (activeRoad === road) li.classList.add('active');
        
        li.innerHTML = `
            <div class="list-item-left">
                <i data-lucide="milestone" class="list-icon"></i>
                <div>
                    <div class="list-item-title">${road}線百公尺里程</div>
                    <div class="list-item-sub">里程範圍: ${start} ~ ${end}</div>
                </div>
            </div>
            <span class="badge">${count} 點</span>
        `;
        
        li.addEventListener('click', () => {
            toggleRoadRoute(road);
        });
        
        listEl.appendChild(li);
    });
    
    lucide.createIcons({ attrs: { class: 'list-icon' } });
}

/**
 * 國道列表中，點選國道切換其路網路網
 */
function toggleRoadRoute(roadName) {
    if (activeRoad === roadName) {
        // 重複點擊則取消高亮
        activeRoad = null;
    } else {
        activeRoad = roadName;
    }
    
    // 更新高亮 class
    document.querySelectorAll('#road-list li').forEach(li => {
        if (li.dataset.road === activeRoad) {
            li.classList.add('active');
        } else {
            li.classList.remove('active');
        }
    });
    
    // 重繪地圖里程點 (動態過濾)
    updateMilestonePointsOnMap();
    
    // 定位到該國道的中間點或範圍
    if (activeRoad) {
        const pts = roadGrouped[activeRoad];
        if (pts.length > 0) {
            const latLngs = pts.map(p => [p.lat, p.lng]);
            const bounds = L.latLngBounds(latLngs);
            map.fitBounds(bounds, { padding: [40, 40] });
            
            showMapToast(`已載入並繪製${roadName}路網軌跡`);
        }
    }
    
    // 手機版自動切換到地圖畫面，以便觀看
    if (window.innerWidth <= 768) {
        switchMobileTab('map');
    }
}

/**
 * 選取特定里程點並展示屬性
 */
function selectMilestone(item, distanceInMeters = null) {
    selectedMilestone = item;
    
    // 高亮對應清單項目
    document.querySelectorAll('#results-list li').forEach(li => {
        if (parseInt(li.dataset.id) === item.id) {
            li.classList.add('active');
        } else {
            li.classList.remove('active');
        }
    });
    
    // 填寫詳情資訊
    document.getElementById('detail-road-name').textContent = `${item.road}線`;
    document.getElementById('detail-dir').textContent = getDirectionLabel(item.direction);
    
    // 解析里程樁顯示 (K與M分拆)
    // 格式如 016K+600 或 000K+0
    const parts = item.milestone.split('K+');
    if (parts.length === 2) {
        document.getElementById('detail-k').textContent = parseInt(parts[0], 10);
        // M 值補足 3 位數，如 600 或 0 補成 000
        let mStr = parts[1];
        if (mStr.length === 1) mStr = mStr + '00';
        else if (mStr.length === 2) mStr = '0' + mStr;
        document.getElementById('detail-m').textContent = mStr;
    } else {
        document.getElementById('detail-k').textContent = '-';
        document.getElementById('detail-m').textContent = '---';
    }
    
    // 距離與輸入座標顯示
    const distBadge = document.getElementById('detail-distance');
    if (distanceInMeters !== null) {
        const d = distanceInMeters;
        distBadge.textContent = d < 1000 ? `離您 ${Math.round(d)} 公尺` : `離您 ${(d / 1000).toFixed(2)} 公里`;
        distBadge.classList.remove('hide');
    } else {
        // 如果是直接點選圓點，則動態計算與輸入框座標的距離
        const latInput = parseFloat(document.getElementById('input-lat').value);
        const lngInput = parseFloat(document.getElementById('input-lng').value);
        if (!isNaN(latInput) && !isNaN(lngInput)) {
            const d = haversineDistance(latInput, lngInput, item.lat, item.lng);
            distBadge.textContent = d < 1000 ? `離您 ${Math.round(d)} 公尺` : `離您 ${(d / 1000).toFixed(2)} 公里`;
            distBadge.classList.remove('hide');
        } else {
            distBadge.classList.add('hide');
        }
    }
    
    document.getElementById('detail-road-lbl').textContent = `${item.road}線`;
    document.getElementById('detail-lr-lbl').textContent = getDirectionLabel(item.direction);
    document.getElementById('detail-meters').textContent = `${(item.km / 1000).toFixed(1)} 公里 (累計 ${item.km} 公尺)`;
    document.getElementById('detail-elevation').textContent = `${item.elevation} 公尺`;
    document.getElementById('detail-coords').textContent = `${item.lat.toFixed(7)}, ${item.lng.toFixed(7)}`;
    
    // 查詢座標區塊
    const qCoordsContainer = document.getElementById('detail-query-coords-container');
    if (queryCoordinates) {
        document.getElementById('detail-query-coords').textContent = `${queryCoordinates[0].toFixed(6)}, ${queryCoordinates[1].toFixed(6)}`;
        qCoordsContainer.classList.remove('hide');
    } else {
        qCoordsContainer.classList.add('hide');
    }
    
    // 展示面板
    document.getElementById('detail-panel').classList.remove('hide');
}

function getDirectionLabel(dir) {
    const d = dir.toUpperCase().trim();
    if (d === 'N') return '北上主線';
    if (d === 'S') return '南下主線';
    if (d === 'E') return '東向主線';
    if (d === 'W') return '西向主線';
    if (d === 'R') return '右側軌道';
    if (d === 'L') return '左側軌道';
    if (d === 'M') return '雙向/中心主線';
    return `支線/軌道 (${dir})`;
}

// ==========================================================================
// 7. 一鍵更新與流量控制
// ==========================================================================
async function checkAndExecuteUpdate() {
    const btn = document.getElementById('update-btn');
    const icon = document.getElementById('update-icon');
    
    if (btn.classList.contains('disabled')) return;
    
    btn.classList.add('disabled');
    icon.classList.add('spinning');
    btn.setAttribute('disabled', 'true');
    
    try {
        const cachedMeta = await dbGet('metadata');
        const cachedMd5s = cachedMeta ? cachedMeta.resources_md5 : [];
        
        // 1. 流量控制：先下載極小 (200B) 的 metadata.json 檢查 md5
        const res = await fetch('metadata.json?t=' + Date.now());
        if (!res.ok) throw new Error("下載線上中繼資料失敗");
        const onlineMeta = await res.json();
        
        const onlineMd5s = onlineMeta.resources_md5 || [];
        
        // 比較 md5 列表是否一致
        const isSame = JSON.stringify(cachedMd5s) === JSON.stringify(onlineMd5s);
        
        if (isSame && cachedMeta) {
            alert(`目前已是最新版本，與高公局資料來源同步！\n\n線上更新時間：${onlineMeta.last_updated}\n總里程點數：${onlineMeta.total_records} 點\n本地比對字串一致，無須重複下載。`);
            
            // 更新本地最後檢查時間
            cachedMeta.last_checked = new Date().toLocaleString();
            await dbSet('metadata', cachedMeta);
            updateVersionStatus(cachedMeta);
        } else {
            // 版本不一致，提示並下載 539KB 的 CSV 檔案
            const confirmUpdate = confirm(`偵測到線上資料庫有新版本！\n\n本地更新時間：${cachedMeta ? cachedMeta.last_updated : '無快取'}\n線上最新時間：${onlineMeta.last_updated} (約 ${onlineMeta.total_records} 點)\n\n是否下載更新？`);
            
            if (confirmUpdate) {
                const overlay = document.getElementById('loading-overlay');
                const progress = document.getElementById('loading-progress');
                const status = document.getElementById('loading-status');
                
                document.getElementById('loading-title').textContent = "正在下載國道數據";
                overlay.classList.remove('fade-out');
                
                status.textContent = "下載中，國道百公尺里程資料包...";
                progress.style.width = "40%";
                
                const csvRes = await fetch('data/freeway_milestones.csv?t=' + Date.now());
                if (!csvRes.ok) throw new Error("下載最新 CSV 失敗");
                const csvText = await csvRes.text();
                
                status.textContent = "重新編譯快取資料...";
                progress.style.width = "80%";
                
                allMilestones = parseCSVData(csvText);
                
                // 存入快取
                await dbSet('metadata', onlineMeta);
                await dbSet('milestones', allMilestones);
                
                processMilestones();
                
                progress.style.width = "100%";
                status.textContent = "更新完成！";
                
                setTimeout(() => {
                    overlay.classList.add('fade-out');
                }, 500);
                
                updateVersionStatus(onlineMeta);
                alert("國道里程資料庫成功更新至最新版！");
            }
        }
    } catch (error) {
        console.error("更新檢查失敗:", error);
        alert("檢查更新時發生錯誤，請確認網路連線！\n錯誤: " + error.message);
    } finally {
        btn.classList.remove('disabled');
        icon.classList.remove('spinning');
        btn.removeAttribute('disabled');
    }
}

function updateVersionStatus(meta) {
    const statusEl = document.getElementById('version-status');
    statusEl.innerHTML = `
        <i data-lucide="database" style="width:12px; height:12px; color:var(--success-color);"></i>
        <span>資料更新日: ${meta.last_updated} (已快取 ${meta.total_records} 點)</span>
    `;
    lucide.createIcons({ attrs: { class: 'list-icon' } });
}

// ==========================================================================
// 8. 介面路由與事件監聽
// ==========================================================================

function switchTab(tabId) {
    currentTab = tabId;
    
    // PC Tabs 高亮
    document.querySelectorAll('.panel-tab').forEach(btn => {
        if (btn.dataset.tab === tabId) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
    
    // 切換分頁可見度
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.getElementById(`content-${tabId}`).classList.add('active');
}

function switchMobileTab(target) {
    const app = document.getElementById('app-container');
    
    document.querySelectorAll('.mobile-tab').forEach(btn => {
        if (btn.dataset.target === target) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
    
    if (target === 'map') {
        app.classList.remove('show-list');
        app.classList.add('show-map');
        setTimeout(() => {
            if (map) map.invalidateSize();
        }, 200);
    } else {
        app.classList.remove('show-map');
        app.classList.add('show-list');
        
        if (target === 'coords') switchTab('coords');
        else if (target === 'roads') switchTab('roads');
    }
}

function setupRepoLink() {
    const hostname = window.location.hostname;
    const repoEl = document.getElementById('repo-link');
    if (!repoEl) return;
    
    if (hostname.endsWith('.github.io')) {
        const parts = window.location.pathname.split('/');
        const repoName = parts[1] || '';
        const username = hostname.split('.')[0];
        if (username && repoName) {
            repoEl.href = `https://github.com/${username}/${repoName}`;
            repoEl.textContent = `${username}/${repoName}`;
            return;
        }
    }
    repoEl.href = 'https://github.com';
    repoEl.textContent = 'GitHub 專案庫';
}

function bindEvents() {
    // 1. PC Tabs 切換
    document.querySelectorAll('.panel-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            switchTab(btn.dataset.tab);
        });
    });
    
    // 2. Mobile Tabs 切換
    document.querySelectorAll('.mobile-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            switchMobileTab(btn.dataset.target);
        });
    });
    
    // 3. 偵測 GPS 定位按鈕
    document.getElementById('locate-btn').addEventListener('click', () => {
        if (!navigator.geolocation) {
            alert("您的瀏覽器或設備不支援 GPS 定位功能。");
            return;
        }
        
        const locateBtn = document.getElementById('locate-btn');
        locateBtn.setAttribute('disabled', 'true');
        locateBtn.querySelector('span').textContent = "定位中...";
        
        navigator.geolocation.getCurrentPosition(
            (position) => {
                const lat = position.coords.latitude;
                const lng = position.coords.longitude;
                
                document.getElementById('input-lat').value = lat.toFixed(6);
                document.getElementById('input-lng').value = lng.toFixed(6);
                
                locateBtn.removeAttribute('disabled');
                locateBtn.querySelector('span').textContent = "偵測定位";
                
                showMapToast("GPS 定位成功，正在計算最近國道里程...");
                findNearestMilestones(lat, lng);
            },
            (error) => {
                console.error("GPS 定位失敗:", error);
                alert("GPS 定位失敗，請確認是否開啟定位權限。");
                locateBtn.removeAttribute('disabled');
                locateBtn.querySelector('span').textContent = "偵測定位";
            },
            { enableHighAccuracy: true, timeout: 8000 }
        );
    });
    
    // 4. 開始查詢按鈕
    document.getElementById('search-btn').addEventListener('click', () => {
        const latInput = parseFloat(document.getElementById('input-lat').value);
        const lngInput = parseFloat(document.getElementById('input-lng').value);
        
        if (isNaN(latInput) || isNaN(lngInput)) {
            alert("請輸入正確的緯度與經度數值！");
            return;
        }
        
        if (latInput < 21 || latInput > 26 || lngInput < 118 || lngInput > 123) {
            alert("輸入的經緯度超出台灣範圍 (經度約118-123，緯度約21-26)。");
            return;
        }
        
        findNearestMilestones(latInput, lngInput);
    });
    
    // 5. 關閉詳情卡片
    document.getElementById('close-detail-btn').addEventListener('click', () => {
        document.getElementById('detail-panel').classList.add('hide');
        selectedMilestone = null;
        document.querySelectorAll('#results-list li').forEach(li => li.classList.remove('active'));
        clearSearchVisuals();
    });
    
    // 6. 複製經緯度
    document.getElementById('copy-coords-btn').addEventListener('click', () => {
        if (!selectedMilestone) return;
        const txt = `${selectedMilestone.lat.toFixed(7)},${selectedMilestone.lng.toFixed(7)}`;
        navigator.clipboard.writeText(txt).then(() => {
            const btnSpan = document.querySelector('#copy-coords-btn span');
            const original = btnSpan.textContent;
            btnSpan.textContent = "已複製！";
            setTimeout(() => btnSpan.textContent = original, 1500);
        });
    });
    
    // 7. 導航按鈕
    document.getElementById('navigate-btn').addEventListener('click', () => {
        if (!selectedMilestone) return;
        const url = `https://www.google.com/maps/dir/?api=1&destination=${selectedMilestone.lat},${selectedMilestone.lng}`;
        window.open(url, '_blank');
    });
    
    // 8. 一鍵更新按鈕
    document.getElementById('update-btn').addEventListener('click', () => {
        checkAndExecuteUpdate();
    });
    
    // 9. 主題切換按鈕
    const themeBtn = document.getElementById('theme-toggle-btn');
    if (themeBtn) {
        themeBtn.addEventListener('click', () => {
            toggleTheme();
        });
    }
}
