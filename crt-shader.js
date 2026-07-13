/*
 * crt-shader.js
 * -----------------------------------------------------------------------
 * Drop this file (and crt-geom.cg) into the root folder of the site,
 * next to index.html / 404.html / etc. Include it once per page:
 *
 *   <script src="/crt-shader.js" defer></script>
 *
 * On load it checks whether /crt-geom.cg exists at the site root. If it
 * does, it turns on a WebGL post-processing overlay that mimics the
 * look of the crt-geom.cg RetroArch shader (screen curvature, scanlines,
 * shadow/dot mask, corner vignette, gamma) using the actual parameter
 * values found in that file. If the file is missing (or WebGL isn't
 * available), this script does nothing and the page renders exactly as
 * before.
 *
 * Nothing about the page's real DOM is changed - it keeps rendering
 * normally underneath. This just paints a live, shaded "photo" of the
 * page on top of it every frame.
 * -----------------------------------------------------------------------
 */
(function () {
  'use strict';

  var CG_PATHS = ['crt-geom.cg', '/crt-geom.cg'];
  var OVERLAY_ID = 'crt-shader-overlay';
  var CAPTURE_INTERVAL_MS = 90; // ~11fps DOM capture, plenty for a mostly-static page

  // Default parameter values, taken straight from crt-geom.cg's own
  // #pragma parameter defaults. Overwritten below if we can parse the
  // real file.
  var params = {
    CRTgamma: 2.4,
    monitorgamma: 2.2,
    d: 1.5,
    CURVATURE: 1.0,
    R: 2.0,
    cornersize: 0.03,
    cornersmooth: 1000.0,
    x_tilt: 0.0,
    y_tilt: 0.0,
    overscan_x: 100.0,
    overscan_y: 100.0,
    DOTMASK: 0.3,
    SHARPER: 1.0,
    scanline_weight: 0.3,
    lum: 0.0,
    interlace_toggle: 1.0
  };

  function parseParams(text) {
    var re = /#pragma\s+parameter\s+(\w+)\s+"[^"]*"\s+([\-0-9.]+)/g;
    var m;
    while ((m = re.exec(text))) {
      var val = parseFloat(m[2]);
      if (!isNaN(val)) params[m[1]] = val;
    }
  }

  function tryFetch(paths, i) {
    if (i >= paths.length) return Promise.resolve(null);
    return fetch(paths[i], { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) return tryFetch(paths, i + 1);
        return res.text();
      })
      .catch(function () {
        return tryFetch(paths, i + 1);
      });
  }

  function start() {
    if (location.protocol === 'file:') {
      console.warn(
        'crt-shader: this page was opened as a local file (file://). ' +
        'Browsers block fetch() from file:// pages, so the crt-geom.cg check ' +
        'will always fail here. Serve the folder with a local web server ' +
        '(e.g. `python3 -m http.server` in this folder, then open ' +
        'http://localhost:8000) or upload it to your host to see the effect.'
      );
    }
    tryFetch(CG_PATHS, 0).then(function (text) {
      if (text == null) return; // crt-geom.cg not found anywhere - do nothing
      try { parseParams(text); } catch (e) { /* fall back to defaults */ }
      try {
        initCRT();
      } catch (e) {
        console.warn('crt-shader: could not initialize CRT effect', e);
      }
    });
  }

  function initCRT() {
    if (document.getElementById(OVERLAY_ID)) return; // already running

    var canvas = document.createElement('canvas');
    canvas.id = OVERLAY_ID;
    canvas.style.position = 'fixed';
    canvas.style.inset = '0';
    canvas.style.left = '0';
    canvas.style.top = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.zIndex = '2147483647';
    canvas.style.pointerEvents = 'none';
    document.documentElement.appendChild(canvas);

    var gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) { canvas.remove(); return; }

    var vsSource =
      'attribute vec2 aPos;' +
      'varying vec2 vUv;' +
      'void main() {' +
      '  vUv = aPos * 0.5 + 0.5;' +
      '  gl_Position = vec4(aPos, 0.0, 1.0);' +
      '}';

    var fsSource =
      'precision mediump float;' +
      'varying vec2 vUv;' +
      'uniform sampler2D uTex;' +
      'uniform float uCRTgamma;' +
      'uniform float uMonitorGamma;' +
      'uniform float uCurvatureR;' +
      'uniform float uCurvatureOn;' +
      'uniform float uCornerSize;' +
      'uniform float uCornerSmooth;' +
      'uniform float uDotMask;' +
      'uniform float uScanlineWeight;' +
      'uniform float uLum;' +
      'uniform float uPitch;' +
      'vec2 barrel(vec2 uv, float R) {' +
      '  vec2 cc = uv * 2.0 - 1.0;' +
      '  float strength = 1.0 / max(R, 0.5);' +
      '  vec2 offset = cc.yx * cc.yx * strength * 0.35;' +
      '  cc += cc * offset;' +
      '  return cc * 0.5 + 0.5;' +
      '}' +
      'void main() {' +
      '  vec2 curved = (uCurvatureOn > 0.5) ? barrel(vUv, uCurvatureR) : vUv;' +
      '  if (curved.x < 0.0 || curved.x > 1.0 || curved.y < 0.0 || curved.y > 1.0) {' +
      '    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);' +
      '    return;' +
      '  }' +
      '  vec3 color = texture2D(uTex, curved).rgb;' +
      '  float scanPos = gl_FragCoord.y / uPitch;' +
      '  float scan = sin(scanPos * 3.14159265);' +
      '  float scanShade = 1.0 - uScanlineWeight * (1.0 - scan * scan);' +
      '  color *= mix(1.0, scanShade, 0.85);' +
      '  float col3 = mod(floor(gl_FragCoord.x / uPitch), 3.0);' +
      '  vec3 mask;' +
      '  if (col3 < 1.0) mask = vec3(1.0, 1.0 - uDotMask, 1.0 - uDotMask);' +
      '  else if (col3 < 2.0) mask = vec3(1.0 - uDotMask, 1.0, 1.0 - uDotMask);' +
      '  else mask = vec3(1.0 - uDotMask, 1.0 - uDotMask, 1.0);' +
      '  color *= mask;' +
      '  vec2 aspect = vec2(1.0, 0.75);' +
      '  vec2 cd = min(curved, 1.0 - curved) * aspect;' +
      '  vec2 cdist = vec2(uCornerSize);' +
      '  cd = cdist - min(cd, cdist);' +
      '  float dist = sqrt(dot(cd, cd));' +
      '  float cval = clamp((cdist.x - dist) * uCornerSmooth, 0.0, 1.0);' +
      '  color *= cval;' +
      '  color = pow(max(color, 0.0), vec3(uCRTgamma));' +
      '  color += uLum;' +
      '  color = pow(max(color, 0.0), vec3(1.0 / uMonitorGamma));' +
      '  gl_FragColor = vec4(color, 1.0);' +
      '}';

    function compile(type, src) {
      var s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        var log = gl.getShaderInfoLog(s);
        gl.deleteShader(s);
        throw new Error('shader compile error: ' + log);
      }
      return s;
    }

    var vs = compile(gl.VERTEX_SHADER, vsSource);
    var fs = compile(gl.FRAGMENT_SHADER, fsSource);
    var program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error('program link error: ' + gl.getProgramInfoLog(program));
    }
    gl.useProgram(program);

    var quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    var aPos = gl.getAttribLocation(program, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    var uTex = gl.getUniformLocation(program, 'uTex');
    var uCRTgamma = gl.getUniformLocation(program, 'uCRTgamma');
    var uMonitorGamma = gl.getUniformLocation(program, 'uMonitorGamma');
    var uCurvatureR = gl.getUniformLocation(program, 'uCurvatureR');
    var uCurvatureOn = gl.getUniformLocation(program, 'uCurvatureOn');
    var uCornerSize = gl.getUniformLocation(program, 'uCornerSize');
    var uCornerSmooth = gl.getUniformLocation(program, 'uCornerSmooth');
    var uDotMask = gl.getUniformLocation(program, 'uDotMask');
    var uScanlineWeight = gl.getUniformLocation(program, 'uScanlineWeight');
    var uLum = gl.getUniformLocation(program, 'uLum');
    var uPitch = gl.getUniformLocation(program, 'uPitch');

    gl.uniform1f(uCRTgamma, params.CRTgamma);
    gl.uniform1f(uMonitorGamma, params.monitorgamma);
    gl.uniform1f(uCurvatureR, params.R);
    gl.uniform1f(uCurvatureOn, params.CURVATURE);
    gl.uniform1f(uCornerSize, params.cornersize);
    gl.uniform1f(uCornerSmooth, params.cornersmooth);
    gl.uniform1f(uDotMask, params.DOTMASK);
    gl.uniform1f(uScanlineWeight, params.scanline_weight);
    gl.uniform1f(uLum, params.lum);
    gl.uniform1i(uTex, 0);

    var texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // 1x1 placeholder pixel until the first DOM capture lands
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));

    function resize() {
      var dpr = window.devicePixelRatio || 1;
      var w = Math.max(1, Math.floor(window.innerWidth * dpr));
      var h = Math.max(1, Math.floor(window.innerHeight * dpr));
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
      gl.uniform1f(uPitch, 3.0 * dpr);
    }
    window.addEventListener('resize', resize);
    resize();

    // --- Live DOM capture, via inline SVG foreignObject ---------------
    var captureFailCount = 0;
    var capturing = false;

    function snapshotCanvasesInto(node) {
      // cloneNode does not copy drawn pixel content of <canvas> elements,
      // so swap each cloned canvas for a static <img> of its current
      // bitmap before serializing.
      var live = document.querySelectorAll('canvas');
      var cloned = node.querySelectorAll('canvas');
      for (var i = 0; i < live.length; i++) {
        if (live[i].id === OVERLAY_ID) continue;
        var src = live[i];
        var dst = cloned[i];
        if (!dst) continue;
        var dataUrl;
        try { dataUrl = src.toDataURL(); } catch (e) { continue; }
        var img = document.createElement('img');
        img.src = dataUrl;
        img.width = src.width;
        img.height = src.height;
        var cs = window.getComputedStyle(src);
        img.setAttribute('style', dst.getAttribute('style') || '');
        img.style.cssText += cs.cssText || '';
        if (dst.parentNode) dst.parentNode.replaceChild(img, dst);
      }
    }

    function snapshotFormFieldsInto(node) {
      // Reflect live .value into the markup for inputs/textareas so the
      // capture matches what's actually on screen right now.
      var liveEls = document.querySelectorAll('textarea, input');
      var clonedEls = node.querySelectorAll('textarea, input');
      for (var i = 0; i < liveEls.length; i++) {
        var src = liveEls[i];
        var dst = clonedEls[i];
        if (!dst) continue;
        if (dst.tagName === 'TEXTAREA') {
          dst.textContent = src.value;
        } else {
          dst.setAttribute('value', src.value);
        }
      }
    }

    function captureDOM() {
      return new Promise(function (resolve, reject) {
        var width = Math.max(1, document.documentElement.clientWidth);
        var height = Math.max(1, document.documentElement.clientHeight);

        var clone = document.body.cloneNode(true);
        var overlayInClone = clone.querySelector('#' + OVERLAY_ID);
        if (overlayInClone) overlayInClone.remove();

        try {
          snapshotCanvasesInto(clone);
          snapshotFormFieldsInto(clone);
        } catch (e) { /* best effort */ }

        var styleHTML = '';
        var styleNodes = document.querySelectorAll('style');
        for (var i = 0; i < styleNodes.length; i++) styleHTML += styleNodes[i].outerHTML;

        var bodyCss = window.getComputedStyle(document.body).cssText || '';

        var htmlContent =
          '<div xmlns="http://www.w3.org/1999/xhtml" style="' + bodyCss + 'width:' + width + 'px;height:' + height + 'px;margin:0;">' +
          styleHTML +
          clone.innerHTML +
          '</div>';

        var svgData =
          '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '">' +
          '<foreignObject width="100%" height="100%">' + htmlContent + '</foreignObject>' +
          '</svg>';

        var blob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var img = new Image();
        img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = function (e) { URL.revokeObjectURL(url); reject(e); };
        img.src = url;
      });
    }

    function captureLoop() {
      if (capturing) { setTimeout(captureLoop, CAPTURE_INTERVAL_MS); return; }
      capturing = true;
      captureDOM()
        .then(function (img) {
          captureFailCount = 0;
          gl.bindTexture(gl.TEXTURE_2D, texture);
          try {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
          } catch (e) {
            // a tainted-canvas style failure - stop trying to avoid spam
            captureFailCount = 999;
          }
        })
        .catch(function () {
          captureFailCount++;
        })
        .then(function () {
          capturing = false;
          if (captureFailCount < 20) {
            setTimeout(captureLoop, CAPTURE_INTERVAL_MS);
          } else {
            // give up quietly; remove overlay so the raw page shows normally
            canvas.remove();
          }
        });
    }
    captureLoop();

    function render() {
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      if (document.getElementById(OVERLAY_ID)) {
        requestAnimationFrame(render);
      }
    }
    requestAnimationFrame(render);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
