// =================================
//      INISIALISASI & VARIABEL
// =================================
const map = L.map('map').setView([-7.7956, 110.3695], 11);
const searchInput = document.getElementById('search-input');
const searchButton = document.getElementById('search-button');
const resultsList = document.getElementById('results-list');
const dashboardList = document.getElementById('dashboard-list');

let allPois = []; // Untuk menyimpan semua data POI dari GeoJSON
let userMarker;
let poiMarkersLayer = L.layerGroup().addTo(map);
let currentWaypoints = [];

// Setup peta dasar OpenStreetMap
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
}).addTo(map);

// Setup kontrol routing OSRM
const routingControl = L.Routing.control({
    waypoints: [],
    router: new L.Routing.OSRMv1({
        serviceUrl: 'https://router.project-osrm.org/route/v1'
    }),
    show: false,
    addWaypoints: false,
    routeWhileDragging: false,
    fitSelectedRoutes: true,
    createMarker: function() { return null; } // Jangan buat marker default
}).addTo(map);

// =================================
//      FUNGSI-FUNGSI UTAMA
// =================================

// 1. Memuat data POI dari GeoJSON
async function loadPois() {
    try {
        const response = await fetch('wisata_diy.geojson');
        const data = await response.json();
        allPois = data.features;
    } catch (error) {
        console.error('Gagal memuat data POI:', error);
        alert('Gagal memuat data pariwisata. Silakan coba lagi.');
    }
}

// 2. Geocoding alamat menggunakan Nominatim
async function geocodeAddress(address) {
    showLoading('Mencari lokasi...');
    try {
        const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}`);
        const data = await response.json();
        if (data && data.length > 0) {
            const location = data[0];
            const latLng = L.latLng(location.lat, location.lon);
            handleLocationFound(latLng, location.display_name);
        } else {
            alert('Lokasi tidak ditemukan.');
        }
    } catch (error) {
        console.error('Error Geocoding:', error);
        alert('Gagal mencari lokasi. Periksa koneksi internet Anda.');
    } finally {
        hideLoading();
    }
}

// 3. Menangani lokasi yang berhasil ditemukan
function handleLocationFound(latLng, displayName) {
    map.setView(latLng, 13);
    if (userMarker) {
        map.removeLayer(userMarker);
    }
    userMarker = L.marker(latLng).addTo(map)
        .bindPopup(`<b>Lokasi Anda:</b><br>${displayName}`)
        .openPopup();
    
    currentWaypoints = [latLng]; // Reset waypoints
    findNearestPois(latLng);
}

// 4. Mencari POI terdekat (Strategi Cerdas Dua Langkah)
async function findNearestPois(userLatLng) {
    showLoading('Mencari wisata terdekat...');
    resultsList.innerHTML = '';
    poiMarkersLayer.clearLayers();

    // Langkah 1: Filter cepat 20 kandidat terdekat dengan jarak lurus
    const poisWithDistance = allPois.map(poi => {
        const poiLatLng = L.latLng(poi.geometry.coordinates[1], poi.geometry.coordinates[0]);
        const distance = turf.distance(turf.point([userLatLng.lng, userLatLng.lat]), turf.point([poiLatLng.lng, poiLatLng.lat]));
        return { ...poi, distance };
    });
    poisWithDistance.sort((a, b) => a.distance - b.distance);
    const candidates = poisWithDistance.slice(0, 20);

    // Langkah 2: Analisis waktu tempuh untuk 20 kandidat menggunakan OSRM
    const promises = candidates.map(poi => {
        const poiLatLng = L.latLng(poi.geometry.coordinates[1], poi.geometry.coordinates[0]);
        const url = `https://router.project-osrm.org/route/v1/driving/${userLatLng.lng},${userLatLng.lat};${poiLatLng.lng},${poiLatLng.lat}?overview=false`;
        return fetch(url).then(res => res.json());
    });
    
    try {
        const results = await Promise.all(promises);
        const poisWithDuration = candidates.map((poi, index) => {
            const duration = (results[index].routes && results[index].routes[0]) ? results[index].routes[0].duration : Infinity;
            return { ...poi, duration };
        });

        poisWithDuration.sort((a, b) => a.duration - b.duration);
        const top5Pois = poisWithDuration.slice(0, 5);

        displayNearestResults(top5Pois);
        displayPoiMarkers(candidates); // Tampilkan marker untuk semua kandidat

    } catch (error) {
        console.error("Error saat fetching OSRM:", error);
        // Jika OSRM gagal, tampilkan berdasarkan jarak lurus saja
        displayNearestResults(candidates.slice(0, 5));
        displayPoiMarkers(candidates);
    } finally {
        hideLoading();
    }
}

// 5. Menampilkan hasil POI terdekat di panel
function displayNearestResults(pois) {
    resultsList.innerHTML = '<ul>' + pois.map(poi => {
        const durationInMinutes = poi.duration ? Math.round(poi.duration / 60) : 'N/A';
        // ==================== PERBAIKAN DI SINI ====================
        const coordsString = [...poi.geometry.coordinates].reverse().join(',');
        // ========================================================
        return `<li data-coords="${coordsString}">
                    <strong>${poi.properties.nama_objek}</strong>
                    <div class="item-desc">
                        ${poi.duration ? `Sekitar ${durationInMinutes} menit berkendara` : `Jarak lurus: ${poi.distance.toFixed(2)} km`}
                    </div>
                </li>`;
    }).join('') + '</ul>';
    
    // Tambah event listener untuk setiap item list
    document.querySelectorAll('#results-list li').forEach(item => {
        item.addEventListener('click', (e) => {
            const coords = e.currentTarget.dataset.coords.split(',').map(Number);
            const poiLatLng = L.latLng(coords[0], coords[1]);
            
            currentWaypoints = [userMarker.getLatLng(), poiLatLng];
            routingControl.setWaypoints(currentWaypoints);
            
            map.fitBounds(L.latLngBounds(currentWaypoints));
            updateDashboard(userMarker.getLatLng(), poiLatLng);
        });
    });
}

// 6. Menampilkan marker POI di peta
function displayPoiMarkers(pois) {
    poiMarkersLayer.clearLayers();
    pois.forEach(poi => {
        const poiLatLng = L.latLng(poi.geometry.coordinates[1], poi.geometry.coordinates[0]);
        const marker = L.marker(poiLatLng)
            .bindPopup(`<b>${poi.properties.nama_objek}</b><br>${poi.properties.deskripsi}`)
            .on('click', () => {
                currentWaypoints = [userMarker.getLatLng(), poiLatLng];
                routingControl.setWaypoints(currentWaypoints);
                updateDashboard(userMarker.getLatLng(), poiLatLng);
            });
        poiMarkersLayer.addLayer(marker);
    });
}

// 7. Memperbarui dashboard "Searah"
function updateDashboard(originLatLng, destinationLatLng) {
    dashboardList.innerHTML = '';
    const mainBearing = turf.bearing(
        turf.point([originLatLng.lng, originLatLng.lat]), 
        turf.point([destinationLatLng.lng, destinationLatLng.lat])
    );
    
    const onTheWayPois = allPois.filter(poi => {
        const poiLatLng = L.latLng(poi.geometry.coordinates[1], poi.geometry.coordinates[0]);
        if (poiLatLng.equals(destinationLatLng) || poiLatLng.equals(originLatLng)) {
            return false; // Abaikan titik awal dan tujuan
        }
        
        const bearingToPoi = turf.bearing(
            turf.point([originLatLng.lng, originLatLng.lat]), 
            turf.point([poiLatLng.lng, poiLatLng.lat])
        );
        
        // Cek apakah bearingnya mirip (toleransi 30 derajat)
        const bearingDifference = Math.abs(mainBearing - bearingToPoi);
        return bearingDifference < 30 || bearingDifference > 330; // Handle wrapping around 360 degrees
    });

    onTheWayPois.forEach(poi => {
        const item = document.createElement('div');
        item.className = 'dashboard-item';
        item.innerText = poi.properties.nama_objek;
        // ==================== PERBAIKAN DI SINI ====================
        item.dataset.coords = [...poi.geometry.coordinates].reverse().join(',');
        // =========================================================

        item.addEventListener('click', () => {
            const coords = item.dataset.coords.split(',').map(Number);
            const nextPoiLatLng = L.latLng(coords[0], coords[1]);
            
            // Tambahkan ke rute yang sudah ada
            currentWaypoints.push(nextPoiLatLng);
            routingControl.setWaypoints(currentWaypoints);
            
            // Perbarui dashboard untuk segmen berikutnya
            const lastLegOrigin = currentWaypoints[currentWaypoints.length - 2];
            updateDashboard(lastLegOrigin, nextPoiLatLng);
        });

        dashboardList.appendChild(item);
    });
}

// Helper untuk menampilkan/menyembunyikan loading
function showLoading(message) {
    let loadingDiv = document.getElementById('loading-overlay');
    if (!loadingDiv) {
        loadingDiv = document.createElement('div');
        loadingDiv.id = 'loading-overlay';
        loadingDiv.className = 'loading';
        document.body.appendChild(loadingDiv);
    }
    loadingDiv.innerText = message;
    loadingDiv.style.display = 'flex';
}

function hideLoading() {
    const loadingDiv = document.getElementById('loading-overlay');
    if (loadingDiv) {
        loadingDiv.style.display = 'none';
    }
}


// =================================
//      EVENT LISTENERS & EKSEKUSI
// =================================

// Event listener untuk tombol search
searchButton.addEventListener('click', () => {
    if (searchInput.value) {
        geocodeAddress(searchInput.value);
    }
});

// Event listener untuk menekan 'Enter' di kolom search
searchInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && searchInput.value) {
        geocodeAddress(searchInput.value);
    }
});

// Jalankan fungsi loadPois saat aplikasi pertama kali dimuat
window.onload = loadPois;