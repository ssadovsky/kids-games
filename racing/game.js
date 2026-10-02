/**
 * 3D Гонки от третьего лица (ракурс над машиной)
 * Оптимизировано для Samsung Galaxy S10 и мобильных браузеров / APK
 */

(function () {
    'use strict';

    // --- НАСТРОЙКИ И СОСТОЯНИЕ ---
    const CONFIG = {
        maxSpeed: 42.0,            // ~180 км/ч
        nitroMaxSpeed: 58.0,       // ~250 км/ч
        accel: 22.0,
        brakePower: 35.0,
        friction: 6.0,
        steerSpeed: 3.2,
        maxSteerAngle: 0.58,
        driftFriction: 2.2,
        offroadFriction: 14.0,
        roadWidth: 16.0,
        totalLaps: 3
    };

    const STATE = {
        isPlaying: false,
        isPaused: false,
        soundEnabled: true,
        currentLap: 1,
        lapStartTime: 0,
        bestLapTime: Infinity,
        raceFinished: false,
        cameraMode: 0 // 0: над машиной (elevated chase), 1: классический вид сзади, 2: вид сверху (top-down)
    };

    // Ввод пользователя
    const INPUT = {
        forward: false,
        backward: false,
        left: false,
        right: false,
        nitro: false
    };

    // --- ЗВУКОВОЙ ДВИЖОК (Web Audio API, без внешних файлов) ---
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
        }

        init() {
            if (this.initialized) return;
            try {
                const AudioCtx = window.AudioContext || window.webkitAudioContext;
                this.ctx = new AudioCtx();

                // Мотор (пилообразный осциллятор + фильтр низких частот)
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

                // Генератор белого шума для визга шин (Дрифт)
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
            } catch (e) {
                console.warn('Web Audio не поддерживается или заблокирован:', e);
            }
        }

        update(speedRatio, isAccelerating, isDrifting, isNitro) {
            if (!this.initialized || !STATE.soundEnabled) return;
            if (this.ctx.state === 'suspended') {
                this.ctx.resume();
            }

            const now = this.ctx.currentTime;
            // Звук двигателя
            const baseFreq = 42 + speedRatio * 180 + (isAccelerating ? 25 : 0);
            this.engineOsc.frequency.setTargetAtTime(baseFreq, now, 0.06);
            const targetGain = 0.03 + (isAccelerating ? 0.04 : 0.015);
            this.engineGain.gain.setTargetAtTime(targetGain, now, 0.08);

            // Звук заноса
            const skidVol = isDrifting ? Math.min(0.08, speedRatio * 0.1) : 0;
            this.skidGain.gain.setTargetAtTime(skidVol, now, 0.04);

            // Звук нитро
            const nitroVol = isNitro ? 0.09 : 0;
            this.nitroGain.gain.setTargetAtTime(nitroVol, now, 0.08);
            if (isNitro) {
                this.nitroOsc.frequency.setTargetAtTime(620 + speedRatio * 200, now, 0.05);
            }
        }

        playCrash() {
            if (!this.initialized || !STATE.soundEnabled) return;
            try {
                const now = this.ctx.currentTime;
                const osc = this.ctx.createOscillator();
                const gain = this.ctx.createGain();
                osc.type = 'triangle';
                osc.frequency.setValueAtTime(120, now);
                osc.frequency.exponentialRampToValueAtTime(30, now + 0.25);
                gain.gain.setValueAtTime(0.2, now);
                gain.gain.exponentialRampToValueAtTime(0.01, now + 0.25);
                osc.connect(gain);
                gain.connect(this.ctx.destination);
                osc.start(now);
                osc.stop(now + 0.25);
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

    // Тактильный отклик (вибрация для Samsung Galaxy S10)
    function triggerHaptic(duration = 40) {
        if ('vibrate' in navigator) {
            try {
                navigator.vibrate(duration);
            } catch (e) {}
        }
    }

    // --- СЦЕНА THREE.JS ---
    const container = document.getElementById('canvas-container');
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0e172a);
    scene.fog = new THREE.FogExp2(0x0e172a, 0.0035);

    const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.5, 600);

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // 60 FPS для Galaxy S10
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);

    // Освещение сцены
    const ambientLight = new THREE.AmbientLight(0xddeeff, 0.7);
    scene.add(ambientLight);

    const sunLight = new THREE.DirectionalLight(0xfff7e6, 1.2);
    sunLight.position.set(120, 160, 90);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.width = 1024;
    sunLight.shadow.mapSize.height = 1024;
    sunLight.shadow.camera.near = 10;
    sunLight.shadow.camera.far = 400;
    const shadowDist = 90;
    sunLight.shadow.camera.left = -shadowDist;
    sunLight.shadow.camera.right = shadowDist;
    sunLight.shadow.camera.top = shadowDist;
    sunLight.shadow.camera.bottom = -shadowDist;
    scene.add(sunLight);

    const hemiLight = new THREE.HemisphereLight(0x38bdf8, 0x1e293b, 0.5);
    scene.add(hemiLight);

    // --- ГЕНЕРАЦИЯ ТРАССЫ ---
    const trackControlPoints = [
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

    const trackCurve = new THREE.CatmullRomCurve3(trackControlPoints, true, 'catmullrom', 0.15);
    const trackLength = trackCurve.getLength();

    // Создание меша трассы с бордюрами и разметкой
    function createTrackMesh() {
        const segments = 400;
        const width = CONFIG.roadWidth;
        const roadGeom = new THREE.BufferGeometry();
        const positions = [];
        const uvs = [];
        const indices = [];

        const curbGeom = new THREE.BufferGeometry();
        const curbPositions = [];
        const curbColors = [];

        for (let i = 0; i <= segments; i++) {
            const t = i / segments;
            const pt = trackCurve.getPointAt(t);
            const tangent = trackCurve.getTangentAt(t).normalize();
            const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();

            // Точки дороги
            const left = pt.clone().add(normal.clone().multiplyScalar(-width / 2));
            const right = pt.clone().add(normal.clone().multiplyScalar(width / 2));

            positions.push(left.x, 0.05, left.z);
            positions.push(right.x, 0.05, right.z);

            uvs.push(0, t * 80);
            uvs.push(1, t * 80);

            // Бордюры (поребрики)
            const curbWidth = 1.4;
            const curbLeftOuter = left.clone().add(normal.clone().multiplyScalar(-curbWidth));
            const curbRightOuter = right.clone().add(normal.clone().multiplyScalar(curbWidth));

            const isRed = Math.floor(t * 160) % 2 === 0;
            const r = isRed ? 0.95 : 0.95;
            const g = isRed ? 0.15 : 0.95;
            const b = isRed ? 0.15 : 0.95;

            curbPositions.push(curbLeftOuter.x, 0.15, curbLeftOuter.z);
            curbPositions.push(left.x, 0.1, left.z);
            curbColors.push(r, g, b, r, g, b);

            curbPositions.push(right.x, 0.1, right.z);
            curbPositions.push(curbRightOuter.x, 0.15, curbRightOuter.z);
            curbColors.push(r, g, b, r, g, b);

            if (i < segments) {
                const base = i * 2;
                indices.push(base, base + 1, base + 2);
                indices.push(base + 1, base + 3, base + 2);
            }
        }

        roadGeom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        roadGeom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        roadGeom.setIndex(indices);
        roadGeom.computeVertexNormals();

        // Процедурная текстура асфальта
        const roadCanvas = document.createElement('canvas');
        roadCanvas.width = 256;
        roadCanvas.height = 512;
        const ctx = roadCanvas.getContext('2d');
        ctx.fillStyle = '#22262d';
        ctx.fillRect(0, 0, 256, 512);

        // Центральная прерывистая линия
        ctx.strokeStyle = '#f8fafc';
        ctx.lineWidth = 6;
        ctx.setLineDash([32, 28]);
        ctx.beginPath();
        ctx.moveTo(128, 0);
        ctx.lineTo(128, 512);
        ctx.stroke();

        // Боковые сплошные полосы
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
        roadTex.repeat.set(1, 40);

        const roadMat = new THREE.MeshStandardMaterial({
            map: roadTex,
            roughness: 0.85,
            metalness: 0.1
        });
        const roadMesh = new THREE.Mesh(roadGeom, roadMat);
        roadMesh.receiveShadow = true;
        scene.add(roadMesh);

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

        const curbMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 });
        const curbMesh = new THREE.Mesh(curbGeom, curbMat);
        curbMesh.receiveShadow = true;
        scene.add(curbMesh);

        // Земля вокруг трассы
        const groundGeom = new THREE.PlaneGeometry(1200, 1200, 16, 16);
        groundGeom.rotateX(-Math.PI / 2);
        const groundMat = new THREE.MeshStandardMaterial({ color: 0x172520, roughness: 0.95 });
        const ground = new THREE.Mesh(groundGeom, groundMat);
        ground.position.y = -0.05;
        ground.receiveShadow = true;
        scene.add(ground);

        createStartFinishArch();
        createDecorations();
    }

    // Стартовая арка и финишная линия
    function createStartFinishArch() {
        const p0 = trackCurve.getPointAt(0);
        const tangent = trackCurve.getTangentAt(0).normalize();
        const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
        const w = CONFIG.roadWidth + 4;

        const archGroup = new THREE.Group();

        const pillarMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, metalness: 0.8, roughness: 0.2 });
        const postGeom = new THREE.CylinderGeometry(0.35, 0.45, 9, 12);

        const leftPost = new THREE.Mesh(postGeom, pillarMat);
        leftPost.position.copy(p0).add(normal.clone().multiplyScalar(-w / 2)).setY(4.5);
        leftPost.castShadow = true;
        archGroup.add(leftPost);

        const rightPost = new THREE.Mesh(postGeom, pillarMat);
        rightPost.position.copy(p0).add(normal.clone().multiplyScalar(w / 2)).setY(4.5);
        rightPost.castShadow = true;
        archGroup.add(rightPost);

        const crossGeom = new THREE.BoxGeometry(w + 1, 1.8, 1.2);
        const crossMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.3 });
        const cross = new THREE.Mesh(crossGeom, crossMat);
        cross.position.copy(p0).setY(8.5);
        cross.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), normal);
        cross.castShadow = true;
        archGroup.add(cross);

        // Неоновый баннер
        const signCanvas = document.createElement('canvas');
        signCanvas.width = 512;
        signCanvas.height = 128;
        const sctx = signCanvas.getContext('2d');
        sctx.fillStyle = '#050b14';
        sctx.fillRect(0, 0, 512, 128);
        sctx.fillStyle = '#00f0ff';
        sctx.font = 'bold 50px Arial Black, sans-serif';
        sctx.textAlign = 'center';
        sctx.textBaseline = 'middle';
        sctx.shadowColor = '#00f0ff';
        sctx.shadowBlur = 15;
        sctx.fillText('⚡ START / FINISH ⚡', 256, 64);

        const signTex = new THREE.CanvasTexture(signCanvas);
        const signMat = new THREE.MeshBasicMaterial({ map: signTex });
        const signGeom = new THREE.PlaneGeometry(w - 2, 1.5);
        const signMesh = new THREE.Mesh(signGeom, signMat);
        signMesh.position.copy(cross.position);
        signMesh.position.add(tangent.clone().multiplyScalar(0.65));
        signMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), tangent);
        archGroup.add(signMesh);

        // Черно-белая клетчатая разметка
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

        scene.add(archGroup);
    }

    // Декорации трассы
    function createDecorations() {
        const count = 36;
        const lampMat = new THREE.MeshStandardMaterial({ color: 0x334155, metalness: 0.8 });
        const bulbMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8 });
        const trunkMat = new THREE.MeshStandardMaterial({ color: 0x3e2723 });
        const foliageMat = new THREE.MeshStandardMaterial({ color: 0x1b4332, roughness: 0.9 });

        for (let i = 0; i < count; i++) {
            const t = i / count;
            const pt = trackCurve.getPointAt(t);
            const tangent = trackCurve.getTangentAt(t).normalize();
            const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
            const side = (i % 2 === 0 ? 1 : -1);
            const dist = CONFIG.roadWidth / 2 + 3.2;

            const pos = pt.clone().add(normal.clone().multiplyScalar(side * dist));

            if (i % 3 === 0) {
                // Фонарь
                const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 8, 8), lampMat);
                pole.position.copy(pos).setY(4);
                pole.castShadow = true;
                scene.add(pole);

                const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.4, 8, 8), bulbMat);
                bulb.position.copy(pos).setY(8);
                scene.add(bulb);
            } else {
                // Дерево
                const tree = new THREE.Group();
                const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.5, 5, 8), trunkMat);
                trunk.position.y = 2.5;
                trunk.castShadow = true;
                tree.add(trunk);

                const foliage = new THREE.Mesh(new THREE.ConeGeometry(2.4, 6, 8), foliageMat);
                foliage.position.y = 6.5;
                foliage.castShadow = true;
                tree.add(foliage);

                tree.position.copy(pos).add(normal.clone().multiplyScalar(side * (Math.random() * 4 + 2)));
                scene.add(tree);
            }
        }
    }

    createTrackMesh();

    // --- МОДЕЛЬ МАШИНЫ ---
    function buildCarModel(colorHex = 0x00f0ff, isPlayer = false) {
        const car = new THREE.Group();

        const bodyMat = new THREE.MeshStandardMaterial({
            color: colorHex,
            metalness: 0.75,
            roughness: 0.22
        });
        const darkMat = new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.4 });
        const glassMat = new THREE.MeshStandardMaterial({
            color: 0x1e293b,
            metalness: 0.9,
            roughness: 0.1,
            transparent: true,
            opacity: 0.8
        });
        const wheelMat = new THREE.MeshStandardMaterial({ color: 0x1f2937, roughness: 0.9 });
        const rimMat = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, metalness: 0.9, roughness: 0.1 });

        // Корпус
        const baseGeom = new THREE.BoxGeometry(2.1, 0.55, 4.4);
        const baseMesh = new THREE.Mesh(baseGeom, bodyMat);
        baseMesh.position.y = 0.5;
        baseMesh.castShadow = true;
        car.add(baseMesh);

        // Кабина
        const cabinGeom = new THREE.BoxGeometry(1.6, 0.55, 2.1);
        const cabinMesh = new THREE.Mesh(cabinGeom, glassMat);
        cabinMesh.position.set(0, 0.95, -0.2);
        cabinMesh.castShadow = true;
        car.add(cabinMesh);

        // Крыша
        const roofGeom = new THREE.BoxGeometry(1.5, 0.08, 1.8);
        const roofMesh = new THREE.Mesh(roofGeom, bodyMat);
        roofMesh.position.set(0, 1.25, -0.2);
        car.add(roofMesh);

        // Нос / Сплиттер
        const noseGeom = new THREE.BoxGeometry(1.95, 0.3, 0.8);
        const noseMesh = new THREE.Mesh(noseGeom, bodyMat);
        noseMesh.position.set(0, 0.38, 2.3);
        noseMesh.castShadow = true;
        car.add(noseMesh);

        // Спойлер
        const spoilerWing = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.08, 0.5), darkMat);
        spoilerWing.position.set(0, 1.2, -2.1);
        spoilerWing.castShadow = true;
        car.add(spoilerWing);

        const leftStrut = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.45, 0.15), darkMat);
        leftStrut.position.set(-0.7, 0.95, -2.1);
        car.add(leftStrut);
        const rightStrut = leftStrut.clone();
        rightStrut.position.x = 0.7;
        car.add(rightStrut);

        // Фары
        const headlightMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
        const leftLight = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.14, 0.1), headlightMat);
        leftLight.position.set(-0.72, 0.52, 2.65);
        car.add(leftLight);
        const rightLight = leftLight.clone();
        rightLight.position.x = 0.72;
        car.add(rightLight);

        // Задние стоп-сигналы
        const brakeLightMat = new THREE.MeshBasicMaterial({ color: 0x770011 });
        const rearLight = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.12, 0.1), brakeLightMat);
        rearLight.position.set(0, 0.62, -2.22);
        car.add(rearLight);

        // Колеса
        const wheelGeom = new THREE.CylinderGeometry(0.42, 0.42, 0.35, 16);
        wheelGeom.rotateZ(Math.PI / 2);
        const rimGeom = new THREE.CylinderGeometry(0.24, 0.24, 0.36, 8);
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
        frontLeftWheelGroup.position.set(-1.08, 0.42, 1.4);
        car.add(frontLeftWheelGroup);

        const frontRightWheelGroup = new THREE.Group();
        const frontRightWheel = createWheel();
        frontRightWheelGroup.add(frontRightWheel);
        frontRightWheelGroup.position.set(1.08, 0.42, 1.4);
        car.add(frontRightWheelGroup);

        const rearLeftWheel = createWheel();
        rearLeftWheel.position.set(-1.08, 0.42, -1.35);
        car.add(rearLeftWheel);

        const rearRightWheel = createWheel();
        rearRightWheel.position.set(1.08, 0.42, -1.35);
        car.add(rearRightWheel);

        // Выхлопные трубы для нитро
        const exhaustMat = new THREE.MeshBasicMaterial({ color: 0x00f0ff });
        const leftExhaust = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.3, 8), exhaustMat);
        leftExhaust.rotateX(Math.PI / 2);
        leftExhaust.position.set(-0.45, 0.35, -2.25);
        leftExhaust.visible = false;
        car.add(leftExhaust);

        const rightExhaust = leftExhaust.clone();
        rightExhaust.position.x = 0.45;
        rightExhaust.visible = false;
        car.add(rightExhaust);

        scene.add(car);

        return {
            group: car,
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

    // Игрок
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

    // Стартовая позиция
    const pStart = trackCurve.getPointAt(0.01);
    const pStartAhead = trackCurve.getPointAt(0.02);
    player.pos.copy(pStart);
    player.heading = Math.atan2(pStartAhead.x - pStart.x, pStartAhead.z - pStart.z);
    player.model.group.position.copy(player.pos);
    player.model.group.rotation.y = player.heading;

    // --- БОТЫ (AI СОПЕРНИКИ) ---
    const AI_COLORS = [0xff2a55, 0xffbb00, 0x10b981];
    const aiCars = [];

    AI_COLORS.forEach((col, idx) => {
        const model = buildCarModel(col, false);
        const startT = (0.01 - (idx + 1) * 0.025 + 1.0) % 1.0;
        const sideOffset = (idx % 2 === 0 ? 3.5 : -3.5);

        aiCars.push({
            model: model,
            t: startT,
            speed: 34 + Math.random() * 5,
            sideOffset: sideOffset,
            targetSideOffset: sideOffset,
            currentLap: 1,
            totalProgress: startT,
            name: `Гонщик #${idx + 2}`
        });
    });

    // --- СИСТЕМА ЧАСТИЦ ---
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

    // --- ФИЗИКА И УПРАВЛЕНИЕ ИГРОКОМ ---
    function updatePlayerPhysics(dt) {
        const isAccelerating = INPUT.forward;
        player.isBraking = INPUT.backward;

        // Нитро ускорение
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

        // Проверка на съезд с дороги
        const closestSplineT = getClosestTrackT(player.pos);
        const roadCenter = trackCurve.getPointAt(closestSplineT);
        const distFromCenter = player.pos.distanceTo(roadCenter);
        const isOffroad = distFromCenter > CONFIG.roadWidth / 2;

        let effectiveFriction = CONFIG.friction;
        if (isOffroad) {
            effectiveFriction = CONFIG.offroadFriction;
            maxSpd *= 0.55;
        }

        // Разгон / Замедление
        if (isAccelerating) {
            const accelMult = (player.speed < maxSpd * 0.5) ? 1.2 : 0.9;
            player.speed += CONFIG.accel * accelMult * dt;
        } else if (player.isBraking) {
            if (player.speed > 1.0) {
                player.speed -= CONFIG.brakePower * dt;
            } else {
                player.speed = Math.max(-14.0, player.speed - CONFIG.accel * 0.7 * dt);
            }
        } else {
            if (player.speed > 0) {
                player.speed = Math.max(0, player.speed - effectiveFriction * dt);
            } else if (player.speed < 0) {
                player.speed = Math.min(0, player.speed + effectiveFriction * dt);
            }
        }

        player.speed = Math.min(maxSpd, player.speed);

        // Рулевое управление: ВЛЕВО = отрицательный угол (поворот к -X), ВПРАВО = положительный угол (к +X)
        const speedRatio = Math.min(1.0, Math.abs(player.speed) / (CONFIG.maxSpeed * 0.6));
        let targetSteer = 0;
        if (INPUT.left) targetSteer -= CONFIG.maxSteerAngle;
        if (INPUT.right) targetSteer += CONFIG.maxSteerAngle;

        player.steerAngle += (targetSteer - player.steerAngle) * Math.min(1.0, 12 * dt);

        // Поворот передних колес визуально
        player.model.frontLeftWheelGroup.rotation.y = player.steerAngle;
        player.model.frontRightWheelGroup.rotation.y = player.steerAngle;

        // Вращение колес по оси качения
        const wheelRoll = (player.speed * dt) / 0.42;
        player.model.frontLeftWheel.rotation.x += wheelRoll;
        player.model.frontRightWheel.rotation.x += wheelRoll;
        player.model.rearLeftWheel.rotation.x += wheelRoll;
        player.model.rearRightWheel.rotation.x += wheelRoll;

        // Дрифт / Занос
        const turnIntensity = Math.abs(player.steerAngle) * Math.abs(player.speed);
        player.isDrifting = (turnIntensity > 15.0 && (player.isBraking || Math.abs(player.steerAngle) > 0.35));

        if (player.isDrifting && Math.abs(player.speed) > 10) {
            player.driftFactor += (1.0 - player.driftFactor) * 8 * dt;
            player.nitroEnergy = Math.min(100, player.nitroEnergy + dt * 15);

            const leftTire = player.pos.clone().add(new THREE.Vector3(-1.0, 0.1, -1.3).applyAxisAngle(new THREE.Vector3(0, 1, 0), player.heading));
            const rightTire = player.pos.clone().add(new THREE.Vector3(1.0, 0.1, -1.3).applyAxisAngle(new THREE.Vector3(0, 1, 0), player.heading));
            spawnParticle(leftTire.x, leftTire.y, leftTire.z, (Math.random() - 0.5) * 1.5, Math.random() * 0.8 + 0.3, (Math.random() - 0.5) * 1.5, 0.85, 0.88, 0.95, 0.4, 1.4);
            spawnParticle(rightTire.x, rightTire.y, rightTire.z, (Math.random() - 0.5) * 1.5, Math.random() * 0.8 + 0.3, (Math.random() - 0.5) * 1.5, 0.85, 0.88, 0.95, 0.4, 1.4);
        } else {
            player.driftFactor += (0.0 - player.driftFactor) * 6 * dt;
        }

        // Изменение угла курса (heading)
        if (Math.abs(player.speed) > 0.1) {
            const steerFactor = player.isDrifting ? 1.4 : 1.0;
            player.heading += player.steerAngle * speedRatio * (player.speed >= 0 ? 1 : -1) * CONFIG.steerSpeed * steerFactor * dt;
        }

        // Вектор перемещения
        const moveDir = new THREE.Vector3(
            Math.sin(player.heading + (player.steerAngle * player.driftFactor * 0.3)),
            0,
            Math.cos(player.heading + (player.steerAngle * player.driftFactor * 0.3))
        );

        player.pos.add(moveDir.multiplyScalar(player.speed * dt));

        // Реалистичный крен подвески в сторону, противоположную повороту
        const rollAngle = player.steerAngle * speedRatio * 0.16;
        player.model.group.rotation.z = rollAngle;
        player.model.group.position.copy(player.pos);
        player.model.group.rotation.y = player.heading;

        // Звуки
        sound.update(
            Math.abs(player.speed) / CONFIG.maxSpeed,
            isAccelerating,
            player.isDrifting,
            isUsingNitro
        );

        updateLapProgress(closestSplineT);
        checkCollisionsWithAI();
    }

    // Поиск ближайшей точки трассы
    let lastKnownT = 0.01;
    function getClosestTrackT(pos) {
        let bestT = lastKnownT;
        let minDistSq = Infinity;
        const searchRange = 0.08;

        for (let i = -15; i <= 15; i++) {
            const testT = (lastKnownT + (i / 15) * searchRange + 1.0) % 1.0;
            const pt = trackCurve.getPointAt(testT);
            const distSq = pos.distanceToSquared(pt);
            if (distSq < minDistSq) {
                minDistSq = distSq;
                bestT = testT;
            }
        }
        lastKnownT = bestT;
        return bestT;
    }

    // Прогресс кругов
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

    // --- БОТЫ (AI) ---
    function updateAICars(dt) {
        aiCars.forEach(ai => {
            const deltaT = (ai.speed / trackLength) * dt;
            const prevT = ai.t;
            ai.t = (ai.t + deltaT) % 1.0;

            if (prevT > 0.85 && ai.t < 0.15) {
                ai.currentLap++;
            }
            ai.totalProgress = (ai.currentLap - 1) + ai.t;

            const centerPt = trackCurve.getPointAt(ai.t);
            const tangent = trackCurve.getTangentAt(ai.t).normalize();
            const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();

            ai.sideOffset += (ai.targetSideOffset - ai.sideOffset) * dt;
            const targetPos = centerPt.clone().add(normal.clone().multiplyScalar(ai.sideOffset));

            ai.model.group.position.copy(targetPos);
            ai.model.group.rotation.y = Math.atan2(tangent.x, tangent.z);

            const roll = (ai.speed * dt) / 0.42;
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
                player.speed *= 0.72;
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

    // --- КАМЕРА: РАКУРС НАД МАШИНОЙ (ELEVATED 3RD PERSON) ---
    const cameraCurrentPos = new THREE.Vector3();
    const cameraTargetLook = new THREE.Vector3();

    function updateCamera(dt) {
        const heading = player.heading;

        // По умолчанию режим 0: "Над машиной" (высокий угол обзора, превосходная видимость поворотов)
        let camHeight = 9.5;
        let camDistBehind = 14.5;
        let lookAheadDist = 6.0;
        let lookHeight = 1.6;

        if (STATE.cameraMode === 1) {
            // Классический вид сзади
            camHeight = 4.2;
            camDistBehind = 9.5;
            lookAheadDist = 8.0;
            lookHeight = 1.2;
        } else if (STATE.cameraMode === 2) {
            // Вид сверху / полуизометрия
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

        // Плавная интерполяция
        const smoothSpeed = Math.min(1.0, 9.0 * dt);
        cameraCurrentPos.lerp(targetCamPos, smoothSpeed);
        cameraTargetLook.lerp(targetLookAt, smoothSpeed * 1.2);

        camera.position.copy(cameraCurrentPos);
        camera.lookAt(cameraTargetLook);
    }

    // --- МИНИ-КАРТА (2D Canvas) ---
    const mapCanvas = document.getElementById('minimap-canvas');
    const mapCtx = mapCanvas.getContext('2d');

    function drawMinimap() {
        const w = mapCanvas.width;
        const h = mapCanvas.height;
        mapCtx.clearRect(0, 0, w, h);
        mapCtx.fillStyle = 'rgba(13, 20, 36, 0.85)';
        mapCtx.fillRect(0, 0, w, h);

        const pad = 12;
        const scale = Math.min((w - pad * 2) / 540, (h - pad * 2) / 380);
        const cx = w / 2;
        const cy = h / 2;

        function toMap(x, z) {
            return {
                x: cx + x * scale,
                y: cy + (z - 140) * scale
            };
        }

        // Отрисовка трассы
        mapCtx.beginPath();
        for (let i = 0; i <= 60; i++) {
            const pt = trackCurve.getPointAt(i / 60);
            const m = toMap(pt.x, pt.z);
            if (i === 0) mapCtx.moveTo(m.x, m.y);
            else mapCtx.lineTo(m.x, m.y);
        }
        mapCtx.closePath();
        mapCtx.strokeStyle = 'rgba(0, 240, 255, 0.4)';
        mapCtx.lineWidth = 4;
        mapCtx.stroke();

        // Финишная черта
        const sp = trackCurve.getPointAt(0);
        const sm = toMap(sp.x, sp.z);
        mapCtx.fillStyle = '#ffffff';
        mapCtx.fillRect(sm.x - 2, sm.y - 2, 4, 4);

        // Боты
        aiCars.forEach(ai => {
            const p = ai.model.group.position;
            const m = toMap(p.x, p.z);
            mapCtx.fillStyle = '#ffde59';
            mapCtx.beginPath();
            mapCtx.arc(m.x, m.y, 3, 0, Math.PI * 2);
            mapCtx.fill();
        });

        // Игрок со стрелкой направления
        const pm = toMap(player.pos.x, player.pos.z);
        mapCtx.save();
        mapCtx.translate(pm.x, pm.y);
        mapCtx.rotate(-player.heading + Math.PI);
        mapCtx.fillStyle = '#00f0ff';
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

            if (STATE.isPlaying && !STATE.raceFinished) {
                const elapsed = (performance.now() - STATE.lapStartTime) / 1000;
                uiTime.textContent = formatTime(elapsed);
                uiBest.textContent = formatTime(STATE.bestLapTime);
            }

            drawMinimap();
        }
    }

    // --- ОБРАБОТКА ВВОДА (Тачскрин Galaxy S10 + Мультитач + Клавиатура) ---
    function setupControls() {
        // Клавиатура (ПК / тестирование)
        window.addEventListener('keydown', (e) => {
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
                case 'ShiftLeft':
                case 'ShiftRight':
                    INPUT.nitro = false;
                    break;
            }
        });

        // Мультитач обработка для Galaxy S10
        function processTouches(touches) {
            const newActive = { left: false, right: false, gas: false, brake: false, nitro: false };

            for (let i = 0; i < touches.length; i++) {
                const t = touches[i];
                const el = document.elementFromPoint(t.clientX, t.clientY);
                if (el) {
                    const btn = el.closest('.touch-btn');
                    if (btn && btn.dataset.key) {
                        newActive[btn.dataset.key] = true;
                    }
                }
            }

            INPUT.left = newActive.left;
            INPUT.right = newActive.right;
            INPUT.forward = newActive.gas;
            INPUT.backward = newActive.brake;
            INPUT.nitro = newActive.nitro;

            ['left', 'right', 'gas', 'brake', 'nitro'].forEach(key => {
                const btn = document.querySelector(`.touch-btn[data-key="${key}"]`);
                if (btn) {
                    if (newActive[key]) btn.classList.add('active');
                    else btn.classList.remove('active');
                }
            });
        }

        window.addEventListener('touchstart', (e) => {
            sound.init();
            processTouches(e.touches);
        }, { passive: false });

        window.addEventListener('touchmove', (e) => {
            processTouches(e.touches);
        }, { passive: false });

        window.addEventListener('touchend', (e) => {
            processTouches(e.touches);
        }, { passive: false });

        window.addEventListener('touchcancel', (e) => {
            processTouches(e.touches);
        }, { passive: false });

        // Поддержка кликов мышью для кнопок на экране
        const touchButtons = document.querySelectorAll('.touch-btn');
        touchButtons.forEach(btn => {
            const key = btn.dataset.key;
            if (!key) return;
            const inputField = (key === 'gas' ? 'forward' : (key === 'brake' ? 'backward' : key));

            btn.addEventListener('mousedown', (e) => {
                e.preventDefault();
                INPUT[inputField] = true;
                btn.classList.add('active');
                sound.init();
            });

            const onMouseUp = () => {
                INPUT[inputField] = false;
                btn.classList.remove('active');
            };

            btn.addEventListener('mouseup', onMouseUp);
            btn.addEventListener('mouseleave', onMouseUp);
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

        // Кнопка полноэкранного режима
        document.getElementById('btn-fullscreen').addEventListener('click', () => {
            if (!document.fullscreenElement) {
                document.documentElement.requestFullscreen().catch(() => {});
            } else {
                document.exitFullscreen().catch(() => {});
            }
        });

        // Кнопка старта
        document.getElementById('btn-start').addEventListener('click', () => {
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
        document.getElementById('overlay-screen').classList.add('hidden');
        STATE.isPlaying = true;
        STATE.raceFinished = false;
        STATE.currentLap = 1;
        STATE.lapStartTime = performance.now();
        document.getElementById('ui-lap').textContent = `1/${CONFIG.totalLaps}`;
        showCenterBanner('СТАРТ! ⚡');
        triggerHaptic(50);
    }

    function restartGame() {
        const pStart = trackCurve.getPointAt(0.01);
        const pStartAhead = trackCurve.getPointAt(0.02);
        player.pos.copy(pStart);
        player.heading = Math.atan2(pStartAhead.x - pStart.x, pStartAhead.z - pStart.z);
        player.speed = 0;
        player.nitroEnergy = 100;
        player.currentLap = 1;
        player.lapProgress = 0;
        player.totalProgress = 0;

        aiCars.forEach((ai, idx) => {
            const startT = (0.01 - (idx + 1) * 0.025 + 1.0) % 1.0;
            ai.t = startT;
            ai.currentLap = 1;
            ai.totalProgress = startT;
        });

        startGame();
    }

    // Ресайз окна
    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    cameraCurrentPos.copy(player.pos).add(new THREE.Vector3(0, 10, -15));
    cameraTargetLook.copy(player.pos);

    setupControls();

    // --- ГЛАВНЫЙ ИГРОВОЙ ЦИКЛ ---
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
