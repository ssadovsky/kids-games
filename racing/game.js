/**
 * 3D Гонки от третьего лица (ракурс над машиной)
 * Оптимизировано для Samsung Galaxy S10 и автономной игры
 * Управление: аналоговый экранный джойстик (тачскрин или мышь)
 * Выбор трасс:
 *   - Трасса 1: Яркий солнечный день, скоростной овал, бортики (для детей)
 *   - Трасса 2: Неоновая ночь, крутые виражи и шиканы
 * Кнопка СТОП: полная остановка и вперед, и назад (без движения назад!)
 * Короткий звук аварии с кулдауном (без затянутого гула)
 * Меню паузы и автоповорот в альбомный режим
 */

(function () {
    'use strict';

    // --- НАСТРОЙКИ И СОСТОЯНИЕ ---
    const CONFIG = {
        maxSpeed: 44.0,            // ~190 км/ч
        nitroMaxSpeed: 62.0,       // ~265 км/ч
        accel: 24.0,
        brakePower: 45.0,          // Мощный тормоз для быстрой остановки
        friction: 6.5,
        steerSpeed: 3.4,
        maxSteerAngle: 0.60,
        driftFriction: 2.4,
        roadWidth: 17.0,
        totalLaps: 3
    };

    const STATE = {
        isPlaying: false,
        isPaused: false,
        soundEnabled: true,
        currentTrackIndex: 0,      // 0: День / Овал, 1: Ночь / Виражи
        currentLap: 1,
        lapStartTime: 0,
        bestLapTime: Infinity,
        raceFinished: false,
        cameraMode: 0,
        playerHue: 0,
        playerColorHex: '#00d2ff'
    };

    // Ввод
    const JOYSTICK = {
        active: false,
        pointerId: null,
        steer: 0,      // -1.0 (влево) .. +1.0 (вправо)
        throttle: 0    // -1.0 (назад) .. +1.0 (газ)
    };

    const INPUT = {
        forward: false,
        backward: false,
        left: false,
        right: false,
        nitro: false,
        brake: false
    };

    const MOUSE_CONTROL = {
        leftDown: false,
        rightDown: false,
        steerDelta: 0
    };

    function tryLockLandscape() {
        try {
            if (screen.orientation && screen.orientation.lock) {
                screen.orientation.lock('landscape').catch(() => {});
            }
        } catch (e) {}
    }

    // --- ЗВУКОВОЙ ДВИЖОК (Web Audio API) ---
    class SoundEngine {
        constructor() {
            this.ctx = null;
            this.engineOsc = null;
            this.engineGain = null;
            this.nitroOsc = null;
            this.nitroGain = null;
            this.noiseNode = null;
            this.skidGain = null;
            this.initialized = false;
            this.lastCrashTime = 0;
        }

        init() {
            if (this.initialized) return;
            try {
                const AudioCtx = window.AudioContext || window.webkitAudioContext;
                this.ctx = new AudioCtx();

                // Мотор
                this.engineOsc = this.ctx.createOscillator();
                this.engineOsc.type = 'sawtooth';
                this.engineOsc.frequency.setValueAtTime(45, this.ctx.currentTime);

                const filter = this.ctx.createBiquadFilter();
                filter.type = 'lowpass';
                filter.frequency.setValueAtTime(320, this.ctx.currentTime);

                this.engineGain = this.ctx.createGain();
                this.engineGain.gain.setValueAtTime(0.04, this.ctx.currentTime);

                this.engineOsc.connect(filter);
                filter.connect(this.engineGain);
                this.engineGain.connect(this.ctx.destination);
                this.engineOsc.start();

                // Нитро-свист
                this.nitroOsc = this.ctx.createOscillator();
                this.nitroOsc.type = 'sine';
                this.nitroOsc.frequency.setValueAtTime(480, this.ctx.currentTime);
                this.nitroGain = this.ctx.createGain();
                this.nitroGain.gain.setValueAtTime(0, this.ctx.currentTime);
                this.nitroOsc.connect(this.nitroGain);
                this.nitroGain.connect(this.ctx.destination);
                this.nitroOsc.start();

                // Визг шин
                const bufferSize = this.ctx.sampleRate * 2;
                const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
                const data = buffer.getChannelData(0);
                for (let i = 0; i < bufferSize; i++) {
                    data[i] = Math.random() * 2 - 1;
                }
                this.noiseNode = this.ctx.createBufferSource();
                this.noiseNode.buffer = buffer;
                this.noiseNode.loop = true;

                const skidFilter = this.ctx.createBiquadFilter();
                skidFilter.type = 'bandpass';
                skidFilter.frequency.setValueAtTime(1100, this.ctx.currentTime);
                skidFilter.Q.setValueAtTime(3.0, this.ctx.currentTime);

                this.skidGain = this.ctx.createGain();
                this.skidGain.gain.setValueAtTime(0, this.ctx.currentTime);

                this.noiseNode.connect(skidFilter);
                skidFilter.connect(this.skidGain);
                this.skidGain.connect(this.ctx.destination);
                this.noiseNode.start();

                this.initialized = true;
            } catch (e) {}
        }

        stop() {
            if (!this.initialized || !this.ctx) return;
            const now = this.ctx.currentTime;
            if (this.engineGain) this.engineGain.gain.setValueAtTime(0, now);
            if (this.skidGain) this.skidGain.gain.setValueAtTime(0, now);
            if (this.nitroGain) this.nitroGain.gain.setValueAtTime(0, now);
            if (this.ctx.state === 'running') {
                this.ctx.suspend().catch(() => {});
            }
        }

        resume() {
            if (!this.initialized || !this.ctx) return;
            if (this.ctx.state === 'suspended' && STATE.soundEnabled) {
                this.ctx.resume().catch(() => {});
            }
        }

        update(speedRatio, isAccelerating, isDrifting, isNitro) {
            if (!this.initialized || !STATE.soundEnabled || STATE.isPaused) {
                if (this.engineGain) this.engineGain.gain.value = 0;
                if (this.skidGain) this.skidGain.gain.value = 0;
                if (this.nitroGain) this.nitroGain.gain.value = 0;
                return;
            }
            if (this.ctx.state === 'suspended') {
                this.ctx.resume();
            }

            const now = this.ctx.currentTime;
            const baseFreq = 42 + speedRatio * 190 + (isAccelerating ? 25 : 0);
            this.engineOsc.frequency.setTargetAtTime(baseFreq, now, 0.06);
            const targetGain = 0.03 + (isAccelerating ? 0.045 : 0.015);
            this.engineGain.gain.setTargetAtTime(targetGain, now, 0.08);

            const skidVol = isDrifting ? Math.min(0.09, speedRatio * 0.12) : 0;
            this.skidGain.gain.setTargetAtTime(skidVol, now, 0.04);

            const nitroVol = isNitro ? 0.09 : 0;
            this.nitroGain.gain.setTargetAtTime(nitroVol, now, 0.08);
            if (isNitro) {
                this.nitroOsc.frequency.setTargetAtTime(620 + speedRatio * 220, now, 0.05);
            }
        }

        // Короткий четкий звук аварии (0.22 сек), не затягивается и имеет кулдаун
        playCrash() {
            if (!this.initialized || !STATE.soundEnabled || STATE.isPaused) return;
            const nowMs = performance.now();
            if (nowMs - this.lastCrashTime < 600) return; // Кулдаун 0.6 сек, чтобы звук не дрожал
            this.lastCrashTime = nowMs;

            try {
                const now = this.ctx.currentTime;
                const osc = this.ctx.createOscillator();
                const gain = this.ctx.createGain();
                osc.type = 'triangle';
                osc.frequency.setValueAtTime(130, now);
                osc.frequency.exponentialRampToValueAtTime(35, now + 0.22);

                gain.gain.setValueAtTime(0.24, now);
                gain.gain.exponentialRampToValueAtTime(0.005, now + 0.22);

                osc.connect(gain);
                gain.connect(this.ctx.destination);
                osc.start(now);
                osc.stop(now + 0.22);
            } catch (e) {}
        }

        toggle() {
            STATE.soundEnabled = !STATE.soundEnabled;
            if (this.engineGain) {
                this.engineGain.gain.value = STATE.soundEnabled ? 0.04 : 0;
            }
            if (this.skidGain) {
                this.skidGain.gain.value = 0;
            }
            return STATE.soundEnabled;
        }
    }

    const sound = new SoundEngine();

    function triggerHaptic(duration = 40) {
        if ('vibrate' in navigator) {
            try { navigator.vibrate(duration); } catch (e) {}
        }
    }

    // --- СЦЕНА THREE.JS ---
    const container = document.getElementById('canvas-container');
    const scene = new THREE.Scene();

    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || ('ontouchstart' in window);

    const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.5, 650);

    const renderer = new THREE.WebGLRenderer({ antialias: !isMobile, powerPreference: 'high-performance' });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(isMobile ? Math.min(window.devicePixelRatio, 1.35) : Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = isMobile ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    container.appendChild(renderer.domElement);

    // Освещение (будет динамически настраиваться под День/Ночь)
    const ambientLight = new THREE.AmbientLight(0xdbeafe, 0.8);
    scene.add(ambientLight);

    const sunLight = new THREE.DirectionalLight(0xfffbeb, 1.4);
    sunLight.position.set(130, 180, 100);
    sunLight.castShadow = true;
    const shadowRes = isMobile ? 512 : 1024;
    sunLight.shadow.mapSize.width = shadowRes;
    sunLight.shadow.mapSize.height = shadowRes;
    sunLight.shadow.camera.near = 10;
    sunLight.shadow.camera.far = 420;
    const shadowDist = 110;
    sunLight.shadow.camera.left = -shadowDist;
    sunLight.shadow.camera.right = shadowDist;
    sunLight.shadow.camera.top = shadowDist;
    sunLight.shadow.camera.bottom = -shadowDist;
    scene.add(sunLight);

    const hemiLight = new THREE.HemisphereLight(0x38bdf8, 0x0f172a, 0.6);
    scene.add(hemiLight);

    // --- ТОЧКИ ДВУХ ТРАСС ---
    // Трасса 1 (Легкая, скоростной овал с мягкими поворотами)
    const TRACK_POINTS_EASY = [
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(110, 0, 0),
        new THREE.Vector3(190, 0, 45),
        new THREE.Vector3(230, 0, 120),
        new THREE.Vector3(190, 0, 195),
        new THREE.Vector3(110, 0, 240),
        new THREE.Vector3(0, 0, 240),
        new THREE.Vector3(-110, 0, 240),
        new THREE.Vector3(-190, 0, 195),
        new THREE.Vector3(-230, 0, 120),
        new THREE.Vector3(-190, 0, 45),
        new THREE.Vector3(-110, 0, 0)
    ];

    // Трасса 2 (Сложная, шиканы и крутые виражи)
    const TRACK_POINTS_HARD = [
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(120, 0, 30),
        new THREE.Vector3(220, 0, 100),
        new THREE.Vector3(260, 0, 220),
        new THREE.Vector3(190, 0, 320),
        new THREE.Vector3(90, 0, 310),
        new THREE.Vector3(20, 0, 240),
        new THREE.Vector3(-60, 0, 220),
        new THREE.Vector3(-140, 0, 290),
        new THREE.Vector3(-220, 0, 260),
        new THREE.Vector3(-260, 0, 140),
        new THREE.Vector3(-200, 0, 30),
        new THREE.Vector3(-110, 0, -40),
        new THREE.Vector3(-30, 0, -20)
    ];

    const TRACK_CURVES = [
        new THREE.CatmullRomCurve3(TRACK_POINTS_EASY, true, 'catmullrom', 0.15),
        new THREE.CatmullRomCurve3(TRACK_POINTS_HARD, true, 'catmullrom', 0.15)
    ];

    let currentTrackCurve = TRACK_CURVES[0];
    let trackLength = currentTrackCurve.getLength();

    const trackGroup = new THREE.Group();
    scene.add(trackGroup);

    // --- ПРОЦЕДУРНАЯ ТЕКСТУРА ТРАВЫ (0% CORS, 100% запуск из file://) ---
    function createProceduralGrassTexture() {
        const canvas = document.createElement('canvas');
        canvas.width = 512;
        canvas.height = 512;
        const ctx = canvas.getContext('2d');

        // Базовый цвет лугового газона
        ctx.fillStyle = '#2f7a44';
        ctx.fillRect(0, 0, 512, 512);

        // 1. Естественные пятна плотности дерна (крупные мягкие градиенты)
        for (let i = 0; i < 45; i++) {
            const x = Math.random() * 512;
            const y = Math.random() * 512;
            const r = Math.random() * 80 + 30;
            const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
            const col = Math.random() > 0.45 ? 'rgba(72, 187, 120, 0.4)' : 'rgba(39, 103, 73, 0.4)';
            grad.addColorStop(0, col);
            grad.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.fill();
        }

        // 2. Тысячи травинок разной насыщенности для микродетализации
        const blades = ['#48bb78', '#38a169', '#2f855a', '#68d391', '#276749', '#529b69', '#3b7a57'];
        for (let i = 0; i < 20000; i++) {
            const x = Math.random() * 512;
            const y = Math.random() * 512;
            const len = Math.random() * 6 + 3;
            const angle = Math.random() * Math.PI * 2;
            ctx.strokeStyle = blades[Math.floor(Math.random() * blades.length)];
            ctx.lineWidth = Math.random() > 0.65 ? 1.5 : 1.0;
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x + Math.cos(angle) * len, y + Math.sin(angle) * len);
            ctx.stroke();
        }

        const tex = new THREE.CanvasTexture(canvas);
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(80, 80);
        return tex;
    }

    function createProceduralGrassNormalMap() {
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 256;
        const ctx = canvas.getContext('2d');
        const imgData = ctx.createImageData(256, 256);
        const data = imgData.data;

        for (let i = 0; i < 256 * 256; i++) {
            const nx = 128 + Math.floor((Math.random() - 0.5) * 40);
            const ny = 128 + Math.floor((Math.random() - 0.5) * 40);
            const nz = 255 - Math.floor(Math.random() * 15);
            const idx = i * 4;
            data[idx] = nx;
            data[idx + 1] = ny;
            data[idx + 2] = nz;
            data[idx + 3] = 255;
        }
        ctx.putImageData(imgData, 0, 0);

        const tex = new THREE.CanvasTexture(canvas);
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(80, 80);
        return tex;
    }

    // Инициализация текстур: сразу процедурная, с плавным апгрейдом на Base64 если загружен
    const grassDiffTex = createProceduralGrassTexture();
    const grassNorTex = createProceduralGrassNormalMap();

    if (window.GRASS_DIFFUSE_BASE64) {
        const img = new Image();
        img.onload = () => {
            grassDiffTex.image = img;
            grassDiffTex.repeat.set(100, 100);
            grassDiffTex.needsUpdate = true;
        };
        img.src = window.GRASS_DIFFUSE_BASE64;
    }

    if (window.GRASS_NORMAL_BASE64) {
        const imgN = new Image();
        imgN.onload = () => {
            grassNorTex.image = imgN;
            grassNorTex.repeat.set(100, 100);
            grassNorTex.needsUpdate = true;
        };
        imgN.src = window.GRASS_NORMAL_BASE64;
    }

    // Земля вокруг трассы (плоская на Y = -0.05, чтобы дорога на Y = 0 никогда не перекрывалась!)
    const groundGeom = new THREE.PlaneGeometry(2400, 2400, 8, 8);
    groundGeom.rotateX(-Math.PI / 2);
    const groundMat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: grassDiffTex,
        normalMap: grassNorTex,
        normalScale: new THREE.Vector2(0.65, 0.65),
        roughness: 0.85,
        metalness: 0.04
    });
    const ground = new THREE.Mesh(groundGeom, groundMat);
    ground.position.y = -0.05;
    ground.receiveShadow = true;
    scene.add(ground);

    // Настройка окружения: День для Трассы 1, Лунная ночь для Трассы 2
    function applyEnvironmentTheme(isDay) {
        if (isDay) {
            // Солнечный летний день
            scene.background = new THREE.Color(0x70c5ff);
            scene.fog = new THREE.FogExp2(0xa3daf8, 0.0016);
            ambientLight.color.setHex(0xe0f2fe);
            ambientLight.intensity = 0.95;
            sunLight.color.setHex(0xfffae0);
            sunLight.intensity = 1.6;
            hemiLight.color.setHex(0x70c5ff);
            hemiLight.groundColor.setHex(0x2f855a);
            groundMat.color.setHex(0xffffff); // Сочная луговая трава
        } else {
            // Атмосферная лунная кибер-ночь (трава отчётливо видна, НЕ чёрная!)
            scene.background = new THREE.Color(0x0c192c);
            scene.fog = new THREE.FogExp2(0x0c192c, 0.0022);
            ambientLight.color.setHex(0x94a3b8);
            ambientLight.intensity = 0.85;
            sunLight.color.setHex(0x60a5fa);
            sunLight.intensity = 1.1;
            hemiLight.color.setHex(0x38bdf8);
            hemiLight.groundColor.setHex(0x1e3a2b);
            groundMat.color.setHex(0x4a7c59); // Приятный лунный оттенок ночной травы
        }
    }

    function buildTrack(trackIndex) {
        while (trackGroup.children.length > 0) {
            const obj = trackGroup.children[0];
            trackGroup.remove(obj);
            if (obj.geometry) obj.geometry.dispose();
        }

        currentTrackCurve = TRACK_CURVES[trackIndex];
        trackLength = currentTrackCurve.getLength();

        // Применяем тему: Трасса 0 — День, Трасса 1 — Ночь
        applyEnvironmentTheme(trackIndex === 0);

        // На первой трассе делаем дорогу ровно в 2 раза шире (34 м вместо 17 м)
        CONFIG.roadWidth = (trackIndex === 0) ? 34.0 : 17.0;
        const width = CONFIG.roadWidth;

        const segments = 400;
        const roadGeom = new THREE.BufferGeometry();
        const positions = [];
        const uvs = [];
        const indices = [];

        const curbGeom = new THREE.BufferGeometry();
        const curbPositions = [];
        const curbColors = [];

        const barrierGeom = new THREE.BufferGeometry();
        const barrierPositions = [];
        const barrierColors = [];
        const barrierHeight = 1.35;

        for (let i = 0; i <= segments; i++) {
            const t = i / segments;
            const pt = currentTrackCurve.getPointAt(t);
            const tangent = currentTrackCurve.getTangentAt(t).normalize();
            const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();

            const left = pt.clone().add(normal.clone().multiplyScalar(-width / 2));
            const right = pt.clone().add(normal.clone().multiplyScalar(width / 2));

            positions.push(left.x, 0.05, left.z);
            positions.push(right.x, 0.05, right.z);
            uvs.push(0, t * 70);
            uvs.push(1, t * 70);

            // Бордюры
            const curbWidth = 1.2;
            const curbLeftOuter = left.clone().add(normal.clone().multiplyScalar(-curbWidth));
            const curbRightOuter = right.clone().add(normal.clone().multiplyScalar(curbWidth));

            const isRed = Math.floor(t * 140) % 2 === 0;
            const r = 0.95;
            const g = isRed ? 0.15 : 0.95;
            const b = isRed ? 0.15 : 0.95;

            curbPositions.push(curbLeftOuter.x, 0.12, curbLeftOuter.z);
            curbPositions.push(left.x, 0.08, left.z);
            curbColors.push(r, g, b, r, g, b);

            curbPositions.push(right.x, 0.08, right.z);
            curbPositions.push(curbRightOuter.x, 0.12, curbRightOuter.z);
            curbColors.push(r, g, b, r, g, b);

            // Высокие защитные бортики (машина никогда не вылетает!)
            barrierPositions.push(curbLeftOuter.x, 0.1, curbLeftOuter.z);
            barrierPositions.push(curbLeftOuter.x, barrierHeight, curbLeftOuter.z);
            barrierPositions.push(curbRightOuter.x, 0.1, curbRightOuter.z);
            barrierPositions.push(curbRightOuter.x, barrierHeight, curbRightOuter.z);

            barrierColors.push(r, g, b, r, g, b);
            barrierColors.push(r, g, b, r, g, b);

            if (i < segments) {
                const base = i * 2;
                indices.push(base, base + 1, base + 2);
                indices.push(base + 1, base + 3, base + 2);
            }
        }

        // Асфальт
        roadGeom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        roadGeom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        roadGeom.setIndex(indices);
        roadGeom.computeVertexNormals();

        const roadCanvas = document.createElement('canvas');
        roadCanvas.width = 512;
        roadCanvas.height = 512;
        const ctx = roadCanvas.getContext('2d');
        ctx.fillStyle = (trackIndex === 0) ? '#283140' : '#181d26';
        ctx.fillRect(0, 0, 512, 512);

        for (let j = 0; j < 800; j++) {
            ctx.fillStyle = Math.random() > 0.5 ? '#333f52' : '#1e2531';
            ctx.fillRect(Math.random() * 512, Math.random() * 512, 2, 2);
        }

        ctx.strokeStyle = '#f8fafc';
        if (trackIndex === 0) {
            // Для широкой дороги: центральная линия + 2 промежуточные полосы движения
            ctx.lineWidth = 8;
            ctx.setLineDash([36, 28]);
            ctx.beginPath();
            ctx.moveTo(256, 0);
            ctx.lineTo(256, 512);
            ctx.stroke();

            ctx.lineWidth = 5;
            ctx.setLineDash([26, 32]);
            ctx.beginPath();
            ctx.moveTo(128, 0);
            ctx.lineTo(128, 512);
            ctx.moveTo(384, 0);
            ctx.lineTo(384, 512);
            ctx.stroke();
        } else {
            // Для классической одинарной дороги
            ctx.lineWidth = 6;
            ctx.setLineDash([32, 28]);
            ctx.beginPath();
            ctx.moveTo(256, 0);
            ctx.lineTo(256, 512);
            ctx.stroke();
        }

        // Белые краевые ограничительные полосы
        ctx.setLineDash([]);
        ctx.lineWidth = 8;
        ctx.beginPath();
        ctx.moveTo(14, 0);
        ctx.lineTo(14, 512);
        ctx.moveTo(498, 0);
        ctx.lineTo(498, 512);
        ctx.stroke();

        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 5;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(14, 0);
        ctx.lineTo(14, 512);
        ctx.moveTo(242, 0);
        ctx.lineTo(242, 512);
        ctx.stroke();

        const roadTex = new THREE.CanvasTexture(roadCanvas);
        roadTex.wrapS = THREE.RepeatWrapping;
        roadTex.wrapT = THREE.RepeatWrapping;
        roadTex.repeat.set(1, 35);

        const roadMat = new THREE.MeshStandardMaterial({ map: roadTex, roughness: 0.8, metalness: 0.15 });
        const roadMesh = new THREE.Mesh(roadGeom, roadMat);
        roadMesh.receiveShadow = true;
        trackGroup.add(roadMesh);

        // Бордюры
        const curbIndices = [];
        for (let i = 0; i < segments; i++) {
            const b = i * 4;
            curbIndices.push(b, b + 1, b + 4);
            curbIndices.push(b + 1, b + 5, b + 4);
            curbIndices.push(b + 2, b + 3, b + 6);
            curbIndices.push(b + 3, b + 7, b + 6);
        }
        curbGeom.setAttribute('position', new THREE.Float32BufferAttribute(curbPositions, 3));
        curbGeom.setAttribute('color', new THREE.Float32BufferAttribute(curbColors, 3));
        curbGeom.setIndex(curbIndices);
        curbGeom.computeVertexNormals();

        const curbMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.65 });
        const curbMesh = new THREE.Mesh(curbGeom, curbMat);
        curbMesh.receiveShadow = true;
        trackGroup.add(curbMesh);

        // Отбойники
        const barIndices = [];
        for (let i = 0; i < segments; i++) {
            const b = i * 4;
            barIndices.push(b, b + 1, b + 4);
            barIndices.push(b + 1, b + 5, b + 4);
            barIndices.push(b + 2, b + 3, b + 6);
            barIndices.push(b + 3, b + 7, b + 6);
        }
        barrierGeom.setAttribute('position', new THREE.Float32BufferAttribute(barrierPositions, 3));
        barrierGeom.setAttribute('color', new THREE.Float32BufferAttribute(barrierColors, 3));
        barrierGeom.setIndex(barIndices);
        barrierGeom.computeVertexNormals();

        const barrierMat = new THREE.MeshStandardMaterial({
            vertexColors: true,
            roughness: 0.4,
            metalness: 0.5,
            side: THREE.DoubleSide
        });
        const barrierMesh = new THREE.Mesh(barrierGeom, barrierMat);
        barrierMesh.castShadow = true;
        barrierMesh.receiveShadow = true;
        trackGroup.add(barrierMesh);

        createStartFinishArch(trackGroup);
        createDecorations(trackGroup, trackIndex === 0);
    }

    function createStartFinishArch(parentGroup) {
        const p0 = currentTrackCurve.getPointAt(0);
        const tangent = currentTrackCurve.getTangentAt(0).normalize();
        const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
        const w = CONFIG.roadWidth + 4;

        const archGroup = new THREE.Group();
        const pillarMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, metalness: 0.85, roughness: 0.2 });
        const postGeom = new THREE.CylinderGeometry(0.35, 0.45, 6.5, 12);

        // Левый стартовый пилон со световым маяком
        const leftPost = new THREE.Mesh(postGeom, pillarMat);
        leftPost.position.copy(p0).add(normal.clone().multiplyScalar(-w / 2)).setY(3.25);
        leftPost.castShadow = true;
        archGroup.add(leftPost);

        const leftBeacon = new THREE.Mesh(new THREE.SphereGeometry(0.38, 12, 12), new THREE.MeshBasicMaterial({ color: 0x00f0ff }));
        leftBeacon.position.copy(leftPost.position).setY(6.7);
        archGroup.add(leftBeacon);

        // Правый стартовый пилон со световым маяком
        const rightPost = new THREE.Mesh(postGeom, pillarMat);
        rightPost.position.copy(p0).add(normal.clone().multiplyScalar(w / 2)).setY(3.25);
        rightPost.castShadow = true;
        archGroup.add(rightPost);

        const rightBeacon = new THREE.Mesh(new THREE.SphereGeometry(0.38, 12, 12), new THREE.MeshBasicMaterial({ color: 0x00f0ff }));
        rightBeacon.position.copy(rightPost.position).setY(6.7);
        archGroup.add(rightBeacon);

        // Клетчатая финишная черта на асфальте (пространство над трассой свободно, обзор 100% открыт!)
        const finishLineGeom = new THREE.PlaneGeometry(CONFIG.roadWidth, 2.5);
        finishLineGeom.rotateX(-Math.PI / 2);
        const checkCanvas = document.createElement('canvas');
        checkCanvas.width = 256;
        checkCanvas.height = 64;
        const cctx = checkCanvas.getContext('2d');
        const sq = 32;
        for (let x = 0; x < 256; x += sq) {
            for (let y = 0; y < 64; y += sq) {
                cctx.fillStyle = (Math.floor(x / sq) + Math.floor(y / sq)) % 2 === 0 ? '#ffffff' : '#111111';
                cctx.fillRect(x, y, sq, sq);
            }
        }
        const checkTex = new THREE.CanvasTexture(checkCanvas);
        const checkMat = new THREE.MeshBasicMaterial({ map: checkTex });
        const finishLine = new THREE.Mesh(finishLineGeom, checkMat);
        finishLine.position.copy(p0).setY(0.08);
        finishLine.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), tangent);
        archGroup.add(finishLine);

        parentGroup.add(archGroup);
    }

    let basePineTemplate = null;
    let currentDecorationsGroup = null;
    let currentDecorationsIsDay = true;

    function initPineModel() {
        if (window.PINE_MODEL_BASE64 && typeof THREE.GLTFLoader !== 'undefined') {
            try {
                const binaryStr = atob(window.PINE_MODEL_BASE64);
                const len = binaryStr.length;
                const bytes = new Uint8Array(len);
                for (let i = 0; i < len; i++) {
                    bytes[i] = binaryStr.charCodeAt(i);
                }
                new THREE.GLTFLoader().parse(bytes.buffer, '', (gltf) => {
                    basePineTemplate = gltf.scene;
                    basePineTemplate.traverse((child) => {
                        if (child.isMesh) {
                            child.castShadow = false;
                            child.receiveShadow = false;
                        }
                    });
                    if (currentDecorationsGroup) {
                        populateDecorations(currentDecorationsGroup, currentDecorationsIsDay);
                    }
                });
            } catch (e) {
                console.warn('Error parsing pine model:', e);
            }
        }
    }
    initPineModel();

    function createPineTree(scale = 1.0, isDay = true) {
        if (basePineTemplate) {
            const pine = basePineTemplate.clone(true);
            const s = scale * 5.2; // Настоящая детальная 3D ель с ветвями и иголками (~6.8м в высоту)
            pine.scale.set(s, s, s);
            pine.rotation.y = Math.random() * Math.PI * 2;
            return pine;
        }

        // Запасная объемная ель с 16 пушистыми хвойными лапами (не конусы!)
        const pine = new THREE.Group();
        const trunkMat = new THREE.MeshStandardMaterial({ color: 0x3d271d, roughness: 0.92 });
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.18 * scale, 0.42 * scale, 4.2 * scale, 8), trunkMat);
        trunk.position.y = 2.1 * scale;
        trunk.castShadow = true;
        pine.add(trunk);

        const needleMat = new THREE.MeshStandardMaterial({
            color: isDay ? 0x1f5c35 : 0x10361f,
            roughness: 0.78
        });

        const tiers = 16;
        for (let t = 0; t < tiers; t++) {
            const hRatio = t / tiers;
            const y = (1.2 + hRatio * 3.6) * scale;
            const branchLen = (3.2 * (1.0 - hRatio * 0.72)) * scale;
            const branch = new THREE.Mesh(
                new THREE.ConeGeometry(branchLen * 0.42, branchLen, 5),
                needleMat
            );
            branch.rotateX(Math.PI / 2.3);
            branch.position.y = y;
            branch.rotation.y = t * 2.399;
            branch.castShadow = false;
            branch.receiveShadow = false;
            pine.add(branch);
        }
        return pine;
    }

    function createRock(scale = 1.0) {
        const rockGeom = new THREE.DodecahedronGeometry(1.2 * scale, 1);
        const rockMat = new THREE.MeshStandardMaterial({
            color: 0x5a6a7a,
            roughness: 0.9,
            flatShading: true
        });
        const rock = new THREE.Mesh(rockGeom, rockMat);
        rock.position.y = 0.5 * scale;
        rock.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
        rock.castShadow = true;
        rock.receiveShadow = true;
        return rock;
    }

    function createDecorations(parentGroup, isDay) {
        currentDecorationsGroup = new THREE.Group();
        currentDecorationsIsDay = isDay;
        parentGroup.add(currentDecorationsGroup);
        populateDecorations(currentDecorationsGroup, isDay);
    }

    function populateDecorations(targetGroup, isDay) {
        while (targetGroup.children.length > 0) {
            targetGroup.remove(targetGroup.children[0]);
        }

        const count = 52;
        const lampMat = new THREE.MeshStandardMaterial({ color: 0x334155, metalness: 0.8 });
        const bulbMat = new THREE.MeshBasicMaterial({ color: isDay ? 0xfef08a : 0x38bdf8 });

        for (let i = 0; i < count; i++) {
            const t = i / count;
            const pt = currentTrackCurve.getPointAt(t);
            const tangent = currentTrackCurve.getTangentAt(t).normalize();
            const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
            const side = (i % 2 === 0 ? 1 : -1);
            const dist = CONFIG.roadWidth / 2 + 5.0;
            const pos = pt.clone().add(normal.clone().multiplyScalar(side * dist));

            if (i % 4 === 0) {
                // Фонарный столб
                const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 8, 8), lampMat);
                pole.position.copy(pos).setY(4);
                pole.castShadow = false;
                targetGroup.add(pole);

                const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.4, 8, 8), bulbMat);
                bulb.position.copy(pos).setY(8);
                targetGroup.add(bulb);
            } else if (i % 5 === 0) {
                // Природный валун
                const rockScale = 0.8 + (i % 3) * 0.4;
                const rock = createRock(rockScale);
                rock.position.copy(pos).add(normal.clone().multiplyScalar(side * (Math.random() * 4 + 1.5)));
                targetGroup.add(rock);
            } else {
                // Настоящая 3D ель
                const pineScale = 0.85 + ((i * 7) % 7) * 0.09;
                const pine = createPineTree(pineScale, isDay);
                pine.position.copy(pos).add(normal.clone().multiplyScalar(side * (Math.random() * 6 + 2.0)));
                targetGroup.add(pine);

                // Дополнительная ель в роще
                if (i % 3 === 1) {
                    const pine2 = createPineTree(pineScale * 0.78, isDay);
                    pine2.position.copy(pine.position).add(new THREE.Vector3((Math.random() - 0.5) * 8, 0, (Math.random() - 0.5) * 8));
                    targetGroup.add(pine2);
                }
            }
        }
    }

    // --- МОДЕЛЬ МАШИНЫ ---
    function buildCarModel(colorHex = 0x00d2ff, isPlayer = false) {
        const car = new THREE.Group();

        const bodyMat = new THREE.MeshStandardMaterial({
            color: colorHex,
            metalness: 0.88,
            roughness: 0.16
        });
        const stripeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.2 });
        const darkMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.35 });
        const glassMat = new THREE.MeshStandardMaterial({
            color: 0x0a101d,
            metalness: 0.95,
            roughness: 0.08,
            transparent: true,
            opacity: 0.85
        });
        const wheelMat = new THREE.MeshStandardMaterial({ color: 0x18181b, roughness: 0.85 });
        const rimMat = new THREE.MeshStandardMaterial({ color: 0xf1f5f9, metalness: 0.95, roughness: 0.1 });

        const bodyGroup = new THREE.Group();

        const baseGeom = new THREE.BoxGeometry(2.1, 0.55, 4.4);
        const baseMesh = new THREE.Mesh(baseGeom, bodyMat);
        baseMesh.position.y = 0.5;
        baseMesh.castShadow = true;
        bodyGroup.add(baseMesh);

        const stripeGeom = new THREE.BoxGeometry(0.35, 0.02, 4.42);
        const stripeMesh = new THREE.Mesh(stripeGeom, stripeMat);
        stripeMesh.position.set(0, 0.78, 0);
        bodyGroup.add(stripeMesh);

        const cabinGeom = new THREE.BoxGeometry(1.65, 0.58, 2.2);
        const cabinMesh = new THREE.Mesh(cabinGeom, glassMat);
        cabinMesh.position.set(0, 0.96, -0.2);
        cabinMesh.castShadow = true;
        bodyGroup.add(cabinMesh);

        const roofGeom = new THREE.BoxGeometry(1.5, 0.08, 1.8);
        const roofMesh = new THREE.Mesh(roofGeom, bodyMat);
        roofMesh.position.set(0, 1.26, -0.2);
        bodyGroup.add(roofMesh);

        const noseGeom = new THREE.BoxGeometry(2.0, 0.34, 0.9);
        const noseMesh = new THREE.Mesh(noseGeom, bodyMat);
        noseMesh.position.set(0, 0.38, 2.35);
        noseMesh.castShadow = true;
        bodyGroup.add(noseMesh);

        const splitterGeom = new THREE.BoxGeometry(2.15, 0.08, 0.5);
        const splitterMesh = new THREE.Mesh(splitterGeom, darkMat);
        splitterMesh.position.set(0, 0.18, 2.65);
        splitterMesh.castShadow = true;
        bodyGroup.add(splitterMesh);

        const spoilerWing = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.08, 0.55), darkMat);
        spoilerWing.position.set(0, 1.25, -2.15);
        spoilerWing.castShadow = true;
        bodyGroup.add(spoilerWing);

        const leftStrut = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.5, 0.18), darkMat);
        leftStrut.position.set(-0.75, 0.98, -2.15);
        bodyGroup.add(leftStrut);
        const rightStrut = leftStrut.clone();
        rightStrut.position.x = 0.75;
        bodyGroup.add(rightStrut);

        const headlightMat = new THREE.MeshBasicMaterial({ color: 0xeff6ff });
        const leftLight = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.14, 0.1), headlightMat);
        leftLight.position.set(-0.75, 0.52, 2.75);
        bodyGroup.add(leftLight);
        const rightLight = leftLight.clone();
        rightLight.position.x = 0.75;
        bodyGroup.add(rightLight);

        const brakeLightMat = new THREE.MeshBasicMaterial({ color: 0x770011 });
        const rearLight = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.12, 0.1), brakeLightMat);
        rearLight.position.set(0, 0.62, -2.22);
        bodyGroup.add(rearLight);

        if (isPlayer) {
            const underLight = new THREE.PointLight(0x00f0ff, 2.0, 6.0);
            underLight.position.set(0, 0.2, 0);
            car.add(underLight);
        }

        car.add(bodyGroup);

        const wheelGeom = new THREE.CylinderGeometry(0.44, 0.44, 0.38, 16);
        wheelGeom.rotateZ(Math.PI / 2);
        const rimGeom = new THREE.CylinderGeometry(0.26, 0.26, 0.39, 8);
        rimGeom.rotateZ(Math.PI / 2);

        function createWheel() {
            const wGroup = new THREE.Group();
            const tire = new THREE.Mesh(wheelGeom, wheelMat);
            tire.castShadow = true;
            const rim = new THREE.Mesh(rimGeom, rimMat);
            wGroup.add(tire);
            wGroup.add(rim);
            return wGroup;
        }

        const frontLeftWheelGroup = new THREE.Group();
        const frontLeftWheel = createWheel();
        frontLeftWheelGroup.add(frontLeftWheel);
        frontLeftWheelGroup.position.set(-1.12, 0.44, 1.4);
        car.add(frontLeftWheelGroup);

        const frontRightWheelGroup = new THREE.Group();
        const frontRightWheel = createWheel();
        frontRightWheelGroup.add(frontRightWheel);
        frontRightWheelGroup.position.set(1.12, 0.44, 1.4);
        car.add(frontRightWheelGroup);

        const rearLeftWheel = createWheel();
        rearLeftWheel.position.set(-1.12, 0.44, -1.35);
        car.add(rearLeftWheel);

        const rearRightWheel = createWheel();
        rearRightWheel.position.set(1.12, 0.44, -1.35);
        car.add(rearRightWheel);

        const exhaustMat = new THREE.MeshBasicMaterial({ color: 0x00f0ff });
        const leftExhaust = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.35, 8), exhaustMat);
        leftExhaust.rotateX(Math.PI / 2);
        leftExhaust.position.set(-0.48, 0.35, -2.28);
        leftExhaust.visible = false;
        car.add(leftExhaust);

        const rightExhaust = leftExhaust.clone();
        rightExhaust.position.x = 0.48;
        rightExhaust.visible = false;
        car.add(rightExhaust);

        scene.add(car);

        return {
            group: car,
            bodyGroup,
            frontLeftWheelGroup,
            frontRightWheelGroup,
            frontLeftWheel,
            frontRightWheel,
            rearLeftWheel,
            rearRightWheel,
            brakeLightMat,
            leftExhaust,
            rightExhaust
        };
    }

    const playerModel = buildCarModel(0x00d2ff, true);
    const player = {
        model: playerModel,
        pos: new THREE.Vector3(0, 0, 0),
        heading: 0,
        speed: 0,
        steerAngle: 0,
        driftFactor: 0,
        nitroEnergy: 100,
        trackProgress: 0,
        currentLap: 1,
        lapProgress: 0,
        totalProgress: 0,
        isBraking: false,
        isDrifting: false
    };

    // ПАЛИТРА ЦВЕТОВ ДЛЯ МАШИН (игрок и соперники)
    const CAR_PALETTE = [
        { name: 'Синий Апекс', hex: '#00d2ff', hue: 0 },
        { name: 'Красный Апекс', hex: '#ff2a55', hue: 2.27 },
        { name: 'Золотой Апекс', hex: '#ffbb00', hue: 3.55 },
        { name: 'Изумрудный Апекс', hex: '#10b981', hue: 4.54 },
        { name: 'Фиолетовый Апекс', hex: '#a855f7', hue: 5.40 },
        { name: 'Оранжевый Апекс', hex: '#f97316', hue: 2.80 }
    ];

    // БОТЫ (AI)
    const aiCars = [];
    const AI_DEFAULT_CONFIGS = [
        { hex: '#ff2a55', hue: 2.27, offset: 3.2, name: 'Красный Апекс' },
        { hex: '#ffbb00', hue: 3.55, offset: -3.2, name: 'Золотой Апекс' },
        { hex: '#10b981', hue: 4.54, offset: 2.2, name: 'Изумрудный Апекс' }
    ];

    AI_DEFAULT_CONFIGS.forEach((item, idx) => {
        const colNum = parseInt(item.hex.replace('#', '0x'), 16);
        const model = buildCarModel(colNum, false);
        aiCars.push({
            model: model,
            t: 0,
            speed: 23 + idx * 1.5,
            sideOffset: item.offset,
            targetSideOffset: item.offset,
            currentLap: 1,
            totalProgress: 0,
            name: item.name,
            colorHex: item.hex,
            hue: item.hue,
            customCar: null
        });
    });

    let masterCarScene = null;
    let playerCustomCar = null;

    // Клонирование 3D-модели GLB со сдвигом оттенка (Hue Shift) в шейдере
    function createTintedCarClone(sourceModel, hueRadians) {
        const clone = sourceModel.clone(true);
        clone.traverse((child) => {
            if (child.isMesh && child.material) {
                const originalMat = child.material;
                const mat = originalMat.clone();
                if (Math.abs(hueRadians) > 0.02) {
                    const cosA = Math.cos(hueRadians).toFixed(5);
                    const sinA = Math.sin(hueRadians).toFixed(5);
                    mat.onBeforeCompile = (shader) => {
                        shader.fragmentShader = `
                            vec3 applyHueShift(vec3 c) {
                                const vec3 k = vec3(0.57735, 0.57735, 0.57735);
                                float cosAngle = ${cosA};
                                float sinAngle = ${sinA};
                                return c * cosAngle + cross(k, c) * sinAngle + k * dot(k, c) * (1.0 - cosAngle);
                            }
                        ` + shader.fragmentShader;
                        shader.fragmentShader = shader.fragmentShader.replace(
                            '#include <map_fragment>',
                            `
                            #include <map_fragment>
                            #ifdef USE_MAP
                            diffuseColor.rgb = applyHueShift(diffuseColor.rgb);
                            #endif
                            `
                        );
                    };
                    mat.customProgramCacheKey = () => 'car_hue_' + hueRadians.toFixed(3);
                }
                child.material = mat;
                child.castShadow = true;
                child.receiveShadow = true;
            }
        });
        return clone;
    }

    // Перекрашивание машин ботов в другие цвета, отличные от цвета игрока
    function reassignAICarColors() {
        if (!masterCarScene) return;
        const available = CAR_PALETTE.filter(p => Math.abs(p.hue - STATE.playerHue) > 0.15);
        aiCars.forEach((ai, idx) => {
            const chosen = available[idx % available.length];
            ai.colorHex = chosen.hex;
            ai.hue = chosen.hue;
            ai.name = chosen.name;

            if (ai.customCar) {
                ai.model.group.remove(ai.customCar);
                ai.customCar.traverse(c => {
                    if (c.isMesh && c.material) c.material.dispose();
                });
            }
            ai.customCar = createTintedCarClone(masterCarScene, ai.hue);
            ai.model.group.add(ai.customCar);
        });
    }

    // Выбор цвета машинки игроком
    function setPlayerColor(hue, hex) {
        STATE.playerHue = hue;
        STATE.playerColorHex = hex;

        if (masterCarScene) {
            if (playerCustomCar) {
                player.model.group.remove(playerCustomCar);
                playerCustomCar.traverse(c => {
                    if (c.isMesh && c.material) c.material.dispose();
                });
            }
            playerCustomCar = createTintedCarClone(masterCarScene, hue);
            player.model.group.add(playerCustomCar);

            reassignAICarColors();
        }
    }

    function tryLoadCustomGLB(modelPath = 'car.glb') {
        if (typeof THREE.GLTFLoader === 'undefined') return;
        const loader = new THREE.GLTFLoader();

        function applyModel(customModel) {
            const box = new THREE.Box3().setFromObject(customModel);
            const size = new THREE.Vector3();
            box.getSize(size);
            const maxDim = Math.max(size.x, size.y, size.z);
            const scale = 4.4 / (maxDim || 4.4);
            customModel.scale.set(scale, scale, scale);

            customModel.traverse((child) => {
                if (child.isMesh) {
                    child.castShadow = true;
                    child.receiveShadow = true;
                }
            });

            masterCarScene = customModel;

            // 1. Применяем к машинке игрока
            if (player.model.bodyGroup) player.model.bodyGroup.visible = false;
            if (player.model.frontLeftWheelGroup) player.model.frontLeftWheelGroup.visible = false;
            if (player.model.frontRightWheelGroup) player.model.frontRightWheelGroup.visible = false;
            if (player.model.rearLeftWheel) player.model.rearLeftWheel.visible = false;
            if (player.model.rearRightWheel) player.model.rearRightWheel.visible = false;

            playerCustomCar = createTintedCarClone(masterCarScene, STATE.playerHue || 0);
            player.model.group.add(playerCustomCar);

            // 2. Применяем ко ВСЕМ машинкам соперников (AI)
            aiCars.forEach(ai => {
                if (ai.model.bodyGroup) ai.model.bodyGroup.visible = false;
                if (ai.model.frontLeftWheelGroup) ai.model.frontLeftWheelGroup.visible = false;
                if (ai.model.frontRightWheelGroup) ai.model.frontRightWheelGroup.visible = false;
                if (ai.model.rearLeftWheel) ai.model.rearLeftWheel.visible = false;
                if (ai.model.rearRightWheel) ai.model.rearRightWheel.visible = false;
            });
            reassignAICarColors();
        }

        // 1. Попытка загрузить встроенную модель (работает офлайн и без сервера по file://)
        if (window.CAR_MODEL_BASE64) {
            try {
                const binaryStr = atob(window.CAR_MODEL_BASE64);
                const len = binaryStr.length;
                const bytes = new Uint8Array(len);
                for (let i = 0; i < len; i++) {
                    bytes[i] = binaryStr.charCodeAt(i);
                }
                loader.parse(
                    bytes.buffer,
                    '',
                    (gltf) => {
                        applyModel(gltf.scene);
                    },
                    (err) => {
                        console.warn('Failed to parse embedded car model, falling back to URL:', err);
                        loadViaUrl();
                    }
                );
                return;
            } catch (e) {
                console.warn('Error decoding base64 car model:', e);
            }
        }

        // 2. Резервная загрузка через HTTP-запрос по URL
        loadViaUrl();

        function loadViaUrl() {
            loader.load(
                modelPath,
                (gltf) => {
                    applyModel(gltf.scene);
                },
                undefined,
                (err) => {
                    console.warn('Custom GLB car could not be loaded, using procedural model:', err);
                }
            );
        }
    }

    tryLoadCustomGLB('car.glb');

    let lastKnownT = 0.01;
    const cameraCurrentPos = new THREE.Vector3();
    const cameraTargetLook = new THREE.Vector3();

    function snapCameraToPlayer() {
        const heading = player.heading;
        let camDistBehind = 14.5;
        let camHeight = 9.5;
        let lookAheadDist = 6.0;
        let lookHeight = 1.6;

        if (STATE.cameraMode === 1) {
            camHeight = 4.2;
            camDistBehind = 9.5;
            lookAheadDist = 8.0;
            lookHeight = 1.2;
        } else if (STATE.cameraMode === 2) {
            camHeight = 22.0;
            camDistBehind = 16.0;
            lookAheadDist = 4.0;
            lookHeight = 0.5;
        }

        const behindVec = new THREE.Vector3(
            -Math.sin(heading) * camDistBehind,
            camHeight,
            -Math.cos(heading) * camDistBehind
        );
        cameraCurrentPos.copy(player.pos).add(behindVec);
        cameraTargetLook.copy(player.pos).add(new THREE.Vector3(
            Math.sin(heading) * lookAheadDist,
            lookHeight,
            Math.cos(heading) * lookAheadDist
        ));
        camera.position.copy(cameraCurrentPos);
        camera.lookAt(cameraTargetLook);
    }

    function resetPositions() {
        lastKnownT = 0.01;
        const pStart = currentTrackCurve.getPointAt(0.01);
        const pStartAhead = currentTrackCurve.getPointAt(0.02);
        player.pos.copy(pStart);
        player.heading = Math.atan2(pStartAhead.x - pStart.x, pStartAhead.z - pStart.z);
        player.speed = 0;
        player.steerAngle = 0;
        player.driftFactor = 0;
        player.nitroEnergy = 100;
        player.currentLap = 1;
        player.lapProgress = 0.01;
        player.totalProgress = 0.01;
        player.trackProgress = 0.01;
        player.isBraking = false;
        player.isDrifting = false;

        player.model.group.position.copy(player.pos);
        player.model.group.rotation.set(0, player.heading, 0);

        if (player.model.frontLeftWheelGroup) player.model.frontLeftWheelGroup.rotation.y = 0;
        if (player.model.frontRightWheelGroup) player.model.frontRightWheelGroup.rotation.y = 0;

        // Сброс всех управляющих инпутов
        INPUT.forward = false;
        INPUT.backward = false;
        INPUT.left = false;
        INPUT.right = false;
        INPUT.nitro = false;
        INPUT.brake = false;
        JOYSTICK.active = false;
        JOYSTICK.steer = 0;
        JOYSTICK.throttle = 0;
        MOUSE_CONTROL.leftDown = false;
        MOUSE_CONTROL.rightDown = false;
        MOUSE_CONTROL.steerDelta = 0;

        const isEasyTrack = (STATE.currentTrackIndex === 0);
        aiCars.forEach((ai, idx) => {
            ai.speed = isEasyTrack ? (22 + idx * 1.5 + Math.random() * 2) : (36 + idx * 1.5 + Math.random() * 3);

            const startT = (0.01 - (idx + 1) * 0.025 + 1.0) % 1.0;
            ai.t = startT;
            ai.currentLap = 1;
            ai.totalProgress = startT;

            const centerPt = currentTrackCurve.getPointAt(ai.t);
            const tangent = currentTrackCurve.getTangentAt(ai.t).normalize();
            const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
            const pos = centerPt.clone().add(normal.clone().multiplyScalar(ai.sideOffset));
            ai.model.group.position.copy(pos);
            ai.model.group.rotation.set(0, Math.atan2(tangent.x, tangent.z), 0);
        });

        snapCameraToPlayer();

        const uiLap = document.getElementById('ui-lap');
        if (uiLap) uiLap.textContent = `1/${CONFIG.totalLaps}`;
        const uiPos = document.getElementById('ui-pos');
        if (uiPos) uiPos.textContent = '1';
        const uiTime = document.getElementById('ui-time');
        if (uiTime) uiTime.textContent = '00:00.0';
        const speedNum = document.getElementById('speed-number');
        if (speedNum) speedNum.textContent = '0';
    }

    buildTrack(0);
    resetPositions();

    // --- ЧАСТИЦЫ ---
    const MAX_PARTICLES = 160;
    const particleGeom = new THREE.BufferGeometry();
    const particlePositions = new Float32Array(MAX_PARTICLES * 3);
    const particleColors = new Float32Array(MAX_PARTICLES * 3);
    const particleSizes = new Float32Array(MAX_PARTICLES);

    for (let i = 0; i < MAX_PARTICLES; i++) {
        particlePositions[i * 3 + 1] = -100;
        particleSizes[i] = 0;
    }

    particleGeom.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3));
    particleGeom.setAttribute('color', new THREE.BufferAttribute(particleColors, 3));
    particleGeom.setAttribute('size', new THREE.BufferAttribute(particleSizes, 1));

    const partCanvas = document.createElement('canvas');
    partCanvas.width = 64;
    partCanvas.height = 64;
    const pctx = partCanvas.getContext('2d');
    const grad = pctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.4, 'rgba(255,255,255,0.7)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    pctx.fillStyle = grad;
    pctx.fillRect(0, 0, 64, 64);
    const partTex = new THREE.CanvasTexture(partCanvas);

    const particleMat = new THREE.PointsMaterial({
        size: 1.2,
        map: partTex,
        transparent: true,
        vertexColors: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending
    });

    const particleSystem = new THREE.Points(particleGeom, particleMat);
    scene.add(particleSystem);

    const particlesData = [];
    for (let i = 0; i < MAX_PARTICLES; i++) {
        particlesData.push({
            alive: false,
            life: 0,
            maxLife: 1,
            vx: 0, vy: 0, vz: 0,
            size: 0.8
        });
    }

    function spawnParticle(x, y, z, vx, vy, vz, r, g, b, maxLife, size) {
        for (let i = 0; i < MAX_PARTICLES; i++) {
            if (!particlesData[i].alive) {
                const p = particlesData[i];
                p.alive = true;
                p.life = 0;
                p.maxLife = maxLife;
                p.vx = vx;
                p.vy = vy;
                p.vz = vz;
                p.size = size;

                particlePositions[i * 3] = x;
                particlePositions[i * 3 + 1] = y;
                particlePositions[i * 3 + 2] = z;

                particleColors[i * 3] = r;
                particleColors[i * 3 + 1] = g;
                particleColors[i * 3 + 2] = b;

                particleSizes[i] = size;
                return;
            }
        }
    }

    function updateParticles(dt) {
        for (let i = 0; i < MAX_PARTICLES; i++) {
            const p = particlesData[i];
            if (p.alive) {
                p.life += dt;
                if (p.life >= p.maxLife) {
                    p.alive = false;
                    particlePositions[i * 3 + 1] = -100;
                    continue;
                }
                const progress = p.life / p.maxLife;
                particlePositions[i * 3] += p.vx * dt;
                particlePositions[i * 3 + 1] += p.vy * dt;
                particlePositions[i * 3 + 2] += p.vz * dt;
                particleSizes[i] = p.size * (1 + progress * 2.0);
            }
        }
        particleGeom.attributes.position.needsUpdate = true;
        particleGeom.attributes.size.needsUpdate = true;
    }

    // --- ФИЗИКА И УПРАВЛЕНИЕ ИГРОКОМ С БОРТИКАМИ И КНОПКОЙ СТОП ---
    function updatePlayerPhysics(dt) {
        let throttleInput = 0;
        const isWowMouseDrive = (MOUSE_CONTROL.leftDown && MOUSE_CONTROL.rightDown);

        if (JOYSTICK.active) {
            throttleInput = JOYSTICK.throttle;
        } else {
            if (INPUT.forward || isWowMouseDrive) throttleInput += 1.0;
            if (INPUT.backward) throttleInput -= 1.0;
        }

        // КНОПКА «СТОП»: ОСТАНАВЛИВАЕТ И ПЕРЕДНИЙ, И ЗАДНИЙ ХОД! (НИКАКОГО ДВИЖЕНИЯ НАЗАД)
        if (INPUT.brake) {
            player.isBraking = true;
            if (player.speed > 0) {
                player.speed = Math.max(0, player.speed - CONFIG.brakePower * 1.6 * dt);
            } else if (player.speed < 0) {
                player.speed = Math.min(0, player.speed + CONFIG.brakePower * 1.6 * dt);
            }
            if (Math.abs(player.speed) < 0.6) {
                player.speed = 0;
            }
            player.model.brakeLightMat.color.setHex(0xff0033);
        } else {
            const isAccelerating = (throttleInput > 0.1);
            player.isBraking = (throttleInput < -0.1);

            // Нитро
            let maxSpd = CONFIG.maxSpeed;
            const isUsingNitro = INPUT.nitro && player.nitroEnergy > 0 && isAccelerating;
            if (isUsingNitro) {
                maxSpd = CONFIG.nitroMaxSpeed;
                player.nitroEnergy = Math.max(0, player.nitroEnergy - dt * 25);
                player.model.leftExhaust.visible = true;
                player.model.rightExhaust.visible = true;

                const backOff = new THREE.Vector3(0, 0.4, -2.4).applyAxisAngle(new THREE.Vector3(0, 1, 0), player.heading).add(player.pos);
                spawnParticle(backOff.x, backOff.y, backOff.z, (Math.random() - 0.5) * 2, Math.random() * 1.5, (Math.random() - 0.5) * 2, 0.0, 0.9, 1.0, 0.25, 1.2);
            } else {
                player.model.leftExhaust.visible = false;
                player.model.rightExhaust.visible = false;
                player.nitroEnergy = Math.min(100, player.nitroEnergy + dt * 4.5);
            }

            // Стоп-сигналы
            if (player.isBraking) {
                player.model.brakeLightMat.color.setHex(0xff0033);
            } else {
                player.model.brakeLightMat.color.setHex(0x770011);
            }

            // Разгон и торможение от стика
            if (isAccelerating) {
                const power = Math.abs(throttleInput);
                const accelMult = (player.speed < maxSpd * 0.5) ? 1.25 : 0.95;
                player.speed += CONFIG.accel * power * accelMult * dt;
            } else if (player.isBraking) {
                if (player.speed > 1.0) {
                    player.speed -= CONFIG.brakePower * dt;
                } else {
                    // Задний ход включается ТОЛЬКО когда стик потянут назад и машина уже стояла
                    player.speed = Math.max(-14.0, player.speed - CONFIG.accel * 0.75 * dt);
                }
            } else {
                if (player.speed > 0) {
                    player.speed = Math.max(0, player.speed - CONFIG.friction * dt);
                } else if (player.speed < 0) {
                    player.speed = Math.min(0, player.speed + CONFIG.friction * dt);
                }
            }
            player.speed = Math.min(maxSpd, player.speed);
        }

        // РУЛЕВОЕ УПРАВЛЕНИЕ: Инвертировано (стик вправо -> машина вправо)
        let steerInput = 0;
        if (JOYSTICK.active) {
            steerInput = -JOYSTICK.steer;
        } else {
            if (INPUT.left) steerInput += 1.0;
            if (INPUT.right) steerInput -= 1.0;
            if (MOUSE_CONTROL.rightDown) {
                steerInput += MOUSE_CONTROL.steerDelta;
            }
            steerInput = THREE.MathUtils.clamp(steerInput, -1.0, 1.0);
        }

        // Плавный возврат мышиного руля в центр
        MOUSE_CONTROL.steerDelta *= 0.86;
        if (Math.abs(MOUSE_CONTROL.steerDelta) < 0.005) MOUSE_CONTROL.steerDelta = 0;

        const targetSteer = steerInput * CONFIG.maxSteerAngle;
        player.steerAngle += (targetSteer - player.steerAngle) * Math.min(1.0, 14 * dt);

        player.model.frontLeftWheelGroup.rotation.y = -player.steerAngle;
        player.model.frontRightWheelGroup.rotation.y = -player.steerAngle;

        const wheelRoll = (player.speed * dt) / 0.44;
        player.model.frontLeftWheel.rotation.x += wheelRoll;
        player.model.frontRightWheel.rotation.x += wheelRoll;
        player.model.rearLeftWheel.rotation.x += wheelRoll;
        player.model.rearRightWheel.rotation.x += wheelRoll;

        // Дрифт
        const turnIntensity = Math.abs(player.steerAngle) * Math.abs(player.speed);
        player.isDrifting = (turnIntensity > 15.0 && (player.isBraking || Math.abs(player.steerAngle) > 0.35));

        if (player.isDrifting && Math.abs(player.speed) > 10) {
            player.driftFactor += (1.0 - player.driftFactor) * 8 * dt;
            player.nitroEnergy = Math.min(100, player.nitroEnergy + dt * 15);

            const leftTire = player.pos.clone().add(new THREE.Vector3(-1.1, 0.1, -1.3).applyAxisAngle(new THREE.Vector3(0, 1, 0), player.heading));
            const rightTire = player.pos.clone().add(new THREE.Vector3(1.1, 0.1, -1.3).applyAxisAngle(new THREE.Vector3(0, 1, 0), player.heading));
            spawnParticle(leftTire.x, leftTire.y, leftTire.z, (Math.random() - 0.5) * 1.5, Math.random() * 0.8 + 0.3, (Math.random() - 0.5) * 1.5, 0.85, 0.88, 0.95, 0.4, 1.4);
            spawnParticle(rightTire.x, rightTire.y, rightTire.z, (Math.random() - 0.5) * 1.5, Math.random() * 0.8 + 0.3, (Math.random() - 0.5) * 1.5, 0.85, 0.88, 0.95, 0.4, 1.4);
        } else {
            player.driftFactor += (0.0 - player.driftFactor) * 6 * dt;
        }

        const speedRatio = Math.min(1.0, Math.abs(player.speed) / (CONFIG.maxSpeed * 0.6));
        if (Math.abs(player.speed) > 0.1) {
            const steerFactor = player.isDrifting ? 1.4 : 1.0;
            player.heading += player.steerAngle * speedRatio * (player.speed >= 0 ? 1 : -1) * CONFIG.steerSpeed * steerFactor * dt;
        }

        const moveDir = new THREE.Vector3(
            Math.sin(player.heading + (player.steerAngle * player.driftFactor * 0.3)),
            0,
            Math.cos(player.heading + (player.steerAngle * player.driftFactor * 0.3))
        );
        player.pos.add(moveDir.multiplyScalar(player.speed * dt));

        // --- БОРТИКИ: НЕ ВЫЛЕТАЕМ + КОРОТКИЙ ЗВУК ---
        const closestSplineT = getClosestTrackT(player.pos);
        const centerPt = currentTrackCurve.getPointAt(closestSplineT);
        const tangent = currentTrackCurve.getTangentAt(closestSplineT).normalize();
        const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();

        const toCar = player.pos.clone().sub(centerPt);
        const lateralDist = toCar.dot(normal);
        const maxAllowedLateral = (CONFIG.roadWidth / 2) - 1.2;

        if (Math.abs(lateralDist) > maxAllowedLateral) {
            const clampedDist = Math.sign(lateralDist) * maxAllowedLateral;
            player.pos.copy(centerPt).add(normal.clone().multiplyScalar(clampedDist));

            player.speed *= 0.82;
            sound.playCrash(); // Звук с защитой от долгого гудения
            triggerHaptic(45);

            const sparkPos = player.pos.clone().add(normal.clone().multiplyScalar(Math.sign(lateralDist) * 1.1));
            for (let i = 0; i < 5; i++) {
                spawnParticle(
                    sparkPos.x, sparkPos.y + 0.6, sparkPos.z,
                    (Math.random() - 0.5) * 4, Math.random() * 3 + 1, (Math.random() - 0.5) * 4,
                    1.0, 0.8, 0.2, 0.3, 1.1
                );
            }

            const tangentHeading = Math.atan2(tangent.x, tangent.z);
            let diffHeading = tangentHeading - player.heading;
            while (diffHeading < -Math.PI) diffHeading += Math.PI * 2;
            while (diffHeading > Math.PI) diffHeading -= Math.PI * 2;
            player.heading += diffHeading * 0.15;
        }

        const rollAngle = -player.steerAngle * speedRatio * 0.16;
        player.model.group.rotation.z = rollAngle;
        player.model.group.position.copy(player.pos);
        player.model.group.rotation.y = player.heading;

        sound.update(
            Math.abs(player.speed) / CONFIG.maxSpeed,
            (throttleInput > 0.1),
            player.isDrifting,
            INPUT.nitro
        );

        updateLapProgress(closestSplineT);
        checkCollisionsWithAI();
    }

    function getClosestTrackT(pos) {
        let bestT = lastKnownT;
        const curPt = currentTrackCurve.getPointAt(lastKnownT);
        let minDistSq = pos.distanceToSquared(curPt);

        // Если машина дальше 20 метров от прошлой точки (рестарт, смена трассы), сканируем всю кривую
        if (minDistSq > 400) {
            const samples = 80;
            for (let i = 0; i < samples; i++) {
                const t = i / samples;
                const pt = currentTrackCurve.getPointAt(t);
                const dSq = pos.distanceToSquared(pt);
                if (dSq < minDistSq) {
                    minDistSq = dSq;
                    bestT = t;
                }
            }
        }

        const searchRange = 0.06;
        for (let i = -15; i <= 15; i++) {
            const testT = (bestT + (i / 15) * searchRange + 1.0) % 1.0;
            const pt = currentTrackCurve.getPointAt(testT);
            const distSq = pos.distanceToSquared(pt);
            if (distSq < minDistSq) {
                minDistSq = distSq;
                bestT = testT;
            }
        }
        lastKnownT = bestT;
        return bestT;
    }

    function updateLapProgress(currentT) {
        player.trackProgress = currentT;
        if (player.lapProgress > 0.85 && currentT < 0.15) {
            completeLap();
        }
        player.lapProgress = currentT;
        player.totalProgress = (STATE.currentLap - 1) + currentT;
    }

    function completeLap() {
        const now = performance.now();
        const lapDuration = (now - STATE.lapStartTime) / 1000;
        STATE.lapStartTime = now;

        if (lapDuration < STATE.bestLapTime && STATE.currentLap > 1) {
            STATE.bestLapTime = lapDuration;
            showCenterBanner(`ЛУЧШИЙ КРУГ! ${formatTime(lapDuration)}`);
        } else {
            showCenterBanner(`КРУГ ${STATE.currentLap}!`);
        }

        if (STATE.currentLap >= CONFIG.totalLaps) {
            finishRace();
        } else {
            STATE.currentLap++;
            document.getElementById('ui-lap').textContent = `${STATE.currentLap}/${CONFIG.totalLaps}`;
        }
    }

    function finishRace() {
        STATE.raceFinished = true;
        const finalPos = calculatePosition();
        showCenterBanner(`ФИНИШ! МЕСТО: ${finalPos}`);
        triggerHaptic(200);

        setTimeout(() => {
            const overlay = document.getElementById('overlay-screen');
            overlay.querySelector('h1').textContent = finalPos === 1 ? '🏆 ВЫ ПОБЕДИЛИ!' : '🏁 ГОНКА ЗАВЕРШЕНА!';
            overlay.querySelector('p').textContent = `Твое место: ${finalPos} из 4. Лучший круг: ${formatTime(STATE.bestLapTime)}. Сыграть еще раз?`;
            overlay.querySelector('#btn-start').textContent = 'РЕВАНШ!';
            overlay.classList.remove('hidden');
        }, 2200);
    }

    function updateAICars(dt) {
        aiCars.forEach(ai => {
            const deltaT = (ai.speed / trackLength) * dt;
            const prevT = ai.t;
            ai.t = (ai.t + deltaT) % 1.0;

            if (prevT > 0.85 && ai.t < 0.15) {
                ai.currentLap++;
            }
            ai.totalProgress = (ai.currentLap - 1) + ai.t;

            const centerPt = currentTrackCurve.getPointAt(ai.t);
            const tangent = currentTrackCurve.getTangentAt(ai.t).normalize();
            const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();

            ai.sideOffset += (ai.targetSideOffset - ai.sideOffset) * dt;
            const targetPos = centerPt.clone().add(normal.clone().multiplyScalar(ai.sideOffset));

            ai.model.group.position.copy(targetPos);
            ai.model.group.rotation.y = Math.atan2(tangent.x, tangent.z);

            const roll = (ai.speed * dt) / 0.44;
            ai.model.frontLeftWheel.rotation.x += roll;
            ai.model.frontRightWheel.rotation.x += roll;
            ai.model.rearLeftWheel.rotation.x += roll;
            ai.model.rearRightWheel.rotation.x += roll;
        });
    }

    function checkCollisionsWithAI() {
        const carRadius = 2.0;
        aiCars.forEach(ai => {
            const aiPos = ai.model.group.position;
            const dist = player.pos.distanceTo(aiPos);
            if (dist < carRadius) {
                const pushDir = player.pos.clone().sub(aiPos).normalize();
                player.pos.add(pushDir.clone().multiplyScalar(0.4));
                player.speed *= 0.75;
                sound.playCrash();
                triggerHaptic(70);

                const hitPoint = player.pos.clone().add(aiPos).multiplyScalar(0.5);
                for (let i = 0; i < 8; i++) {
                    spawnParticle(
                        hitPoint.x, hitPoint.y + 0.5, hitPoint.z,
                        (Math.random() - 0.5) * 6, Math.random() * 4 + 1, (Math.random() - 0.5) * 6,
                        1.0, 0.75, 0.1, 0.35, 1.0
                    );
                }
            }
        });
    }

    function calculatePosition() {
        let pos = 1;
        aiCars.forEach(ai => {
            if (ai.totalProgress > player.totalProgress) {
                pos++;
            }
        });
        return pos;
    }

    // --- КАМЕРА ---

    function updateCamera(dt) {
        const heading = player.heading;

        let camHeight = 9.5;
        let camDistBehind = 14.5;
        let lookAheadDist = 6.0;
        let lookHeight = 1.6;

        if (STATE.cameraMode === 1) {
            camHeight = 4.2;
            camDistBehind = 9.5;
            lookAheadDist = 8.0;
            lookHeight = 1.2;
        } else if (STATE.cameraMode === 2) {
            camHeight = 22.0;
            camDistBehind = 16.0;
            lookAheadDist = 4.0;
            lookHeight = 0.5;
        }

        const behindVec = new THREE.Vector3(
            -Math.sin(heading) * camDistBehind,
            camHeight,
            -Math.cos(heading) * camDistBehind
        );
        const targetCamPos = player.pos.clone().add(behindVec);

        const forwardVec = new THREE.Vector3(
            Math.sin(heading) * lookAheadDist,
            lookHeight,
            Math.cos(heading) * lookAheadDist
        );
        const targetLookAt = player.pos.clone().add(forwardVec);

        const smoothSpeed = Math.min(1.0, 9.0 * dt);
        cameraCurrentPos.lerp(targetCamPos, smoothSpeed);
        cameraTargetLook.lerp(targetLookAt, smoothSpeed * 1.2);

        camera.position.copy(cameraCurrentPos);
        camera.lookAt(cameraTargetLook);
    }

    // --- МИНИ-КАРТА ---
    const mapCanvas = document.getElementById('minimap-canvas');
    const mapCtx = mapCanvas.getContext('2d');

    function drawMinimap() {
        const w = mapCanvas.width;
        const h = mapCanvas.height;
        mapCtx.clearRect(0, 0, w, h);
        mapCtx.fillStyle = 'rgba(10, 16, 32, 0.88)';
        mapCtx.fillRect(0, 0, w, h);

        const pad = 12;
        const scale = Math.min((w - pad * 2) / 540, (h - pad * 2) / 380);
        const cx = w / 2;
        const cy = h / 2;
        const centerZ = STATE.currentTrackIndex === 0 ? 120 : 140;

        function toMap(x, z) {
            return {
                x: cx + x * scale,
                y: cy + (z - centerZ) * scale
            };
        }

        mapCtx.beginPath();
        for (let i = 0; i <= 60; i++) {
            const pt = currentTrackCurve.getPointAt(i / 60);
            const m = toMap(pt.x, pt.z);
            if (i === 0) mapCtx.moveTo(m.x, m.y);
            else mapCtx.lineTo(m.x, m.y);
        }
        mapCtx.closePath();
        mapCtx.strokeStyle = 'rgba(0, 240, 255, 0.45)';
        mapCtx.lineWidth = 4;
        mapCtx.stroke();

        const sp = currentTrackCurve.getPointAt(0);
        const sm = toMap(sp.x, sp.z);
        mapCtx.fillStyle = '#ffffff';
        mapCtx.fillRect(sm.x - 2, sm.y - 2, 4, 4);

        aiCars.forEach(ai => {
            const p = ai.model.group.position;
            const m = toMap(p.x, p.z);
            mapCtx.fillStyle = ai.colorHex || '#ffde59';
            mapCtx.beginPath();
            mapCtx.arc(m.x, m.y, 3.5, 0, Math.PI * 2);
            mapCtx.fill();
        });

        const pm = toMap(player.pos.x, player.pos.z);
        mapCtx.save();
        mapCtx.translate(pm.x, pm.y);
        mapCtx.rotate(-player.heading + Math.PI);
        mapCtx.fillStyle = STATE.playerColorHex || '#00f0ff';
        mapCtx.beginPath();
        mapCtx.moveTo(0, -6);
        mapCtx.lineTo(4, 5);
        mapCtx.lineTo(0, 2);
        mapCtx.lineTo(-4, 5);
        mapCtx.closePath();
        mapCtx.fill();
        mapCtx.restore();
    }

    // --- ОБНОВЛЕНИЕ HUD ---
    const uiSpeed = document.getElementById('speed-number');
    const uiNitroBar = document.getElementById('nitro-bar');
    const uiPos = document.getElementById('ui-pos');
    const uiTime = document.getElementById('ui-time');
    const uiBest = document.getElementById('ui-best');
    const centerBanner = document.getElementById('center-banner');

    function formatTime(sec) {
        if (!isFinite(sec)) return '--:--.-';
        const m = Math.floor(sec / 60);
        const s = (sec % 60).toFixed(1);
        return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
    }

    function showCenterBanner(text) {
        centerBanner.textContent = text;
        centerBanner.classList.add('show');
        setTimeout(() => {
            centerBanner.classList.remove('show');
        }, 1500);
    }

    let hudTimer = 0;
    function updateHUD(dt) {
        hudTimer += dt;
        if (hudTimer > 0.05) {
            hudTimer = 0;
            const kmh = Math.max(0, Math.round(player.speed * 4.3));
            uiSpeed.textContent = kmh;
            uiNitroBar.style.width = `${player.nitroEnergy}%`;

            const curPos = calculatePosition();
            uiPos.textContent = curPos;

            if (STATE.isPlaying && !STATE.raceFinished && !STATE.isPaused) {
                const elapsed = (performance.now() - STATE.lapStartTime) / 1000;
                uiTime.textContent = formatTime(elapsed);
                uiBest.textContent = formatTime(STATE.bestLapTime);
            }

            drawMinimap();
        }
    }

    // --- ПАУЗА В ИГРЕ ---
    const pauseScreen = document.getElementById('pause-screen');
    const btnPause = document.getElementById('btn-pause');
    const btnResume = document.getElementById('btn-resume');
    const btnRestartPause = document.getElementById('btn-restart-pause');

    function togglePause() {
        if (!STATE.isPlaying || STATE.raceFinished) return;
        STATE.isPaused = !STATE.isPaused;
        if (STATE.isPaused) {
            pauseScreen.classList.remove('hidden');
            btnPause.textContent = '▶️ Играть';
            sound.stop(); // Полностью глушим звук на паузе!
        } else {
            pauseScreen.classList.add('hidden');
            btnPause.textContent = '⏸️ Пауза';
            STATE.lapStartTime = performance.now(); // корректировка таймера
            sound.resume(); // Возобновляем звук при продолжении гонки
        }
    }

    // --- УПРАВЛЕНИЕ: ДЖОЙСТИК, КНОПКИ, КЛАВИАТУРА ---
    function setupControls() {
        const joyZone = document.getElementById('joystick-zone');
        const joyBase = document.getElementById('joystick-base');
        const joyKnob = document.getElementById('joystick-knob');
        const maxRadius = 48;

        function handleJoystickMove(clientX, clientY) {
            const rect = joyBase.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;

            const dx = clientX - centerX;
            const dy = clientY - centerY;
            const dist = Math.hypot(dx, dy);

            let clampedX = dx;
            let clampedY = dy;
            if (dist > maxRadius) {
                const angle = Math.atan2(dy, dx);
                clampedX = Math.cos(angle) * maxRadius;
                clampedY = Math.sin(angle) * maxRadius;
            }

            joyKnob.style.transform = `translate(${clampedX}px, ${clampedY}px)`;
            JOYSTICK.steer = clampedX / maxRadius;
            JOYSTICK.throttle = -clampedY / maxRadius;
        }

        function resetJoystick() {
            JOYSTICK.active = false;
            JOYSTICK.pointerId = null;
            JOYSTICK.steer = 0;
            JOYSTICK.throttle = 0;
            joyKnob.style.transform = 'translate(0px, 0px)';
        }

        joyZone.addEventListener('pointerdown', (e) => {
            if (STATE.isPaused) return;
            e.preventDefault();
            sound.init();
            tryLockLandscape();
            JOYSTICK.active = true;
            JOYSTICK.pointerId = e.pointerId;
            joyZone.setPointerCapture(e.pointerId);
            handleJoystickMove(e.clientX, e.clientY);
            triggerHaptic(20);
        });

        joyZone.addEventListener('pointermove', (e) => {
            if (JOYSTICK.active && e.pointerId === JOYSTICK.pointerId) {
                e.preventDefault();
                handleJoystickMove(e.clientX, e.clientY);
            }
        });

        joyZone.addEventListener('pointerup', (e) => {
            if (e.pointerId === JOYSTICK.pointerId) {
                e.preventDefault();
                resetJoystick();
            }
        });

        joyZone.addEventListener('pointercancel', (e) => {
            resetJoystick();
        });

        // Правые кнопки
        const btnNitro = document.getElementById('btn-nitro');
        const btnBrake = document.getElementById('btn-brake');

        function bindActionBtn(el, inputProp) {
            const press = (e) => {
                if (STATE.isPaused) return;
                e.preventDefault();
                sound.init();
                tryLockLandscape();
                INPUT[inputProp] = true;
                el.classList.add('active');
                triggerHaptic(25);
            };
            const release = (e) => {
                e.preventDefault();
                INPUT[inputProp] = false;
                el.classList.remove('active');
            };

            el.addEventListener('pointerdown', press);
            el.addEventListener('pointerup', release);
            el.addEventListener('pointercancel', release);
            el.addEventListener('pointerleave', release);
        }

        bindActionBtn(btnNitro, 'nitro');
        bindActionBtn(btnBrake, 'brake');

        // Клавиатура на ПК
        window.addEventListener('keydown', (e) => {
            if (e.code === 'KeyP' || e.code === 'Escape') {
                togglePause();
                return;
            }
            if (STATE.isPaused) return;

            switch (e.code) {
                case 'KeyW':
                case 'ArrowUp':
                    INPUT.forward = true;
                    break;
                case 'KeyS':
                case 'ArrowDown':
                    INPUT.backward = true;
                    break;
                case 'KeyA':
                case 'ArrowLeft':
                    INPUT.left = true;
                    break;
                case 'KeyD':
                case 'ArrowRight':
                    INPUT.right = true;
                    break;
                case 'Space':
                    INPUT.brake = true;
                    break;
                case 'ShiftLeft':
                case 'ShiftRight':
                    INPUT.nitro = true;
                    break;
                case 'KeyC':
                    cycleCamera();
                    break;
                case 'KeyR':
                    restartGame();
                    break;
            }
        });

        window.addEventListener('keyup', (e) => {
            switch (e.code) {
                case 'KeyW':
                case 'ArrowUp':
                    INPUT.forward = false;
                    break;
                case 'KeyS':
                case 'ArrowDown':
                    INPUT.backward = false;
                    break;
                case 'KeyA':
                case 'ArrowLeft':
                    INPUT.left = false;
                    break;
                case 'KeyD':
                case 'ArrowRight':
                    INPUT.right = false;
                    break;
                case 'Space':
                    INPUT.brake = false;
                    break;
                case 'ShiftLeft':
                case 'ShiftRight':
                    INPUT.nitro = false;
                    break;
            }
        });

        // Блокировка контекстного меню правой кнопки мыши (ПКМ) для игры как в WoW
        window.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            return false;
        });

        // Управление мышью в стиле World of Warcraft:
        // ЛКМ + ПКМ одновременно = газ вперед
        // Зажатая ПКМ + движение мыши вправо/влево = поворот руля
        window.addEventListener('mousedown', (e) => {
            if (e.target.closest('#hud-top, #quick-actions, #pause-screen, #overlay-screen, #joystick-zone, #action-buttons-zone, .touch-btn')) {
                return;
            }
            sound.init();
            if (e.button === 0) {
                MOUSE_CONTROL.leftDown = true;
            } else if (e.button === 2) {
                MOUSE_CONTROL.rightDown = true;
            }
        });

        window.addEventListener('mouseup', (e) => {
            if (e.button === 0) {
                MOUSE_CONTROL.leftDown = false;
            } else if (e.button === 2) {
                MOUSE_CONTROL.rightDown = false;
                MOUSE_CONTROL.steerDelta = 0;
            }
        });

        window.addEventListener('mousemove', (e) => {
            if (MOUSE_CONTROL.rightDown && !STATE.isPaused && STATE.isPlaying) {
                const moveX = e.movementX || 0;
                const sens = 0.035;
                MOUSE_CONTROL.steerDelta = THREE.MathUtils.clamp(MOUSE_CONTROL.steerDelta - moveX * sens, -1.0, 1.0);
            }
        });

        window.addEventListener('blur', () => {
            MOUSE_CONTROL.leftDown = false;
            MOUSE_CONTROL.rightDown = false;
            MOUSE_CONTROL.steerDelta = 0;
        });

        // Кнопки паузы
        btnPause.addEventListener('click', () => {
            togglePause();
        });

        btnResume.addEventListener('click', () => {
            togglePause();
        });

        btnRestartPause.addEventListener('click', () => {
            togglePause();
            restartGame();
        });

        // Кнопки трасс
        const btnTrack1 = document.getElementById('btn-track-1');
        const btnTrack2 = document.getElementById('btn-track-2');

        btnTrack1.addEventListener('click', () => {
            STATE.currentTrackIndex = 0;
            btnTrack1.classList.add('active');
            btnTrack2.classList.remove('active');
            buildTrack(0);
            resetPositions();
            triggerHaptic(30);
        });

        btnTrack2.addEventListener('click', () => {
            STATE.currentTrackIndex = 1;
            btnTrack2.classList.add('active');
            btnTrack1.classList.remove('active');
            buildTrack(1);
            resetPositions();
            triggerHaptic(30);
        });

        // Кнопки выбора цвета машинки игрока
        const colorBtns = document.querySelectorAll('.color-btn');
        colorBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                colorBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                const hue = parseFloat(btn.dataset.hue || 0);
                const hex = btn.dataset.hex || '#00d2ff';
                setPlayerColor(hue, hex);
                triggerHaptic(25);
            });
        });

        // Кнопка камеры
        document.getElementById('btn-cam').addEventListener('click', () => {
            cycleCamera();
        });

        // Кнопка звука
        const btnSound = document.getElementById('btn-sound');
        btnSound.addEventListener('click', () => {
            sound.init();
            const on = sound.toggle();
            btnSound.textContent = on ? '🔊 Звук' : '🔇 Звук';
        });

        // Открытие меню выбора трасс (из верхней панели и из экрана паузы)
        function openTrackSelectMenu() {
            if (STATE.isPaused) {
                pauseScreen.classList.add('hidden');
                STATE.isPaused = false;
                btnPause.textContent = '⏸️ Пауза';
            }
            STATE.isPlaying = false;
            sound.stop();

            // Сбрасываем машины на стартовую решётку сразу при открытии меню
            buildTrack(STATE.currentTrackIndex);
            resetPositions();

            // Синхронизируем кнопки трасс
            const bT1 = document.getElementById('btn-track-1');
            const bT2 = document.getElementById('btn-track-2');
            if (bT1 && bT2) {
                if (STATE.currentTrackIndex === 0) {
                    bT1.classList.add('active');
                    bT2.classList.remove('active');
                } else {
                    bT2.classList.add('active');
                    bT1.classList.remove('active');
                }
            }

            const overlay = document.getElementById('overlay-screen');
            overlay.classList.remove('hidden');
            document.getElementById('btn-start').textContent = 'ПОГНАЛИ!';
            triggerHaptic(30);
        }

        const btnTrackMenu = document.getElementById('btn-track-menu');
        if (btnTrackMenu) {
            btnTrackMenu.addEventListener('click', openTrackSelectMenu);
        }

        const btnTrackMenuPause = document.getElementById('btn-track-menu-pause');
        if (btnTrackMenuPause) {
            btnTrackMenuPause.addEventListener('click', openTrackSelectMenu);
        }

        // Кнопка полноэкранного режима
        document.getElementById('btn-fullscreen').addEventListener('click', () => {
            tryLockLandscape();
            const doc = document;
            const docEl = doc.documentElement;
            const isFull = doc.fullscreenElement || doc.webkitFullscreenElement;

            if (!isFull) {
                const req = docEl.requestFullscreen || docEl.webkitRequestFullscreen || docEl.msRequestFullscreen;
                if (req) {
                    req.call(docEl, { navigationUI: 'hide' }).catch(() => {
                        req.call(docEl).catch(() => {});
                    });
                }
            } else {
                const exit = doc.exitFullscreen || doc.webkitExitFullscreen || doc.msExitFullscreen;
                if (exit) exit.call(doc).catch(() => {});
            }
            setTimeout(onWindowResize, 80);
            setTimeout(onWindowResize, 250);
            setTimeout(onWindowResize, 500);
        });

        // Кнопка старта
        document.getElementById('btn-start').addEventListener('click', () => {
            tryLockLandscape();
            resetPositions();
            startGame();
        });
    }

    function cycleCamera() {
        STATE.cameraMode = (STATE.cameraMode + 1) % 3;
        const modes = ['Над машиной', 'Вид сзади', 'Вид сверху'];
        showCenterBanner(`Камера: ${modes[STATE.cameraMode]}`);
        triggerHaptic(30);
    }

    function startGame() {
        sound.init();
        resetPositions();
        document.getElementById('overlay-screen').classList.add('hidden');
        STATE.isPlaying = true;
        STATE.isPaused = false;
        STATE.raceFinished = false;
        STATE.currentLap = 1;
        STATE.lapStartTime = performance.now();
        document.getElementById('ui-lap').textContent = `1/${CONFIG.totalLaps}`;
        showCenterBanner('СТАРТ! ⚡');
        triggerHaptic(50);
    }

    function restartGame() {
        resetPositions();
        startGame();
    }

    function onWindowResize() {
        const w = window.innerWidth;
        const h = window.innerHeight;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
    }

    window.addEventListener('resize', onWindowResize);
    window.addEventListener('orientationchange', () => {
        onWindowResize();
        setTimeout(onWindowResize, 100);
        setTimeout(onWindowResize, 300);
    });
    document.addEventListener('fullscreenchange', () => {
        onWindowResize();
        setTimeout(onWindowResize, 100);
        setTimeout(onWindowResize, 300);
    });
    document.addEventListener('webkitfullscreenchange', () => {
        onWindowResize();
        setTimeout(onWindowResize, 100);
        setTimeout(onWindowResize, 300);
    });

    cameraCurrentPos.copy(player.pos).add(new THREE.Vector3(0, 10, -15));
    cameraTargetLook.copy(player.pos);

    setupControls();

    // --- ГЛАВНЫЙ ЦИКЛ ---
    let lastTime = performance.now();

    function animate(time) {
        requestAnimationFrame(animate);

        const dt = Math.min((time - lastTime) / 1000, 0.1);
        lastTime = time;

        if (STATE.isPlaying && !STATE.isPaused) {
            updatePlayerPhysics(dt);
            updateAICars(dt);
        }

        updateParticles(dt);
        updateCamera(dt);
        updateHUD(dt);

        renderer.render(scene, camera);
    }

    requestAnimationFrame(animate);

})();
