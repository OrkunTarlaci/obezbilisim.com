/*!
 * OBEZ BİLİŞİM – 3D laptop açılış deneyimi
 * Bağımlılıksız (saf WebGL2 + CSS matrix3d). Three.js / GSAP gerekmez.
 *
 * Nasıl çalışır:
 *  1. laptop.glb (orijinal geometri + kapanma klibi) okunur, WebGL2 ile çizilir.
 *  2. Modelin ekran yüzeyi (quad) canvas'ta "delik" olarak bırakılır.
 *  3. Deliğin altındaki CSS katmanında gerçek site (iframe, ?embed=1) çalışır;
 *     kameranın view-projection matrisinden türetilen tek bir matrix3d ile
 *     ekran quad'ına oturur. Çerçeve / çentik / menteşe = modelin kendi geometrisi.
 *  4. Kamera bitişte ekranı tam doldurur; iframe, ana sayfayla birebir aynı
 *     düzende olduğu için overlay kaldırılır ve kullanıcı gerçek siteyle baş başa kalır.
 */
(function () {
  'use strict';

  var root = document.documentElement;
  var boot;

  var SCRIPT_SRC = (document.currentScript && document.currentScript.src) || '';
  var FORCE = false;
  var DEBUG = /[?&]introdebug=1/.test(location.search);
  var STORE_KEY = 'obezIntroSeen';

  /* ------------------------------------------------------------------ *
   *  Zaman çizelgesi (saniye)
   * ------------------------------------------------------------------ */
  var T = {
    camA: 3.6,        // kamera: hafif yaklaşma / yükselme (0 → camA)
    lid0: 0.55,       // kapak açılma başlangıcı
    lidDur: 2.9,      // kapak açılma süresi
    wake0: 1.7,       // ekran uyanma başlangıcı
    wakeDur: 0.9,
    dolly0: 2.35,     // ekrana yaklaşma başlangıcı
    dollyDur: 3.3,
    end: 5.75         // animasyon sonu
  };
  var FOV = 30 * Math.PI / 180;

  /* ------------------------------------------------------------------ *
   *  Küçük matematik kütüphanesi (kolon-major, WebGL uyumlu)
   * ------------------------------------------------------------------ */
  var clamp01 = function (x) { return x < 0 ? 0 : x > 1 ? 1 : x; };
  var smooth = function (a, b, x) { x = clamp01((x - a) / (b - a)); return x * x * (3 - 2 * x); };
  var easeIO = function (x) { return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
  var tmp16 = new Float32Array(16);

  function mMul(o, a, b) {
    for (var c = 0; c < 4; c++) {
      for (var r = 0; r < 4; r++) {
        tmp16[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      }
    }
    o.set(tmp16); return o;
  }
  function mIdent(o) { o.fill(0); o[0] = o[5] = o[10] = o[15] = 1; return o; }
  function mPersp(o, fovy, aspect, n, f) {
    var t = 1 / Math.tan(fovy / 2);
    o.fill(0); o[0] = t / aspect; o[5] = t; o[10] = (f + n) / (n - f); o[11] = -1; o[14] = 2 * f * n / (n - f); return o;
  }
  function vSub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function vCross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function vDot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function vNorm(a) { var l = Math.sqrt(vDot(a, a)) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
  function mLookAt(o, eye, tgt, up) {
    var z = vNorm(vSub(eye, tgt)), x = vNorm(vCross(up, z)), y = vCross(z, x);
    o[0] = x[0]; o[1] = y[0]; o[2] = z[0]; o[3] = 0;
    o[4] = x[1]; o[5] = y[1]; o[6] = z[1]; o[7] = 0;
    o[8] = x[2]; o[9] = y[2]; o[10] = z[2]; o[11] = 0;
    o[12] = -vDot(x, eye); o[13] = -vDot(y, eye); o[14] = -vDot(z, eye); o[15] = 1; return o;
  }
  function mFromTQ(o, t, q) {
    var x = q[0], y = q[1], z = q[2], w = q[3];
    var x2 = x + x, y2 = y + y, z2 = z + z, xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
    o[0] = 1 - (yy + zz); o[1] = xy + wz; o[2] = xz - wy; o[3] = 0;
    o[4] = xy - wz; o[5] = 1 - (xx + zz); o[6] = yz + wx; o[7] = 0;
    o[8] = xz + wy; o[9] = yz - wx; o[10] = 1 - (xx + yy); o[11] = 0;
    o[12] = t[0]; o[13] = t[1]; o[14] = t[2]; o[15] = 1; return o;
  }
  function mPoint(m, p) { return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]]; }
  function mDir(m, p) { return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2], m[1] * p[0] + m[5] * p[1] + m[9] * p[2], m[2] * p[0] + m[6] * p[1] + m[10] * p[2]]; }

  /* ------------------------------------------------------------------ *
   *  Çalışma durumu
   * ------------------------------------------------------------------ */
  var finished = false, rafId = 0, gl = null, overlay, els = {}, model, G = {}, L = {}, CAM, lowPerfFrames = [];
  var inertList = [];
  var dpr = 1, W = 0, H = 0, running = false, t = 0, lastNow = 0;
  var resizeTimer = 0;

  /* ------------------------------------------------------------------ *
   *  Overlay DOM + CSS
   * ------------------------------------------------------------------ */
  function buildOverlay() {
    var css = document.createElement('style');
    css.id = 'obez-intro-style';
    css.textContent =
      '#obez-intro{position:fixed;inset:0;z-index:2147483647;overflow:hidden;background:#050506;color:#e9e9ee;' +
      'font-family:"Space Grotesk","Inter",system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}' +
      '#obez-intro .oi-bg{position:absolute;inset:0;background:' +
      'radial-gradient(circle 70px at 79% 11%,rgba(255,178,100,.30),rgba(255,178,100,.30) 45%,rgba(255,178,100,0) 100%),' +
      'radial-gradient(circle 44px at 90% 24%,rgba(255,150,80,.16),rgba(255,150,80,0) 100%),' +
      'radial-gradient(circle 52px at 16% 15%,rgba(255,214,150,.16),rgba(255,214,150,0) 100%),' +
      'radial-gradient(ellipse 80% 50% at 80% 0%,rgba(255,170,90,.16),rgba(255,170,90,0) 100%),' +
      'linear-gradient(#0c0806,#17100b 60%,#1c130d)}' +
      '#obez-intro .oi-css{position:absolute;inset:0;overflow:hidden;pointer-events:none}' +
      '#obez-intro .oi-screen{position:absolute;left:0;top:0;transform-origin:0 0;background:#000;visibility:hidden;will-change:transform;overflow:hidden}' +
      '#obez-intro .oi-screen iframe{position:absolute;border:0;background:#0a0a0a;opacity:0;pointer-events:none}' +
      '#obez-intro .oi-gl{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;opacity:0;transition:opacity .8s ease}' +
      '#obez-intro .oi-brand{position:absolute;left:0;right:0;bottom:10%;text-align:center;font-weight:500;font-size:12px;letter-spacing:.46em;' +
      'color:rgba(255,240,222,.62);text-shadow:0 1px 10px rgba(0,0,0,.65);opacity:0;pointer-events:none;user-select:none;padding-left:.46em}' +
      '#obez-intro .oi-load{position:absolute;left:50%;top:50%;width:132px;height:2px;margin:-1px 0 0 -66px;background:rgba(255,255,255,.09);' +
      'border-radius:2px;overflow:hidden;transition:opacity .4s ease}' +
      '#obez-intro .oi-load i{display:block;height:100%;width:6%;background:#D4AF37;transition:width .3s ease}' +
      '#obez-intro .oi-load.hide{opacity:0}' +
      '#obez-intro .oi-skip{position:absolute;right:28px;bottom:26px;font:500 13px/1 "Inter",system-ui,sans-serif;color:rgba(255,255,255,.72);' +
      'background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.18);border-radius:999px;padding:10px 18px;cursor:pointer;' +
      'opacity:0;transition:opacity .5s ease,border-color .2s ease,color .2s ease}' +
      '#obez-intro .oi-skip.show{opacity:1}' +
      '#obez-intro .oi-skip:hover{color:#fff;border-color:#D4AF37}' +
      '#obez-intro .oi-skip:focus-visible{outline:2px solid #D4AF37;outline-offset:3px}' +
      '#obez-intro .oi-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}';
    document.head.appendChild(css);

    overlay = document.createElement('div');
    overlay.id = 'obez-intro';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Açılış animasyonu');
    overlay.innerHTML =
      '<div class="oi-bg"></div>' +
      '<div class="oi-css"><div class="oi-screen"><iframe title="Obez Bilişim ana sayfa önizlemesi" tabindex="-1" aria-hidden="true" inert></iframe></div></div>' +
      '<canvas class="oi-gl" aria-hidden="true"></canvas>' +
      '<div class="oi-brand" aria-hidden="true">OBEZ BİLİŞİM</div>' +
      '<div class="oi-load" aria-hidden="true"><i></i></div>' +
      '<button type="button" class="oi-skip">Animasyonu geç</button>' +
      '<p class="oi-sr" role="status">Açılış animasyonu oynatılıyor. Atlamak için Esc tuşuna basın.</p>';
    document.body.appendChild(overlay);

    els.canvas = overlay.querySelector('.oi-gl');
    els.screen = overlay.querySelector('.oi-screen');
    els.iframe = overlay.querySelector('iframe');
    els.brand = overlay.querySelector('.oi-brand');
    els.load = overlay.querySelector('.oi-load');
    els.loadBar = els.load.querySelector('i');
    els.skip = overlay.querySelector('.oi-skip');

    // Ana sayfa içeriğini klavye/ekran okuyucudan gizle (animasyon süresince)
    Array.prototype.forEach.call(document.body.children, function (c) {
      if (c === overlay || c.tagName === 'SCRIPT') return;
      if (!c.inert) { c.inert = true; inertList.push(c); }
    });

    els.skip.addEventListener('click', function () { finish('skip'); });
    setTimeout(function () { els.skip.classList.add('show'); }, 300);
    els.skip.focus({ preventScroll: true });
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    window.addEventListener('pageshow', onPageShow);
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); finish('skip'); }
    else if (e.key === 'Tab') { e.preventDefault(); els.skip.focus({ preventScroll: true }); }
  }
  function onPageShow(e) { if (e.persisted) finish('error'); }
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { if (!finished && model) { layout(); if (!rafId) renderAt(t); } }, 80);
  }
  function setProgress(p) { if (els.loadBar) els.loadBar.style.width = Math.round(clamp01(p) * 100) + '%'; }

  /* ------------------------------------------------------------------ *
   *  GLB okuyucu
   * ------------------------------------------------------------------ */
  function parseGLB(buf) {
    var dv = new DataView(buf);
    if (dv.getUint32(0, true) !== 0x46546C67) throw new Error('GLB değil');
    var jl = dv.getUint32(12, true);
    var json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jl)));
    var binStart = 20 + jl + 8;
    function acc(i) {
      var a = json.accessors[i], v = json.bufferViews[a.bufferView];
      var n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
      var C = { 5126: Float32Array, 5123: Uint16Array, 5125: Uint32Array }[a.componentType];
      var off = binStart + (v.byteOffset || 0) + (a.byteOffset || 0);
      return new C(buf.slice(off, off + a.count * n * C.BYTES_PER_ELEMENT));
    }
    function mesh(mi) {
      var p = json.meshes[mi].primitives[0];
      return { pos: acc(p.attributes.POSITION), nor: acc(p.attributes.NORMAL), uv: acc(p.attributes.TEXCOORD_0), idx: acc(p.indices) };
    }
    var anim = json.animations && json.animations[0];
    var lidNode = 1, rot = null, trans = null;
    if (anim) {
      anim.channels.forEach(function (c) {
        lidNode = c.target.node;
        var s = anim.samplers[c.sampler];
        if (c.target.path === 'rotation') rot = { t: acc(s.input), q: acc(s.output) };
        if (c.target.path === 'translation') trans = acc(s.output);
      });
    }
    var baseNode = lidNode === 1 ? 0 : 1;
    var ln = json.nodes[lidNode], bn = json.nodes[baseNode];
    var bvImg = json.bufferViews[json.images[0].bufferView];
    var img = new Uint8Array(buf, binStart + (bvImg.byteOffset || 0), bvImg.byteLength);
    var m = {
      base: mesh(bn.mesh),
      lid: mesh(ln.mesh),
      lidT: trans ? [trans[0], trans[1], trans[2]] : (ln.translation || [0, 0, 0]),
      lidQ0: ln.rotation || [0, 0, 0, 1],
      clip: rot,
      imgBlob: new Blob([img], { type: json.images[0].mimeType || 'image/png' })
    };
    if (rot) {   // klip anahtarlarının X ekseni açıları (dönüş saf X ekseninde)
      var n = rot.t.length; m.clipAng = new Float32Array(n);
      for (var i = 0; i < n; i++) m.clipAng[i] = 2 * Math.atan2(rot.q[i * 4], rot.q[i * 4 + 3]);
    }
    return m;
  }

  /* Kapak açısı → kuaterniyon. Modelin KAPANMA klibinin anahtarları tersine okunur:
     hedef açıya karşılık gelen klip karesi bulunur (zamanlamayı kendi eğrimizle yumuşatırız). */
  function lidQuat(p) {                       // p: 0 = kapalı, 1 = açık
    var c = model.clip, ang = model.clipAng;
    if (!c) { var a = (-Math.PI / 2) * (1 - p) + 0.2554 * p; return [Math.sin(a / 2), 0, 0, Math.cos(a / 2)]; }
    var n = ang.length, aOpen = ang[0], aClosed = ang[n - 1];
    var target = aClosed + (aOpen - aClosed) * p;
    var i = 0; while (i < n - 2 && ang[i + 1] > target) i++;       // açılar klipte azalıyor
    var f = (ang[i] - target) / ((ang[i] - ang[i + 1]) || 1); f = clamp01(f);
    var q0 = c.q.subarray(i * 4, i * 4 + 4), q1 = c.q.subarray((i + 1) * 4, (i + 1) * 4 + 4);
    var q = [q0[0] + (q1[0] - q0[0]) * f, q0[1] + (q1[1] - q0[1]) * f, q0[2] + (q1[2] - q0[2]) * f, q0[3] + (q1[3] - q0[3]) * f];
    var l = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
    return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
  }

  /* ------------------------------------------------------------------ *
   *  WebGL
   * ------------------------------------------------------------------ */
  var VS_LIT =
    '#version 300 es\n' +
    'layout(location=0) in vec3 aPos; layout(location=1) in vec3 aNor; layout(location=2) in vec2 aUV;\n' +
    'uniform mat4 uVP; uniform mat4 uModel;\n' +
    'out vec3 vW; out vec3 vN; out vec2 vUV;\n' +
    'void main(){ vec4 w=uModel*vec4(aPos,1.0); vW=w.xyz; vN=mat3(uModel)*aNor; vUV=aUV; gl_Position=uVP*w; }';

  var FS_LIT =
    '#version 300 es\nprecision highp float;\n' +
    'in vec3 vW; in vec3 vN; in vec2 vUV;\n' +
    'uniform sampler2D uTex; uniform vec3 uCam; uniform float uEnvRot; uniform float uScreenOn; uniform vec3 uScreenPos;\n' +
    'uniform float uReflect; uniform float uFloorY;\n' +
    'out vec4 o;\n' +
    'const float PI=3.14159265;\n' +
    'vec3 envMap(vec3 r){\n' +
    '  float c=cos(uEnvRot), s=sin(uEnvRot); r=vec3(c*r.x-s*r.z, r.y, s*r.x+c*r.z);\n' +
    '  vec3 base=mix(vec3(0.010,0.010,0.014), vec3(0.060,0.064,0.078), smoothstep(0.0,1.0,r.y*0.5+0.5));\n' +
    '  float sb=smoothstep(0.74,0.97,dot(r,normalize(vec3(-0.25,0.9,-0.35))));\n' +
    '  float st1=smoothstep(0.90,0.985,dot(r,normalize(vec3(0.85,0.30,-0.45))));\n' +
    '  float st2=smoothstep(0.92,0.99,dot(r,normalize(vec3(-0.9,0.25,-0.2))));\n' +
    '  float rim=smoothstep(0.78,0.97,dot(r,normalize(vec3(0.1,0.35,0.93))));\n' +
    '  return base + vec3(1.0,0.98,0.95)*sb*1.15 + vec3(1.0,0.97,0.92)*st1*2.6 + vec3(0.7,0.8,1.0)*st2*1.5 + vec3(0.85,0.9,1.0)*rim*1.3;\n' +
    '}\n' +
    'float ggx(float ndh,float a){ float a2=a*a; float d=ndh*ndh*(a2-1.0)+1.0; return a2/(PI*d*d); }\n' +
    'vec3 light(vec3 N,vec3 V,vec3 L,vec3 C,vec3 alb,float rough){\n' +
    '  float ndl=max(dot(N,L),0.0); vec3 H=normalize(L+V); float ndh=max(dot(N,H),0.0); float ndv=max(dot(N,V),0.001);\n' +
    '  float k=(rough+1.0)*(rough+1.0)/8.0; float vis=1.0/(4.0*(ndl*(1.0-k)+k+0.001)*(ndv*(1.0-k)+k));\n' +
    '  float a=rough*rough; float sp=ggx(ndh,a)*vis*0.028;\n' +
    '  return C*ndl*(alb/PI + sp*ndl);\n' +
    '}\n' +
    'void main(){\n' +
    '  vec3 N=normalize(vN); vec3 V=normalize(uCam-vW); if(dot(N,V)<0.0) N=-N;\n' +
    '  vec3 alb=max(pow(texture(uTex,vUV).rgb,vec3(2.2)),vec3(0.012));\n' +
    '  float ndv=max(dot(N,V),0.0);\n' +
    '  vec3 col=alb*(0.55+0.45*N.y)*0.5;\n' +
    '  col+=light(N,V,normalize(vec3(0.45,0.9,-0.55)),vec3(1.0,0.97,0.92)*3.4,alb,0.42);\n' +
    '  col+=light(N,V,normalize(vec3(-0.75,0.35,-0.45)),vec3(0.55,0.65,1.0)*1.4,alb,0.5);\n' +
    '  col+=light(N,V,normalize(vec3(-0.15,0.55,0.85)),vec3(0.9,0.93,1.0)*2.6,alb,0.45);\n' +
    '  float F=0.06+0.94*pow(1.0-ndv,5.0);\n' +
    '  col+=envMap(reflect(-V,N))*(F*0.75+0.025);\n' +
    '  float d=distance(vW,uScreenPos); float glow=uScreenOn*smoothstep(1.25,0.05,d);\n' +
    '  col+=(alb*2.2+0.006)*vec3(0.5,0.68,1.0)*glow*max(dot(N,normalize(uScreenPos-vW)),0.0)*0.3;\n' +
    '  col=col*(2.51*col+0.03)/(col*(2.43*col+0.59)+0.14);\n' +
    '  col=pow(clamp(col,0.0,1.0),vec3(1.0/2.2));\n' +
    '  float a=1.0;\n' +
    '  if(uReflect>0.5){ float h=max(uFloorY-vW.y,0.0); a=0.20*(1.0-smoothstep(0.0,0.5,h)); }\n' +
    '  o=vec4(col*a,a);\n' +
    '}';

  var FS_FLAT =
    '#version 300 es\nprecision highp float;\n' +
    'in vec3 vW; in vec3 vN; in vec2 vUV;\n' +
    'uniform vec4 uColor; uniform float uFade; uniform float uFloorY;\n' +
    'out vec4 o;\n' +
    'void main(){ float a=1.0; if(uFade>0.5){ float h=max(uFloorY-vW.y,0.0); a=0.20*(1.0-smoothstep(0.0,0.5,h)); } o=uColor*a; }';

  var VS_FLOOR =
    '#version 300 es\n' +
    'layout(location=0) in vec3 aPos; uniform mat4 uVP; out vec3 vW;\n' +
    'void main(){ vW=aPos; gl_Position=uVP*vec4(aPos,1.0); }';

  var FS_FLOOR =
    '#version 300 es\n' +
    'precision highp float;\n' +
    'in vec3 vW;\n' +
    'uniform float uScreenOn; uniform float uOpen; uniform float uPass; uniform vec3 uCam;\n' +
    'out vec4 o;\n' +
    'float sdBox(vec2 p, vec2 b){ vec2 d=abs(p)-b; return length(max(d,0.0))+min(max(d.x,d.y),0.0); }\n' +
    'float h11(float n){ return fract(sin(n*127.1+11.7)*43758.5453); }\n' +
    'float h21(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }\n' +
    'float vn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);\n' +
    '  return mix(mix(h21(i),h21(i+vec2(1.0,0.0)),f.x), mix(h21(i+vec2(0.0,1.0)),h21(i+vec2(1.0,1.0)),f.x), f.y); }\n' +
    'float fbm3(vec2 p){ float a=0.5, s=0.0; for(int i=0;i<3;i++){ s+=a*vn(p); p=p*2.03+vec2(17.0,9.0); a*=0.5; } return s; }\n' +
    'void main(){\n' +
    '  vec2 p=vW.xz;\n' +
    '  if(uPass>0.5){\n' +
    '    float d=sdBox(p,vec2(0.66,0.45));\n' +
    '    float contact=1.0-smoothstep(0.0,0.07,d);\n' +
    '    float soft=1.0-smoothstep(0.0,0.95,d); soft*=soft;\n' +
    '    float behind=uOpen*(1.0-smoothstep(0.0,0.7,sdBox(p-vec2(0.0,0.62),vec2(0.6,0.22))))*0.40;\n' +
    '    float a=clamp(contact*0.88+soft*0.50+behind,0.0,0.92);\n' +
    '    o=vec4(0.0,0.0,0.0,a);\n' +
    '    return;\n' +
    '  }\n' +
    '  float dist=length(uCam-vW);\n' +
    '  float vis=1.0-smoothstep(7.0,16.0,dist);\n' +
    '  if(vis<=0.0){ o=vec4(0.0); return; }\n' +
    '  float fw=max(fwidth(p.x),fwidth(p.y));\n' +
    '  const float PW=0.85; const float PL=15.0;\n' +
    '  float row=floor(p.y/PW); float fy=p.y/PW-row;\n' +
    '  float cx=(p.x+h11(row+1.3)*PL)/PL; float col=floor(cx); float fx=cx-col;\n' +
    '  float id=h21(vec2(row,col)+7.0);\n' +
    '  vec2 q=vec2(p.x+id*41.0, p.y+id*17.0);\n' +
    '  float warp=fbm3(vec2(q.x*0.30,q.y*1.2));\n' +
    '  float ringAA=1.0-smoothstep(0.02,0.07,fw);\n' +
    '  float ring=smoothstep(0.0,1.0,fract(q.y*9.0+warp*5.0+vn(vec2(q.x*0.5,q.y*3.0))*1.2));\n' +
    '  ring=mix(0.5,ring,ringAA);\n' +
    '  float fibAA=1.0-smoothstep(0.004,0.016,fw);\n' +
    '  float fib=vn(vec2(q.x*1.6,q.y*64.0))*0.6+vn(vec2(q.x*3.2,q.y*170.0))*0.4;\n' +
    '  fib=mix(0.5,fib,fibAA);\n' +
    '  float tone=0.48+0.16*(ring-0.5)+0.30*(fib-0.5)+0.22*(fbm3(q*vec2(0.12,0.9))-0.5);\n' +
    '  vec3 alb=mix(vec3(0.17,0.105,0.062),vec3(0.47,0.315,0.185),clamp(tone,0.0,1.0));\n' +
    '  alb*=0.88+0.24*h11(row*3.1+col*1.7+2.0);\n' +
    '  float gd=min(min(fy,1.0-fy)*PW,min(fx,1.0-fx)*PL);\n' +
    '  float groove=1.0-smoothstep(0.0,0.006+fw,gd);\n' +
    '  alb*=mix(1.0,0.38,groove);\n' +
    '  alb=pow(alb,vec3(2.2));\n' +
    '  vec3 V=normalize(uCam-vW);\n' +
    '  vec3 N=normalize(vec3(0.0,1.0,(fib-0.5)*0.10*fibAA+(ring-0.5)*0.03));\n' +
    '  vec3 L=normalize(vec3(0.45,0.9,-0.55));\n' +
    '  vec3 H=normalize(L+V);\n' +
    '  float ndl=max(dot(N,L),0.0);\n' +
    '  vec2 qq=p-vec2(0.0,0.10); float pool=exp(-dot(qq,qq)/(2.0*1.65*1.65));\n' +
    '  float light=0.10+1.25*pool;\n' +
    '  vec3 c=alb*vec3(1.0,0.82,0.62)*light*(0.55+0.55*ndl)*1.9;\n' +
    '  float spec=pow(max(dot(N,H),0.0),55.0);\n' +
    '  c+=vec3(1.0,0.85,0.65)*spec*0.5*pool*(1.0-groove);\n' +
    '  float F=0.03+0.97*pow(1.0-max(V.y,0.0),5.0);\n' +
    '  c+=vec3(0.30,0.22,0.15)*F*(0.25+pool);\n' +
    '  vec2 s=p-vec2(0.0,-0.95); float spill=uScreenOn*exp(-dot(s,s)/(2.0*0.8*0.8));\n' +
    '  c+=alb*vec3(0.30,0.52,1.0)*spill*3.2;\n' +
    '  c=c*(2.51*c+0.03)/(c*(2.43*c+0.59)+0.14);\n' +
    '  c=pow(clamp(c,0.0,1.0),vec3(1.0/2.2));\n' +
    '  o=vec4(c*vis,vis);\n' +
    '}';

  function compile(type, src) {
    var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Shader: ' + gl.getShaderInfoLog(s));
    return s;
  }
  function program(vs, fs) {
    var p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs)); gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Link: ' + gl.getProgramInfoLog(p));
    var u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (var i = 0; i < n; i++) { var inf = gl.getActiveUniform(p, i); u[inf.name] = gl.getUniformLocation(p, inf.name); }
    return { p: p, u: u };
  }

  function makeVAO(vbos, idx) {
    var vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbos.pos); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbos.nor); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbos.uv); gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, 0);
    var ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return { vao: vao, count: idx.length, type: idx instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT };
  }
  function makeVBOs(m) {
    function buf(a) { var b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, a, gl.STATIC_DRAW); return b; }
    return { pos: buf(m.pos), nor: buf(m.nor), uv: buf(m.uv) };
  }

  function buildGL(img) {
    G.lit = program(VS_LIT, FS_LIT);
    G.flat = program(VS_LIT, FS_FLAT);
    G.floor = program(VS_FLOOR, FS_FLOOR);

    // Taban
    var bv = makeVBOs(model.base);
    G.base = makeVAO(bv, model.base.idx);

    // Kapak: ekran quad'ı (delik) ile gövde ayrılır
    var lid = model.lid, P = lid.pos, N = lid.nor, I = lid.idx, body = [], scr = [];
    function isScr(v) { var z = P[v * 3 + 2]; return N[v * 3 + 2] < -0.99 && z > 0.009 && z < 0.0105 && Math.abs(P[v * 3]) < 0.67; }
    for (var i = 0; i < I.length; i += 3) {
      var a = I[i], b = I[i + 1], c = I[i + 2];
      if (isScr(a) && isScr(b) && isScr(c)) scr.push(a, b, c); else body.push(a, b, c);
    }
    if (!scr.length) throw new Error('Ekran yüzeyi bulunamadı');
    var AT = lid.pos.length / 3 > 65535 ? Uint32Array : Uint16Array;
    var lv = makeVBOs(lid);
    G.lidBody = makeVAO(lv, new AT(body));
    G.lidScreen = makeVAO(lv, new AT(scr));

    // Ekran quad'ının modele ait yerel çerçevesi
    var seen = {}, vs = [];
    scr.forEach(function (v) { if (!seen[v]) { seen[v] = 1; vs.push([P[v * 3], P[v * 3 + 1], P[v * 3 + 2]]); } });
    var minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
    vs.forEach(function (p) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); });
    var mid = (minY + maxY) / 2, top = [0, 0, 0], bot = [0, 0, 0], nt = 0, nb = 0;
    vs.forEach(function (p) { if (p[1] > mid) { top[0] += p[0]; top[1] += p[1]; top[2] += p[2]; nt++; } else { bot[0] += p[0]; bot[1] += p[1]; bot[2] += p[2]; nb++; } });
    top = top.map(function (x) { return x / nt; }); bot = bot.map(function (x) { return x / nb; });
    var down = vNorm(vSub(bot, top));
    L.qCenter = [(top[0] + bot[0]) / 2, (top[1] + bot[1]) / 2, (top[2] + bot[2]) / 2];
    L.qAx = [-1, 0, 0];                          // izleyicinin gördüğü "sağ" (laptop arkadan -Z'ye bakar)
    L.qDown = down;
    L.qN = vNorm(vCross(down, L.qAx));           // izleyiciye bakan normal
    if (L.qN[2] > 0) L.qN = [-L.qN[0], -L.qN[1], -L.qN[2]];
    L.qw = maxX - minX;
    L.qh = Math.sqrt(vDot(vSub(bot, top), vSub(bot, top)));

    // Zemin
    var fb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, fb);
    var minY0 = 1e9; for (var j = 1; j < model.base.pos.length; j += 3) minY0 = Math.min(minY0, model.base.pos[j]);
    L.floorY = minY0;
    var e = 22, fy = L.floorY;
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-e, fy, -e, e, fy, -e, -e, fy, e, e, fy, e]), gl.STATIC_DRAW);
    G.floorVAO = gl.createVertexArray(); gl.bindVertexArray(G.floorVAO);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0); gl.bindVertexArray(null);

    // Doku
    G.tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, G.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    var ext = gl.getExtension('EXT_texture_filter_anisotropic');
    if (ext) gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
  }

  /* ------------------------------------------------------------------ *
   *  Yerleşim (pencere boyutu değişince yeniden hesaplanır)
   * ------------------------------------------------------------------ */
  function lidMatrix(o, p) { return mFromTQ(o, model.lidT, lidQuat(p)); }

  function layout() {
    W = overlay.clientWidth; H = overlay.clientHeight;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    var maxPx = (W < 800) ? 2.4e6 : 4.6e6; if (W * H * dpr * dpr > maxPx) dpr = Math.sqrt(maxPx / (W * H));
    els.canvas.width = Math.round(W * dpr); els.canvas.height = Math.round(H * dpr);

    // Dikey/dar ekran (telefon): ekranda sitenin masaüstü hali (3:2) açılır, bitişte gerçek mobil siteye yumuşak geçiş yapılır.
    L.virtual = (W / H) < 1.25;
    if (L.virtual) {
      var iw = 1280, ih = Math.round(iw * L.qh / L.qw);
      L.k = iw / L.qw; L.ew = iw; L.eh = ih;
      els.screen.style.width = iw + 'px'; els.screen.style.height = ih + 'px';
      els.iframe.style.width = iw + 'px'; els.iframe.style.height = ih + 'px';
      els.iframe.style.left = '0px'; els.iframe.style.top = '0px';
    } else {
      // iframe, gerçek pencere ile BİREBİR aynı boyutta (düzen farkı olmasın)
      L.k = Math.max(W / L.qw, H / L.qh);
      var ew = Math.ceil(L.qw * L.k - 1e-6), eh = Math.ceil(L.qh * L.k - 1e-6);
      if ((ew - W) % 2) ew++; if ((eh - H) % 2) eh++;
      L.ew = ew; L.eh = eh;
      els.screen.style.width = ew + 'px'; els.screen.style.height = eh + 'px';
      els.iframe.style.width = W + 'px'; els.iframe.style.height = H + 'px';
      els.iframe.style.left = ((ew - W) / 2) + 'px'; els.iframe.style.top = ((eh - H) / 2) + 'px';
    }

    // Kapağın tam açık hali → bitiş kamerası
    var m = new Float32Array(16); lidMatrix(m, 1);
    var C = mPoint(m, L.qCenter), n = vNorm(mDir(m, L.qN)), down = mDir(m, L.qDown);
    var dF = (L.virtual ? L.qw * H / W : H / L.k) / (2 * Math.tan(FOV / 2));   // virtual: ekranın GENİŞLİĞİ pencereyi doldurur
    L.final = {
      C: C, n: n, up: vNorm([-down[0], -down[1], -down[2]]), ax: mDir(m, L.qAx),
      az: Math.atan2(n[0], -n[2]), el: Math.asin(n[1]), ld: Math.log(dF)
    };
    L.openC = C;
    var af = Math.max(1, Math.pow(1.75 / (W / H), 0.8));          // dar/yüksek pencerede kamerayı geri çek (laptop taşmasın)
    CAM = {
      p0: { az: 16 * Math.PI / 180, el: 26 * Math.PI / 180, ld: Math.log(3.05 * af), tx: 0, ty: 0.03, tz: 0.05 },
      p1: { az: -5 * Math.PI / 180, el: 13 * Math.PI / 180, ld: Math.log(3.5 * af), tx: 0, ty: 0.30, tz: 0.28 },
      pF: { az: L.final.az, el: L.final.el, ld: L.final.ld, tx: C[0], ty: C[1], tz: C[2] }
    };
  }

  /* ------------------------------------------------------------------ *
   *  Çizim
   * ------------------------------------------------------------------ */
  var mView = new Float32Array(16), mProj = new Float32Array(16), mVP = new Float32Array(16),
      mLid = new Float32Array(16), mBase = new Float32Array(16), mMirror = new Float32Array(16),
      mTmp = new Float32Array(16), mEl = new Float32Array(16), mFin = new Float32Array(16);

  function state(time) {
    var lidP = easeIO(clamp01((time - T.lid0) / T.lidDur));
    var eA = easeIO(clamp01(time / T.camA));
    var eB = easeIO(clamp01((time - T.dolly0) / T.dollyDur));
    var P0 = CAM.p0, P1 = CAM.p1, PF = CAM.pF;
    function v(k) { return P0[k] + (P1[k] - P0[k]) * eA + (PF[k] - P1[k]) * eB; }
    var az = v('az'), el = v('el'), d = Math.exp(v('ld'));
    var tg = [v('tx'), v('ty'), v('tz')];
    var eye = [tg[0] + d * Math.sin(az) * Math.cos(el), tg[1] + d * Math.sin(el), tg[2] - d * Math.cos(az) * Math.cos(el)];
    var upF = L.final.up;
    var up = vNorm([upF[0] * eB, 1 + (upF[1] - 1) * eB, upF[2] * eB]);
    return {
      lidP: lidP, eB: eB, eye: eye, tg: tg, up: up,
      wake: smooth(T.wake0, T.wake0 + T.wakeDur, time),
      brand: smooth(0.15, 1.0, time) * (1 - smooth(1.9, 2.9, time))
    };
  }

  function renderAt(time) {
    var s = state(time);
    gl.viewport(0, 0, els.canvas.width, els.canvas.height);
    mLookAt(mView, s.eye, s.tg, s.up);
    mPersp(mProj, FOV, W / H, 0.05, 60);
    mMul(mVP, mProj, mView);
    lidMatrix(mLid, s.lidP);
    mIdent(mBase);
    var fy = L.floorY;
    mIdent(mMirror); mMirror[5] = -1; mMirror[13] = 2 * fy;          // y' = 2*fy - y
    var scrPos = mPoint(mLid, L.qCenter);
    var envRot = 0.55 + time * 0.22;

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.CULL_FACE);

    // ---- 0) Ahşap masa yüzeyi
    gl.disable(gl.DEPTH_TEST);
    var fp = G.floor; gl.useProgram(fp.p);
    gl.uniformMatrix4fv(fp.u.uVP, false, mVP);
    gl.uniform3fv(fp.u.uCam, s.eye);
    gl.uniform1f(fp.u.uScreenOn, s.wake); gl.uniform1f(fp.u.uOpen, s.lidP);
    gl.uniform1f(fp.u.uPass, 0);
    gl.bindVertexArray(G.floorVAO); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); gl.bindVertexArray(null);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true);

    // ---- 1) Yansıma (cilalı masa üstünde hafif laptop yansıması)
    var lit = G.lit; gl.useProgram(lit.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, G.tex); gl.uniform1i(lit.u.uTex, 0);
    gl.uniformMatrix4fv(lit.u.uVP, false, mVP);
    gl.uniform3fv(lit.u.uCam, s.eye); gl.uniform1f(lit.u.uEnvRot, envRot);
    gl.uniform1f(lit.u.uScreenOn, s.wake); gl.uniform3fv(lit.u.uScreenPos, scrPos);
    gl.uniform1f(lit.u.uFloorY, fy);
    gl.uniform1f(lit.u.uReflect, 1);
    mMul(mTmp, mMirror, mBase); gl.uniformMatrix4fv(lit.u.uModel, false, mTmp); drawVAO(G.base);
    mMul(mTmp, mMirror, mLid); gl.uniformMatrix4fv(lit.u.uModel, false, mTmp); drawVAO(G.lidBody);
    var fl = G.flat; gl.useProgram(fl.p);
    gl.uniformMatrix4fv(fl.u.uVP, false, mVP); gl.uniformMatrix4fv(fl.u.uModel, false, mTmp);
    gl.uniform1f(fl.u.uFade, 1); gl.uniform1f(fl.u.uFloorY, fy);
    var sc = 0.16 * s.wake;
    gl.uniform4f(fl.u.uColor, 0.30 * sc, 0.42 * sc, 0.62 * sc, sc);
    drawVAO(G.lidScreen);
    gl.clear(gl.DEPTH_BUFFER_BIT);

    // ---- 2) Masanın üstüne laptop gölgesi
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(fp.p);
    gl.uniformMatrix4fv(fp.u.uVP, false, mVP);
    gl.uniform3fv(fp.u.uCam, s.eye);
    gl.uniform1f(fp.u.uScreenOn, s.wake); gl.uniform1f(fp.u.uOpen, s.lidP);
    gl.uniform1f(fp.u.uPass, 1);
    gl.bindVertexArray(G.floorVAO); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); gl.bindVertexArray(null);

    // ---- 3) Laptop
    gl.enable(gl.DEPTH_TEST);
    gl.useProgram(lit.p); gl.uniform1f(lit.u.uReflect, 0);
    gl.uniformMatrix4fv(lit.u.uModel, false, mBase); drawVAO(G.base);
    gl.uniformMatrix4fv(lit.u.uModel, false, mLid); drawVAO(G.lidBody);

    // ---- 4) Ekran deliği (alfa = 0 → altındaki gerçek site görünür)
    gl.useProgram(fl.p);
    gl.uniformMatrix4fv(fl.u.uVP, false, mVP); gl.uniformMatrix4fv(fl.u.uModel, false, mLid);
    gl.uniform1f(fl.u.uFade, 0); gl.uniform4f(fl.u.uColor, 0, 0, 0, 0);
    gl.disable(gl.BLEND);
    gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(-2, -2);
    drawVAO(G.lidScreen);
    gl.disable(gl.POLYGON_OFFSET_FILL);

    // ---- CSS ekran katmanı (aynı kamera, tek matrix3d)
    placeScreen(s);

    // Bitişe yakın canvas'ı sön: iframe, pencereyi piksel piksel doldurur
    if (s.eB > 0.9 && !L.virtual) { els.canvas.style.transition = 'none'; els.canvas.style.opacity = 1 - smooth(0.985, 1.0, s.eB); }
    else if (DEBUG && els.canvas.style.opacity !== '1') { els.canvas.style.transition = 'none'; els.canvas.style.opacity = 1; }
    els.iframe.style.opacity = s.wake;
    els.brand.style.opacity = s.brand;
    return s;
  }
  function drawVAO(v) { gl.bindVertexArray(v.vao); gl.drawElements(gl.TRIANGLES, v.count, v.type, 0); gl.bindVertexArray(null); }

  function placeScreen(s) {
    var ax = mDir(mLid, L.qAx), ay = mDir(mLid, L.qDown), n = mDir(mLid, L.qN), C = mPoint(mLid, L.qCenter);
    var k = L.k, hx = (L.ew / 2) / k, hy = (L.eh / 2) / k;
    // eleman px (u,v,0) → dünya
    mEl[0] = ax[0] / k; mEl[1] = ax[1] / k; mEl[2] = ax[2] / k; mEl[3] = 0;
    mEl[4] = ay[0] / k; mEl[5] = ay[1] / k; mEl[6] = ay[2] / k; mEl[7] = 0;
    mEl[8] = n[0] / k; mEl[9] = n[1] / k; mEl[10] = n[2] / k; mEl[11] = 0;
    mEl[12] = C[0] - ax[0] * hx - ay[0] * hy; mEl[13] = C[1] - ax[1] * hx - ay[1] * hy; mEl[14] = C[2] - ax[2] * hx - ay[2] * hy; mEl[15] = 1;
    mMul(mFin, mVP, mEl);
    var m = mFin, out = new Array(16);
    for (var j = 0; j < 4; j++) {
      var x = m[j * 4], y = m[j * 4 + 1], z = m[j * 4 + 2], w = m[j * 4 + 3];
      out[j * 4] = 0.5 * W * (x + w);
      out[j * 4 + 1] = 0.5 * H * (w - y);
      out[j * 4 + 2] = z;
      out[j * 4 + 3] = w;
    }
    els.screen.style.transform = 'matrix3d(' + out.join(',') + ')';
    els.screen.style.visibility = 'visible';
  }

  /* ------------------------------------------------------------------ *
   *  Döngü + yaşam döngüsü
   * ------------------------------------------------------------------ */
  function frame(now) {
    if (finished) return;
    rafId = requestAnimationFrame(frame);
    var dt = Math.min((now - lastNow) / 1000, 0.05); lastNow = now;
    if (!running) return;
    t += dt;
    // Performans güvenliği (zorlama modunda devre dışı)
    if (!FORCE && lowPerfFrames.length < 40 && t > 0.3) {
      lowPerfFrames.push(dt);
      if (lowPerfFrames.length === 40) {
        var avg = lowPerfFrames.reduce(function (a, b) { return a + b; }, 0) / 40;
        if (avg > 0.045) { if (dpr > 1) { dpr = 1; els.canvas.width = W; els.canvas.height = H; lowPerfFrames = []; } else { finish('skip'); return; } }
      }
    }
    try { renderAt(t); } catch (e) { fail(e); return; }
    if (t >= T.end) finish('done');
  }

  function finish(mode) {
    if (finished) return; finished = true;
    cancelAnimationFrame(rafId);
    try { sessionStorage.setItem(STORE_KEY, '1'); } catch (e) { }
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('pageshow', onPageShow);
    clearTimeout(boot.watchdog);
    try { if (boot && boot.abort) boot.abort.abort(); } catch (e) { }   // yarım kalan model indirmesi ana sitenin bant genişliğini yemesin

    // Kaydırma kilidini ve erişilebilirlik kilidini bırak (overlay hâlâ üstte → görünür sıçrama yok)
    root.classList.remove('obez-intro');
    inertList.forEach(function (c) { c.inert = false; });
    inertList = [];
    var killStyle = function () { var s = document.getElementById('obez-intro-style'); if (s) s.remove(); };

    var cleanup = function () {
      try { if (gl) { var lose = gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext(); } } catch (e) { }
      if (els.iframe) els.iframe.src = 'about:blank';
      if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
      killStyle();
    };
    if (mode === 'error' || !overlay) { cleanup(); return; }
    // iki kare bekle: ana sayfa kilit kalkınca düzenini otursun, sonra kısa çapraz geçiş
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        overlay.style.pointerEvents = 'none';
        overlay.style.transition = 'opacity ' + (mode === 'done' ? (L.virtual ? '.7s' : '.3s') : '.45s') + ' ease';
        overlay.style.opacity = '0';
        setTimeout(cleanup, mode === 'done' ? (L.virtual ? 780 : 360) : 520);
      });
    });
  }
  function fail(e) { if (finished) return; try { console.warn('[obez-intro] hata, normal site gösteriliyor:', e && e.message ? e.message : e); } catch (x) { } finish('error'); }

  /* ------------------------------------------------------------------ *
   *  Başlatma
   * ------------------------------------------------------------------ */
  function loadImage(blob) {
    return new Promise(function (res, rej) {
      var img = new Image(); var url = URL.createObjectURL(blob);
      img.onload = function () { URL.revokeObjectURL(url); res(img); };
      img.onerror = function () { rej(new Error('Doku okunamadı')); };
      img.src = url;
    });
  }
  function waitIframe(ms) {
    // Hazır = sayfa ayrıştırıldı (Bootstrap CSS uygulanmış) + kısa bekleme; fontların/ikonların bitmesi beklenmez.
    // Süre içinde olmazsa (yavaş bağlantı) yarım yüklenmiş siteyi göstermek yerine animasyon atlanır.
    return new Promise(function (res, rej) {
      var done = false, tm, poll, since = 0;
      function ok() { if (done) return; done = true; clearTimeout(tm); clearInterval(poll); res(); }
      els.iframe.addEventListener('load', ok, { once: true });
      poll = setInterval(function () {
        try {
          var d = els.iframe.contentDocument;
          if (d && d.readyState !== 'loading' && /embed=1/.test(d.location.href)) {
            if (!since) since = performance.now(); else if (performance.now() - since > 700) ok();
          }
        } catch (e) { }
      }, 100);
      tm = setTimeout(function () {
        if (done) return; done = true; clearInterval(poll);
        if (FORCE) res(); else rej(new Error('site önizlemesi zamanında yüklenmedi (yavaş bağlantı)'));
      }, ms);
    });
  }

  function start() {
    clearTimeout(boot.watchdog);
    // yükleme çok uzarsa (yavaş ağ/GPU sorunu) sessizce normal siteye dön — süre, <head> script'inin başladığı andan itibaren sayılır
    var left = Math.max(800, (boot.budget || 15000) - (performance.now() - (boot.t0 || performance.now())));
    boot.watchdog = setTimeout(function () { if (!running && !finished && !DEBUG) fail(new Error('zaman aşımı (yavaş bağlantı)')); }, left);
    buildOverlay();
    setProgress(0.08);
    // Gerçek siteyi ekran içeriği olarak yükle (aynı URL, ?embed=1 → intro tekrar çalışmaz)
    els.iframe.src = location.pathname + '?embed=1';
    var iframeReady = waitIframe(FORCE ? 7000 : left);
    iframeReady.catch(fail);            // önizleme hazır olmayacaksa model beklemeden hemen vazgeç

    var glbP = boot.glb || fetch(new URL('laptop.glb', SCRIPT_SRC || location.href).href).then(function (r) {
      if (!r.ok) throw new Error('GLB ' + r.status); return r.arrayBuffer();
    });
    var ctx;
    try {
      ctx = els.canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: true, depth: true, stencil: false, powerPreference: 'high-performance' });
    } catch (e) { }
    if (!ctx) { fail(new Error('WebGL2 yok')); return; }
    gl = ctx;
    gl.canvas.addEventListener('webglcontextlost', function (e) { e.preventDefault(); if (!finished) finish('error'); });

    glbP.then(function (buf) {
      setProgress(0.35);
      model = parseGLB(buf);
      return loadImage(model.imgBlob);
    }).then(function (img) {
      setProgress(0.6);
      buildGL(img);
      layout();
      renderAt(0);                       // ilk kare (sahne hazır)
      return iframeReady;
    }).then(function () {
      if (finished) return;
      setProgress(1);
      // Ekranın "çerçeve dışı" rengi: sitenin kendi arka planı
      try {
        var bg = getComputedStyle(els.iframe.contentDocument.body).backgroundColor;
        if (bg && bg !== 'rgba(0, 0, 0, 0)') { els.screen.style.background = bg; els.iframe.style.background = bg; }
      } catch (e) { }
      els.load.classList.add('hide');
      els.canvas.style.opacity = 1;
      lastNow = performance.now();
      if (DEBUG) {
        window.obezIntroDebug = {
          seek: function (s) { running = false; t = s; var st = renderAt(s); return { lidP: st.lidP, eB: st.eB, W: W, H: H, k: L.k, ew: L.ew, eh: L.eh }; },
          finish: finish
        };
        rafId = requestAnimationFrame(frame);
        return;
      }
      running = true; t = 0;
      rafId = requestAnimationFrame(frame);
    }).catch(fail);
  }

  // Başlık script'i geç çalışabilir (ör. Cloudflare Rocket Loader): hazır olana kadar kısa süre bekle
  var tries = 0;
  (function launch() {
    boot = window.__obezIntro;
    if (boot && root.classList.contains('obez-intro')) {
      FORCE = !!boot.force;
      if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
      return;
    }
    if (window.__obezIntroSkip || tries++ > 40) return;   // bilerek atlandı ya da hiç başlamadı
    setTimeout(launch, 100);
  })();
})();
